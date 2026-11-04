# RK Tactical Companion (Python)

The Companion that ships with the panel from 2.0.0 on. It is a Windows console app written in Python, built into a single exe with PyInstaller. It reads the pilot's aircraft from SimConnect, sends it to the relay, and hands the other pilots to the panel through the same SimConnect client data areas as before. The older C++ Companion (1.5.4) is still in `companion/`.

`app/` is the source, with websockets vendored in `app/vendor`. `app/tests` holds two checks that run against a local fake relay and a simulated SimConnect.

## Building

Needs 64 bit Python 3.10 to 3.14 on Windows.

```powershell
.\companion-python\Release-Companion.ps1
```

This runs both tests, builds `RELEASE/RKTacticalCompanion.exe`, checks it loads on its own, and writes `dist/RKTacticalCompanion-<version>.zip` with its `.sha256`. The version is `VERSION` in `app/companion.py`. Then run `tools\Update-BundledCompanion.ps1` to put the exe in both panel packages.
