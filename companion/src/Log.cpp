#include "Log.h"
#include "Version.h"

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winhttp.h>

#include <chrono>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <system_error>

namespace rk {
namespace {

std::mutex g_mutex;
std::ofstream g_file;
int g_level = 1;
std::filesystem::path g_path;

constexpr std::uintmax_t kMaxBytes = 2u * 1024u * 1024u;

std::string timestamp() {
    SYSTEMTIME t{};
    GetLocalTime(&t);
    char buffer[40];
    std::snprintf(buffer, sizeof(buffer), "%04d-%02d-%02d %02d:%02d:%02d.%03d",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond, t.wMilliseconds);
    return buffer;
}

bool openAt(const std::filesystem::path& path) {
    std::error_code ignored;
    if (std::filesystem::exists(path, ignored) && std::filesystem::file_size(path, ignored) > kMaxBytes) {
        const auto old = path.wstring() + L".1";
        std::filesystem::remove(old, ignored);
        std::filesystem::rename(path, old, ignored);
    }
    g_file.open(path, std::ios::app);
    if (g_file) { g_path = path; }
    return static_cast<bool>(g_file);
}

} // namespace

std::string utf8Text(const std::wstring& value) {
    if (value.empty()) { return {}; }
    const int length = WideCharToMultiByte(CP_UTF8, 0, value.c_str(),
        static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    std::string result(static_cast<std::size_t>(length), '\0');
    WideCharToMultiByte(CP_UTF8, 0, value.c_str(), static_cast<int>(value.size()),
        result.data(), length, nullptr, nullptr);
    return result;
}

std::string shortId(const std::wstring& id) {
    const std::string text = utf8Text(id);
    return text.size() > 8 ? text.substr(0, 8) + "..." : text;
}

std::string describeWinHttpError(unsigned long code) {
    switch (code) {
    case 12002: return "12002 the request timed out";
    case 12007: return "12007 the server name could not be resolved (DNS)";
    case 12029: return "12029 could not connect (blocked port, firewall or server down)";
    case 12030: return "12030 the connection was dropped";
    case 12038: return "12038 the certificate name does not match";
    case 12044: return "12044 the server asked for a client certificate";
    case 12157: return "12157 a secure connection could not be set up (TLS)";
    case 12175: return "12175 the secure connection failed";
    case 12152: return "12152 the server sent an unexpected reply";
    case 12017: return "12017 the request was cancelled";
    default: return std::to_string(code);
    }
}

void logInit(const std::filesystem::path& directory, int level) {
    std::lock_guard<std::mutex> lock(g_mutex);
    g_level = level;
    if (level <= 0) { return; }
    if (!openAt(directory / L"companion.log")) {
        wchar_t* appData = nullptr;
        std::filesystem::path fallback;
        const DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", nullptr, 0);
        if (length > 0) {
            std::wstring value(length, L'\0');
            GetEnvironmentVariableW(L"LOCALAPPDATA", value.data(), length);
            value.resize(length - 1);
            fallback = std::filesystem::path(value) / L"RKTacticalCompanion";
            std::error_code ignored;
            std::filesystem::create_directories(fallback, ignored);
            openAt(fallback / L"companion.log");
        }
        (void)appData;
    }
    if (g_file) {
        g_file << "\n==== " << timestamp() << " RK Tactical Companion "
            << utf8Text(RK_COMPANION_VERSION) << " log started ====\n";
        g_file.flush();
        std::cout << "Logging to " << g_path.string() << " (log_level=" << level << ")\n";
    } else {
        std::cout << "Could not open companion.log, so logging is off.\n";
    }
}

void logLine(int level, const std::string& text) {
    std::lock_guard<std::mutex> lock(g_mutex);
    if (!g_file || level > g_level) { return; }
    g_file << timestamp() << "  " << text << "\n";
    g_file.flush();
}

void say(const std::string& text) {
    std::cout << text << "\n";
    logLine(1, text);
}

} // namespace rk
