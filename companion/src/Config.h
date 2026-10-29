#pragma once

#include <filesystem>
#include <string>

namespace rk {

struct CompanionConfig {
    std::wstring displayName = L"RK Pilot";
    std::wstring playerId;
    std::wstring relayUrl;
    float launchVolume = 1.0f;
    float activeVolume = 0.85f;
    std::filesystem::path executableDirectory;
    std::filesystem::path launchSoundPath;
    std::filesystem::path activeSoundPath;
};

CompanionConfig loadConfig();

} // namespace rk
