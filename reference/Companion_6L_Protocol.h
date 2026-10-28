#pragma once

#include <cstdint>
#include <cstddef>

namespace rk {

constexpr std::uint32_t kTelemetryMagic = 0x31544B52u;
constexpr std::uint32_t kTelemetryVersion = 1u;
constexpr char kTelemetryAreaName[] = "RK_TACTICAL_AUDIO_TELEMETRY_V1";
constexpr std::uint32_t kMultiplayerMagic = 0x31504D52u;
constexpr std::uint32_t kMultiplayerVersion = 3u;
constexpr std::size_t kMaxMultiplayerContacts = 32u;
constexpr char kMultiplayerAreaName[] = "RK_TACTICAL_MULTIPLAYER_CONTACTS_V3";
constexpr std::uint32_t kCompanionStatusMagic = 0x31534B52u;
constexpr std::uint32_t kCompanionStatusVersion = 1u;
constexpr char kCompanionStatusAreaName[] = "RK_TACTICAL_COMPANION_STATUS_V1";
constexpr std::uint32_t kCombatMagic = 0x31434B52u;
constexpr std::uint32_t kCombatVersion = 2u;
constexpr char kCombatOutAreaName[] = "RK_TACTICAL_MULTIPLAYER_COMBAT_OUT_V2";
constexpr char kCombatInAreaName[] = "RK_TACTICAL_MULTIPLAYER_COMBAT_IN_V2";

constexpr std::uint32_t kCombatFlagLocalTarget = 1u;

enum class CombatEventType : std::uint32_t {
    None = 0,
    Launch = 1,
    End = 2,
    Hit = 3,
    Countermeasure = 4,
    VisualUpdate = 5,
    Explosion = 6
};

#pragma pack(push, 1)
struct TacticalTelemetryV1 {
    std::uint32_t magic;
    std::uint32_t protocolVersion;
    std::uint32_t messageSize;
    std::uint32_t publishSequence;
    std::uint32_t launchSequence;
    std::uint32_t activeEnemyMissiles;
    std::uint32_t enemyMissileTypeMask;
    std::uint32_t reserved;
};

struct MultiplayerContactV1 {
    std::uint32_t idHash;
    std::uint32_t flags;
    double latitude;
    double longitude;
    double altitudeFt;
    float headingDeg;
    float speedKts;
    char displayName[32];
    char aircraftTitle[48];
};

struct MultiplayerSnapshotV1 {
    std::uint32_t magic;
    std::uint32_t protocolVersion;
    std::uint32_t messageSize;
    std::uint32_t sequence;
    std::uint32_t contactCount;
    std::uint32_t reserved;
    MultiplayerContactV1 contacts[kMaxMultiplayerContacts];
};

struct CompanionStatusV1 {
    std::uint32_t magic;
    std::uint32_t protocolVersion;
    std::uint32_t messageSize;
    std::uint32_t sequence;
    std::uint32_t processRunning;
    std::uint32_t relayConnected;
};

struct MultiplayerCombatEventV1 {
    std::uint32_t magic;
    std::uint32_t protocolVersion;
    std::uint32_t messageSize;
    std::uint32_t sequence;
    std::uint32_t eventType;
    std::uint32_t weaponType;
    std::uint32_t sourceContactId;
    std::uint32_t targetContactId;
    std::uint32_t weaponId;
    std::uint32_t flags;
    double latitude;
    double longitude;
    double altitudeFt;
    float headingDeg;
    float damage;
    float durationSeconds;
    float missDistanceFt;
};
#pragma pack(pop)

static_assert(sizeof(TacticalTelemetryV1) == 32,
    "The WASM and companion telemetry layouts must remain identical.");
static_assert(sizeof(MultiplayerContactV1) == 120,
    "The relay, companion and WASM contact layouts must remain identical.");
static_assert(sizeof(MultiplayerSnapshotV1) == 3864,
    "The multiplayer snapshot must remain below the SimConnect 8K limit.");
static_assert(sizeof(CompanionStatusV1) == 24,
    "The companion and WASM status layouts must remain identical.");
static_assert(sizeof(MultiplayerCombatEventV1) == 80,
    "The companion, WASM and relay combat layouts must remain identical.");

struct UserAircraftState {
    double latitude = 0.0;
    double longitude = 0.0;
    double altitudeFt = 0.0;
    double headingDeg = 0.0;
    double speedKts = 0.0;
    char aircraftTitle[256]{};
};

} // namespace rk
