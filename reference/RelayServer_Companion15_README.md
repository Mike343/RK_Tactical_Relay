# RK Tactical Relay 1.3 Shared Weapons and VFX

This is the small Internet relay used by `RKTacticalCompanion.exe`. It stores
only the latest aircraft state for each connected RK player and broadcasts a
global snapshot. It does not connect to MSFS and it does not play audio.

All clients are assigned to `rk-tactical-global`. Client-supplied room names
are ignored, so players cannot accidentally split into separate rooms. Each
client receives the nearest 32 live RK contacts four times per second.

## Local test

1. Install Node.js 20 or newer.
2. Open a command prompt in this folder.
3. Run `npm install`.
4. Run `npm start`.
5. Leave `relay_url=ws://127.0.0.1:8787` in each local test client.

`http://127.0.0.1:8787/health` returns a basic health response.

## Internet hosting

The package publisher hosts this folder once on a Node-compatible service and
puts it behind HTTPS. Put the resulting `wss://` WebSocket address in the
distributed `companion.ini`. Individual players only run the companion EXE;
they do not host this service.

Protocol 3 exchanges presence and position telemetry in a fixed-size binary
snapshot containing no more than 32 nearby remote contacts per client. It
broadcasts validated weapon launches, visual position updates, endings,
countermeasures and explosions to every other client. Damage events remain
restricted to the selected target. Only authenticated Companion clients can
send events.

## Console connection log

The relay logs every accepted companion handshake and authenticated
disconnection. Each entry includes its UTC timestamp, player name, player ID,
remote address and the current connected-user count. Rejected protocol,
identity and capacity attempts are also reported. Combat events are logged with
weapon, source, target and delivery count. High-frequency aircraft-state and
weapon-position messages remain intentionally unlogged.

Example:

```text
[2026-08-15T17:22:10.124Z] CONNECT name="RK Pilot" id=abc123 address=192.168.1.25 users=1
[2026-08-15T17:25:44.801Z] DISCONNECT name="RK Pilot" id=abc123 address=192.168.1.25 users=0 code=1000 reason="none"
```
