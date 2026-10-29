# RK Tactical Relay

This is the multiplayer relay for the RK Tactical Companion, written in Go. Pilots flying MSFS 2020 or 2024 connect their Companion to it and see each other in one shared worldwide room, with missiles, guns, countermeasures and team rules carried between them.

The first version was rebuilt from the archived Node.js revision 6L server, the Companion 1.5 protocol header and the documented behavior of the August 25, 2026 Go `1.4.0-test3` release. I have since hardened it, taught it the Companion 1.5 team protocol, and added replicas, a Docker image, Kubernetes manifests, a deploy script, and a live server browser page. The Companion source lives in this repo too.

It isn't the original August 25 source and it isn't proven to be byte for byte identical, so test it with real Companions before you trust it with a live server.

## What's in here

- `main.go`: the server. Protocol, aircraft state, combat routing, snapshots, heartbeat and logging.
- `team.go`: Companion 1.5 team rules. Tracking, who can fight who, countermeasure sides.
- `config.go`: `relay.ini` and environment settings.
- `wire.go`: tolerant JSON decoding, so one bad field drops that message and not the connection.
- `websocket.go`: an RFC 6455 WebSocket server and client on the Go standard library.
- `outbox.go`: a send queue per connection, so one slow client can't stall everyone else.
- `proxy.go`: the real client address behind a proxy or load balancer.
- `peer.go`: links between replicas so several pods act as one room.
- `history.go` and `public.go`: recent flights and the public list behind the server browser.
- `dashboard.go`: the local only `/dashboard` and `/api/stats`.
- `resilience.go`: panic recovery, connection limits, readiness and draining.
- `web/` and `Dockerfile.web`: the server browser page and its nginx image.
- `companion/`: the Windows Companion app. `companion/tests/` has a network test that runs two Companions against a relay.
- `Dockerfile`, `deploy/k8s/`, `deploy.ps1` and `RUNBOOK.md`: containers, Kubernetes and deployment.
- `reference/`: the original Node servers and the Companion header. I keep them for auditing and they aren't needed to build.
- Tests are `*_test.go`, plus an optional `integration_test.py` that drives two Companions over real sockets.

## Building and running

You need Go 1.22 or newer. There are no external packages.

```powershell
.\BUILD_WINDOWS.cmd
```

```sh
sh BUILD_LINUX.sh
```

Put `relay.ini` next to the binary and run it. On Windows the dashboard opens in your browser when `open_dashboard=true`. On Linux nothing launches, so reach `/dashboard` over an SSH tunnel.

A Linux container is the better way to run it. A plain Windows binary is fine for testing.

## Configuration

```ini
[relay]
port=8787
open_dashboard=true
public_ip_lookup=true
trust_proxy=false
trusted_proxies=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,fc00::/7,127.0.0.0/8,::1/128
peer_dns=
peer_port=8788
peer_token=
public_api=false
max_conns_per_ip=64
drain_seconds=0
```

Environment variables win over the file: `PORT`, `OPEN_DASHBOARD`, `PUBLIC_IP_LOOKUP`, `TRUST_PROXY`, `TRUSTED_PROXIES`, `PUBLIC_API`, `PEER_DNS`, `PEER_PORT`, `PEER_TOKEN`, `MAX_CONNS_PER_IP` and `DRAIN_SECONDS`. `POD_NAME` and `POD_IP` name an instance when you run replicas.

For a test instance set `PORT` to something like `18787` and leave your public relay alone. Keep 8787 in production so existing Companion configs keep working.

## Client addresses behind a proxy

By default the relay logs the address of the TCP connection, which is the proxy or the node when you sit behind one. Set `trust_proxy=true` and it reads `X-Forwarded-For` or `X-Real-IP` instead, but only when the connection comes from an address in `trusted_proxies`. It walks the forwarded list from the right and takes the first address that isn't a trusted proxy, so a client can't fake its address by sending the header.

The dashboard never trusts those headers. It still needs a loopback connection, and it refuses requests with proxy headers or a `Host` that isn't local.

## Docker

```sh
docker build -t rk-tactical-relay .
docker run -p 8787:8787 rk-tactical-relay
```

The image is a static Linux binary on distroless, running as a numeric nonroot user, with the public IP lookup off. The relay closes clients cleanly on SIGTERM. Use `/health` for liveness and `/ready` for readiness.

## Kubernetes

The manifests are in `deploy/k8s/`. For a real deploy use `deploy.ps1`, which does everything from a fresh start: preflight checks, tests, build and push, namespace, pull secret, peer token, apply, rollout and a peer link check.

```powershell
.\deploy.ps1 -LoadBalancerIP 192.168.1.241
```

`-DryRun` changes nothing, `-Status` shows what's running, `-Rollback` goes back one revision and `-Teardown` removes the namespace after you type its name. `RUNBOOK.md` has the same steps by hand, plus the OPNsense port forward, DNS and troubleshooting.

Replicas find each other through the headless `rk-relay-peers` service and open a link between every pair of pods on port 8788. Over those links they share aircraft state, combat events and flight history, so pilots on different pods see each other and hits reach the target wherever it is connected. A pilot who reconnects on another pod has the old connection closed. A link needs the shared token and the network policy only lets relay pods reach port 8788.

What's included:

- `deployment.yaml`: two replicas, rolling updates, probes and a read only root filesystem.
- `service.yaml`: a LoadBalancer with `externalTrafficPolicy: Local`, which keeps the real client address without needing a proxy.
- `service-peers.yaml`: the headless service for replica discovery.
- `networkpolicy.yaml`, `pdb.yaml` and `hpa.yaml`: network limits, a disruption budget and CPU autoscaling from 2 to 6 pods.
- `web.yaml`: the server browser, with an ingress for the page and a `/ws` route to the relay.
- `ingress.yaml`: an optional nginx example for the relay alone. It isn't in the kustomization.

Things to know:

- The peer links aren't encrypted. The token and the traffic stay on the cluster network, so use a mesh or an encrypted CNI if that matters to you.
- Scaling down closes the connections on the removed pod. Companions reconnect on their own, but expect a short drop.
- The player cap of 1,024 applies per pod.
- Dashboards and counters are per pod. Use `kubectl port-forward` to reach one.
- A new pod needs a few seconds to link up, so remote contacts can be missing briefly after a rollout.

## Server browser

`web/index.html` is a single page that shows who is flying right now. It has a map, a searchable pilot list, headline stats, a recent flights log, and the address to paste into the Companion. nginx serves it from `Dockerfile.web` and proxies `/api/public` to the relay, so the browser never talks to port 8787. `deploy.ps1` builds it and fills in the host name (`-Hostname`, `rk.hangaraddons.com` by default).

The relay is one worldwide room, so the page lists pilots, not separate sessions. Positions are rounded to about a kilometre and altitudes to the nearest 100 feet. The list only exists when `public_api=true`, and the Kubernetes deployment turns it on. Map tiles come from OpenStreetMap and Leaflet from unpkg, so visitors' browsers contact both.

Recent flights are the last 200 sessions where a pilot flew for at least 20 seconds. Replicas share them and a new pod copies them from its peers, so they survive a rolling update. They live in memory, so restarting every pod at once clears them.

The same host also serves the relay over TLS at `wss://rk.hangaraddons.com/ws` through the ingress. Use it for networks that block port 8787.

## Companion

The Windows Companion is in `companion/`. It's a C++ SimConnect app that plays the missile warning sounds and carries your aircraft state and combat events to the relay. Build it with Visual Studio and the MSFS SDK as described in `companion/README.md`, and set `relay_url` in `companion/companion.ini` first.

To make a release, bump the version in `companion/src/Version.h` and run `companion/Release-Companion.ps1`. It builds, checks that `relay_url` is set, and writes `companion/dist/RKTacticalCompanion-<version>.zip` and a `.sha256` file. The zip has the exe, ini, audio, SimConnect.dll and a player README. The script prints the `gh release create` command to publish it. Build output and the zip are ignored by git.

`reference/RelayServer_Companion15_Protocol4.js` is the Node relay that came with Companion 1.5. I keep it to audit the team rules. It asks for hello protocol 4 while the Companion sends 3, and this relay accepts both.

## Reliability

- Every client has its own send queue and writer. A slow or stalled connection can't hold anyone up, and it gets dropped if its queue fills.
- Snapshots are latest wins. A client that can't keep up skips to the newest one, and the drops show in the dashboard counters.
- Snapshots are built across all CPU cores and pick the 32 nearest contacts without sorting everyone. A full 1,024 player broadcast costs about 50 ms of CPU.
- Connections idle for 30 seconds are closed, on top of the ping and pong check.
- At most `max_conns_per_ip` connections per client address, 64 by default and 0 turns it off.
- Background loops and writers recover from panics and restart.
- On SIGTERM the relay fails `/ready`, refuses new connections, waits `drain_seconds`, then closes clients with a going away code. Give the pod a longer termination grace period than that.
- Replica links reconnect on their own and share state every 100 ms. Remote pilots show up within about 350 ms, and combat crosses pods straight away.

Replicas link in a full mesh, which is fine for a handful of pods. Past about ten you'd want a different design.

## Protocol

| Item | Value |
|---|---|
| WebSocket | uncompressed text JSON in, binary snapshots and JSON combat events out |
| Hello | `{"type":"hello","protocol":3,"id":"pilot-id","name":"Pilot Name"}`, protocol 3 or 4 is accepted |
| Welcome | `{"type":"welcome","protocol":3,"id":"pilot-id","network":"rk-tactical-global"}`, echoing the client's protocol |
| Network | `rk-tactical-global`, one worldwide room |
| Snapshot | magic `0x31504D52`, 3864 bytes, 24 byte header (version 4), 120 byte contacts, little endian |
| Contacts per viewer | the 32 nearest live pilots, state expires after 10 seconds |
| Contact hash | FNV-1a 32 bit of the UTF-8 player ID |
| Combat source ID | `0x60000000 \| (hash & 0x0fffffff)` |
| Combat events | 1 launch, 2 end, 3 hit, 4 countermeasure, 5 visual update, 6 explosion, 7 to 9 team events |
| Teams | state carries `team` (0 solo, 1, 2), `flight` and `detected`. Contact flags are the team plus 4 when the viewer's team tracks it |
| Combat delivery | hits go only to the target, everything else to all other pilots, and the low flag bit marks the target |
| Limits | one state update per 100 ms, snapshots every 250 ms and on connect or disconnect, 16 KiB per message, 1,024 players per instance |
| Heartbeat | ping every 5 seconds, disconnect after a missed pong |

On top of the original behavior:

- Combat is limited to 300 events per second per client.
- At most 256 connections can wait on their hello at once.
- Snapshots and combat only go out after the welcome has been sent.
- Malformed fields drop the message, not the connection.
- Team rules from Companion 1.5. A team only fights the other team, solo pilots only fight solo pilots, a launch needs the target tracked by a teammate, and countermeasures stay on the same side.

## Endpoints

- `/` takes the Companion WebSocket upgrade. As with the Node server, other unreserved paths also work, which is how `/ws` behind the ingress reaches it.
- `/health` returns status, protocol, player count and peer count with no player details.
- `/ready` is the same but answers 503 while draining, and for the first few seconds of a new replica so it can link up first.
- `/api/public` is the list behind the server browser, only when `public_api=true`.
- `/dashboard` and `/api/stats` only answer on a loopback connection. Use an SSH tunnel, a VPN or `kubectl port-forward`.
- Port 8788 is the replica link. It only starts when `peer_dns` and `peer_token` are set. Don't expose it publicly.

The dashboard shows a green light while at least one Companion is connected, and `REMOTE CONNECTION CONFIRMED` once a public address has finished a handshake.

## Limitations

- Not yet tested against real MSFS Companions on separate PCs, and the team rules are only covered by the test suite.
- The `ws://` endpoint is unencrypted and pilots aren't authenticated. Anyone who knows a pilot ID can take it over, the same as the original server. Use the `wss://` address when you can.
- The dashboard memory figure is the Go heap and CPU isn't sampled. Everything is in memory and lost on restart.
- The Companion isn't code signed yet, so Windows SmartScreen warns about it.
- Don't run the old and new servers on the same port. Use a staging port to compare them.

## Testing

```sh
go vet ./...
go test -race -count=1 ./...
```

The tests start the relay in process and talk to it over real sockets: handshake order, protocol rejection, snapshots, team tracking, combat routing, rate limits, proxy handling, the dashboard guard, flight history, and two relays sharing contacts and combat through a peer link.

`python integration_test.py` runs the optional external wire test against a built binary. To audit the behavior, compare the files in `reference/` with `main.go`, `team.go` and the tests.
