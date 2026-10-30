#include "Config.h"
#include <windows.h>
#include <fstream>
#include <iostream>
#include <sstream>

static int failures = 0;

static void check(bool ok, const char* what) {
    std::cout << (ok ? "PASS " : "FAIL ") << what << "\n";
    if (!ok) { ++failures; }
}

static void writeIni(const std::filesystem::path& dir, const std::string& body) {
    std::ofstream out(dir / L"companion.ini", std::ios::trunc);
    out << "[companion]\n" << body;
}

static std::string readFile(const std::filesystem::path& path) {
    std::ifstream in(path, std::ios::binary);
    std::stringstream s;
    s << in.rdbuf();
    return s.str();
}

int main() {
    wchar_t exe[MAX_PATH]{};
    GetModuleFileNameW(nullptr, exe, MAX_PATH);
    const auto dir = std::filesystem::path(exe).parent_path();
    const auto cfg = dir / L"SimConnect.cfg";
    std::filesystem::remove(cfg);
    std::filesystem::remove(dir / L"companion_id.txt");

    writeIni(dir, "display_name=RK Client\nrelay_url=ws://example.test:8787\n");
    auto config = rk::loadConfig();
    check(config.askForName, "default name asks for a name");
    check(config.simConnectHost.empty() && config.simConnectPort == 500, "no host means this PC");
    rk::applySimConnectConfig(config);
    check(!std::filesystem::exists(cfg), "no SimConnect.cfg for this PC");

    check(rk::saveDisplayName(config, L"Maverick"), "name saved to the ini");
    config = rk::loadConfig();
    check(!config.askForName && config.displayName == L"Maverick", "saved name is read back and not asked again");

    writeIni(dir, "display_name=Goose\nsimconnect_host=192.168.1.50\nsimconnect_port=5000\n");
    config = rk::loadConfig();
    check(config.simConnectHost == L"192.168.1.50" && config.simConnectPort == 5000, "remote host and port are read");
    rk::applySimConnectConfig(config);
    check(readFile(cfg) == "[SimConnect]\r\nProtocol=IPv4\r\nAddress=192.168.1.50\r\nPort=5000\r\n", "SimConnect.cfg is written for the remote PC");

    writeIni(dir, "display_name=Goose\n");
    config = rk::loadConfig();
    rk::applySimConnectConfig(config);
    check(!std::filesystem::exists(cfg), "our SimConnect.cfg is removed when the host is cleared");

    { std::ofstream own(cfg, std::ios::binary); own << "[SimConnect]\r\nProtocol=Pipe\r\n"; }
    rk::applySimConnectConfig(config);
    check(std::filesystem::exists(cfg), "a SimConnect.cfg we didn't write is left alone");
    std::filesystem::remove(cfg);

    writeIni(dir, "simconnect_host=bad host;x\nsimconnect_port=99999\n");
    config = rk::loadConfig();
    check(config.simConnectHost.empty() && config.simConnectPort == 500, "bad host and port fall back to this PC");
    check(rk::validSimConnectHost(L"sim-pc.local") && !rk::validSimConnectHost(L"0.0.0.0") && !rk::validSimConnectHost(L"a/b"), "host validation");
    check(rk::cleanDisplayName(L"  Very Long Name That Goes On And On And On And On  ").size() == 40, "names are capped at 40");

    std::filesystem::remove(dir / L"companion.ini");
    std::filesystem::remove(dir / L"companion_id.txt");
    return failures == 0 ? 0 : 1;
}
