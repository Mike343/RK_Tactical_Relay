# RK Tactical Relay (Protocol 3)

A Go implementation of the RK Tactical Relay. It was rebuilt from the archived Node.js revision 6L server, the Tactical Companion 1.5 protocol header and the documented behavior of the August 25, 2026 Go `1.4.0-test3` release.

This is not the original August 25 Go source and it is not proven to be byte for byte identical. Test it against real RK Tactical Companions before replacing a live server.

## Source files

- `main.go`: server, protocol 3, aircraft state and combat routing, snapshots, heartbeat, logging.
- `config.go`: `relay.ini` and environment settings.
- `wire.go`: tolerant JSON decoding, so one malformed field drops that message instead of the connection.
- `websocket.go`: RFC 6455 WebSocket server and client built on the Go standard library. Masking, ping and pong, close, fragments and size limits.
- `outbox.go`: per connection send queue, so one slow client can't stall everyone else.
- `proxy.go`: real client address behind a reverse proxy or load balancer.
- `peer.go`: links between replicas so several pods act as one room.
- `dashboard.go`: loopback only `/dashboard` and `/api/stats`.
- `public.go`: optional `/api/public` listing for the server browser.
- `web/`, `Dockerfile.web`: the server browser page and its nginx image.
- `main_test.go`: protocol, snapshot, routing, proxy and replica tests.
- `integration_test.py`: optional two Companion wire test using Python `websocket-client`.
- `reference/`: the original Node server and the Companion header, kept for auditing. They aren't needed to build.
- `Dockerfile` and `deploy/k8s/`: container image and Kubernetes manifests.

## Building

Go 1.22 or newer. No external packages are needed.

Windows x64:

```bat
BUILD_WINDOWS.cmd
```

Linux x64:

```sh
sh BUILD_LINUX.sh
```

Put `relay.ini` next to the binary and run it. On Windows the dashboard opens in the browser when `open_dashboard=true`. On Linux nothing is launched, so reach `/dashboard` through an SSH tunnel.

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

Environment variables override the file: `PORT`, `OPEN_DASHBOARD`, `PUBLIC_IP_LOOKUP`, `TRUST_PROXY`, `TRUSTED_PROXIES`, `PUBLIC_API`, `PEER_DNS`, `PEER_PORT`, `PEER_TOKEN`, `MAX_CONNS_PER_IP`, `DRAIN_SECONDS`. `POD_NAME` and `POD_IP` name this instance when running replicas.

For a test instance set `PORT` to something else, like `18787`, and leave your public relay alone. Keep 8787 in production so existing Companion configs keep working.

## Client addresses behind a proxy

By default the relay logs the address of the TCP connection, which is the proxy or the node when you run behind one. Set `trust_proxy=true` and the relay reads `X-Forwarded-For` (or `X-Real-IP`) instead, but only when the connection comes from an address in `trusted_proxies`. It walks the forwarded list from the right and takes the first address that isn't a trusted proxy, so a client can't fake its own address by sending the header.

The dashboard never trusts these headers. It still needs a loopback connection, and it refuses requests that carry proxy headers or a non local `Host`.

## Docker

```sh
docker build -t rk-tactical-relay .
docker run -p 8787:8787 rk-tactical-relay
```

The image is a static Linux binary on distroless, running as nonroot, with the public IP lookup off. The relay closes clients cleanly on SIGTERM. Use `/health` for probes.

## Kubernetes and replicas

The manifests are in `deploy/k8s/`. Create the shared secret first, then apply:

```sh
kubectl create secret generic rk-relay-peer --from-literal=token=$(openssl rand -hex 32)
kubectl apply -k deploy/k8s
```

Replicas find each other through the headless `rk-relay-peers` service and open a link between every pair of pods on port 8788. Over those links they share aircraft state and combat events, so pilots on different pods see each other and hits reach the target wherever it is connected. If a pilot reconnects on another pod, the old connection is closed. A link needs the shared token, and the NetworkPolicy only lets relay pods reach port 8788.

What is included:

- `deployment.yaml`: two replicas, rolling updates, probes, read only root filesystem.
- `service.yaml`: a LoadBalancer with `externalTrafficPolicy: Local`, which keeps the real client address without needing a proxy.
- `service-peers.yaml`: the headless service for replica discovery.
- `networkpolicy.yaml`, `pdb.yaml`, `hpa.yaml`: network limits, disruption budget and CPU autoscaling from 2 to 6 pods.
- `ingress.yaml`: optional nginx example with long WebSocket timeouts. It isn't in the kustomization. Use it with `TRUST_PROXY=true`, which the deployment already sets.

Notes:

- The peer links aren't encrypted. The token and the traffic stay inside the cluster network, so use a mesh or encrypted CNI if that matters to you.
- Scaling down closes the WebSocket connections on the removed pod. Companions reconnect on their own, but expect a short drop.
- The player cap of 1,024 applies per pod.
- Dashboards and counters are per pod. Use `kubectl port-forward` to reach one.
- A new pod needs a few seconds to link up with the others, so remote contacts can be missing briefly after a rollout.

## Scaling and reliability

What the relay does to keep latency low and survive bad networks:

- Every client has its own send queue and writer. A slow or stalled connection can't hold up anyone else, and it is dropped if its queue fills.
- Snapshots are latest wins. If a client can't keep up it skips to the newest snapshot instead of working through old ones. Dropped snapshots and slow disconnects show up in the dashboard counters.
- Snapshots are built across all CPU cores and pick the 32 nearest contacts without sorting everyone. A full 1,024 player broadcast takes about 50 ms of CPU.
- Connections idle for 30 seconds are closed, on top of the ping and pong check, so half open sockets don't pile up.
- At most `max_conns_per_ip` connections per client address (64 by default, 0 turns it off). Behind a proxy this uses the real address once `trust_proxy` is on.
- Background loops and writers recover from panics and restart, so one bad message can't take the relay down.
- On SIGTERM the relay fails `/ready`, refuses new connections, waits `drain_seconds`, then closes clients with a going away code. Give the pod a termination grace period longer than that.
- Replica links reconnect on their own, and replicas share state every 100 ms. Remote pilots show up in snapshots within about 350 ms, and combat crosses pods straight away.

Scaling limits: each pod holds up to 1,024 pilots and replicas link in a full mesh, which is fine for a handful of pods. Past roughly ten, a different design would be needed.

## Client compatibility

Taken from the revision 6L Node server and Companion 1.5.

| Item | Value |
|---|---|
| WebSocket | uncompressed text JSON in, binary snapshots and JSON combat events out |
| Hello | `{"type":"hello","protocol":3,"id":"pilot-id","name":"Pilot Name"}` |
| Welcome | `{"type":"welcome","protocol":3,"id":"pilot-id","network":"rk-tactical-global"}` |
| Network | `rk-tactical-global`, one worldwide room |
| Snapshot magic | `0x31504D52` little endian |
| Snapshot length | 3864 bytes, 24 byte header, 120 byte contact records |
| Contacts per viewer | 32 nearest live pilots, state expires after 10 seconds |
| Contact hash | FNV-1a 32 bit of the UTF-8 player ID |
| Combat source ID | `0x60000000 \| (hash & 0x0fffffff)` |
| Combat events | 1 launch, 2 end, 3 hit, 4 countermeasure, 5 visual update, 6 explosion |
| Combat delivery | hits go only to the target, everything else to all other pilots |
| Local target flag | low bit set on combat sent to the selected target |
| State limit | one state update per 100 ms per player |
| Snapshot rate | every 250 ms, and right away on connect and disconnect |
| Heartbeat | ping every 5 seconds, disconnect after a missed pong |
| Max players | 1,024 per instance |
| Max inbound message | 16 KiB |

Additions on top of the original behavior:

- Combat is limited to 300 events per second per client.
- At most 256 connections can wait on their hello at once.
- Snapshots and combat go out only after the welcome has been sent.
- Malformed fields drop the message, not the connection.

## Endpoints

- `/` takes the Companion WebSocket upgrade. As with the Node server, other unreserved paths also work.
- `/health` returns status, protocol, player count and peer count, with no player details. Use it for liveness.
- `/ready` is the same, but answers 503 while the relay is draining, and for the first few seconds of a replica so it can link up before it takes pilots. Use it for readiness.
- `/api/public` is the list behind the server browser page. It answers only when `public_api=true`, and shows pilot names, aircraft, speed, altitude and positions rounded to about a kilometre.
- `/dashboard` and `/api/stats` only answer on a loopback connection. Use an SSH tunnel, a VPN or `kubectl port-forward`.
- Port 8788 is the replica link and is only started when `peer_dns` and `peer_token` are set. Don't expose it publicly.

The dashboard shows a green light while at least one Companion is connected, and `REMOTE CONNECTION CONFIRMED` once a public address has finished a handshake.

## Limitations

- Not yet tested against real MSFS 2020 or 2024 Companions on separate PCs.
- The `ws://` endpoint is unencrypted and players aren't authenticated. Anyone who knows a pilot ID can take it over, as with the original server.
- The dashboard memory figure is the Go heap, and CPU isn't sampled. Everything lives in memory and is lost on restart.
- Don't run the old and new servers on the same port. Use a staging port to compare them.

## Testing

```sh
go vet ./...
go test -race -count=1 ./...
```

The tests start the relay in process and talk to it over real sockets: handshake order, protocol rejection, snapshots, combat routing, rate limits, proxy address handling, the dashboard guard, and two relays sharing contacts and combat through a peer link.

`python integration_test.py` runs the optional external wire test against a built binary.

To audit the behavior, compare `reference/RelayServer_6L_Protocol3.js` and `reference/Companion_6L_Protocol.h` with `main.go` and the tests.

## Server browser

`web/index.html` is a single page that shows who is flying, with a map, a searchable pilot list and the address to paste into the Companion. It is served by nginx from `Dockerfile.web` and asks the relay for `/api/public` through the same host, so the browser never talks to port 8787. The Kubernetes manifest in `deploy/k8s/web.yaml` puts it behind the nginx ingress with a Let's Encrypt certificate, and `deploy.ps1` builds, pushes and fills in the host name (`-Hostname`, `rk.hangaraddons.com` by default).

The relay is one worldwide room, so the page lists pilots rather than separate sessions. Map tiles come from OpenStreetMap and Leaflet from unpkg, so visitors' browsers contact both.
