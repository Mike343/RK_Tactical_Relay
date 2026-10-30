#include "Config.h"

#define NOMINMAX
#include <windows.h>
#include <objbase.h>

#include <algorithm>
#include <fstream>
#include <iostream>
#include <sstream>
#include <system_error>

namespace rk {
namespace {

std::filesystem::path executableDirectory() {
    std::wstring path(32768, L'\0');
    const DWORD length = GetModuleFileNameW(nullptr, path.data(),
        static_cast<DWORD>(path.size()));
    path.resize(length);
    return std::filesystem::path(path).parent_path();
}

std::wstring readIni(const std::filesystem::path& path,
    const wchar_t* key, const wchar_t* fallback) {
    std::wstring value(2048, L'\0');
    const std::wstring pathText = path.wstring();
    const DWORD length = GetPrivateProfileStringW(L"companion", key, fallback,
        value.data(), static_cast<DWORD>(value.size()), pathText.c_str());
    value.resize(length);
    return value;
}

std::wstring trim(const std::wstring& value) {
    const auto first = value.find_first_not_of(L" \t\r\n");
    if (first == std::wstring::npos) { return {}; }
    const auto last = value.find_last_not_of(L" \t\r\n");
    return value.substr(first, last - first + 1);
}

bool validRelayUrl(const std::wstring& url) {
    return url.rfind(L"ws://", 0) == 0 || url.rfind(L"wss://", 0) == 0;
}

std::wstring cleanPlayerId(const std::wstring& value) {
    std::wstring result;
    for (const wchar_t c : value) {
        const bool allowed = (c >= L'A' && c <= L'Z') || (c >= L'a' && c <= L'z')
            || (c >= L'0' && c <= L'9') || c == L'_' || c == L'-' || c == L'.';
        if (allowed && result.size() < 64) { result.push_back(c); }
    }
    return result;
}

float parseVolume(const std::wstring& value, float fallback) {
    try {
        const float parsed = std::stof(value);
        return (std::max)(0.0f, (std::min)(2.0f, parsed));
    } catch (...) {
        return fallback;
    }
}

std::wstring createGuidText() {
    GUID guid{};
    if (FAILED(CoCreateGuid(&guid))) { return L"rk-player"; }
    wchar_t text[40]{};
    StringFromGUID2(guid, text, 40);
    std::wstring result(text);
    result.erase(std::remove(result.begin(), result.end(), L'{'), result.end());
    result.erase(std::remove(result.begin(), result.end(), L'}'), result.end());
    return result;
}

std::wstring loadOrCreatePlayerId(const std::filesystem::path& directory,
    const std::wstring& configured) {
    if (!configured.empty()) { return configured; }
    const auto path = directory / L"companion_id.txt";
    {
        std::wifstream input(path);
        std::wstring value;
        std::getline(input, value);
        if (!value.empty()) { return value; }
    }
    const std::wstring value = createGuidText();
    std::wofstream output(path, std::ios::trunc);
    output << value << L"\n";
    return value;
}

bool isManagedSimConnectCfg(const std::string& text) {
    std::istringstream lines(text);
    std::string line;
    int count = 0;
    while (std::getline(lines, line)) {
        if (!line.empty() && line.back() == '\r') { line.pop_back(); }
        if (line.empty()) { continue; }
        const bool expected = (count == 0 && line == "[SimConnect]")
            || (count == 1 && line == "Protocol=IPv4")
            || (count == 2 && line.rfind("Address=", 0) == 0)
            || (count == 3 && line.rfind("Port=", 0) == 0);
        if (!expected) { return false; }
        ++count;
    }
    return count == 4;
}

} // namespace

std::wstring cleanDisplayName(const std::wstring& value) {
    std::wstring result;
    for (const wchar_t c : value) {
        if (c >= 32 && c != 127) { result.push_back(c); }
    }
    result = trim(result);
    if (result.size() > 40) { result.resize(40); }
    return result;
}

bool validSimConnectHost(const std::wstring& host) {
    if (host.empty() || host.size() > 253) { return false; }
    for (const wchar_t c : host) {
        const bool allowed = (c >= L'A' && c <= L'Z') || (c >= L'a' && c <= L'z')
            || (c >= L'0' && c <= L'9') || c == L'.' || c == L'-';
        if (!allowed) { return false; }
    }
    return host != L"0.0.0.0" && host != L"255.255.255.255"
        && host.front() != L'.' && host.back() != L'.';
}

bool saveDisplayName(const CompanionConfig& config, const std::wstring& name) {
    const std::wstring ini = (config.executableDirectory / L"companion.ini").wstring();
    return WritePrivateProfileStringW(L"companion", L"display_name",
        name.c_str(), ini.c_str()) != FALSE;
}

void applySimConnectConfig(const CompanionConfig& config) {
    SetCurrentDirectoryW(config.executableDirectory.c_str());
    const auto path = config.executableDirectory / L"SimConnect.cfg";
    if (!config.simConnectHost.empty()) {
        std::string host;
        for (const wchar_t c : config.simConnectHost) { host.push_back(static_cast<char>(c)); }
        std::ofstream out(path, std::ios::binary | std::ios::trunc);
        out << "[SimConnect]\r\nProtocol=IPv4\r\nAddress=" << host
            << "\r\nPort=" << config.simConnectPort << "\r\n";
        if (!out) {
            std::wcerr << L"Unable to write SimConnect.cfg, so the remote MSFS address won't be used.\n";
        }
        return;
    }
    std::ifstream in(path, std::ios::binary);
    if (!in) { return; }
    std::stringstream buffer;
    buffer << in.rdbuf();
    in.close();
    if (isManagedSimConnectCfg(buffer.str())) {
        std::error_code ignored;
        std::filesystem::remove(path, ignored);
    }
}

CompanionConfig loadConfig() {
    CompanionConfig config;
    config.executableDirectory = executableDirectory();
    const auto ini = config.executableDirectory / L"companion.ini";
    const std::wstring configuredName = trim(readIni(ini, L"display_name", L""));
    config.askForName = configuredName.empty() || configuredName == L"RK Client"
        || configuredName == L"RK Pilot";
    config.displayName = cleanDisplayName(configuredName);
    if (config.displayName.empty()) { config.displayName = L"RK Pilot"; }
    const std::wstring host = trim(readIni(ini, L"simconnect_host", L""));
    if (!host.empty() && host != L"localhost" && host != L"127.0.0.1") {
        if (validSimConnectHost(host)) {
            config.simConnectHost = host;
        } else {
            std::wcerr << L"simconnect_host isn't a valid address, so MSFS is expected on this PC: "
                << host << L"\n";
        }
    }
    try {
        const int port = std::stoi(readIni(ini, L"simconnect_port", L"500"));
        if (port >= 1 && port <= 65535) { config.simConnectPort = port; }
    } catch (...) {
    }
    config.relayUrl = trim(readIni(ini, L"relay_url", L""));
    if (!config.relayUrl.empty() && !validRelayUrl(config.relayUrl)) {
        std::wcerr << L"relay_url must start with ws:// or wss://, so multiplayer is off: "
            << config.relayUrl << L"\n";
        config.relayUrl.clear();
    }
    config.launchVolume = parseVolume(
        readIni(ini, L"launch_volume", L"1.0"), 1.0f);
    config.activeVolume = parseVolume(
        readIni(ini, L"active_volume", L"0.85"), 0.85f);
    config.playerId = loadOrCreatePlayerId(config.executableDirectory,
        cleanPlayerId(readIni(ini, L"player_id", L"")));
    config.launchSoundPath = config.executableDirectory
        / L"Audio" / L"enemy_missile_launch.wav";
    config.activeSoundPath = config.executableDirectory
        / L"Audio" / L"enemy_missile_in_air_loop.wav";
    return config;
}

} // namespace rk
