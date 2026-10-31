#pragma once

#include "Config.h"
#include "Protocol.h"

#include <atomic>
#include <deque>
#include <mutex>
#include <string>
#include <thread>

namespace rk {

class MultiplayerClient {
public:
    explicit MultiplayerClient(const CompanionConfig& config);
    ~MultiplayerClient();
    MultiplayerClient(const MultiplayerClient&) = delete;
    MultiplayerClient& operator=(const MultiplayerClient&) = delete;

    void start();
    void stop();
    void updateLocalState(const UserAircraftState& state, bool valid);
    void setDisplayName(const std::wstring& name);
    bool connected() const;
    int remotePlayerCount() const;
    bool consumeSnapshot(MultiplayerSnapshotV1& snapshot);
    void queueCombatEvent(const MultiplayerCombatEventV1& event);
    bool consumeCombatEvent(MultiplayerCombatEventV1& event);

private:
    void run();
    bool connectWebSocket();
    void closeWebSocket();
    bool sendText(const std::string& text);
    void sendLoop();
    void receiveLoop(void* socket);
    void abortSocket(std::thread& receiver);
    std::string makeHello() const;
    std::string makeState(const UserAircraftState& state) const;
    std::string makeCombatEvent(const MultiplayerCombatEventV1& event) const;
    void processMessage(const std::string& text);
    void noteReason(const std::string& reason);
    std::string takeReason();

    CompanionConfig config_;
    mutable std::mutex stateMutex_;
    UserAircraftState localState_{};
    bool localStateValid_ = false;
    std::thread worker_;
    std::atomic<bool> stopRequested_{false};
    std::atomic<bool> connected_{false};
    std::atomic<int> remotePlayerCount_{0};
    std::atomic<long long> lastReceiveMs_{0};
    std::atomic<bool> receiverRunning_{false};
    std::atomic<bool> reconnectRequested_{false};
    mutable std::mutex nameMutex_;
    std::mutex reasonMutex_;
    std::string endReason_;
    std::atomic<unsigned long long> statesSent_{0};
    std::atomic<unsigned long long> combatOut_{0};
    std::atomic<unsigned long long> combatIn_{0};
    std::atomic<unsigned long long> snapshotsIn_{0};
    std::mutex snapshotMutex_;
    MultiplayerSnapshotV1 latestSnapshot_{};
    std::uint32_t consumedSnapshotSequence_ = 0;
    std::mutex outgoingCombatMutex_;
    std::deque<MultiplayerCombatEventV1> outgoingCombat_;
    std::mutex incomingCombatMutex_;
    std::deque<MultiplayerCombatEventV1> incomingCombat_;
    void* session_ = nullptr;
    void* connection_ = nullptr;
    void* socket_ = nullptr;
};

} // namespace rk
