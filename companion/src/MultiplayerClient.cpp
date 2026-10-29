#include "MultiplayerClient.h"
#include "Version.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <limits>
#include <sstream>
#include <vector>

namespace rk {
namespace {

std::string utf8(const std::wstring& value) {
    if (value.empty()) { return {}; }
    const int length = WideCharToMultiByte(CP_UTF8, 0, value.c_str(),
        static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<std::size_t>(length), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.c_str(),
        static_cast<int>(value.size()), result.data(), length, nullptr, nullptr);
    return result;
}

std::string jsonEscape(const std::string& value) {
    std::string result;
    result.reserve(value.size() + 8);
    for (const unsigned char c : value) {
        switch (c) {
        case '\\': result += "\\\\"; break;
        case '"': result += "\\\""; break;
        case '\b': result += "\\b"; break;
        case '\f': result += "\\f"; break;
        case '\n': result += "\\n"; break;
        case '\r': result += "\\r"; break;
        case '\t': result += "\\t"; break;
        default:
            if (c >= 0x20) { result.push_back(static_cast<char>(c)); }
            break;
        }
    }
    return result;
}

std::wstring httpEquivalent(const std::wstring& url) {
    if (url.rfind(L"wss://", 0) == 0) { return L"https://" + url.substr(6); }
    if (url.rfind(L"ws://", 0) == 0) { return L"http://" + url.substr(5); }
    return url;
}

bool jsonNumber(const std::string& text, const char* key, double& value) {
    const std::string needle = std::string("\"") + key + "\":";
    const std::size_t position = text.find(needle);
    if (position == std::string::npos) { return false; }
    const char* start = text.c_str() + position + needle.size();
    char* end = nullptr;
    const double parsed = std::strtod(start, &end);
    if (end == start) { return false; }
    value = parsed;
    return true;
}

bool jsonUnsigned(const std::string& text, const char* key,
    std::uint32_t& value) {
    double parsed = 0.0;
    if (!jsonNumber(text, key, parsed) || parsed < 0.0
        || parsed > static_cast<double>(
            (std::numeric_limits<std::uint32_t>::max)())) {
        return false;
    }
    value = static_cast<std::uint32_t>(parsed + 0.5);
    return true;
}

} // namespace

MultiplayerClient::MultiplayerClient(const CompanionConfig& config)
    : config_(config) {}

MultiplayerClient::~MultiplayerClient() { stop(); }

void MultiplayerClient::start() {
    if (config_.relayUrl.empty() || worker_.joinable()) {
        return;
    }
    stopRequested_ = false;
    worker_ = std::thread(&MultiplayerClient::run, this);
}

void MultiplayerClient::stop() {
    stopRequested_ = true;
    if (worker_.joinable()) { worker_.join(); }
    closeWebSocket();
}

void MultiplayerClient::updateLocalState(
    const UserAircraftState& state, bool valid) {
    std::lock_guard<std::mutex> lock(stateMutex_);
    localState_ = state;
    localStateValid_ = valid;
}

bool MultiplayerClient::connected() const { return connected_.load(); }
int MultiplayerClient::remotePlayerCount() const {
    return remotePlayerCount_.load();
}

bool MultiplayerClient::consumeSnapshot(MultiplayerSnapshotV1& snapshot) {
    std::lock_guard<std::mutex> lock(snapshotMutex_);
    if (latestSnapshot_.sequence == 0
        || latestSnapshot_.sequence == consumedSnapshotSequence_) {
        return false;
    }
    snapshot = latestSnapshot_;
    consumedSnapshotSequence_ = latestSnapshot_.sequence;
    return true;
}

void MultiplayerClient::queueCombatEvent(
    const MultiplayerCombatEventV1& event) {
    if (event.magic != kCombatMagic
        || event.protocolVersion != kCombatVersion
        || event.messageSize != sizeof(MultiplayerCombatEventV1)
        || event.eventType < static_cast<std::uint32_t>(CombatEventType::Launch)
        || event.eventType > 9u) {
        return;
    }
    std::lock_guard<std::mutex> lock(outgoingCombatMutex_);
    if (outgoingCombat_.size() >= 256) { outgoingCombat_.pop_front(); }
    outgoingCombat_.push_back(event);
}

bool MultiplayerClient::consumeCombatEvent(
    MultiplayerCombatEventV1& event) {
    std::lock_guard<std::mutex> lock(incomingCombatMutex_);
    if (incomingCombat_.empty()) { return false; }
    event = incomingCombat_.front();
    incomingCombat_.pop_front();
    return true;
}

void MultiplayerClient::run() {
    using namespace std::chrono_literals;
    while (!stopRequested_) {
        if (!connectWebSocket()) {
            connected_ = false;
            for (int i = 0; i < 30 && !stopRequested_; ++i) {
                std::this_thread::sleep_for(100ms);
            }
            continue;
        }

        connected_ = true;
        std::cout << "Multiplayer relay connected.\n";
        if (!sendText(makeHello())) {
            closeWebSocket();
            continue;
        }

        while (!stopRequested_ && connected_) {
            for (int sent = 0; sent < 64; ++sent) {
                MultiplayerCombatEventV1 combat{};
                {
                    std::lock_guard<std::mutex> lock(outgoingCombatMutex_);
                    if (outgoingCombat_.empty()) { break; }
                    combat = outgoingCombat_.front();
                }
                if (!sendText(makeCombatEvent(combat))) {
                    connected_ = false;
                    break;
                }
                {
                    std::lock_guard<std::mutex> lock(outgoingCombatMutex_);
                    if (!outgoingCombat_.empty()
                        && outgoingCombat_.front().sequence == combat.sequence) {
                        outgoingCombat_.pop_front();
                    }
                }
            }
            if (!connected_) { break; }

            UserAircraftState state{};
            bool valid = false;
            {
                std::lock_guard<std::mutex> lock(stateMutex_);
                state = localState_;
                valid = localStateValid_;
            }
            if (!valid) {
                std::this_thread::sleep_for(50ms);
                continue;
            }
            if (!sendText(makeState(state))) { break; }

            std::string message;
            MultiplayerSnapshotV1 snapshot{};
            bool hasSnapshot = false;
            if (!receiveMessage(message, snapshot, hasSnapshot)) { break; }
            if (hasSnapshot) {
                {
                    std::lock_guard<std::mutex> lock(snapshotMutex_);
                    latestSnapshot_ = snapshot;
                }
                const int remote = static_cast<int>(snapshot.contactCount);
                const int previous = remotePlayerCount_.exchange(remote);
                if (previous != remote) {
                    std::cout << "RK multiplayer contacts: " << remote << "\n";
                }
            } else {
                processMessage(message);
            }
            std::this_thread::sleep_for(10ms);
        }
        closeWebSocket();
        if (!stopRequested_) { std::cout << "Multiplayer relay disconnected; retrying.\n"; }
    }
}

bool MultiplayerClient::connectWebSocket() {
    closeWebSocket();
    const std::wstring url = httpEquivalent(config_.relayUrl);
    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwSchemeLength = static_cast<DWORD>(-1);
    parts.dwHostNameLength = static_cast<DWORD>(-1);
    parts.dwUrlPathLength = static_cast<DWORD>(-1);
    parts.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(url.c_str(), 0, 0, &parts)) { return false; }

    std::wstring host(parts.lpszHostName, parts.dwHostNameLength);
    std::wstring path(parts.lpszUrlPath, parts.dwUrlPathLength);
    if (parts.dwExtraInfoLength > 0) {
        path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
    }
    if (path.empty()) { path = L"/"; }

    HINTERNET session = WinHttpOpen(L"RKTacticalCompanion/" RK_COMPANION_VERSION,
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) { return false; }
    WinHttpSetTimeouts(session, 3000, 3000, 3000, 2000);
    HINTERNET connection = WinHttpConnect(session, host.c_str(),
        parts.nPort, 0);
    if (!connection) {
        WinHttpCloseHandle(session);
        return false;
    }

    const DWORD flags = parts.nScheme == INTERNET_SCHEME_HTTPS
        ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET request = WinHttpOpenRequest(connection, L"GET", path.c_str(),
        nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!request) {
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        return false;
    }
    if (!WinHttpSetOption(request, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET,
        nullptr, 0)
        || !WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
            WINHTTP_NO_REQUEST_DATA, 0, 0, 0)
        || !WinHttpReceiveResponse(request, nullptr)) {
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        return false;
    }
    HINTERNET socket = WinHttpWebSocketCompleteUpgrade(request, 0);
    WinHttpCloseHandle(request);
    if (!socket) {
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        return false;
    }
    session_ = session;
    connection_ = connection;
    socket_ = socket;
    return true;
}

void MultiplayerClient::closeWebSocket() {
    connected_ = false;
    remotePlayerCount_ = 0;
    {
        std::lock_guard<std::mutex> lock(snapshotMutex_);
        latestSnapshot_.magic = kMultiplayerMagic;
        latestSnapshot_.protocolVersion = kMultiplayerVersion;
        latestSnapshot_.messageSize = sizeof(MultiplayerSnapshotV1);
        ++latestSnapshot_.sequence;
        if (latestSnapshot_.sequence == 0) { latestSnapshot_.sequence = 1; }
        latestSnapshot_.contactCount = 0;
    }
    {
        std::lock_guard<std::mutex> lock(outgoingCombatMutex_);
        outgoingCombat_.clear();
    }
    {
        std::lock_guard<std::mutex> lock(incomingCombatMutex_);
        incomingCombat_.clear();
    }
    if (socket_) {
        WinHttpWebSocketClose(static_cast<HINTERNET>(socket_),
            WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
        WinHttpCloseHandle(static_cast<HINTERNET>(socket_));
        socket_ = nullptr;
    }
    if (connection_) {
        WinHttpCloseHandle(static_cast<HINTERNET>(connection_));
        connection_ = nullptr;
    }
    if (session_) {
        WinHttpCloseHandle(static_cast<HINTERNET>(session_));
        session_ = nullptr;
    }
}

bool MultiplayerClient::sendText(const std::string& text) {
    if (!socket_) { return false; }
    const DWORD result = WinHttpWebSocketSend(static_cast<HINTERNET>(socket_),
        WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE,
        const_cast<char*>(text.data()), static_cast<DWORD>(text.size()));
    return result == NO_ERROR;
}

bool MultiplayerClient::receiveMessage(std::string& text,
    MultiplayerSnapshotV1& snapshot, bool& hasSnapshot) {
    if (!socket_) { return false; }
    hasSnapshot = false;
    text.clear();
    std::vector<char> buffer(65536);
    DWORD received = 0;
    WINHTTP_WEB_SOCKET_BUFFER_TYPE type =
        WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE;
    const DWORD result = WinHttpWebSocketReceive(
        static_cast<HINTERNET>(socket_), buffer.data(),
        static_cast<DWORD>(buffer.size()), &received, &type);
    if (result != NO_ERROR
        || type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) {
        return false;
    }
    if (type == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE) {
        if (received != sizeof(MultiplayerSnapshotV1)) { return true; }
        std::memcpy(&snapshot, buffer.data(), sizeof(snapshot));
        if (snapshot.magic != kMultiplayerMagic
            || snapshot.protocolVersion != kMultiplayerVersion
            || snapshot.messageSize != sizeof(MultiplayerSnapshotV1)
            || snapshot.contactCount > kMaxMultiplayerContacts) {
            return true;
        }
        hasSnapshot = true;
        return true;
    }
    if (type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE) {
        text.assign(buffer.data(), buffer.data() + received);
    }
    return true;
}

std::string MultiplayerClient::makeHello() const {
    std::ostringstream out;
    out << "{\"type\":\"hello\",\"protocol\":3"
        << ",\"id\":\"" << jsonEscape(utf8(config_.playerId)) << "\""
        << ",\"name\":\"" << jsonEscape(utf8(config_.displayName)) << "\"}";
    return out.str();
}

std::string MultiplayerClient::makeCombatEvent(
    const MultiplayerCombatEventV1& event) const {
    std::ostringstream out;
    out << std::fixed << std::setprecision(7)
        << "{\"type\":\"combat\",\"event\":" << event.eventType
        << ",\"weapon\":" << event.weaponType
        << ",\"target\":" << event.targetContactId
        << ",\"weaponId\":" << event.weaponId
        << ",\"flags\":" << event.flags
        << ",\"lat\":" << event.latitude
        << ",\"lon\":" << event.longitude
        << std::setprecision(2)
        << ",\"altFt\":" << event.altitudeFt
        << ",\"heading\":" << event.headingDeg
        << ",\"damage\":" << event.damage
        << ",\"duration\":" << event.durationSeconds
        << ",\"missDistance\":" << event.missDistanceFt
        << "}";
    return out.str();
}

std::string MultiplayerClient::makeState(const UserAircraftState& state) const {
    std::ostringstream out;
    out << std::fixed << std::setprecision(7)
        << "{\"type\":\"state\",\"lat\":" << state.latitude
        << ",\"lon\":" << state.longitude
        << std::setprecision(2)
        << ",\"altFt\":" << state.altitudeFt
        << ",\"heading\":" << state.headingDeg
        << ",\"speedKts\":" << state.speedKts
        << ",\"aircraft\":\"" << jsonEscape(state.aircraftTitle) << "\""
        << ",\"team\":" << state.team << ",\"flight\":" << state.flight << ",\"detected\":[";
    for(int i=0;i<32;++i){if(i)out << ',';out << state.detectedPeers[i];}
    out << "]}";
    return out.str();
}

void MultiplayerClient::processMessage(const std::string& text) {
    if (text.find("\"type\":\"combat\"") != std::string::npos) {
        MultiplayerCombatEventV1 event{};
        event.magic = kCombatMagic;
        event.protocolVersion = kCombatVersion;
        event.messageSize = sizeof(event);
        double latitude = 0.0;
        double longitude = 0.0;
        double altitudeFt = 0.0;
        double headingDeg = 0.0;
        double damage = 0.0;
        double duration = 0.0;
        double missDistance = 0.0;
        if (!jsonUnsigned(text, "event", event.eventType)
            || !jsonUnsigned(text, "weapon", event.weaponType)
            || !jsonUnsigned(text, "source", event.sourceContactId)
            || !jsonUnsigned(text, "target", event.targetContactId)
            || !jsonUnsigned(text, "weaponId", event.weaponId)
            || !jsonUnsigned(text, "flags", event.flags)
            || !jsonNumber(text, "lat", latitude)
            || !jsonNumber(text, "lon", longitude)
            || !jsonNumber(text, "altFt", altitudeFt)
            || !jsonNumber(text, "heading", headingDeg)
            || !jsonNumber(text, "damage", damage)
            || !jsonNumber(text, "duration", duration)
            || !jsonNumber(text, "missDistance", missDistance)) {
            return;
        }
        event.latitude = latitude;
        event.longitude = longitude;
        event.altitudeFt = altitudeFt;
        event.headingDeg = static_cast<float>(headingDeg);
        event.damage = static_cast<float>(damage);
        event.durationSeconds = static_cast<float>(duration);
        event.missDistanceFt = static_cast<float>(missDistance);
        std::lock_guard<std::mutex> lock(incomingCombatMutex_);
        if (incomingCombat_.size() >= 256) { incomingCombat_.pop_front(); }
        incomingCombat_.push_back(event);
        return;
    }
    if (text.find("\"type\":\"error\"") != std::string::npos) {
        std::cout << "Relay returned an error message.\n";
    }
}

} // namespace rk
