"use strict";

const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const port = Number(process.env.PORT || 8787);
const globalNetwork = "rk-tactical-global";
const maxPlayers = 1024;
const stateExpiryMs = 10000;
const multiplayerMagic = 0x31504d52;
const multiplayerVersion = 4;
const snapshotBytes = 3864;
const contactBytes = 120;
let snapshotSequence = 0;

const server = http.createServer((request, response) => {
    if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
            ok: true,
            network: globalNetwork,
            protocol: multiplayerVersion,
            players: clients.size
        }));
        return;
    }
    response.writeHead(404);
    response.end();
});

const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const clients = new Map();

function timestamp() {
    return new Date().toISOString();
}

function remoteAddress(socket) {
    return cleanText(socket.rkRemoteAddress, 64) || "unknown";
}

function logClientEvent(event, socket, client, details) {
    const suffix = details ? ` ${details}` : "";
    console.log(
        `[${timestamp()}] ${event}`
        + ` name=${JSON.stringify(client.name)}`
        + ` id=${client.id}`
        + ` address=${remoteAddress(socket)}`
        + ` users=${clients.size}${suffix}`);
}

function cleanText(value, maximum) {
    return String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maximum);
}

function validNumber(value, minimum, maximum) {
    const number = Number(value);
    return Number.isFinite(number) && number >= minimum && number <= maximum
        ? number : null;
}

function send(socket, payload) {
    if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
    }
}

function distanceKey(viewer, contact) {
    if (!viewer || !viewer.state) { return 0; }
    const latitudeRadians = viewer.state.lat * Math.PI / 180;
    const dLat = contact.state.lat - viewer.state.lat;
    const rawLongitude = contact.state.lon - viewer.state.lon;
    const wrappedLongitude = ((rawLongitude + 540) % 360) - 180;
    const dLon = wrappedLongitude * Math.cos(latitudeRadians);
    return dLat * dLat + dLon * dLon;
}

function coneDetects(a,b,miles) {
    const rad=Math.PI/180, dlat=(b.lat-a.lat)*rad,dlon=(((b.lon-a.lon+540)%360)-180)*rad;
    const h=Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlon/2)**2;
    const horizontal=3958.7613*2*Math.asin(Math.sqrt(Math.min(1,h)));
    if(Math.hypot(horizontal,(b.altFt-a.altFt)/5280)>miles)return false;
    const bearing=Math.atan2(Math.sin(dlon)*Math.cos(b.lat*rad),Math.cos(a.lat*rad)*Math.sin(b.lat*rad)-Math.sin(a.lat*rad)*Math.cos(b.lat*rad)*Math.cos(dlon))/rad;
    return Math.abs(((bearing-a.heading+540)%360)-180)<=60;
}
function teamDetects(viewer,target) {
    if(!viewer || !viewer.team || viewer.team===target.team)return true;
    const id=panelContactId(target.id),now=Date.now();
    for(const ally of clients.values()){
        if(ally.team!==viewer.team || !ally.state || now-ally.lastStateMs>stateExpiryMs)continue;
        if((ally.detected||[]).includes(id) || coneDetects(ally.state,target.state,100))return true;
    }return false;
}
function teamsInteract(a,b,weapon){return (a===0)===(b===0) && !(a!==0 && a===b && weapon===1);}
function playersFor(excludedId) {
    const now = Date.now();
    const players = [];
    let viewer = null;
    for (const client of clients.values()) {
        if (client.id === excludedId) { viewer = client; break; }
    }
    for (const client of clients.values()) {
        if (client.id === excludedId || !client.state
            || now - client.lastStateMs > stateExpiryMs) {
            continue;
        }
        players.push({
            id: client.id,
            name: client.name,
            lat: client.state.lat,
            lon: client.state.lon,
            altFt: client.state.altFt,
            heading: client.state.heading,
            speedKts: client.state.speedKts,
            aircraft: client.state.aircraft,
            team: client.team || 0,
            tracked: teamDetects(viewer,client),
            distanceKey: distanceKey(viewer, client)
        });
    }
    players.sort((left, right) => left.distanceKey - right.distanceKey);
    return players.slice(0, 32);
}

function idHash(text) {
    let hash = 0x811c9dc5;
    for (const byte of Buffer.from(text, "utf8")) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash || 1;
}

function panelContactId(id) {
    return (0x60000000 | (idHash(id) & 0x0fffffff)) >>> 0;
}

function unsignedInteger(value, maximum = 0xffffffff) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= maximum
        ? number : null;
}

function combatName(eventType) {
    return ["NONE", "LAUNCH", "END", "HIT", "COUNTERMEASURE",
        "UPDATE", "EXPLOSION"][eventType]
        || "UNKNOWN";
}

function weaponName(weaponType) {
    return ["NONE", "AIM120", "AIM9", "TRACER", "CHAFF", "FLARE"][weaponType]
        || "UNKNOWN";
}

function writeFixedUtf8(buffer, offset, length, text) {
    const source = Buffer.from(String(text || ""), "utf8");
    source.copy(buffer, offset, 0, Math.min(source.length, length - 1));
}

function binarySnapshot(excludedId) {
    const players = playersFor(excludedId);
    const buffer = Buffer.alloc(snapshotBytes);
    snapshotSequence = (snapshotSequence + 1) >>> 0 || 1;
    buffer.writeUInt32LE(multiplayerMagic, 0);
    buffer.writeUInt32LE(multiplayerVersion, 4);
    buffer.writeUInt32LE(snapshotBytes, 8);
    buffer.writeUInt32LE(snapshotSequence, 12);
    buffer.writeUInt32LE(players.length, 16);
    for (let index = 0; index < players.length; index += 1) {
        const player = players[index];
        const offset = 24 + index * contactBytes;
        buffer.writeUInt32LE(idHash(player.id), offset);
        buffer.writeUInt32LE(player.team | (player.tracked ? 4 : 0), offset + 4);
        buffer.writeDoubleLE(player.lat, offset + 8);
        buffer.writeDoubleLE(player.lon, offset + 16);
        buffer.writeDoubleLE(player.altFt, offset + 24);
        buffer.writeFloatLE(player.heading, offset + 32);
        buffer.writeFloatLE(player.speedKts, offset + 36);
        writeFixedUtf8(buffer, offset + 40, 32, player.name);
        writeFixedUtf8(buffer, offset + 72, 48, player.aircraft);
    }
    return buffer;
}

function broadcastSnapshot() {
    for (const [socket, client] of clients.entries()) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(binarySnapshot(client.id), { binary: true });
        }
    }
}

function acceptHello(socket, message) {
    if (Number(message.protocol) !== multiplayerVersion) {
        console.log(`[${timestamp()}] REJECT address=${remoteAddress(socket)}`
            + " reason=unsupported_protocol");
        send(socket, { type: "error", message: "unsupported protocol" });
        socket.close(1002, "unsupported protocol");
        return;
    }
    const id = cleanText(message.id, 64);
    const name = cleanText(message.name, 40) || "RK Pilot";
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(id)) {
        console.log(`[${timestamp()}] REJECT address=${remoteAddress(socket)}`
            + " reason=invalid_identity");
        socket.close(1008, "invalid identity");
        return;
    }
    for (const [otherSocket, other] of clients.entries()) {
        if (other.id === id) {
            logClientEvent("REPLACED", otherSocket, other,
                "reason=identity_reconnected");
            otherSocket.close(4001, "identity reconnected");
            clients.delete(otherSocket);
        }
    }
    if (clients.size >= maxPlayers) {
        console.log(`[${timestamp()}] REJECT address=${remoteAddress(socket)}`
            + " reason=network_full");
        socket.close(1013, "network full");
        return;
    }
    clients.set(socket, {
        id, name, state: null, lastStateMs: 0, lastMessageMs: 0
    });
    logClientEvent("CONNECT", socket, { id, name });
    send(socket, {
        type: "welcome", protocol: multiplayerVersion,
        id, network: globalNetwork
    });
    broadcastSnapshot();
}

function acceptState(socket, client, message) {
    const now = Date.now();
    if (now - client.lastMessageMs < 100) { return; }
    client.lastMessageMs = now;
    const lat = validNumber(message.lat, -90, 90);
    const lon = validNumber(message.lon, -180, 180);
    const altFt = validNumber(message.altFt, -2000, 200000);
    const heading = validNumber(message.heading, -360, 720);
    const speedKts = validNumber(message.speedKts, 0, 10000);
    if ([lat, lon, altFt, heading, speedKts].some((value) => value === null)) {
        return;
    }
    const flight=unsignedInteger(message.flight), team=unsignedInteger(message.team,2);
    if(flight===null || team===null)return;
    if(client.flight!==flight){client.flight=flight;client.team=0;}
    if(!client.team && team)client.team=team;
    client.detected=Array.isArray(message.detected)?message.detected.slice(0,32).filter(v=>unsignedInteger(v)!==null):[];
    client.state = {
        lat, lon, altFt,
        heading: ((heading % 360) + 360) % 360,
        speedKts,
        aircraft: cleanText(message.aircraft, 80)
    };
    client.lastStateMs = now;
}

function acceptCombat(socket, client, message) {
    const eventType = unsignedInteger(message.event, 9);
    const weaponType = unsignedInteger(message.weapon, 5);
    const target = unsignedInteger(message.target);
    const weaponId = unsignedInteger(message.weaponId);
    const flags = unsignedInteger(message.flags);
    const lat = validNumber(message.lat, -90, 90);
    const lon = validNumber(message.lon, -180, 180);
    const altFt = validNumber(message.altFt, -2000, 200000);
    const heading = validNumber(message.heading, -360, 720);
    const damage = validNumber(message.damage, 0, 1000);
    const duration = validNumber(message.duration, 0, 300);
    const missDistance = validNumber(message.missDistance, 0, 10000000);
    if (!eventType || !weaponType || target === null || weaponId === null
        || flags === null || [lat, lon, altFt, heading, damage, duration,
            missDistance].some((value) => value === null)) {
        console.log(`[${timestamp()}] COMBAT_REJECT name=${JSON.stringify(client.name)}`
            + ` id=${client.id} reason=invalid_event`);
        return;
    }

    const source = panelContactId(client.id);
    if(eventType>=7){
        if((eventType===8 && client.team!==1)||(eventType===9 && client.team!==2)||(eventType===7 && !client.team))return;
        if(eventType===7 && !((target>=1&&target<=3)||(target>=101&&target<=136)||(target>=201&&target<=216)))return;
        for(const [otherSocket,other] of clients)if(other.id!==client.id)send(otherSocket,{
            type:"combat",event:eventType,weapon:3,source,target,weaponId,flags:(client.team||0)<<4,
            lat,lon,altFt,heading,damage:0,duration:0,missDistance:0
        });
        return;
    }
    const defense=(flags&64)!==0;
    const attacker=defense?((flags>>4)&3):(client.team||0);
    if(defense && attacker!==1 && attacker!==2)return;
    let victim=null;
    if(target){for(const c of clients.values())if(panelContactId(c.id)===target){victim=c;break;}}
    if(target && (!victim || !teamsInteract(attacker,victim.team||0,weaponType)))return;
    if(eventType===1 && victim && !defense && !teamDetects(client,victim))return;
    const payload = {
        type: "combat",
        event: eventType,
        weapon: weaponType,
        source,
        target,
        weaponId,
        flags: (flags & ~49) | (attacker<<4),
        lat,
        lon,
        altFt,
        heading: ((heading % 360) + 360) % 360,
        damage,
        duration,
        missDistance
    };

    let delivered = 0;
    for (const [otherSocket, other] of clients.entries()) {
        if (other.id === client.id
            || otherSocket.readyState !== WebSocket.OPEN) {
            continue;
        }
        if(eventType===4 && ((client.team||0)===0)!==((other.team||0)===0))continue;
        const localTarget = panelContactId(other.id) === target;
        // Damage is authoritative at the selected target only. Launches,
        // movement, endings, countermeasures and explosions are broadcast so
        // every connected simulator can render the same combat scene.
        if (eventType === 3 && !localTarget) { continue; }
        send(otherSocket, {
            ...payload,
            flags: (payload.flags | (localTarget ? 1 : 0)) >>> 0
        });
        ++delivered;
    }

    // Position updates run at weapon cadence and would make the operational
    // console unusable. Lifecycle, effect and damage events remain visible.
    if (eventType !== 5) {
        console.log(`[${timestamp()}] COMBAT ${combatName(eventType)}`
            + ` weapon=${weaponName(weaponType)}`
            + ` from=${JSON.stringify(client.name)}`
            + ` source=${source} target=${target}`
            + ` delivered=${delivered}`);
    }
}

wss.on("connection", (socket, request) => {
    socket.rkRemoteAddress = request && request.socket
        ? request.socket.remoteAddress : "unknown";
    socket.isAlive = true;
    socket.on("pong", () => { socket.isAlive = true; });
    socket.on("message", (data, isBinary) => {
        if (isBinary) { socket.close(1003, "text only"); return; }
        let message;
        try { message = JSON.parse(data.toString("utf8")); }
        catch { socket.close(1007, "invalid JSON"); return; }
        const client = clients.get(socket);
        if (!client) {
            if (message.type !== "hello") {
                socket.close(1008, "hello required");
                return;
            }
            acceptHello(socket, message);
            return;
        }
        if (message.type === "state") {
            acceptState(socket, client, message);
        } else if (message.type === "combat") {
            acceptCombat(socket, client, message);
        }
    });
    socket.on("close", (code, reasonBuffer) => {
        const client = clients.get(socket);
        clients.delete(socket);
        if (client) {
            const reason = cleanText(
                reasonBuffer ? reasonBuffer.toString("utf8") : "", 80);
            logClientEvent("DISCONNECT", socket, client,
                `code=${code} reason=${JSON.stringify(reason || "none")}`);
        }
        broadcastSnapshot();
    });
    socket.on("error", () => {});
});

setInterval(() => {
    for (const socket of wss.clients) {
        if (!socket.isAlive) { socket.terminate(); continue; }
        socket.isAlive = false;
        socket.ping();
    }
}, 5000).unref();

// State messages may arrive several times per second from every client. A
// fixed snapshot cadence avoids O(n^2) broadcast bursts as the global network
// grows while keeping tactical contacts responsive.
setInterval(broadcastSnapshot, 250).unref();

server.listen(port, "0.0.0.0", () => {
    console.log(`RK Tactical Relay listening on port ${port}`);
});
