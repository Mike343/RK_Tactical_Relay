#pragma once

#include <filesystem>
#include <string>

namespace rk {

void logInit(const std::filesystem::path& directory, int level);
void logLine(int level, const std::string& text);
void say(const std::string& text);
std::string shortId(const std::wstring& id);
std::string utf8Text(const std::wstring& value);
std::string describeWinHttpError(unsigned long code);

} // namespace rk
