#include "Config.h"

#define NOMINMAX
#include <windows.h>
#include <objbase.h>

#include <algorithm>
#include <fstream>
#include <sstream>

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

} // namespace

CompanionConfig loadConfig() {
    CompanionConfig config;
    config.executableDirectory = executableDirectory();
    const auto ini = config.executableDirectory / L"companion.ini";
    config.displayName = readIni(ini, L"display_name", L"RK Pilot");
    config.relayUrl = readIni(ini, L"relay_url", L"");
    config.launchVolume = parseVolume(
        readIni(ini, L"launch_volume", L"1.0"), 1.0f);
    config.activeVolume = parseVolume(
        readIni(ini, L"active_volume", L"0.85"), 0.85f);
    config.playerId = loadOrCreatePlayerId(config.executableDirectory,
        readIni(ini, L"player_id", L""));
    config.launchSoundPath = config.executableDirectory
        / L"Audio" / L"enemy_missile_launch.wav";
    config.activeSoundPath = config.executableDirectory
        / L"Audio" / L"enemy_missile_in_air_loop.wav";
    return config;
}

} // namespace rk
