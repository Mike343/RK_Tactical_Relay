#pragma once

#include <filesystem>
#include <string>

namespace rk {

struct CompanionConfig {
    std::wstring displayName = L"RK Pilot";
    std::wstring playerId;
    std::wstring relayUrl;
    std::wstring simConnectHost;
    int simConnectPort = 500;
    bool askForName = false;
    int logLevel = 1;
    float launchVolume = 1.0f;
    float activeVolume = 0.85f;
    std::filesystem::path executableDirectory;
    std::filesystem::path launchSoundPath;
    std::filesystem::path activeSoundPath;
};

CompanionConfig loadConfig();
std::wstring cleanDisplayName(const std::wstring& value);
bool validSimConnectHost(const std::wstring& host);
bool saveDisplayName(const CompanionConfig& config, const std::wstring& name);
void applySimConnectConfig(const CompanionConfig& config);

} // namespace rk
