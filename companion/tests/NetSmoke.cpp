#define _CRT_SECURE_NO_WARNINGS
#include "MultiplayerClient.h"
#include <chrono>
#include <cstring>
#include <string>
#include <iostream>
#include <thread>

using namespace std::chrono_literals;

static rk::UserAircraftState at(double lat) {
    rk::UserAircraftState s{};
    s.latitude = lat; s.longitude = 10.0; s.altitudeFt = 5000; s.headingDeg = 90; s.speedKts = 200;
    std::strncpy(s.aircraftTitle, "Smoke Test Plane", sizeof(s.aircraftTitle) - 1);
    return s;
}

int main(int argc, char** argv) {
    std::wstring url = argc > 1 ? std::wstring(argv[1], argv[1] + strlen(argv[1])) : L"ws://127.0.0.1:18787";
    rk::CompanionConfig ca; ca.relayUrl = url; ca.playerId = L"smoke-a"; ca.displayName = L"Alpha";
    rk::CompanionConfig cb; cb.relayUrl = url; cb.playerId = L"smoke-b"; cb.displayName = L"Bravo";
    rk::MultiplayerClient a(ca), b(cb);
    a.start(); b.start();
    a.updateLocalState(at(10.0), true);
    b.updateLocalState(at(10.1), true);

    bool saw = false;
    for (int i = 0; i < 80 && !saw; ++i) {
        std::this_thread::sleep_for(50ms);
        rk::MultiplayerSnapshotV1 s{};
        if (a.consumeSnapshot(s) && s.contactCount == 1) {
            std::cout << "A sees " << s.contacts[0].displayName << " flying " << s.contacts[0].aircraftTitle << "\n";
            saw = true;
        }
    }
    std::cout << (saw ? "PASS contacts\n" : "FAIL contacts\n");

    rk::MultiplayerCombatEventV1 e{};
    e.magic = rk::kCombatMagic; e.protocolVersion = rk::kCombatVersion; e.messageSize = sizeof(e);
    e.sequence = 1; e.eventType = 1; e.weaponType = 1; e.weaponId = 7;
    e.latitude = 10.0; e.longitude = 10.0; e.altitudeFt = 5000; e.headingDeg = 90;
    auto t0 = std::chrono::steady_clock::now();
    a.queueCombatEvent(e);
    bool got = false;
    for (int i = 0; i < 400 && !got; ++i) {
        rk::MultiplayerCombatEventV1 in{};
        if (b.consumeCombatEvent(in)) { got = in.eventType == 1 && in.weaponId == 7; break; }
        std::this_thread::sleep_for(1ms);
    }
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now() - t0).count();
    std::cout << (got ? "PASS combat in " : "FAIL combat after ") << ms << " ms\n";

    const bool reconnect = argc > 2 && std::string(argv[2]) == "reconnect";
    if (!reconnect) {
        a.stop();
        b.stop();
        return (saw && got) ? 0 : 1;
    }
    std::cout << "Stop and start the relay now (reconnect test)...\n" << std::flush;
    for (int i = 0; i < 400 && a.connected(); ++i) std::this_thread::sleep_for(100ms);
    std::cout << "A connected=" << a.connected() << " (should be 0 once relay is down)\n" << std::flush;
    auto t1 = std::chrono::steady_clock::now();
    for (int i = 0; i < 600 && !a.connected(); ++i) std::this_thread::sleep_for(100ms);
    std::cout << (a.connected() ? "PASS reconnect after " : "FAIL reconnect after ")
        << std::chrono::duration_cast<std::chrono::seconds>(std::chrono::steady_clock::now() - t1).count() << " s\n";
    a.stop(); b.stop();
    return (saw && got) ? 0 : 1;
}
