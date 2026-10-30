# RK Tactical Panel

This is the in sim half of RK Tactical, the MSFS 2024 package in `rk-tactical-panel-24/`. It was created by `=rk=`, who is happy for it to be hosted here. Copy the folder into the MSFS Community folder to use it.

It holds the toolbar panel (`html_ui/InGamePanels/TacticalPanel`), the WASM module (`modules/RKTacticalSpawner.wasm`), and all the SimObjects, effects and scenery the panel spawns: AIM-120 and AIM-9 missiles, flares and chaff, a HARM, bombs, tracers, ground vehicles, air defense and more. It also carries a copy of the Companion in `copy/Tactical Companion.zip`.

## What can be edited here

- **The panel UI** is plain files: `TacticalPanel.js`, `TacticalPanel.html` and `TacticalPanel.css`. Edit them like any code.
- **Configs and definitions** (`.cfg`, `.xml`, `.json`, `.flt`) are text too.
- **`RKTacticalSpawner.wasm` is a built file.** Its C++ source (`RKTacticalSpawner.sln`) isn't in this package, so changes to weapons, guidance and damage logic need that project from `=rk=`. Until then the WASM can be replaced but not edited.
- Models, textures and sounds are large binaries and are stored with Git LFS.

## After you change anything

MSFS reads `layout.json` to know which files are in the package, with their sizes. If you add, remove or edit a file, regenerate it:

```powershell
.\tools\Update-PanelLayout.ps1
```

That also fixes `total_package_size` in `manifest.json`. Then run the compatibility check:

```powershell
.\tools\Check-PanelCompatibility.ps1
```

## How it fits with the Companion

The panel and the Companion talk through SimConnect client data areas. The names carry a version, so a mismatch means the pair won't work together. The check reads the Companion's `companion/src/Protocol.h` and confirms the WASM uses exactly the same areas:

| Data area | Direction | What it carries |
|---|---|---|
| `RK_TACTICAL_AUDIO_TELEMETRY_V2` | panel to Companion | Missile warning state, team, flight and detected contacts |
| `RK_TACTICAL_MULTIPLAYER_CONTACTS_V4` | Companion to panel | The 32 nearest pilots from the relay |
| `RK_TACTICAL_COMPANION_STATUS_V1` | Companion to panel | A heartbeat, so the panel knows the Companion is running |
| `RK_TACTICAL_MULTIPLAYER_COMBAT_OUT_V3` | panel to Companion | Launches, hits and effects to send to other pilots |
| `RK_TACTICAL_MULTIPLAYER_COMBAT_IN_V3` | Companion to panel | Events other pilots caused, for this panel to show |

If you change a layout on one side, bump the version in the area name on both sides and rebuild both. The check will fail until they agree.

The check also confirms the bundled Companion in `copy/` is the same version as `companion/src/Version.h` and points at the same relay.

## Updating the bundled Companion

After a new Companion release, refresh the copy inside the panel:

```powershell
.\tools\Update-BundledCompanion.ps1
```

It repackages the newest `companion/dist/RKTacticalCompanion-*.zip`, replaces `copy/Tactical Companion.zip`, and updates `layout.json`.

## Making a release

```powershell
.\tools\Build-AddonPackage.ps1
```

This builds the Companion, bundles it into the panel, runs the compatibility check and writes the panel zip, the Companion zip and its `.sha256` into `dist/addon`. Upload those to the addon.

## Working with the repo

The big files use Git LFS, so run `git lfs install` once. A full clone pulls about 1.9 GB of assets. If you only want the code, clone with `GIT_LFS_SKIP_SMUDGE=1` and the heavy files stay as small pointer files.
