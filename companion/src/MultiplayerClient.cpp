#include "MultiplayerClient.h"
#include "Log.h"
#include "Version.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>

#include <algorithm>
#include <chrono>
#include <cmath>
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

bool jsonString(const std::string& text, const char* key, std::string& value) {
    const std::string needle = std::string("\"") + key + "\":\"";
    const std::size_t position = text.find(needle);
    if (position == std::string::npos) { return false; }
    std::string result;
    for (std::size_t i = position + needle.size(); i < text.size(); ++i) {
        const char c = text[i];
        if (c == '"') {
            value = result;
            return true;
        }
        if (c == '\\' && i + 1 < text.size()) {
            result.push_back(text[++i]);
        } else {
            result.push_back(c);
        }
    }
    return false;
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

void MultiplayerClient::setDisplayName(const std::wstring& name) {
    {
        std::lock_guard<std::mutex> lock(nameMutex_);
        config_.displayName = name;
    }
    reconnectRequested_ = true;
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

namespace {

constexpr long long kLivenessMs = 15000;
constexpr std::size_t kMaxTextMessage = 262144;

long long nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

bool finiteIn(double value, double low, double high) {
    return std::isfinite(value) && value >= low && value <= high;
}

bool cleanSnapshot(MultiplayerSnapshotV1& snapshot) {
    if (snapshot.magic != kMultiplayerMagic
        || snapshot.protocolVersion != kMultiplayerVersion
        || snapshot.messageSize != sizeof(MultiplayerSnapshotV1)
        || snapshot.contactCount > kMaxMultiplayerContacts) {
        return false;
    }
    std::uint32_t kept = 0;
    for (std::uint32_t i = 0; i < snapshot.contactCount; ++i) {
        MultiplayerContactV1 contact = snapshot.contacts[i];
        if (!finiteIn(contact.latitude, -90.0, 90.0)
            || !finiteIn(contact.longitude, -180.0, 180.0)
            || !finiteIn(contact.altitudeFt, -2000.0, 200000.0)
            || !finiteIn(contact.headingDeg, -360.0, 720.0)
            || !finiteIn(contact.speedKts, 0.0, 10000.0)) {
            continue;
        }
        contact.displayName[sizeof(contact.displayName) - 1] = '\0';
        contact.aircraftTitle[sizeof(contact.aircraftTitle) - 1] = '\0';
        snapshot.contacts[kept++] = contact;
    }
    for (std::uint32_t i = kept; i < snapshot.contactCount; ++i) {
        snapshot.contacts[i] = MultiplayerContactV1{};
    }
    snapshot.contactCount = kept;
    return true;
}

void sleepWhile(const std::atomic<bool>& stop, std::chrono::milliseconds total) {
    const auto end = std::chrono::steady_clock::now() + total;
    while (!stop && std::chrono::steady_clock::now() < end) {
        std::this_thread::sleep_for(std::chrono::milliseconds(50));
    }
}

} // namespace

void MultiplayerClient::run() {
    using namespace std::chrono_literals;
    std::chrono::milliseconds backoff = 1000ms;
    while (!stopRequested_) {
        if (!connectWebSocket()) {
            connected_ = false;
            const auto jitter = std::chrono::milliseconds(
                static_cast<long long>(std::rand()) % (backoff.count() / 2 + 1));
            sleepWhile(stopRequested_, backoff + jitter);
            backoff = (std::min)(backoff * 2, std::chrono::milliseconds(30000));
            continue;
        }

        connected_ = true;
        std::string helloName;
        {
            std::lock_guard<std::mutex> lock(nameMutex_);
            helloName = utf8Text(config_.displayName);
        }
        say("Multiplayer relay connected. Joining as \"" + helloName + "\" (id " + shortId(config_.playerId) + ").");
        if (!sendText(makeHello())) {
            logLine(1, "Could not send the hello message to the relay.");
            connected_ = false;
            closeWebSocket();
            continue;
        }

        const long long startedAt = nowMs();
        lastReceiveMs_ = startedAt;
        statesSent_ = 0;
        combatOut_ = 0;
        combatIn_ = 0;
        snapshotsIn_ = 0;
        takeReason();
        void* const socket = socket_;
        receiverRunning_ = true;
        std::thread receiver(&MultiplayerClient::receiveLoop, this, socket);
        sendLoop();
        connected_ = false;
        abortSocket(receiver);
        closeWebSocket();
        if (lastReceiveMs_.load() > startedAt) { backoff = 1000ms; }
        if (!stopRequested_) {
            const long long seconds = (nowMs() - startedAt) / 1000;
            std::string reason = takeReason();
            if (reason.empty()) { reason = "the connection ended"; }
            say("Multiplayer relay disconnected after " + std::to_string(seconds) + "s: " + reason + ". Retrying.");
            logLine(1, "Session totals: snapshots received " + std::to_string(snapshotsIn_.load())
                + ", position updates sent " + std::to_string(statesSent_.load())
                + ", combat sent " + std::to_string(combatOut_.load())
                + ", combat received " + std::to_string(combatIn_.load()));
            sleepWhile(stopRequested_, backoff);
        }
    }
}

void MultiplayerClient::sendLoop() {
    using namespace std::chrono_literals;
    auto nextState = std::chrono::steady_clock::now();
    auto nextStateLog = nextState + std::chrono::seconds(2);
    while (!stopRequested_ && connected_) {
        for (int sent = 0; sent < 64; ++sent) {
            MultiplayerCombatEventV1 combat{};
            {
                std::lock_guard<std::mutex> lock(outgoingCombatMutex_);
                if (outgoingCombat_.empty()) { break; }
                combat = outgoingCombat_.front();
            }
            if (!sendText(makeCombatEvent(combat))) {
                noteReason("sending a combat event failed");
                connected_ = false;
                break;
            }
            ++combatOut_;
            if (combat.eventType != 5u) {
                logLine(1, "Combat sent: event " + std::to_string(combat.eventType) + " weapon "
                    + std::to_string(combat.weaponType) + " target " + std::to_string(combat.targetContactId)
                    + " weaponId " + std::to_string(combat.weaponId));
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

        if (reconnectRequested_.exchange(false)) {
            noteReason("the pilot name was changed");
            break;
        }

        if (nowMs() - lastReceiveMs_.load() > kLivenessMs) {
            noteReason("the relay stopped answering for 15 seconds");
            break;
        }

        const auto now = std::chrono::steady_clock::now();
        if (now >= nextState) {
            nextState = now + 100ms;
            UserAircraftState state{};
            bool valid = false;
            {
                std::lock_guard<std::mutex> lock(stateMutex_);
                state = localState_;
                valid = localStateValid_;
            }
            if (valid) {
                if (!sendText(makeState(state))) {
                    noteReason("sending a position update failed");
                    break;
                }
                ++statesSent_;
                if (now >= nextStateLog) {
                    nextStateLog = now + std::chrono::seconds(10);
                    logLine(1, "Position sent: " + std::to_string(statesSent_.load()) + " updates so far, now lat "
                        + std::to_string(state.latitude) + " lon " + std::to_string(state.longitude)
                        + " alt " + std::to_string(static_cast<int>(state.altitudeFt)) + " ft, team "
                        + std::to_string(state.team) + " flight " + std::to_string(state.flight)
                        + ", aircraft \"" + std::string(state.aircraftTitle) + "\"");
                }
            } else if (now >= nextStateLog) {
                nextStateLog = now + std::chrono::seconds(10);
                logLine(1, "Not sending a position: MSFS has not given the Companion your aircraft data yet.");
            }
        }
        std::this_thread::sleep_for(5ms);
    }
}

void MultiplayerClient::receiveLoop(void* socket) {
    struct Done { std::atomic<bool>& flag; ~Done() { flag = false; } } done{receiverRunning_};
    std::vector<char> buffer(65536);
    std::string pending;
    bool discard = false;
    std::uint64_t lastSignature = 0;
    long long lastViewLog = 0;
    long long lastBadLog = 0;
    while (!stopRequested_ && connected_) {
        DWORD received = 0;
        WINHTTP_WEB_SOCKET_BUFFER_TYPE type =
            WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE;
        const DWORD result = WinHttpWebSocketReceive(
            static_cast<HINTERNET>(socket), buffer.data(),
            static_cast<DWORD>(buffer.size()), &received, &type);
        if (result != NO_ERROR) {
            noteReason("receiving failed: " + describeWinHttpError(result));
            break;
        }
        if (type == WINHTTP_WEB_SOCKET_CLOSE_BUFFER_TYPE) {
            USHORT status = 0;
            char text[124]{};
            DWORD textLength = 0;
            WinHttpWebSocketQueryCloseStatus(static_cast<HINTERNET>(socket), &status, text, sizeof(text) - 1, &textLength);
            noteReason("the relay closed the connection (code " + std::to_string(status) + ", \""
                + std::string(text, textLength) + "\")");
            break;
        }
        lastReceiveMs_ = nowMs();
        if (type == WINHTTP_WEB_SOCKET_BINARY_MESSAGE_BUFFER_TYPE) {
            if (received != sizeof(MultiplayerSnapshotV1)) {
                if (nowMs() - lastBadLog > 10000) {
                    lastBadLog = nowMs();
                    logLine(1, "Ignored a binary message of " + std::to_string(received) + " bytes (a snapshot is "
                        + std::to_string(sizeof(MultiplayerSnapshotV1)) + ").");
                }
                continue;
            }
            MultiplayerSnapshotV1 snapshot{};
            std::memcpy(&snapshot, buffer.data(), sizeof(snapshot));
            const std::uint32_t sentCount = snapshot.contactCount;
            const std::uint32_t sentVersion = snapshot.protocolVersion;
            if (!cleanSnapshot(snapshot)) {
                if (nowMs() - lastBadLog > 10000) {
                    lastBadLog = nowMs();
                    logLine(1, "Rejected a snapshot: magic 0x" + [&] { std::ostringstream o; o << std::hex << snapshot.magic; return o.str(); }()
                        + ", version " + std::to_string(sentVersion) + " (this Companion needs " + std::to_string(kMultiplayerVersion)
                        + "), contacts " + std::to_string(sentCount) + ". The server and Companion do not match.");
                }
                continue;
            }
            ++snapshotsIn_;
            {
                std::lock_guard<std::mutex> lock(snapshotMutex_);
                latestSnapshot_ = snapshot;
            }
            const int remote = static_cast<int>(snapshot.contactCount);
            const int previous = remotePlayerCount_.exchange(remote);
            if (previous != remote) {
                std::cout << "RK multiplayer contacts: " << remote << "\n";
            }
            if (snapshot.contactCount < sentCount && nowMs() - lastBadLog > 10000) {
                lastBadLog = nowMs();
                logLine(1, "Dropped " + std::to_string(sentCount - snapshot.contactCount)
                    + " contact(s) from a snapshot because their position was impossible.");
            }
            std::uint64_t signature = 1469598103934665603ull;
            for (std::uint32_t i = 0; i < snapshot.contactCount; ++i) {
                signature = (signature ^ snapshot.contacts[i].idHash) * 1099511628211ull;
                signature = (signature ^ snapshot.contacts[i].flags) * 1099511628211ull;
            }
            signature ^= snapshot.contactCount;
            if ((signature != lastSignature || snapshotsIn_ == 1) && nowMs() - lastViewLog > 1000) {
                lastSignature = signature;
                lastViewLog = nowMs();
                std::string list;
                for (std::uint32_t i = 0; i < snapshot.contactCount && i < 12; ++i) {
                    const auto& c = snapshot.contacts[i];
                    list += std::string(i ? " " : "") + c.displayName + "(t" + std::to_string(c.flags & 3u)
                        + ((c.flags & 4u) ? ",tracked" : ",hidden") + ")";
                }
                logLine(1, "Snapshot " + std::to_string(snapshot.sequence) + " from the relay: "
                    + std::to_string(snapshot.contactCount) + " contact(s) [" + list + "]");
            }
        } else if (type == WINHTTP_WEB_SOCKET_UTF8_FRAGMENT_BUFFER_TYPE
            || type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE) {
            if (discard || pending.size() + received > kMaxTextMessage) {
                discard = true;
                pending.clear();
            } else {
                pending.append(buffer.data(), received);
            }
            if (type == WINHTTP_WEB_SOCKET_UTF8_MESSAGE_BUFFER_TYPE) {
                if (!discard) { processMessage(pending); }
                pending.clear();
                discard = false;
            }
        }
    }
    connected_ = false;
}

void MultiplayerClient::abortSocket(std::thread& receiver) {
    if (socket_) {
        WinHttpWebSocketShutdown(static_cast<HINTERNET>(socket_),
            WINHTTP_WEB_SOCKET_SUCCESS_CLOSE_STATUS, nullptr, 0);
        for (int i = 0; i < 10 && receiverRunning_; ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        WinHttpCloseHandle(static_cast<HINTERNET>(socket_));
        socket_ = nullptr;
    }
    if (receiver.joinable()) { receiver.join(); }
}

bool MultiplayerClient::connectWebSocket() {
    closeWebSocket();
    const std::wstring url = httpEquivalent(config_.relayUrl);
    const auto fail = [](const char* step) {
        logLine(1, std::string("Relay connect failed at ") + step + ": "
            + describeWinHttpError(GetLastError()));
    };
    URL_COMPONENTS parts{};
    parts.dwStructSize = sizeof(parts);
    parts.dwSchemeLength = static_cast<DWORD>(-1);
    parts.dwHostNameLength = static_cast<DWORD>(-1);
    parts.dwUrlPathLength = static_cast<DWORD>(-1);
    parts.dwExtraInfoLength = static_cast<DWORD>(-1);
    if (!WinHttpCrackUrl(url.c_str(), 0, 0, &parts)) { fail("reading the relay_url"); return false; }

    std::wstring host(parts.lpszHostName, parts.dwHostNameLength);
    std::wstring path(parts.lpszUrlPath, parts.dwUrlPathLength);
    if (parts.dwExtraInfoLength > 0) {
        path.append(parts.lpszExtraInfo, parts.dwExtraInfoLength);
    }
    if (path.empty()) { path = L"/"; }
    logLine(1, "Connecting to " + utf8Text(host) + ":" + std::to_string(parts.nPort)
        + utf8Text(path) + (parts.nScheme == INTERNET_SCHEME_HTTPS ? " (encrypted)" : " (not encrypted)"));

    HINTERNET session = WinHttpOpen(L"RKTacticalCompanion/" RK_COMPANION_VERSION,
        WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS, 0);
    if (!session) { fail("opening WinHTTP"); return false; }
    WinHttpSetTimeouts(session, 3000, 3000, 3000, 2000);
    HINTERNET connection = WinHttpConnect(session, host.c_str(),
        parts.nPort, 0);
    if (!connection) {
        fail("connecting");
        WinHttpCloseHandle(session);
        return false;
    }

    const DWORD flags = parts.nScheme == INTERNET_SCHEME_HTTPS
        ? WINHTTP_FLAG_SECURE : 0;
    HINTERNET request = WinHttpOpenRequest(connection, L"GET", path.c_str(),
        nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, flags);
    if (!request) {
        fail("creating the request");
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        return false;
    }
    const char* step = "switching to WebSocket";
    bool ok = WinHttpSetOption(request, WINHTTP_OPTION_UPGRADE_TO_WEB_SOCKET, nullptr, 0) != FALSE;
    if (ok) {
        step = "sending the request";
        ok = WinHttpSendRequest(request, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
            WINHTTP_NO_REQUEST_DATA, 0, 0, 0) != FALSE;
    }
    if (ok) {
        step = "waiting for the server's answer";
        ok = WinHttpReceiveResponse(request, nullptr) != FALSE;
    }
    if (!ok) {
        fail(step);
        WinHttpCloseHandle(request);
        WinHttpCloseHandle(connection);
        WinHttpCloseHandle(session);
        return false;
    }
    DWORD statusCode = 0;
    DWORD statusSize = sizeof(statusCode);
    WinHttpQueryHeaders(request, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &statusSize, WINHTTP_NO_HEADER_INDEX);
    HINTERNET socket = WinHttpWebSocketCompleteUpgrade(request, 0);
    WinHttpCloseHandle(request);
    if (!socket) {
        logLine(1, "The server answered HTTP " + std::to_string(statusCode)
            + " instead of switching to WebSocket (" + describeWinHttpError(GetLastError()) + ")");
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

std::string MultiplayerClient::makeHello() const {
    std::lock_guard<std::mutex> lock(nameMutex_);
    std::ostringstream out;
    out << "{\"type\":\"hello\",\"protocol\":3"
        << ",\"id\":\"" << jsonEscape(utf8(config_.playerId)) << "\""
        << ",\"name\":\"" << jsonEscape(utf8(config_.displayName)) << "\""
        << ",\"client\":\"RKTacticalCompanion/" << utf8(RK_COMPANION_VERSION) << "\"}";
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
    if (text.find("\"type\":\"welcome\"") != std::string::npos) {
        std::string assigned;
        if (jsonString(text, "name", assigned) && !assigned.empty()) {
            std::string requested;
            {
                std::lock_guard<std::mutex> lock(nameMutex_);
                requested = utf8(config_.displayName);
            }
            if (assigned == requested) {
                say("You are flying as \"" + assigned + "\".");
            } else {
                say("Someone is already using \"" + requested + "\", so you are flying as \"" + assigned + "\".");
            }
        } else {
            logLine(1, "Relay welcome received.");
        }
        return;
    }
    if (text.find("\"type\":\"error\"") != std::string::npos) {
        say("The relay sent an error: " + text.substr(0, 200));
        noteReason("the relay reported an error");
        return;
    }
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
        if (event.eventType < 1u || event.eventType > 9u
            || event.weaponType < 1u || event.weaponType > 5u
            || !finiteIn(latitude, -90.0, 90.0)
            || !finiteIn(longitude, -180.0, 180.0)
            || !finiteIn(altitudeFt, -2000.0, 200000.0)
            || !finiteIn(headingDeg, -360.0, 720.0)
            || !finiteIn(damage, 0.0, 1000.0)
            || !finiteIn(duration, 0.0, 300.0)
            || !finiteIn(missDistance, 0.0, 10000000.0)) {
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
        ++combatIn_;
        if (event.eventType != 5u) {
            logLine(1, "Combat received: event " + std::to_string(event.eventType) + " weapon "
                + std::to_string(event.weaponType) + " from " + std::to_string(event.sourceContactId)
                + " target " + std::to_string(event.targetContactId)
                + ((event.flags & kCombatFlagLocalTarget) ? " (this pilot is the target)" : ""));
        }
        return;
    }
}

void MultiplayerClient::noteReason(const std::string& reason) {
    std::lock_guard<std::mutex> lock(reasonMutex_);
    if (endReason_.empty()) { endReason_ = reason; }
}

std::string MultiplayerClient::takeReason() {
    std::lock_guard<std::mutex> lock(reasonMutex_);
    std::string reason;
    reason.swap(endReason_);
    return reason;
}

} // namespace rk
