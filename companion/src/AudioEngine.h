#pragma once

#include <filesystem>
#include <memory>
#include <cstdint>

namespace rk {

class AudioEngine {
public:
    AudioEngine();
    ~AudioEngine();
    AudioEngine(const AudioEngine&) = delete;
    AudioEngine& operator=(const AudioEngine&) = delete;

    bool initialize(const std::filesystem::path& launchPath,
        const std::filesystem::path& activePath,
        float launchVolume, float activeVolume);
    void playLaunch();
    void setMissileActive(bool active);
    bool initializeBattlefield(const std::filesystem::path& directory);
    void updateBattlefield(std::uint32_t word);
    void stopBattlefield();
    void shutdown();
    bool ready() const;

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace rk
