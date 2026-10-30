RK Tactical Companion

This is the Windows helper for the RK Tactical Panel. It plays the missile warning sounds and connects you to the shared RK multiplayer room, so you can see other pilots and fight them.

Setup

1. Extract this folder anywhere you can write to, like your Documents or Desktop. Don't put it in Program Files.
2. Open companion.ini in Notepad and set display_name to the name other pilots will see.
3. Start Microsoft Flight Simulator and load a flight.
4. Run RKTacticalCompanion.exe. Leave its window open while you fly. Close it or press Q to leave multiplayer.

Windows may warn that the app is from an unknown publisher the first time. Choose More info, then Run anyway. The app isn't signed yet.

What you will see in the window

"Multiplayer relay connected" means you are in the room.
"RK multiplayer contacts" is how many other pilots are near you. It stays at 0 until someone else is flying.
"SimConnect connected" means it found the simulator.

Keys: L tests the launch warning, M turns the active missile warning on and off, Q quits.

If it doesn't connect

Check that relay_url in companion.ini is the address you were given, and that your firewall allows the app out. If your network blocks port 8787, ask for the encrypted wss:// address and use that instead.

Everyone has to run the same Companion version. Live pilots and recent flights are shown at https://rk.hangaraddons.com.

Your pilot name

The first time you run it, the window asks what name other pilots should see. Press N any time to change it. It is saved in companion.ini.

Running it on a different PC

If you want MSFS to have the whole PC to itself, you can run the Companion on a second PC on your network. The RK Tactical Panel stays in MSFS and only the Companion moves.

1. On the PC running MSFS, copy SimConnect.xml.example into the MSFS settings folder and rename it SimConnect.xml. For the Store or Xbox version of MSFS 2020 that folder is %LOCALAPPDATA%\Packages\Microsoft.FlightSimulator_8wekyb3d8bbwe\LocalCache, and for Steam it is %APPDATA%\Microsoft Flight Simulator. MSFS 2024 uses a similarly named folder.
2. Open the file and set Address to the IPv4 address of the MSFS PC. Allow the port (500 by default) through that PC's firewall, then restart MSFS.
3. On the PC running the Companion, set simconnect_host in companion.ini to the same address.

The warning sounds play on the PC running the Companion, so use its speakers or headphones. SimConnect isn't encrypted, so only do this on your own network or a VPN.

Names

Every pilot name on the server is unique. If someone is already using yours, the server adds a number, like Maverick 2, and the window tells you the name you got.
