OBSOLETE SHARED STAGING DIRECTORY - REVISION 6M

Neither package definition reads this directory anymore.

MSFS 2020 now stages to PackageSources/modules2020.
MSFS 2024 now stages to PackageSources/modules2024.

This separation prevents an MSFS 2024 WASM from entering the MSFS 2020
package. Do not copy RKTacticalSpawner.wasm into this old directory.

HISTORICAL INSTRUCTIONS FOLLOW

REQUIRED MSFS 2024 WASM BUILD

This source archive intentionally excludes the rejected prebuilt WASM. A new
RKTacticalSpawner.wasm must be created before building rk-tactical-panel-24.

1. Open RKTacticalSpawner.sln in Visual Studio.
2. Select Configuration: Release and Platform: MSFS.
3. Choose Build > Rebuild Solution.
4. This primary solution always uses PlatformToolset MSFS2024.
5. The post-build command automatically replaces this file:
     PackageSources/modules/RKTacticalSpawner.wasm
6. Confirm the file has the new build timestamp.
7. Build rk-tactical-panel-24 with the MSFS 2024 package tool.

The finished module publishes RK_TAC_COUNTERMEASURE_CAPABILITY=510 and
RK_TAC_AI_WARP_CAPABILITY=534. It calls
fsVfxSpawnOnSimObject for user SimObject ID 0. The MSFS2024 platform toolset
automatically links the MSFS_WasmVersions library required by MSFS 2024.

Revision 5L also reads each AI contact's aircraft TITLE and AGL. After a
successful warp it creates a locally controlled copy at the old position,
drives the copy to its measured ground elevation, and repeatedly attempts to
attach RKAircraftFire GUID E0DD3395-F7A1-5BCC-BC5F-466E5FD99BBD after the
model loads. If root attachment remains unavailable, a world-space VFX is
moved with the aircraft. The accompanying RK Aircraft Fire Effect package must
be built and installed.

Revision 5M routes page-2 weapon launches through target-kind and SimConnect
object-ID LVars. Missiles refresh moving AI coordinates throughout flight;
tracers accumulate damage only when their straight path intersects the
designated AI contact. That 5M source introduced capability 513 so an older 5L
WASM could not silently receive the new payload. The current 5U source
supersedes that handshake with capability 521 as described below.

Revision 5N removes the post-assignment missile hold, moves the new missile to
the current aircraft position plus 20 metres forward before engine start, and
spawns Industrial Explosion GUID FF3BADD5-6D0C-4A79-B250-547AE4D639B6 at a
successful proximity-fuse coordinate. The Industrial Explosion 24 VFX package
must be installed for that airburst to resolve.

Revision 5O gives page-2 locked/designated AI contacts a directional
altitude-color symbol and heading-matched outline. Rendered Tracers_rk objects
remain visible for a fixed 1.25 seconds while their visual path length scales
with inherited aircraft speed. Their independent 3,000 ft/s, 1,200-foot
collision path is unchanged.

Revision 5P replaces the Clear All control with a single controlled F/A-18E
aggressor. It spawns 100 statute miles away, pursues the user and launches four
AIM-120 and four AIM9 test missiles inside their existing 80/20-mile ranges.
Incoming target kind 3 follows the user but cannot write damage. The aggressor
is published as traffic role 1 for its pink map symbol and remains lockable and
destructible through the existing AI-traffic damage path.

Revision 5Q restores Clear All on page 1 and makes Aggressor page-2-only.
MSFS 2024 now calls SimConnect_EnumerateSimObjectsAndLiveries before creation,
then uses the returned spawnable F/A-18E container title and livery. The MSFS
2020 fallback list begins with Boeing F/A 18E Super Hornet Asobo. Failure
messages distinguish an active aggressor from a missing preset.

Revision 5R responds to SimConnect exception 22 by staging F/A-18E creation at
20 statute miles and 300 knots. After assignment, the existing client position
controller moves the object to the required random 100-mile start before it is
published or acknowledged. An enumerated preset that is still rejected is now
reported as creation failure rather than preset missing.

Revision 5S corrects the MSFS 2024 multi-packet preset enumeration. The list
handler now compares the zero-based packet index in dwEntryNumber with the
packet count in dwOutOf; it no longer uses dwArraySize, which is the number of
aircraft entries in the current packet. Compact FA18/F18 container titles are
also accepted. The current source therefore supersedes the 5R handshake with
capability 519.

Revision 5T increases AIM9 speed to 1,100 mph and keeps each rendered missile
on the same live altitude and pitch used by its three-dimensional fuse path.
It publishes a sequence for successful enemy launches and an active incoming
missile count. The panel uses those LVars to play the optional one-shot and
looping WAV files in its TacticalPanel/Sounds folder. Capability 520 prevents
the new panel from running with an older guidance/audio WASM.

Revision 5U uses absolute `html_ui` paths for both existing WAV files and
primes their HTML media elements during a real panel click. It also applies
relative-altitude color to a selected aggressor and reduces rendered missile
corrections from 0.15 to 0.05 seconds. Harmless target-kind-3 guidance projects
the user's current ground-speed/heading and vertical speed 0.20 seconds ahead,
reducing pursuit of a stepped, trailing sample. Capability 521 prevents the
updated panel from running with the older guidance WASM.

Revision 5V makes incoming target-kind-3 missiles operational for this test
mode. AIM-120 tests each eligible chaff cloud once at 85%. AIM-9 tests each
eligible flare once at 90% front aspect or 70% rear aspect. A successful roll
commits that missile to the decoy without reacquisition. A missile reaching the
user transmits ENGINE_AUTO_SHUTDOWN and attaches RKAircraftFire until the
engines have stopped and one is restarted.

Revision 5V also replaces the unsuccessful toolbar HTML-audio route with an
invisible native soundai SimObject built from the new
EnemyMissileAlertSound asset group. One variation plays the launch WAV; the
other loops the in-air warning while target-kind-3 missiles are active. Build
the package after copying the new WASM so FSPackageTool compiles and installs
this SimObject and its soundai folders. Capability 522 prevents the new panel
from accepting the older WASM.

Revision 5W publishes RK_TAC_ENEMY_MISSILE_TYPE_MASK. Bit 0 means an active
incoming AIM-120 and bit 1 means an active incoming AIM-9. The panel uses this
mask for a one-pixel flashing border: yellow for radar, red for heat, and
alternating colors when both are present.

Both soundai variations now force unity pitch, full volume, centered panning
and zero distance attenuation. Their carrier is positioned with the user's
current heading and ground speed rather than a fixed 100 knots. The launch WAV
is dynamically raised by approximately 4.8 dB average level and limited below
clipping. Capability 523 prevents the 5W panel from using a 5V WASM that does
not publish the type mask.

Revision 5X draws that type mask as a one-pixel canvas border, avoiding CSS
keyframe failures in detached toolbar windows. Native alert sound carriers are
created at the user's live coordinate and then frozen; the old quarter-second
position stream is removed so source-velocity steps cannot modulate the WAVs.
The launch WAV averages approximately -6.5 dB and peaks at -0.9 dB.

The module also upserts its controlled aggressor into every published traffic
list. Empty/partial scans and transient position-correction failures no longer
erase a still-flying F/A-18 contact. If an explicit removal is rejected, the
controller/contact remains active and targetable. Capability 524 prevents the
5X panel from accepting a 5W WASM without these corrections.

Revision 5Y corrects the severe slowdown caused by the frozen 5X sound source.
Both native alert carriers start with the user's live ground speed and are
placed at the live user coordinate on every user-aircraft frame. This removes
the Doppler separation without restoring the former quarter-second stepping.
The canvas warning stroke is increased from one to three pixels. Capability
525 prevents the 5Y panel from accepting a 5X WASM with frozen carriers.

Revision 5Z removes the carrier-axis freeze so the audio engine receives the
live velocity written on each frame. Both soundai definitions are cockpit-only
and explicitly use centered panning, 360-degree full-volume cones and a
one-million-metre full-scale distance.

Chaff is visible for 3 seconds and effective for 2 seconds. Flare core/smoke
particles last 1.75/2.25 seconds and flare capture lasts 1.25 seconds. A decoy
normally captures one missile; another may share it only inside a 0.20-second,
250-foot chaff packet or 125-foot flare packet. Capabilities 510 and 526 prevent
the 5Z panel from accepting older countermeasure/audio behavior.

Revision 6A restores ViewPoint=All for both AI-carrier sound definitions.
ViewPoint=Inside selected the invisible carrier's own cockpit and suppressed
the warnings for the user. All 5Z attenuation, carrier-motion and
countermeasure limits remain unchanged. Capability 527 identifies the corrected
panel/WASM/package combination.

Revision 6B preserves the exact MSFS 2024 enumerated F/A-18 container title
and livery when creating the destroyed falling copy. Aircraft fire uses the
world-space following VFX as its primary path and root attachment as fallback.
The aggressor is limited to 400-700 knots, accelerates at no more than 20 knots
per second, and turns at no more than 8 degrees per second. Capability 528
identifies this fire/aggressor revision. Native alert sound carriers are
unchanged because they remain spatial AI emitters.

Revision 6C removes the native missile-alert sound carriers and all active
sound-carrier creation/removal code. The panel now uses a solid three-pixel
on/off yellow or red threat band, a six-pixel inward fade, and a five-second
flashing red launch message. Capability 529 identifies this visual-only
warning revision.

Revision 6D adds the read-only RK_TACTICAL_AUDIO_TELEMETRY_V1 SimConnect
client-data area used by RKTacticalCompanion.exe. It publishes only fixed-size
numeric warning telemetry; the external application plays the WAVs through
Windows XAudio2. Capability 530 identifies the required bridge revision.

Revision 6F separates the AIM-9's 20-mile launch range from a 40-mile maximum
travel distance and changes destroyed traffic from a fixed-coordinate fall to
a mild 60-140-knot spiral with a corrected positive nose-down pitch command.
Capability 531 identifies this flight-behavior revision. The companion
telemetry and multiplayer snapshot layouts are unchanged.

Revision 6G adds a two-aircraft Tu-95 formation to the first successful
aggressor spawn. Both bombers are independently selectable/damageable role-3
contacts, fly at 32,000 feet and 420 mph on heading 225 true, and use the
existing model-matched falling/fire path when destroyed. Capability 532
identifies the new controlled-contact role and requires this WASM rebuild.

Revision 6H replaces the Tu-95 10 Hz INITPOSITION correction stream with
simulator-native 500-mile AI waypoint legs. Per-frame telemetry remains active
for the map and weapon targets, but it never drives the rendered aircraft.
Capability 533 identifies the native-flight revision and requires this WASM
rebuild. The F/A-18E aggressor retains its separate 20 Hz pursuit controller.

Revision 6I subscribes to the companion's
RK_TACTICAL_COMPANION_STATUS_V1 client-data area and publishes the fresh state
as RK_TAC_COMPANION_ALIVE. A packet is fresh for three simulation seconds.
Capability 534 identifies the companion-status bridge and requires the matched
panel, WASM and companion builds.

For MSFS 2020, close this solution and open RKTacticalSpawner2020.sln instead.
