#pragma once

#include <stdint.h>

namespace dental { namespace storage_diagnostics {

enum class LineShape : uint8_t { kUnknown, kExpected, kTruncated, kMerged };

struct LineStructure {
  uint16_t length = 0U;
  bool dataPrefixIntact = false;
  bool firstColonPresent = false;
  bool secondColonPresent = false;
  bool offsetTextAvailable = false;
  bool offsetValidHex = false;
  char offsetText[4] = {};
  bool newlineTerminated = false;
  bool printableValidationFailed = false;
  uint16_t unexpectedBytes = 0U;
  LineShape shape = LineShape::kUnknown;
};

// Tracks only line structure. Payload bytes are counted but never retained.
class LineStructureTracker {
 public:
  bool receive(uint8_t byte) {
    if (byte == '\n') {
      last_ = current_;
      last_.newlineTerminated = true;
      classify(last_);
      current_ = LineStructure{};
      prefixMatches_ = true;
      return true;
    }

    const uint16_t position = current_.length;
    if (position != 0xFFFFU) ++current_.length;
    if (byte < 0x20U || byte > 0x7EU) {
      current_.printableValidationFailed = true;
      if (current_.unexpectedBytes != 0xFFFFU) ++current_.unexpectedBytes;
    }

    static constexpr char kDataPrefix[] = "SD:DATA:";
    if (position < sizeof(kDataPrefix) - 1U &&
        byte != static_cast<uint8_t>(kDataPrefix[position]))
      prefixMatches_ = false;
    if (position == 7U) current_.firstColonPresent = byte == ':';
    if (position >= 8U && position <= 10U) {
      current_.offsetText[position - 8U] =
          byte >= 0x20U && byte <= 0x7EU ? static_cast<char>(byte) : '?';
      if (position == 10U) {
        current_.offsetText[3] = '\0';
        current_.offsetTextAvailable = true;
      }
    }
    if (position == 11U) current_.secondColonPresent = byte == ':';
    current_.dataPrefixIntact = prefixMatches_ && current_.length >= 8U;
    return false;
  }

  const LineStructure& last() const { return last_; }

 private:
  static int8_t hex(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    return -1;
  }

  static void classify(LineStructure& line) {
    if (!line.offsetTextAvailable) return;
    const int8_t high = hex(line.offsetText[0]);
    const int8_t middle = hex(line.offsetText[1]);
    const int8_t low = hex(line.offsetText[2]);
    if (high < 0 || middle < 0 || low < 0) return;
    line.offsetValidHex = true;
    const uint16_t offset = static_cast<uint16_t>(
        (static_cast<uint16_t>(high) << 8U) |
        (static_cast<uint16_t>(middle) << 4U) |
        static_cast<uint16_t>(low));
    const uint16_t expectedLength = offset == 504U ? 28U : 60U;
    if (line.length < expectedLength) line.shape = LineShape::kTruncated;
    else if (line.length > expectedLength) line.shape = LineShape::kMerged;
    else line.shape = LineShape::kExpected;
  }

  LineStructure current_;
  LineStructure last_;
  bool prefixMatches_ = true;
};

inline const char* lineShapeName(LineShape shape) {
  switch (shape) {
    case LineShape::kExpected: return "EXPECTED_LENGTH";
    case LineShape::kTruncated: return "TRUNCATED";
    case LineShape::kMerged: return "MERGED";
    default: return "UNKNOWN";
  }
}

} }  // namespace dental::storage_diagnostics
