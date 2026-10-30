# RK Tactical Companion 1.5 Shared Weapons and VFX

This is a separate Windows x64 SimConnect application. It provides stable
single-player warning audio and the online multiplayer transport for the RK
Tactical Panel.

## What works in this revision

- Reads incoming-missile warning telemetry from the revision 6D-6F WASM.
- Plays `enemy_missile_launch.wav` once for every enemy launch.
- Loops `enemy_missile_in_air_loop.wav` only while at least one enemy missile
  is active.
- Uses Windows XAudio2 with frequency ratio 1.0. The sound is not attached to
  an aircraft and cannot change with view direction, altitude or Doppler.
- Runs warning audio independently of relay availability.
- Automatically joins the single RK global network whenever the EXE is running
  and `relay_url` has been set by the package publisher.
- Sends the user's current latitude, longitude, altitude, heading, speed and
  aircraft title.
- Publishes the nearest 32 live RK contacts to the WASM. They appear as cyan
  directional icons on page 2
  with an RK player ID, altitude, speed and heading in the hover readout.
- Routes AIM-120, AIM-9, tracer, chaff and flare events between the WASM and
  relay protocol 3.
- Carries AIM-120/AIM-9 launch and ten-Hz position updates so receiving WASM
  modules can publish hostile missile icons and create synchronized visual
  missile proxies.
- Carries tracer launches, countermeasure VFX and missile-airburst locations so
  connected players see the same weapons and effects in their own simulator.
- Delivers incoming multiplayer launch/end/hit events to the local WASM so the
  existing warning audio, warning bands, engine shutdown and fire effects are
  used on the targeted player's own simulator.
- Publishes `RK_TACTICAL_COMPANION_STATUS_V1` once per second even when the
  relay is unavailable. The revision 6I panel uses this heartbeat to hide its
  Page 2 startup notice only while this EXE is genuinely connected to MSFS.

Protocol 3 enables shared weapon objects and VFX. It is intentionally
incompatible with older relays and companions so a tracking-only installation
cannot silently join this test.

## Build

1. Install the MSFS 2020 or MSFS 2024 SDK and Visual Studio 2022 C++ tools.
2. Open `RKTacticalCompanion.sln`.
3. Select `Release` and `x64`.
4. Build the solution.

Alternatively, double-click `BUILD_RELEASE.bat` after installing the required
SDK and Visual Studio C++ workload.

The project searches both `MSFS2024_SDK` and `MSFS_SDK` for SimConnect headers
and libraries. The output folder is `bin/Release`. Its post-build step copies
the Audio folder, `companion.ini`, and the matching SDK `SimConnect.dll` beside
the EXE. The project links the Windows SDK import library `xaudio2.lib`.

## Starting and stopping multiplayer

The package publisher must place the public relay's `wss://` address in
`companion.ini` before distributing the companion. After that, starting the
EXE automatically joins the one global RK network. Do not run the EXE when
multiplayer should be disabled. There is no room name or multiplayer switch
for end users.

The companion reconnects automatically if MSFS, the flight or the network is
restarted. Warning audio still works if the relay is temporarily unavailable.

- Press `L` to test the launch voice.
- Press `M` to toggle the active-missile warning for testing.
- Press `Q` to exit.

The revision 6L panel requires capability 537 and Relay Server 1.3. Every user
must run this Companion 1.5 build. The console confirms the number of
multiplayer tracks successfully published into SimConnect.

## Local relay test

1. In `RelayServer`, run `npm install`, then `npm start`.
2. Temporarily set `relay_url=ws://127.0.0.1:8787` when both clients are on the
   same PC.
3. For different PCs on a LAN, replace `127.0.0.1` with the relay PC address.
4. Give each client a different `display_name`; `player_id` may remain blank.

For Internet use, the package publisher hosts the RelayServer once and embeds
its `wss://` address in every distributed companion. Individual players do not
run a relay or choose a room.

## Changes in 1.5.1

- Sending and receiving run on separate threads. Combat events leave within a few milliseconds instead of waiting for the next incoming message, and your position goes out at a steady 10 Hz.
- Reconnects back off from 1 to 30 seconds with some jitter, so a relay restart isn't hit by every Companion at once. A silent connection is dropped after 15 seconds and reconnected.
- Snapshots from the relay are validated. Contacts with impossible positions are dropped and their names are always terminated. Combat events are range checked before they reach the simulator.
- `relay_url` must start with `ws://` or `wss://`. Names are trimmed and capped, and a `player_id` that the relay would refuse is cleaned.

`tests/Run-NetSmoke.ps1` builds a small test that starts two clients against a relay, checks that they see each other and that a launch crosses, and with `-Reconnect` checks recovery after you restart the relay. It needs a relay on `ws://127.0.0.1:18787` by default.

## Changes in 1.5.2

- **MSFS on another PC.** Set `simconnect_host` (and `simconnect_port`, 500 by default) in `companion.ini` and the Companion writes a `SimConnect.cfg` beside the exe and connects over your network. Leave `simconnect_host` blank for MSFS on the same PC. A `SimConnect.cfg` the Companion didn't write is never touched or removed.
- **Pilot name in the app.** The first run asks for a name and saves it to `companion.ini`. Press `N` any time to change it, and the Companion reconnects with the new name.

### Running the Companion on a different PC

The Companion talks to MSFS through SimConnect, which works across a network. On the PC running MSFS, create a `SimConnect.xml` with an IPv4 endpoint and open its TCP port in the firewall:

```xml
<?xml version="1.0" encoding="Windows-1252"?>
<SimBase.Document Type="SimConnect" version="1,0">
  <Descr>SimConnect Server Configuration</Descr>
  <Filename>SimConnect.xml</Filename>
  <Disabled>False</Disabled>
  <SimConnect.Comm>
    <Descr>RK Tactical Companion (remote)</Descr>
    <Protocol>IPv4</Protocol>
    <Scope>global</Scope>
    <Address>192.168.1.50</Address>
    <Port>500</Port>
    <MaxClients>64</MaxClients>
    <MaxRecvSize>41088</MaxRecvSize>
    <DisableNagle>False</DisableNagle>
  </SimConnect.Comm>
</SimBase.Document>
```

Use the address of the MSFS PC. The file goes in the MSFS settings folder: for the Store or Xbox version of MSFS 2020 it's `%LOCALAPPDATA%\Packages\Microsoft.FlightSimulator_8wekyb3d8bbwe\LocalCache`, and for Steam it's `%APPDATA%\Microsoft Flight Simulator`. MSFS 2024 uses a similarly named folder. Restart MSFS after adding it, then set `simconnect_host` on the other PC to the same address.

Things to know:

- The warning sounds play on the PC running the Companion, so use that PC's speakers or headphones.
- SimConnect isn't encrypted. Use it on your own network or a VPN.
- The RK Tactical Panel still runs inside MSFS. Only the Companion moves.
- Remote mode hasn't been tested with MSFS yet.

`tests/Run-ConfigSmoke.ps1` checks the config behavior, including the `SimConnect.cfg` it writes and removes.

## Changes in 1.5.3

- If another pilot is already using your name, the relay gives you the same name with a number added, like `Maverick 2`, and the Companion tells you what you ended up with. The check ignores capitals and covers every replica. A pilot who reconnects keeps their name, and a name is free again once that pilot leaves.
