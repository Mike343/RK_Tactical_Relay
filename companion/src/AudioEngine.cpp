#include "AudioEngine.h"

#define NOMINMAX
#include <windows.h>
#include <xaudio2.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <vector>

namespace rk {
namespace {

struct WaveAsset {
    WAVEFORMATEX format{};
    std::vector<std::uint8_t> samples;
};

std::uint32_t fourcc(char a, char b, char c, char d) {
    return static_cast<std::uint32_t>(static_cast<unsigned char>(a))
        | (static_cast<std::uint32_t>(static_cast<unsigned char>(b)) << 8)
        | (static_cast<std::uint32_t>(static_cast<unsigned char>(c)) << 16)
        | (static_cast<std::uint32_t>(static_cast<unsigned char>(d)) << 24);
}

bool readU32(std::ifstream& input, std::uint32_t& value) {
    input.read(reinterpret_cast<char*>(&value), sizeof(value));
    return input.good();
}

bool loadPcmWave(const std::filesystem::path& path, WaveAsset& asset) {
    std::ifstream input(path, std::ios::binary);
    if (!input) { return false; }

    std::uint32_t riff = 0, riffSize = 0, wave = 0;
    if (!readU32(input, riff) || !readU32(input, riffSize)
        || !readU32(input, wave)
        || riff != fourcc('R', 'I', 'F', 'F')
        || wave != fourcc('W', 'A', 'V', 'E')) {
        return false;
    }

    bool haveFormat = false;
    bool haveData = false;
    while (input && (!haveFormat || !haveData)) {
        std::uint32_t chunkId = 0, chunkSize = 0;
        if (!readU32(input, chunkId) || !readU32(input, chunkSize)) { break; }
        if (chunkId == fourcc('f', 'm', 't', ' ')) {
            if (chunkSize < 16) { return false; }
            std::vector<std::uint8_t> bytes(chunkSize);
            input.read(reinterpret_cast<char*>(bytes.data()), chunkSize);
            if (!input) { return false; }
            std::memcpy(&asset.format, bytes.data(), 16);
            asset.format.cbSize = 0;
            haveFormat = true;
        } else if (chunkId == fourcc('d', 'a', 't', 'a')) {
            asset.samples.resize(chunkSize);
            input.read(reinterpret_cast<char*>(asset.samples.data()), chunkSize);
            if (!input) { return false; }
            haveData = true;
        } else {
            input.seekg(chunkSize, std::ios::cur);
        }
        if ((chunkSize & 1u) != 0) { input.seekg(1, std::ios::cur); }
    }

    return haveFormat && haveData && asset.format.wFormatTag == WAVE_FORMAT_PCM
        && asset.format.nChannels > 0 && asset.format.nSamplesPerSec > 0
        && !asset.samples.empty();
}

} // namespace

struct AudioEngine::Impl {
    IXAudio2* engine = nullptr;
    IXAudio2MasteringVoice* mastering = nullptr;
    std::array<IXAudio2SourceVoice*, 4> launchVoices{};
    IXAudio2SourceVoice* activeVoice = nullptr;
    IXAudio2SourceVoice* gunVoice = nullptr;
    std::array<IXAudio2SourceVoice*, 16> explosionVoices{};
    std::size_t explosionCursor=0;
    WaveAsset gun, explosion;
    bool gunPlaying = false;
    bool battleInitialized = false;
    std::uint32_t lastExplosion = 0;
    WaveAsset launch;
    WaveAsset active;
    std::size_t launchCursor = 0;
    bool activePlaying = false;
    float launchVolume = 1.0f;
    float activeVolume = 0.85f;
};

AudioEngine::AudioEngine() : impl_(std::make_unique<Impl>()) {}
AudioEngine::~AudioEngine() { shutdown(); }

bool AudioEngine::initialize(const std::filesystem::path& launchPath,
    const std::filesystem::path& activePath,
    float launchVolume, float activeVolume) {
    shutdown();
    impl_ = std::make_unique<Impl>();
    impl_->launchVolume = launchVolume;
    impl_->activeVolume = activeVolume;

    if (!loadPcmWave(launchPath, impl_->launch)) {
        std::wcerr << L"Unable to load launch WAV: " << launchPath << L"\n";
        return false;
    }
    if (!loadPcmWave(activePath, impl_->active)) {
        std::wcerr << L"Unable to load active-warning WAV: " << activePath << L"\n";
        return false;
    }
    if (FAILED(XAudio2Create(&impl_->engine, 0, XAUDIO2_DEFAULT_PROCESSOR))) {
        std::cerr << "XAudio2Create failed.\n";
        return false;
    }
    const HRESULT masteringResult =
        impl_->engine->CreateMasteringVoice(&impl_->mastering);
    if (FAILED(masteringResult)) {
        std::cerr << "CreateMasteringVoice failed with HRESULT 0x"
            << std::hex << std::uppercase
            << static_cast<unsigned long>(masteringResult)
            << std::nouppercase << std::dec << "\n";
        shutdown();
        return false;
    }
    for (auto& voice : impl_->launchVoices) {
        if (FAILED(impl_->engine->CreateSourceVoice(
            &voice, &impl_->launch.format, 0, 1.0f))) {
            std::cerr << "Unable to create a launch voice.\n";
            shutdown();
            return false;
        }
        voice->SetVolume(impl_->launchVolume);
        voice->SetFrequencyRatio(1.0f);
    }
    if (FAILED(impl_->engine->CreateSourceVoice(
        &impl_->activeVoice, &impl_->active.format, 0, 1.0f))) {
        std::cerr << "Unable to create the active-warning voice.\n";
        shutdown();
        return false;
    }
    impl_->activeVoice->SetVolume(impl_->activeVolume);
    impl_->activeVoice->SetFrequencyRatio(1.0f);
    return true;
}

void AudioEngine::playLaunch() {
    if (!ready()) { return; }
    IXAudio2SourceVoice* voice = impl_->launchVoices[
        impl_->launchCursor++ % impl_->launchVoices.size()];
    voice->Stop(0);
    voice->FlushSourceBuffers();
    XAUDIO2_BUFFER buffer{};
    buffer.AudioBytes = static_cast<UINT32>(impl_->launch.samples.size());
    buffer.pAudioData = impl_->launch.samples.data();
    buffer.Flags = XAUDIO2_END_OF_STREAM;
    if (SUCCEEDED(voice->SubmitSourceBuffer(&buffer))) { voice->Start(0); }
}

void AudioEngine::setMissileActive(bool active) {
    if (!ready() || impl_->activePlaying == active) { return; }
    if (active) {
        impl_->activeVoice->Stop(0);
        impl_->activeVoice->FlushSourceBuffers();
        XAUDIO2_BUFFER buffer{};
        buffer.AudioBytes = static_cast<UINT32>(impl_->active.samples.size());
        buffer.pAudioData = impl_->active.samples.data();
        buffer.LoopCount = XAUDIO2_LOOP_INFINITE;
        if (SUCCEEDED(impl_->activeVoice->SubmitSourceBuffer(&buffer))) {
            impl_->activeVoice->Start(0);
            impl_->activePlaying = true;
        }
    } else {
        impl_->activeVoice->Stop(0);
        impl_->activeVoice->FlushSourceBuffers();
        impl_->activePlaying = false;
    }
}

bool AudioEngine::initializeBattlefield(const std::filesystem::path& directory) {
    if(!ready()) return false;
    if(!loadPcmWave(directory / L"brrrt.wav",impl_->gun)
        || !loadPcmWave(directory / L"Explosion.wav",impl_->explosion)) return false;
    if(FAILED(impl_->engine->CreateSourceVoice(&impl_->gunVoice,&impl_->gun.format,0,1.0f))) return false;
    for(auto& voice:impl_->explosionVoices)
        if(FAILED(impl_->engine->CreateSourceVoice(&voice,&impl_->explosion.format,0,1.0f))) return false;
    return true;
}
void AudioEngine::updateBattlefield(std::uint32_t word) {
    if(!impl_->gunVoice || !impl_->explosionVoices[0]) return;
    const auto sequence=word>>16;
    const float gun=static_cast<float>((word>>8)&255u)/255.0f;
    const float blast=static_cast<float>(word&255u)/255.0f;
    impl_->gunVoice->SetVolume(gun);

    if(gun>0 && !impl_->gunPlaying){
        XAUDIO2_BUFFER buffer{};
        buffer.AudioBytes=static_cast<UINT32>(impl_->gun.samples.size());
        buffer.pAudioData=impl_->gun.samples.data();buffer.LoopCount=XAUDIO2_LOOP_INFINITE;
        if(SUCCEEDED(impl_->gunVoice->SubmitSourceBuffer(&buffer))){impl_->gunVoice->Start(0);impl_->gunPlaying=true;}
    } else if(gun<=0 && impl_->gunPlaying){
        impl_->gunVoice->Stop(0);impl_->gunVoice->FlushSourceBuffers();impl_->gunPlaying=false;
    }
    if(impl_->battleInitialized && sequence!=impl_->lastExplosion && blast>0){
        auto* voice=impl_->explosionVoices[impl_->explosionCursor++ % impl_->explosionVoices.size()];
        voice->Stop(0);voice->FlushSourceBuffers();voice->SetVolume(blast);
        XAUDIO2_BUFFER buffer{};buffer.AudioBytes=static_cast<UINT32>(impl_->explosion.samples.size());
        buffer.pAudioData=impl_->explosion.samples.data();buffer.Flags=XAUDIO2_END_OF_STREAM;
        if(SUCCEEDED(voice->SubmitSourceBuffer(&buffer))) voice->Start(0);
    }
    impl_->lastExplosion=sequence;impl_->battleInitialized=true;
}
void AudioEngine::stopBattlefield() {
    if(!impl_->gunPlaying && !impl_->battleInitialized) return;
    if(impl_->gunVoice){impl_->gunVoice->Stop(0);impl_->gunVoice->FlushSourceBuffers();}
    for(auto* voice:impl_->explosionVoices)if(voice){voice->Stop(0);voice->FlushSourceBuffers();}
    impl_->gunPlaying=false;impl_->battleInitialized=false;
}

void AudioEngine::shutdown() {
    if (!impl_) { return; }
    stopBattlefield();
    if(impl_->gunVoice){impl_->gunVoice->DestroyVoice();impl_->gunVoice=nullptr;}
    for(auto& voice:impl_->explosionVoices)if(voice){voice->DestroyVoice();voice=nullptr;}
    if (impl_->activeVoice) {
        impl_->activeVoice->Stop(0);
        impl_->activeVoice->DestroyVoice();
        impl_->activeVoice = nullptr;
    }
    for (auto& voice : impl_->launchVoices) {
        if (voice) {
            voice->Stop(0);
            voice->DestroyVoice();
            voice = nullptr;
        }
    }
    if (impl_->mastering) {
        impl_->mastering->DestroyVoice();
        impl_->mastering = nullptr;
    }
    if (impl_->engine) {
        impl_->engine->Release();
        impl_->engine = nullptr;
    }
    impl_->activePlaying = false;
}

bool AudioEngine::ready() const {
    return impl_ && impl_->engine && impl_->mastering && impl_->activeVoice;
}

} // namespace rk
