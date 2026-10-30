Companion for the RK Tactical Panel. Extract the zip, set `display_name` in `companion.ini`, start MSFS, then run `RKTacticalCompanion.exe`.

Connects to the shared RK relay at rk.hangaraddons.com. Live pilots and recent flights are at https://rk.hangaraddons.com.

The app isn't code signed yet, so Windows SmartScreen will ask you to choose More info, then Run anyway. The SHA256 file lets you check the download.

Changes in 1.5.1: combat events and your position go out on their own thread, so launches reach other pilots in a few milliseconds. Reconnecting after a relay restart is smarter and a silent connection is dropped and retried. Data from the relay is validated before it reaches the simulator, and `relay_url` has to be `ws://` or `wss://`.

Changes in 1.5.2: the Companion can run on a different PC from MSFS (set `simconnect_host` in `companion.ini` and see the player README), and the first run asks for your pilot name. Press N to change it later.

Changes in 1.5.3: if someone is already using your name you are given the same name with a number added, and the Companion tells you.
