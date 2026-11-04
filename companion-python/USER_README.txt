RK Tactical Companion for Windows x64 - standalone EXE

1. Save RKTacticalCompanion.exe in a writable folder, such as a folder on Desktop.
2. Close any other running Tactical Companion.
3. Load your flight in MSFS and open the Tactical Panel.
4. Double-click RKTacticalCompanion.exe and enter your pilot name if asked.

No separate Python, DLLs or Audio folder are required.
The EXE unpacks its internal dependencies into a temporary folder while running.
On first use, it creates companion.ini and companion_id.txt beside itself.
companion.log is also written there. Keep these files for your own settings;
do not include your personal ID or settings when sharing the EXE with others.

The default relay is ws://rk.hangaraddons.com:8787.
To keep an existing configuration and pilot ID, copy companion.ini and
companion_id.txt from your previous companion beside the EXE before starting.
Q exits. L tests launch audio. M toggles the active missile warning test.
To rename yourself, close the app, edit display_name in companion.ini and reopen.
For a separate simulator PC, configure simconnect_host and simconnect_port.

The source's networking, telemetry, combat and audio logic are unchanged by
this packaging update. Check the built EXE with your simulator before release.
