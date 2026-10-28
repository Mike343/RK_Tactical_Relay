# Why the Go server exists, and what was preserved

## Baseline

The archived August 23 `RKTacticalPanel_shell_6L_shared_weapons_vfx` package includes `RKTacticalCompanion/RelayServer/server.js` using **Protocol 3** and C++ `Protocol.h` from Companion 1.5. Unlike the earlier Node server 1.1, it already implements combat weapon relay with target-directed hit delivery and a 250-ms broadcast cadence.

The August 25 `RKTacticalRelay_1.4.0-test3_Windows_x64` README describes the standalone Go relay. That release contains a compiled EXE but **not** its Go source.

## Deficiencies in the 6L Node relay addressed here

1. **Operational dependency:** Node.js and npm are required for the Node server; the new Go program compiles to a single native binary.
2. **Configuration:** the Node server reads `PORT`; the new server reads the existing `relay.ini` values, with optional `PORT` override.
3. **Dashboard:** the Node server exposes only `/health`; the Go rebuild adds a local administrative dashboard, `/api/stats`, player table, green connection indicator, combat counters, recent logs, local/LAN/Internet URL suggestions.
4. **Access control:** the Node relay has no administrative route; new routes disclose client IPs and thus require loopback-only access.
5. **Release maintainability:** version 3 had no delivered source; this source includes tested, reproducible Windows and Linux builds.

## Behavior deliberately preserved

- Same network name, WebSocket URL syntax, valid client identities, duplicate-ID reconnection, protocol handshake/error.
- Exact little-endian fixed-size contact snapshot layout and field offsets, 32-contact maximum, FNV-1a hash.
- 100-ms state throttle, ten-second state timeout, contact distance sorting, 250-ms snapshot cadence.
- Same combat numeric input ranges, source-contact calculation, event/weapon enumerations, no echo back to sender, target-only HIT delivery and local-target flag.
- Five-second heartbeat, public health endpoint and logging of non-UPDATE lifecycle events.

## Intentional implementation differences / test gates

- The original Go 1.4.0-test3 HTML/CSS and internal counter implementation are unavailable; dashboard rebuilt from the published feature descriptions.
- A new standard-library WebSocket transport is used instead of the original Gorilla dependency. It has local wire tests, but further interoperability / load testing is warranted before production.
- Exact wording and serialization ordering of JSON may differ. Companion 1.5's parser searches by JSON field names rather than requiring a specific field order.
- The Go counter `RemoteConfirmed` persists after the first non-private remote connection, as described in test3 release notes.
- Builds produced here are NOT certified for public replacement until tested with existing MSFS Companions.
