# RK Tactical Relay — rebuildable Go source (Protocol 3)

This is a **new Go implementation** of the RK Tactical Relay, reconstructed from the project's archived, owned Node.js revision 6L server, the corresponding Tactical Companion 1.5 protocol header, and the documented operational behavior of the August 25, 2026 Go `1.4.0-test3` release.

**It is NOT the recovered original August 25 Go source**, nor a proven bit-for-bit equivalent. It is maintainable replacement source with end-to-end protocol tests. Do not replace a live distributed multiplayer server until tested against actual currently-distributed RK Tactical Companions.

## Source files

- `main.go`: configuration, HTTP/WebSocket server, protocol 3, combat and aircraft state routing, snapshots, heartbeat, logging, local/Internet address discovery.
- `websocket.go`: RFC 6455 uncompressed WebSocket server transport implemented with the Go standard library only (no external or unpublished packages needed). Masked client frames, ping/pong, close, fragment assembly, size limits.
- `dashboard.go`: localhost-only `/dashboard` and `/api/stats`; green connected-client light; player roster, counters, IPs, and logs.
- `main_test.go`: repeatable protocol, snapshot, hash, expiration, and admin-access tests.
- `integration_test.py`: optional two-Companion wire-simulation test using Python `websocket-client`.
- `reference/RelayServer_6L_Protocol3.js` and `reference/Companion_6L_Protocol.h`: original protocol references included for audit. The reference materials are not required to compile.

## Requirements

Install Go 1.22 or later on Windows or Linux. No external Go packages, Node.js runtime, MSFS installation, or SDK are needed to build/host the relay.

### Windows x64

Run `BUILD_WINDOWS.cmd` or:

```bat
set GOOS=windows
set GOARCH=amd64
set CGO_ENABLED=0
go build -trimpath -o RKTacticalRelay.exe .
```

Place `relay.ini` beside the EXE and run it. The dashboard opens in the server PC browser when `open_dashboard=true`.

### Linux x64

```sh
sh BUILD_LINUX.sh
./RKTacticalRelay
```

Place `relay.ini` beside the binary. No local browser is launched on headless Linux. Access `/dashboard` only through an SSH tunnel to the server's loopback interface.

### Configuration

```ini
[relay]
port=8787
open_dashboard=true
public_ip_lookup=true
```

For a local test instance, set the `PORT` environment variable to a different port (e.g., `PORT=18787`), leaving your existing public relay untouched. Keep 8787 for production if you want existing Companion configurations to work unchanged.

## Client compatibility contract

Preserved from archived Node.js revision 6L and Companion 1.5 source:

| Contract item | Value |
|---|---|
| WebSocket | uncompressed text JSON inbound; binary snapshots / JSON combat events outbound |
| Hello | `{"type":"hello","protocol":3,"id":"pilot-id","name":"Pilot Name"}` |
| Welcome | `{"type":"welcome","protocol":3,"id":"pilot-id","network":"rk-tactical-global"}` |
| Multiplayer network | `rk-tactical-global` (one worldwide room) |
| Binary snapshot magic | `0x31504D52` little endian |
| Binary protocol | 3 |
| Snapshot length | 3864 bytes |
| Header | 24 bytes |
| Contact record | 120 bytes |
| Contacts per viewer | 32 nearest live other pilots, state expiry 10 seconds |
| Contact hash | FNV-1a 32-bit of UTF-8 player ID |
| Combat source ID | `0x60000000 | (hash & 0x0fffffff)` |
| Combat events | 1 launch, 2 end, 3 hit, 4 countermeasure, 5 visual update, 6 explosion |
| Combat delivery | Hit (`event=3`) goes **only** to target; other events fan out to all other pilots |
| Local-target flag | Low bit set on combat messages sent to the selected target |
| State acceptance limit | At most one state update per 100 ms per player |
| Snapshot cadence | Every 250 ms, plus immediate broadcast on connect/disconnect |
| Heartbeat | Server ping every 5 seconds; disconnect after missing pong |
| Max players | 1,024 (historical upper bound, **not** capacity-tested) |
| Max inbound message | 16 KiB |

### Public endpoints

- `/` accepts the Companion WebSocket upgrade. (Like the original Node server, upgrades on other unreserved paths also work.)
- `/health` returns basic JSON status and protocol 3 without revealing player details.
- `/dashboard` and `/api/stats` **require a loopback remote socket address**; they are not accessible from ordinary remote clients, even on a private LAN. Use SSH tunneling / VPN to access safely from elsewhere.

### Dashboard

A **green light** illuminates when at least one Companion has completed its Protocol 3 handshake. It goes dark when no clients remain. The dashboard additionally displays `REMOTE CONNECTION CONFIRMED` after a publicly addressed client completes an accepted handshake.

## Known limitations and safety

- This is a **new implementation**. It has not yet been tested against actual installed MSFS 2020/2024 Companions on separate PCs.
- The legacy `ws://` endpoint is unencrypted and does not authenticate players cryptographically. It preserves the distributed client's behavior; server hardening for the public interface should be planned without unexpectedly rejecting clients.
- No claim of full version 3 HTML/dashboard visual identity. Operational dashboard functions have been recreated.
- Dashboard `memory_mib` is the Go heap, not total OS working set; no precise CPU % is sampled. All connections remain in-memory, not durable through server restarts.
- Do not run both the old and the new server on the same TCP port. To compare them, run a staging instance on a separate port.
- The only way to establish full replacement compatibility is to test representative actual Companion versions and live aircraft/combat sessions against a staging instance before replacing the existing service.

## Verification performed

- `go test -count=1 -v ./...` — passed.
- `go vet ./...` — passed.
- `go test -race ./...` — passed.
- `python integration_test.py` — passed in a local test: health, two WebSocket handshakes, exact 3864-byte binary snapshot, FNV contact hash, 2-client combat launch/hit routing, dashboard stats, protocol 1 rejection.
- `GOOS=windows GOARCH=amd64 go build` — successfully cross-compiled a Windows x64 executable.

For auditing, compare `reference/RelayServer_6L_Protocol3.js` and `reference/Companion_6L_Protocol.h` with `main.go` and the tests.
