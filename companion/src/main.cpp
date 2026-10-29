#include "AudioEngine.h"
#include "Config.h"
#include "MultiplayerClient.h"
#include "Protocol.h"
#include "Version.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <SimConnect.h>

#include <atomic>
#include <chrono>
#include <conio.h>
#include <cstdint>
#include <iomanip>
#include <iostream>
#include <thread>

namespace {

enum DefinitionId {
    DefinitionUserAircraft = 1,
    DefinitionTacticalTelemetry = 2,
    DefinitionMultiplayerSnapshot = 3,
    DefinitionCompanionStatus = 4,
    DefinitionCombatOut = 5,
    DefinitionCombatIn = 6
};

enum RequestId {
    RequestUserAircraft = 1,
    RequestTacticalTelemetry = 2,
    RequestCombatOut = 3
};

enum ClientDataId {
    ClientDataTacticalTelemetry = 1,
    ClientDataMultiplayerSnapshot = 2,
    ClientDataCompanionStatus = 3,
    ClientDataCombatOut = 4,
    ClientDataCombatIn = 5
};

struct AppState {
    rk::AudioEngine* audio = nullptr;
    rk::MultiplayerClient* multiplayer = nullptr;
    bool telemetryInitialized = false;
    bool telemetryReceived = false;
    bool dispatchReceived = false;
    std::chrono::steady_clock::time_point lastBattleTelemetry{};
    std::uint32_t lastLaunchSequence = 0;
    rk::UserAircraftState user{};
    bool userValid = false;
    bool simulatorQuit = false;
};

std::atomic<bool> g_stopRequested{false};
bool g_manualActiveWarningTest = false;
bool g_liveMissileActive = false;

void updateActiveWarning(rk::AudioEngine& audio) {
    audio.setMissileActive(
        g_manualActiveWarningTest || g_liveMissileActive);
}

BOOL WINAPI consoleControlHandler(DWORD control) {
    if (control == CTRL_C_EVENT || control == CTRL_CLOSE_EVENT
        || control == CTRL_BREAK_EVENT || control == CTRL_SHUTDOWN_EVENT) {
        g_stopRequested = true;
        return TRUE;
    }
    return FALSE;
}

void processTelemetry(AppState& app,
    const rk::TacticalTelemetryV1& telemetry) {
    if (telemetry.magic != rk::kTelemetryMagic
        || telemetry.protocolVersion != rk::kTelemetryVersion
        || telemetry.messageSize != sizeof(rk::TacticalTelemetryV1)) {
        return;
    }
    app.user.team=telemetry.team;app.user.flight=telemetry.flight;
    for(int i=0;i<32;++i)app.user.detectedPeers[i]=telemetry.detectedPeers[i];
    app.telemetryReceived = true;
    app.lastBattleTelemetry=std::chrono::steady_clock::now();
    app.audio->updateBattlefield(telemetry.reserved);
    const bool active = telemetry.activeEnemyMissiles > 0;
    g_liveMissileActive = active;
    if (!app.telemetryInitialized) {
        app.telemetryInitialized = true;
        app.lastLaunchSequence = telemetry.launchSequence;
        updateActiveWarning(*app.audio);
        std::cout << "WASM warning telemetry connected.\n";
        return;
    }
    if (telemetry.launchSequence != app.lastLaunchSequence) {
        app.lastLaunchSequence = telemetry.launchSequence;
        app.audio->playLaunch();
        std::cout << "WARNING -- MISSILE LAUNCH DETECTED\n";
    }
    updateActiveWarning(*app.audio);
}

void CALLBACK dispatchProc(SIMCONNECT_RECV* data, DWORD size, void* context) {
    (void)size;
    auto& app = *static_cast<AppState*>(context);
    app.dispatchReceived = true;
    switch (data->dwID) {
    case SIMCONNECT_RECV_ID_SIMOBJECT_DATA: {
        const auto* packet = reinterpret_cast<SIMCONNECT_RECV_SIMOBJECT_DATA*>(data);
        if (packet->dwRequestID != RequestUserAircraft) { break; }
        if(size<offsetof(SIMCONNECT_RECV_SIMOBJECT_DATA,dwData)+offsetof(rk::UserAircraftState,team))break;
        const unsigned char* src=reinterpret_cast<const unsigned char*>(&packet->dwData);
        unsigned char* dst=reinterpret_cast<unsigned char*>(&app.user);
        for(std::size_t i=0;i<offsetof(rk::UserAircraftState,team);++i)dst[i]=src[i];
        app.user.aircraftTitle[sizeof(app.user.aircraftTitle) - 1] = '\0';
        app.userValid = true;
        app.multiplayer->updateLocalState(app.user, true);
        break;
    }
    case SIMCONNECT_RECV_ID_CLIENT_DATA: {
        const auto* packet = reinterpret_cast<SIMCONNECT_RECV_CLIENT_DATA*>(data);
        if (packet->dwRequestID == RequestTacticalTelemetry) {
            if(size < offsetof(SIMCONNECT_RECV_CLIENT_DATA,dwData)+sizeof(rk::TacticalTelemetryV1)
                || packet->dwSize < offsetof(SIMCONNECT_RECV_CLIENT_DATA,dwData)+sizeof(rk::TacticalTelemetryV1)) break;
            const auto& telemetry = *reinterpret_cast<
                const rk::TacticalTelemetryV1*>(&packet->dwData);
            processTelemetry(app, telemetry);
        } else if (packet->dwRequestID == RequestCombatOut) {
            const auto& event = *reinterpret_cast<
                const rk::MultiplayerCombatEventV1*>(&packet->dwData);
            app.multiplayer->queueCombatEvent(event);
        }
        break;
    }
    case SIMCONNECT_RECV_ID_EXCEPTION: {
        const auto* exception = reinterpret_cast<SIMCONNECT_RECV_EXCEPTION*>(data);
        std::cout << "SimConnect exception " << exception->dwException
            << " send " << exception->dwSendID
            << " index " << exception->dwIndex << "\n";
        break;
    }
    case SIMCONNECT_RECV_ID_QUIT:
        app.simulatorQuit = true;
        break;
    default:
        break;
    }
}

bool configureSimConnect(HANDLE simConnect) {
    HRESULT hr = SimConnect_AddToDataDefinition(simConnect,
        DefinitionUserAircraft, "PLANE LATITUDE", "degrees");
    if (SUCCEEDED(hr)) {
        hr = SimConnect_AddToDataDefinition(simConnect,
            DefinitionUserAircraft, "PLANE LONGITUDE", "degrees");
    }
    if (SUCCEEDED(hr)) {
        hr = SimConnect_AddToDataDefinition(simConnect,
            DefinitionUserAircraft, "PLANE ALTITUDE", "feet");
    }
    if (SUCCEEDED(hr)) {
        hr = SimConnect_AddToDataDefinition(simConnect,
            DefinitionUserAircraft, "PLANE HEADING DEGREES TRUE", "degrees");
    }
    if (SUCCEEDED(hr)) {
        hr = SimConnect_AddToDataDefinition(simConnect,
            DefinitionUserAircraft, "GROUND VELOCITY", "knots");
    }
    if (SUCCEEDED(hr)) {
        hr = SimConnect_AddToDataDefinition(simConnect,
            DefinitionUserAircraft, "TITLE", nullptr,
            SIMCONNECT_DATATYPE_STRING256);
    }
    if (SUCCEEDED(hr)) {
        hr = SimConnect_RequestDataOnSimObject(simConnect,
            RequestUserAircraft, DefinitionUserAircraft,
            SIMCONNECT_OBJECT_ID_USER, SIMCONNECT_PERIOD_SIM_FRAME,
            SIMCONNECT_DATA_REQUEST_FLAG_DEFAULT, 0, 5, 0);
    }
    if (FAILED(hr)) { return false; }

    hr = SimConnect_MapClientDataNameToID(simConnect,
        rk::kTelemetryAreaName, ClientDataTacticalTelemetry);
    if (FAILED(hr)) { return false; }
    hr = SimConnect_AddToClientDataDefinition(simConnect,
        DefinitionTacticalTelemetry, 0,
        sizeof(rk::TacticalTelemetryV1));
    if (FAILED(hr)) { return false; }

    hr = SimConnect_MapClientDataNameToID(simConnect,
        rk::kMultiplayerAreaName, ClientDataMultiplayerSnapshot);
    if (FAILED(hr)) { return false; }
    // Default flags permit a new connection from the same companion process
    // to resume writing after a simulator flight reconnect.
    SimConnect_CreateClientData(simConnect,
        ClientDataMultiplayerSnapshot,
        sizeof(rk::MultiplayerSnapshotV1),
        static_cast<SIMCONNECT_CREATE_CLIENT_DATA_FLAG>(0));
    hr = SimConnect_AddToClientDataDefinition(simConnect,
        DefinitionMultiplayerSnapshot, 0,
        sizeof(rk::MultiplayerSnapshotV1));
    if (FAILED(hr)) { return false; }

    hr = SimConnect_MapClientDataNameToID(simConnect,
        rk::kCompanionStatusAreaName, ClientDataCompanionStatus);
    if (FAILED(hr)) { return false; }
    SimConnect_CreateClientData(simConnect,
        ClientDataCompanionStatus,
        sizeof(rk::CompanionStatusV1),
        static_cast<SIMCONNECT_CREATE_CLIENT_DATA_FLAG>(0));
    hr = SimConnect_AddToClientDataDefinition(simConnect,
        DefinitionCompanionStatus, 0,
        sizeof(rk::CompanionStatusV1));
    if (FAILED(hr)) { return false; }

    hr = SimConnect_MapClientDataNameToID(simConnect,
        rk::kCombatOutAreaName, ClientDataCombatOut);
    if (FAILED(hr)) { return false; }
    SimConnect_CreateClientData(simConnect,
        ClientDataCombatOut,
        sizeof(rk::MultiplayerCombatEventV1),
        static_cast<SIMCONNECT_CREATE_CLIENT_DATA_FLAG>(0));
    hr = SimConnect_AddToClientDataDefinition(simConnect,
        DefinitionCombatOut, 0,
        sizeof(rk::MultiplayerCombatEventV1));
    if (FAILED(hr)) { return false; }
    hr = SimConnect_RequestClientData(simConnect,
        ClientDataCombatOut, RequestCombatOut, DefinitionCombatOut,
        SIMCONNECT_CLIENT_DATA_PERIOD_ON_SET,
        SIMCONNECT_CLIENT_DATA_REQUEST_FLAG_DEFAULT,
        0, 0, 0);
    if (FAILED(hr)) { return false; }

    hr = SimConnect_MapClientDataNameToID(simConnect,
        rk::kCombatInAreaName, ClientDataCombatIn);
    if (FAILED(hr)) { return false; }
    SimConnect_CreateClientData(simConnect,
        ClientDataCombatIn,
        sizeof(rk::MultiplayerCombatEventV1),
        static_cast<SIMCONNECT_CREATE_CLIENT_DATA_FLAG>(0));
    hr = SimConnect_AddToClientDataDefinition(simConnect,
        DefinitionCombatIn, 0,
        sizeof(rk::MultiplayerCombatEventV1));
    return SUCCEEDED(hr);
}

void requestTelemetry(HANDLE simConnect) {
    SimConnect_RequestClientData(simConnect,
        ClientDataTacticalTelemetry,
        RequestTacticalTelemetry,
        DefinitionTacticalTelemetry,
        SIMCONNECT_CLIENT_DATA_PERIOD_ON_SET,
        SIMCONNECT_CLIENT_DATA_REQUEST_FLAG_DEFAULT,
        0, 0, 0);
}

HRESULT publishMultiplayerSnapshot(HANDLE simConnect,
    const rk::MultiplayerSnapshotV1& snapshot) {
    return SimConnect_SetClientData(simConnect,
        ClientDataMultiplayerSnapshot,
        DefinitionMultiplayerSnapshot,
        SIMCONNECT_CLIENT_DATA_SET_FLAG_DEFAULT,
        0,
        sizeof(snapshot),
        const_cast<rk::MultiplayerSnapshotV1*>(&snapshot));
}

void publishCompanionStatus(HANDLE simConnect,
    std::uint32_t& sequence, bool running, bool relayConnected) {
    rk::CompanionStatusV1 status{};
    status.magic = rk::kCompanionStatusMagic;
    status.protocolVersion = rk::kCompanionStatusVersion;
    status.messageSize = sizeof(status);
    status.sequence = ++sequence;
    if (status.sequence == 0) { status.sequence = ++sequence; }
    status.processRunning = running ? 1u : 0u;
    status.relayConnected = relayConnected ? 1u : 0u;
    SimConnect_SetClientData(simConnect,
        ClientDataCompanionStatus,
        DefinitionCompanionStatus,
        SIMCONNECT_CLIENT_DATA_SET_FLAG_DEFAULT,
        0,
        sizeof(status),
        &status);
}

HRESULT publishCombatInbox(HANDLE simConnect,
    rk::MultiplayerCombatEventV1& event,
    std::uint32_t& sequence) {
    event.sequence = ++sequence;
    if (event.sequence == 0) { event.sequence = ++sequence; }
    return SimConnect_SetClientData(simConnect,
        ClientDataCombatIn,
        DefinitionCombatIn,
        SIMCONNECT_CLIENT_DATA_SET_FLAG_DEFAULT,
        0,
        sizeof(event),
        &event);
}

void processTestKeys(rk::AudioEngine& audio, bool& testLoop) {
    if (!_kbhit()) { return; }
    const int key = _getch();
    if (key == 'q' || key == 'Q') {
        g_stopRequested = true;
    } else if (key == 'l' || key == 'L') {
        audio.playLaunch();
        std::cout << "Launch warning test.\n";
    } else if (key == 'm' || key == 'M') {
        testLoop = !testLoop;
        g_manualActiveWarningTest = testLoop;
        updateActiveWarning(audio);
        std::cout << "Active warning test " << (testLoop ? "ON" : "OFF") << ".\n";
    }
}

} // namespace

int wmain() {
    SetConsoleCtrlHandler(consoleControlHandler, TRUE);
    const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    const bool comInitialized = SUCCEEDED(comResult);
    if (FAILED(comResult) && comResult != RPC_E_CHANGED_MODE) {
        std::cerr << "COM initialization failed: 0x"
            << std::hex << static_cast<unsigned long>(comResult)
            << std::dec << "\n";
    }
    const rk::CompanionConfig config = rk::loadConfig();

    std::wcout << L"RK Tactical Companion " RK_COMPANION_VERSION L" SHARED WEAPONS AND VFX\n"
        << L"Stable Windows audio + multiplayer transport\n"
        << L"L = test launch sound, M = toggle active warning, Q = quit\n";

    rk::AudioEngine audio;
    if (!audio.initialize(config.launchSoundPath, config.activeSoundPath,
        config.launchVolume, config.activeVolume)) {
        std::cerr << "Audio initialization failed; continuing without audio.\n";
    } else {
        std::cout << "Windows warning audio ready at fixed pitch.\n";
    }

    if(!audio.initializeBattlefield(config.executableDirectory / L"Audio"))
        std::cerr << "Battlefield sounds unavailable; check Audio/Explosion.wav and Audio/brrrt.wav.\n";
    rk::MultiplayerClient multiplayer(config);
    if (!config.relayUrl.empty()) {
        multiplayer.start();
        std::wcout << L"Global RK multiplayer enabled: "
            << config.relayUrl << L"\n";
    } else {
        std::cout << "Global RK multiplayer endpoint is not configured; "
            "single-player warning audio remains active.\n";
    }

    bool testLoop = false;
    while (!g_stopRequested) {
        HANDLE simConnect = nullptr;
        const HRESULT openResult = SimConnect_Open(&simConnect,
            "RK Tactical Companion", nullptr, 0, nullptr, 0);
        if (FAILED(openResult)) {
            audio.stopBattlefield();
            processTestKeys(audio, testLoop);
            std::this_thread::sleep_for(std::chrono::seconds(2));
            continue;
        }

        std::cout << "SimConnect connected.\n";
        AppState app{};
        app.audio = &audio;
        app.multiplayer = &multiplayer;
        if (!configureSimConnect(simConnect)) {
            std::cout << "Unable to configure SimConnect; retrying.\n";
            SimConnect_Close(simConnect);
            std::this_thread::sleep_for(std::chrono::seconds(2));
            continue;
        }
        requestTelemetry(simConnect);
        rk::MultiplayerSnapshotV1 emptySnapshot{};
        emptySnapshot.magic = rk::kMultiplayerMagic;
        emptySnapshot.protocolVersion = rk::kMultiplayerVersion;
        emptySnapshot.messageSize = sizeof(emptySnapshot);
        emptySnapshot.sequence = 1;
        const HRESULT emptyPublishResult = publishMultiplayerSnapshot(
            simConnect, emptySnapshot);
        if (FAILED(emptyPublishResult)) {
            std::cout << "Multiplayer SimConnect bridge initialization failed: 0x"
                << std::hex << static_cast<unsigned long>(emptyPublishResult)
                << std::dec << "\n";
        }
        std::uint32_t companionStatusSequence = 0;
        std::uint32_t combatInboxSequence = 0;
        int lastPublishedPeerCount = -1;
        publishCompanionStatus(simConnect, companionStatusSequence,
            true, multiplayer.connected());
        auto nextCompanionHeartbeat = std::chrono::steady_clock::now()
            + std::chrono::seconds(1);
        auto nextTelemetryRetry = std::chrono::steady_clock::now()
            + std::chrono::seconds(2);

        while (!g_stopRequested && !app.simulatorQuit) {
            bool dispatchFailed=false;
            // Drain an existing backlog with a fixed work budget before sleeping.
            for(int packet=0;packet<32 && !app.simulatorQuit;++packet) {
                app.dispatchReceived=false;
                const HRESULT dispatchResult=SimConnect_CallDispatch(simConnect,dispatchProc,&app);
                if(FAILED(dispatchResult)){dispatchFailed=true;break;}
                if(!app.dispatchReceived) break;
            }
            if(dispatchFailed) break;
            if (!app.telemetryReceived
                && std::chrono::steady_clock::now() >= nextTelemetryRetry) {
                requestTelemetry(simConnect);
                nextTelemetryRetry = std::chrono::steady_clock::now()
                    + std::chrono::seconds(2);
            }
            rk::MultiplayerSnapshotV1 snapshot{};
            if (multiplayer.consumeSnapshot(snapshot)) {
                const HRESULT snapshotResult = publishMultiplayerSnapshot(
                    simConnect, snapshot);
                if (SUCCEEDED(snapshotResult)) {
                    const int peers = static_cast<int>(snapshot.contactCount);
                    if (peers != lastPublishedPeerCount) {
                        lastPublishedPeerCount = peers;
                        std::cout << "Multiplayer SimConnect tracks published: "
                            << peers << "\n";
                    }
                } else {
                    std::cout << "Multiplayer SimConnect publish failed: 0x"
                        << std::hex
                        << static_cast<unsigned long>(snapshotResult)
                        << std::dec << "\n";
                }
            }
            rk::MultiplayerCombatEventV1 combat{};
            int combatSafety = 0;
            while (combatSafety < 64
                && multiplayer.consumeCombatEvent(combat)) {
                const HRESULT combatResult = publishCombatInbox(
                    simConnect, combat, combatInboxSequence);
                if (FAILED(combatResult)) {
                    std::cout << "Multiplayer combat inbox publish failed: 0x"
                        << std::hex
                        << static_cast<unsigned long>(combatResult)
                        << std::dec << "\n";
                }
                ++combatSafety;
            }
            if (std::chrono::steady_clock::now()
                >= nextCompanionHeartbeat) {
                publishCompanionStatus(simConnect,
                    companionStatusSequence, true,
                    multiplayer.connected());
                nextCompanionHeartbeat = std::chrono::steady_clock::now()
                    + std::chrono::seconds(1);
            }
            if(std::chrono::steady_clock::now()-app.lastBattleTelemetry>std::chrono::seconds(1)) audio.stopBattlefield();
            processTestKeys(audio, testLoop);
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }

        audio.stopBattlefield();
        g_liveMissileActive = false;
        g_manualActiveWarningTest = false;
        testLoop = false;
        updateActiveWarning(audio);
        multiplayer.updateLocalState({}, false);
        publishCompanionStatus(simConnect, companionStatusSequence,
            false, false);
        ++emptySnapshot.sequence;
        publishMultiplayerSnapshot(simConnect, emptySnapshot);
        SimConnect_Close(simConnect);
        if (!g_stopRequested) {
            std::cout << "SimConnect disconnected; retrying.\n";
            std::this_thread::sleep_for(std::chrono::seconds(2));
        }
    }

    multiplayer.stop();
    audio.shutdown();
    if (comInitialized) { CoUninitialize(); }
    return 0;
}
