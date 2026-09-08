#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace dental {
namespace cache {

constexpr char kActiveCachePath[] = "/inventory_cache.csv";
constexpr char kTemporaryCachePath[] = "/inventory_cache.tmp";
constexpr char kBackupCachePath[] = "/inventory_cache.bak";
constexpr char kCacheMagic[] = "DENTAL_INVENTORY_CACHE";
constexpr char kCacheColumns[] =
    "product_id,barcode,item_name,category,current_stock,"
    "low_stock_threshold,status";
constexpr char kCacheChecksumPrefix[] = "CACHE_CRC32,";
constexpr size_t kGenerationCapacity = 68U;  // "v1-" + SHA-256 + NUL.
constexpr size_t kProductIdCapacity = 32U;
constexpr size_t kMaximumBarcodeUtf16Units = 256U;
constexpr size_t kMaximumBarcodeUtf8Bytes = 1024U;
constexpr size_t kBarcodeCapacity = kMaximumBarcodeUtf8Bytes + 1U;
constexpr size_t kMaximumProductNameUtf16Units = 200U;
constexpr size_t kMaximumProductNameUtf8Bytes = 800U;
constexpr size_t kProductNameCapacity = kMaximumProductNameUtf8Bytes + 1U;
constexpr size_t kCategoryCapacity = 32U;
constexpr size_t kCacheLineCapacity = 2048U;
constexpr size_t kCacheRequestMaximumLength = 4096U;
constexpr uint32_t kMaximumCacheItems = 10000U;
constexpr uint64_t kMaximumStockValue = 9007199254740991ULL;

enum class StockStatus : uint8_t { kHigh, kLow, kEmpty };
enum class CacheOperation : uint8_t { kBegin, kItem, kCommit };

struct CacheProduct {
  char id[kProductIdCapacity];
  char barcode[kBarcodeCapacity];
  char name[kProductNameCapacity];
  char category[kCategoryCapacity];
  uint64_t currentStock;
  uint64_t lowStockThreshold;
  StockStatus status;
};

struct CacheRequest {
  CacheOperation operation;
  char generation[kGenerationCapacity];
  uint32_t itemCount;
  uint32_t index;
  CacheProduct product;
};

struct CacheMetadata {
  bool available;
  char generation[kGenerationCapacity];
  uint32_t itemCount;
};

enum class ReadLineResult : uint8_t { kLine, kEnd, kError, kTooLong };

// Only one read stream is needed at a time. The production adapter closes each
// write before replying, so every accepted item is durable without retaining
// the full snapshot in RAM.
class CacheStorage {
 public:
  virtual ~CacheStorage() {}
  virtual bool available() const = 0;
  virtual bool exists(const char* path) = 0;
  virtual bool remove(const char* path) = 0;
  virtual bool rename(const char* from, const char* to) = 0;
  virtual bool writeFile(const char* path, const char* data,
                         size_t length) = 0;
  virtual bool appendFile(const char* path, const char* data,
                          size_t length) = 0;
  virtual bool beginRead(const char* path) = 0;
  virtual ReadLineResult readLine(char* line, size_t capacity) = 0;
  virtual void endRead() = 0;
};

enum class BeginResult : uint8_t {
  kStarted,
  kAlreadyCurrent,
  kStorageUnavailable,
  kWriteFailed,
};

enum class ItemResult : uint8_t {
  kAccepted,
  kAlreadyAccepted,
  kNoTransfer,
  kGenerationMismatch,
  kUnexpectedIndex,
  kConflictingItem,
  kWriteFailed,
};

enum class CommitResult : uint8_t {
  kCommitted,
  kAlreadyCurrent,
  kNoTransfer,
  kGenerationMismatch,
  kCountMismatch,
  kValidationFailed,
  kReplacementFailed,
  kStorageUnavailable,
};

inline const char* stockStatusName(StockStatus status) {
  switch (status) {
    case StockStatus::kHigh: return "HIGH";
    case StockStatus::kLow: return "LOW";
    case StockStatus::kEmpty: return "EMPTY";
  }
  return "";
}

inline bool validGeneration(const char* generation) {
  if (generation == nullptr || strlen(generation) != 67U ||
      generation[0] != 'v' || generation[1] != '1' ||
      generation[2] != '-') {
    return false;
  }
  for (size_t index = 3U; index < 67U; ++index) {
    const char value = generation[index];
    if (!((value >= '0' && value <= '9') ||
          (value >= 'a' && value <= 'f'))) {
      return false;
    }
  }
  return true;
}

inline bool isTrimWhitespace(uint32_t codePoint) {
  return codePoint == 0x20U || codePoint == 0xA0U || codePoint == 0x1680U ||
         (codePoint >= 0x2000U && codePoint <= 0x200AU) ||
         codePoint == 0x2028U || codePoint == 0x2029U ||
         codePoint == 0x202FU || codePoint == 0x205FU ||
         codePoint == 0x3000U || codePoint == 0xFEFFU;
}

// Match the desktop's UTF-16 length limits while retaining UTF-8 bytes on the
// ESP32. Strict UTF-8 validation prevents malformed byte sequences from
// bypassing character/control bounds in either JSON or a recovered CSV file.
inline bool validBoundedText(const char* value, size_t maximumUtf16Units,
                             size_t maximumUtf8Bytes) {
  if (value == nullptr || value[0] == '\0') return false;
  size_t byteIndex = 0U;
  size_t utf16Units = 0U;
  bool hasNonWhitespace = false;
  while (value[byteIndex] != '\0') {
    const uint8_t first = static_cast<uint8_t>(value[byteIndex]);
    uint32_t codePoint = 0U;
    size_t byteCount = 0U;
    if (first <= 0x7FU) {
      codePoint = first;
      byteCount = 1U;
    } else if (first >= 0xC2U && first <= 0xDFU) {
      codePoint = first & 0x1FU;
      byteCount = 2U;
    } else if (first >= 0xE0U && first <= 0xEFU) {
      codePoint = first & 0x0FU;
      byteCount = 3U;
    } else if (first >= 0xF0U && first <= 0xF4U) {
      codePoint = first & 0x07U;
      byteCount = 4U;
    } else {
      return false;
    }

    for (size_t offset = 1U; offset < byteCount; ++offset) {
      const uint8_t continuation =
          static_cast<uint8_t>(value[byteIndex + offset]);
      if ((continuation & 0xC0U) != 0x80U) return false;
      codePoint = (codePoint << 6U) | (continuation & 0x3FU);
    }
    if ((byteCount == 3U && codePoint < 0x800U) ||
        (byteCount == 4U && codePoint < 0x10000U) ||
        (codePoint >= 0xD800U && codePoint <= 0xDFFFU) ||
        codePoint > 0x10FFFFU || codePoint < 0x20U ||
        codePoint == 0x7FU) {
      return false;
    }

    byteIndex += byteCount;
    if (byteIndex > maximumUtf8Bytes) return false;
    utf16Units += codePoint > 0xFFFFU ? 2U : 1U;
    if (utf16Units > maximumUtf16Units) return false;
    if (!isTrimWhitespace(codePoint)) hasNonWhitespace = true;
  }
  return hasNonWhitespace;
}

inline bool validDecimalProductId(const char* id) {
  if (id == nullptr || id[0] < '1' || id[0] > '9') return false;
  for (size_t index = 0U; id[index] != '\0'; ++index) {
    if (id[index] < '0' || id[index] > '9') return false;
  }
  return true;
}

inline bool validCategory(const char* category) {
  static const char* const categories[] = {
      "General", "Restorative & Esthetic", "Endodontics",
      "Prosthodontics", "Surgery", "Orthodontics"};
  for (size_t index = 0U;
       index < sizeof(categories) / sizeof(categories[0]); ++index) {
    if (strcmp(category, categories[index]) == 0) return true;
  }
  return false;
}

inline bool statusMatchesStock(const CacheProduct& product) {
  if (product.currentStock == 0ULL) {
    return product.status == StockStatus::kEmpty;
  }
  if (product.currentStock <= product.lowStockThreshold) {
    return product.status == StockStatus::kLow;
  }
  return product.status == StockStatus::kHigh;
}

inline bool validProduct(const CacheProduct& product) {
  return validDecimalProductId(product.id) &&
         validBoundedText(product.barcode, kMaximumBarcodeUtf16Units,
                          kMaximumBarcodeUtf8Bytes) &&
         validBoundedText(product.name, kMaximumProductNameUtf16Units,
                          kMaximumProductNameUtf8Bytes) &&
         validCategory(product.category) &&
         product.currentStock <= kMaximumStockValue &&
         product.lowStockThreshold <= kMaximumStockValue &&
         statusMatchesStock(product);
}

namespace detail {

class JsonReader {
 public:
  JsonReader(const char* text, size_t length)
      : text_(text), length_(length), index_(0U) {}

  void skipWhitespace() {
    while (index_ < length_) {
      const char value = text_[index_];
      if (value != ' ' && value != '\t' && value != '\r' && value != '\n') {
        return;
      }
      ++index_;
    }
  }

  bool consume(char expected) {
    skipWhitespace();
    if (index_ >= length_ || text_[index_] != expected) return false;
    ++index_;
    return true;
  }

  bool finished() {
    skipWhitespace();
    return index_ == length_;
  }

  bool unsignedInteger(uint64_t maximum, uint64_t& value) {
    skipWhitespace();
    if (index_ >= length_ || text_[index_] < '0' || text_[index_] > '9') {
      return false;
    }
    if (text_[index_] == '0' && index_ + 1U < length_ &&
        text_[index_ + 1U] >= '0' && text_[index_ + 1U] <= '9') {
      return false;
    }
    uint64_t parsed = 0ULL;
    do {
      const uint64_t digit = static_cast<uint64_t>(text_[index_] - '0');
      if (parsed > (maximum - digit) / 10ULL) return false;
      parsed = parsed * 10ULL + digit;
      ++index_;
    } while (index_ < length_ && text_[index_] >= '0' &&
             text_[index_] <= '9');
    value = parsed;
    return true;
  }

  bool string(char* value, size_t capacity) {
    if (capacity == 0U || !consume('"')) return false;
    size_t written = 0U;
    while (index_ < length_) {
      uint32_t codePoint = static_cast<uint8_t>(text_[index_++]);
      if (codePoint == '"') {
        value[written] = '\0';
        return true;
      }
      const bool wasEscape = codePoint == '\\';
      if (wasEscape) {
        if (index_ >= length_) return false;
        const char escaped = text_[index_++];
        switch (escaped) {
          case '"': codePoint = '"'; break;
          case '\\': codePoint = '\\'; break;
          case '/': codePoint = '/'; break;
          case 'b': codePoint = '\b'; break;
          case 'f': codePoint = '\f'; break;
          case 'n': codePoint = '\n'; break;
          case 'r': codePoint = '\r'; break;
          case 't': codePoint = '\t'; break;
          case 'u': {
            uint16_t first = 0U;
            if (!hexQuad(first)) return false;
            codePoint = first;
            if (first >= 0xD800U && first <= 0xDBFFU) {
              if (index_ + 2U > length_ || text_[index_] != '\\' ||
                  text_[index_ + 1U] != 'u') return false;
              index_ += 2U;
              uint16_t second = 0U;
              if (!hexQuad(second) || second < 0xDC00U ||
                  second > 0xDFFFU) return false;
              codePoint = 0x10000UL +
                          ((static_cast<uint32_t>(first) - 0xD800UL) << 10U) +
                          (static_cast<uint32_t>(second) - 0xDC00UL);
            } else if (first >= 0xDC00U && first <= 0xDFFFU) {
              return false;
            }
            break;
          }
          default: return false;
        }
      }
      // Cache text never permits controls. Reject after decoding as well as on
      // the raw path so \u0000 cannot truncate a C string and change a barcode.
      if (codePoint < 0x20U || codePoint == 0x7FU) return false;
      // JSON is UTF-8 on the wire. Preserve raw multi-byte input exactly;
      // encode only code points introduced by a \u escape.
      if (!wasEscape || codePoint <= 0x7FU) {
        if (written + 1U >= capacity) return false;
        value[written++] = static_cast<char>(codePoint);
      } else if (!appendUtf8(codePoint, value, capacity, written)) {
        return false;
      }
    }
    return false;
  }

 private:
  bool hexQuad(uint16_t& value) {
    if (index_ + 4U > length_) return false;
    uint16_t result = 0U;
    for (uint8_t offset = 0U; offset < 4U; ++offset) {
      const char input = text_[index_++];
      uint8_t digit = 0U;
      if (input >= '0' && input <= '9') digit = input - '0';
      else if (input >= 'a' && input <= 'f') digit = input - 'a' + 10U;
      else if (input >= 'A' && input <= 'F') digit = input - 'A' + 10U;
      else return false;
      result = static_cast<uint16_t>((result << 4U) | digit);
    }
    value = result;
    return true;
  }

  static bool appendUtf8(uint32_t codePoint, char* value, size_t capacity,
                         size_t& written) {
    uint8_t bytes[4U] = {};
    size_t count = 0U;
    if (codePoint <= 0x7FU) {
      bytes[0] = static_cast<uint8_t>(codePoint);
      count = 1U;
    } else if (codePoint <= 0x7FFU) {
      bytes[0] = static_cast<uint8_t>(0xC0U | (codePoint >> 6U));
      bytes[1] = static_cast<uint8_t>(0x80U | (codePoint & 0x3FU));
      count = 2U;
    } else if (codePoint <= 0xFFFFU) {
      bytes[0] = static_cast<uint8_t>(0xE0U | (codePoint >> 12U));
      bytes[1] = static_cast<uint8_t>(0x80U | ((codePoint >> 6U) & 0x3FU));
      bytes[2] = static_cast<uint8_t>(0x80U | (codePoint & 0x3FU));
      count = 3U;
    } else if (codePoint <= 0x10FFFFU) {
      bytes[0] = static_cast<uint8_t>(0xF0U | (codePoint >> 18U));
      bytes[1] = static_cast<uint8_t>(0x80U | ((codePoint >> 12U) & 0x3FU));
      bytes[2] = static_cast<uint8_t>(0x80U | ((codePoint >> 6U) & 0x3FU));
      bytes[3] = static_cast<uint8_t>(0x80U | (codePoint & 0x3FU));
      count = 4U;
    } else {
      return false;
    }
    if (written + count >= capacity) return false;
    for (size_t index = 0U; index < count; ++index) {
      value[written++] = static_cast<char>(bytes[index]);
    }
    return true;
  }

  const char* text_;
  size_t length_;
  size_t index_;
};

inline bool parseStatus(const char* value, StockStatus& status) {
  if (strcmp(value, "HIGH") == 0) status = StockStatus::kHigh;
  else if (strcmp(value, "LOW") == 0) status = StockStatus::kLow;
  else if (strcmp(value, "EMPTY") == 0) status = StockStatus::kEmpty;
  else return false;
  return true;
}

inline bool parseProduct(JsonReader& reader, CacheProduct& product) {
  bool seen[7U] = {};
  if (!reader.consume('{')) return false;
  for (size_t field = 0U; field < 7U; ++field) {
    char key[24U] = {};
    if (!reader.string(key, sizeof(key)) || !reader.consume(':')) return false;
    if (strcmp(key, "id") == 0) {
      if (seen[0] || !reader.string(product.id, sizeof(product.id))) return false;
      seen[0] = true;
    } else if (strcmp(key, "barcode") == 0) {
      if (seen[1] || !reader.string(product.barcode, sizeof(product.barcode))) return false;
      seen[1] = true;
    } else if (strcmp(key, "name") == 0) {
      if (seen[2] || !reader.string(product.name, sizeof(product.name))) return false;
      seen[2] = true;
    } else if (strcmp(key, "category") == 0) {
      if (seen[3] || !reader.string(product.category, sizeof(product.category))) return false;
      seen[3] = true;
    } else if (strcmp(key, "currentStock") == 0) {
      if (seen[4] || !reader.unsignedInteger(kMaximumStockValue,
                                             product.currentStock)) return false;
      seen[4] = true;
    } else if (strcmp(key, "lowStockThreshold") == 0) {
      if (seen[5] || !reader.unsignedInteger(kMaximumStockValue,
                                              product.lowStockThreshold)) return false;
      seen[5] = true;
    } else if (strcmp(key, "status") == 0) {
      char status[6U] = {};
      if (seen[6] || !reader.string(status, sizeof(status)) ||
          !parseStatus(status, product.status)) return false;
      seen[6] = true;
    } else {
      return false;
    }
    if (field < 6U && !reader.consume(',')) return false;
  }
  if (!reader.consume('}')) return false;
  for (size_t index = 0U; index < 7U; ++index) if (!seen[index]) return false;
  return validProduct(product);
}

inline bool appendCharacter(char* output, size_t capacity, size_t& written,
                            char value) {
  if (written + 1U >= capacity) return false;
  output[written++] = value;
  output[written] = '\0';
  return true;
}

inline bool appendText(char* output, size_t capacity, size_t& written,
                       const char* value) {
  for (size_t index = 0U; value[index] != '\0'; ++index) {
    if (!appendCharacter(output, capacity, written, value[index])) return false;
  }
  return true;
}

inline bool appendCsvQuoted(char* output, size_t capacity, size_t& written,
                            const char* value) {
  if (!appendCharacter(output, capacity, written, '"')) return false;
  for (size_t index = 0U; value[index] != '\0'; ++index) {
    if (value[index] == '"' &&
        !appendCharacter(output, capacity, written, '"')) return false;
    if (!appendCharacter(output, capacity, written, value[index])) return false;
  }
  return appendCharacter(output, capacity, written, '"');
}

inline bool parseCsvQuoted(const char* line, size_t& index, char* output,
                           size_t capacity) {
  if (line[index++] != '"') return false;
  size_t written = 0U;
  while (line[index] != '\0') {
    const char value = line[index++];
    if (value == '"') {
      if (line[index] == '"') {
        ++index;
        if (written + 1U >= capacity) return false;
        output[written++] = '"';
      } else {
        output[written] = '\0';
        return true;
      }
    } else {
      if (written + 1U >= capacity) return false;
      output[written++] = value;
    }
  }
  return false;
}

inline bool consumeCsvComma(const char* line, size_t& index) {
  if (line[index] != ',') return false;
  ++index;
  return true;
}

inline bool parseCsvUnsigned(const char* line, size_t& index,
                             uint64_t maximum, uint64_t& value) {
  if (line[index] < '0' || line[index] > '9') return false;
  if (line[index] == '0' && line[index + 1U] >= '0' &&
      line[index + 1U] <= '9') return false;
  uint64_t parsed = 0ULL;
  do {
    const uint64_t digit = static_cast<uint64_t>(line[index] - '0');
    if (parsed > (maximum - digit) / 10ULL) return false;
    parsed = parsed * 10ULL + digit;
    ++index;
  } while (line[index] >= '0' && line[index] <= '9');
  value = parsed;
  return true;
}

}  // namespace detail

inline bool parseCacheRequest(const char* body, size_t length,
                              CacheRequest& request) {
  if (body == nullptr || length == 0U ||
      length > kCacheRequestMaximumLength) return false;
  request = CacheRequest{CacheOperation::kBegin, {}, 0U, 0U, {}};
  detail::JsonReader reader(body, length);
  bool hasOperation = false;
  bool hasGeneration = false;
  bool hasItemCount = false;
  bool hasIndex = false;
  bool hasProduct = false;
  char operation[7U] = {};

  if (!reader.consume('{')) return false;
  size_t fields = 0U;
  while (fields < 5U) {
    char key[16U] = {};
    if (!reader.string(key, sizeof(key)) || !reader.consume(':')) return false;
    if (strcmp(key, "operation") == 0) {
      if (hasOperation || !reader.string(operation, sizeof(operation))) return false;
      hasOperation = true;
    } else if (strcmp(key, "generation") == 0) {
      if (hasGeneration || !reader.string(request.generation,
                                           sizeof(request.generation))) return false;
      hasGeneration = true;
    } else if (strcmp(key, "itemCount") == 0) {
      uint64_t itemCount = 0ULL;
      if (hasItemCount || !reader.unsignedInteger(kMaximumCacheItems,
                                                   itemCount)) return false;
      request.itemCount = static_cast<uint32_t>(itemCount);
      hasItemCount = true;
    } else if (strcmp(key, "index") == 0) {
      uint64_t index = 0ULL;
      if (hasIndex || !reader.unsignedInteger(kMaximumCacheItems, index)) return false;
      request.index = static_cast<uint32_t>(index);
      hasIndex = true;
    } else if (strcmp(key, "product") == 0) {
      if (hasProduct || !detail::parseProduct(reader, request.product)) return false;
      hasProduct = true;
    } else {
      return false;
    }
    ++fields;
    reader.skipWhitespace();
    if (reader.consume('}')) break;
    if (!reader.consume(',')) return false;
  }
  if (!reader.finished() || !hasOperation || !hasGeneration ||
      !validGeneration(request.generation)) return false;

  if (strcmp(operation, "begin") == 0) {
    request.operation = CacheOperation::kBegin;
    return fields == 3U && hasItemCount && !hasIndex && !hasProduct;
  }
  if (strcmp(operation, "commit") == 0) {
    request.operation = CacheOperation::kCommit;
    return fields == 3U && hasItemCount && !hasIndex && !hasProduct;
  }
  if (strcmp(operation, "item") == 0) {
    request.operation = CacheOperation::kItem;
    return fields == 4U && !hasItemCount && hasIndex && hasProduct;
  }
  return false;
}

inline bool formatProductCsv(const CacheProduct& product, char* output,
                             size_t capacity, size_t& length) {
  if (!validProduct(product) || capacity == 0U) return false;
  output[0] = '\0';
  size_t written = 0U;
  char currentStock[24U] = {};
  char threshold[24U] = {};
  snprintf(currentStock, sizeof(currentStock), "%llu",
           static_cast<unsigned long long>(product.currentStock));
  snprintf(threshold, sizeof(threshold), "%llu",
           static_cast<unsigned long long>(product.lowStockThreshold));
  const bool ok =
      detail::appendCsvQuoted(output, capacity, written, product.id) &&
      detail::appendCharacter(output, capacity, written, ',') &&
      detail::appendCsvQuoted(output, capacity, written, product.barcode) &&
      detail::appendCharacter(output, capacity, written, ',') &&
      detail::appendCsvQuoted(output, capacity, written, product.name) &&
      detail::appendCharacter(output, capacity, written, ',') &&
      detail::appendCsvQuoted(output, capacity, written, product.category) &&
      detail::appendCharacter(output, capacity, written, ',') &&
      detail::appendText(output, capacity, written, currentStock) &&
      detail::appendCharacter(output, capacity, written, ',') &&
      detail::appendText(output, capacity, written, threshold) &&
      detail::appendCharacter(output, capacity, written, ',') &&
      detail::appendText(output, capacity, written,
                         stockStatusName(product.status));
  if (!ok) return false;
  length = written;
  return true;
}

inline bool parseProductCsv(const char* line, CacheProduct& product) {
  if (line == nullptr) return false;
  product = CacheProduct{};
  size_t index = 0U;
  char status[6U] = {};
  if (!detail::parseCsvQuoted(line, index, product.id,
                              sizeof(product.id)) ||
      !detail::consumeCsvComma(line, index) ||
      !detail::parseCsvQuoted(line, index, product.barcode,
                              sizeof(product.barcode)) ||
      !detail::consumeCsvComma(line, index) ||
      !detail::parseCsvQuoted(line, index, product.name,
                              sizeof(product.name)) ||
      !detail::consumeCsvComma(line, index) ||
      !detail::parseCsvQuoted(line, index, product.category,
                              sizeof(product.category)) ||
      !detail::consumeCsvComma(line, index) ||
      !detail::parseCsvUnsigned(line, index, kMaximumStockValue,
                                product.currentStock) ||
      !detail::consumeCsvComma(line, index) ||
      !detail::parseCsvUnsigned(line, index, kMaximumStockValue,
                                product.lowStockThreshold) ||
      !detail::consumeCsvComma(line, index)) return false;
  size_t statusLength = 0U;
  while (line[index] != '\0' && statusLength + 1U < sizeof(status)) {
    status[statusLength++] = line[index++];
  }
  status[statusLength] = '\0';
  return line[index] == '\0' && detail::parseStatus(status, product.status) &&
         validProduct(product);
}

inline bool formatMetadataLine(const char* generation, uint32_t itemCount,
                               char* line, size_t capacity) {
  if (!validGeneration(generation) || itemCount > kMaximumCacheItems) {
    return false;
  }
  const int written = snprintf(line, capacity, "%s,1,%s,%lu", kCacheMagic,
                               generation,
                               static_cast<unsigned long>(itemCount));
  return written > 0 && static_cast<size_t>(written) < capacity;
}

inline uint32_t updateCrc32(uint32_t crc, const char* data, size_t length) {
  for (size_t index = 0U; index < length; ++index) {
    crc ^= static_cast<uint8_t>(data[index]);
    for (uint8_t bit = 0U; bit < 8U; ++bit) {
      crc = (crc >> 1U) ^ (0xEDB88320UL &
                           static_cast<uint32_t>(-(static_cast<int32_t>(crc & 1U))));
    }
  }
  return crc;
}

inline uint32_t updateCrc32Line(uint32_t crc, const char* line) {
  crc = updateCrc32(crc, line, strlen(line));
  return updateCrc32(crc, "\n", 1U);
}

inline bool parseChecksumLine(const char* line, uint32_t& checksum) {
  if (line == nullptr ||
      strncmp(line, kCacheChecksumPrefix,
              strlen(kCacheChecksumPrefix)) != 0) return false;
  const char* value = line + strlen(kCacheChecksumPrefix);
  if (strlen(value) != 8U) return false;
  uint32_t parsed = 0U;
  for (size_t index = 0U; index < 8U; ++index) {
    const char input = value[index];
    uint8_t digit = 0U;
    if (input >= '0' && input <= '9') digit = input - '0';
    else if (input >= 'a' && input <= 'f') digit = input - 'a' + 10U;
    else if (input >= 'A' && input <= 'F') digit = input - 'A' + 10U;
    else return false;
    parsed = (parsed << 4U) | digit;
  }
  checksum = parsed;
  return true;
}

inline bool parseMetadataLine(const char* line, CacheMetadata& metadata) {
  if (line == nullptr) return false;
  const size_t magicLength = strlen(kCacheMagic);
  if (strncmp(line, kCacheMagic, magicLength) != 0 ||
      strcmp(line + magicLength, ",1,") == 0) return false;
  size_t index = magicLength;
  if (line[index++] != ',' || line[index++] != '1' || line[index++] != ',') {
    return false;
  }
  size_t generationLength = 0U;
  while (line[index] != '\0' && line[index] != ',') {
    if (generationLength + 1U >= sizeof(metadata.generation)) return false;
    metadata.generation[generationLength++] = line[index++];
  }
  metadata.generation[generationLength] = '\0';
  if (line[index++] != ',' || !validGeneration(metadata.generation)) return false;
  uint64_t itemCount = 0ULL;
  if (!detail::parseCsvUnsigned(line, index, kMaximumCacheItems, itemCount) ||
      line[index] != '\0') return false;
  metadata.available = true;
  metadata.itemCount = static_cast<uint32_t>(itemCount);
  return true;
}

class OfflineInventoryCache {
 public:
  explicit OfflineInventoryCache(CacheStorage& storage) : storage_(storage) {}

  const CacheMetadata& metadata() const { return installed_; }
  uint32_t receivedItems() const { return transferReceived_; }
  bool transferActive() const { return transferActive_; }

  bool loadAtBoot() {
    resetRuntimeState();
    if (!storage_.available()) return false;

    CacheMetadata active = {};
    if (validateComplete(kActiveCachePath, active)) {
      installed_ = active;
      return true;
    }

    // A complete temporary file means power was lost after its checksum was
    // written but before (or during) promotion. It may replace an invalid or
    // absent active file, but it must never displace a valid active cache.
    CacheMetadata temporary = {};
    if (validateComplete(kTemporaryCachePath, temporary)) {
      if ((!storage_.exists(kActiveCachePath) ||
           storage_.remove(kActiveCachePath)) &&
          storage_.rename(kTemporaryCachePath, kActiveCachePath)) {
        CacheMetadata promoted = {};
        if (validateComplete(kActiveCachePath, promoted) &&
            promoted.itemCount == temporary.itemCount &&
            strcmp(promoted.generation, temporary.generation) == 0) {
          installed_ = promoted;
          return true;
        }
      }

      // A failed/partial promotion must not leave corrupt active data in front
      // of a recoverable backup. Failure to remove it is a hard unavailable
      // state rather than a reason to publish stale in-memory metadata.
      CacheMetadata promoted = {};
      if (validateComplete(kActiveCachePath, promoted)) {
        installed_ = promoted;
        return true;
      }
      if (storage_.exists(kActiveCachePath) &&
          !storage_.remove(kActiveCachePath)) {
        return false;
      }
    }

    CacheMetadata backup = {};
    if (!validateComplete(kBackupCachePath, backup)) return false;

    if (storage_.exists(kActiveCachePath) &&
        !storage_.remove(kActiveCachePath)) {
      return false;
    }
    if (!storage_.rename(kBackupCachePath, kActiveCachePath)) {
      CacheMetadata restoredDespiteError = {};
      if (!validateComplete(kActiveCachePath, restoredDespiteError)) {
        return false;
      }
      installed_ = restoredDespiteError;
      return true;
    }
    CacheMetadata restored = {};
    if (!validateComplete(kActiveCachePath, restored) ||
        restored.itemCount != backup.itemCount ||
        strcmp(restored.generation, backup.generation) != 0) {
      return false;
    }
    installed_ = restored;
    return true;
  }

  BeginResult begin(const char* generation, uint32_t itemCount) {
    clearTransfer();
    if (!storage_.available()) return BeginResult::kStorageUnavailable;
    if (!validGeneration(generation) || itemCount > kMaximumCacheItems) {
      return BeginResult::kWriteFailed;
    }
    if (installed_.available && installed_.itemCount == itemCount &&
        strcmp(installed_.generation, generation) == 0) {
      transferReceived_ = itemCount;
      return BeginResult::kAlreadyCurrent;
    }

    // Never trust a prefix left by an interrupted process. The generation is
    // a desktop SHA-256 identifier, not a digest the ESP32 can independently
    // recompute. Restarting at zero keeps memory bounded and ensures the live
    // transfer CRC covers only rows accepted by this runtime instance.
    if (storage_.exists(kTemporaryCachePath) &&
        !storage_.remove(kTemporaryCachePath)) return BeginResult::kWriteFailed;
    char metadataLine[128U] = {};
    if (!formatMetadataLine(generation, itemCount, metadataLine,
                            sizeof(metadataLine))) return BeginResult::kWriteFailed;
    char header[256U] = {};
    const int length = snprintf(header, sizeof(header), "%s\n%s\n",
                                metadataLine, kCacheColumns);
    if (length <= 0 || static_cast<size_t>(length) >= sizeof(header) ||
        !storage_.writeFile(kTemporaryCachePath, header,
                            static_cast<size_t>(length))) {
      return BeginResult::kWriteFailed;
    }
    activateTransfer(generation, itemCount, 0U,
                     updateCrc32(0xFFFFFFFFUL, header,
                                 static_cast<size_t>(length)));
    return BeginResult::kStarted;
  }

  ItemResult item(const char* generation, uint32_t index,
                   const CacheProduct& product) {
    if (!transferActive_) return ItemResult::kNoTransfer;
    if (!storage_.available()) return ItemResult::kWriteFailed;
    if (!validGeneration(generation)) return ItemResult::kGenerationMismatch;
    if (strcmp(transferGeneration_, generation) != 0) {
      return ItemResult::kGenerationMismatch;
    }
    if (!validProduct(product) || index >= transferExpected_) {
      return ItemResult::kUnexpectedIndex;
    }
    char* const row = lineBuffer_;
    row[0] = '\0';
    size_t rowLength = 0U;
    if (!formatProductCsv(product, row, kCacheLineCapacity - 1U, rowLength)) {
      return ItemResult::kWriteFailed;
    }
    if (index < transferReceived_) {
      comparisonBuffer_[0] = '\0';
      if (!readProductLine(index, comparisonBuffer_, kCacheLineCapacity)) {
        return ItemResult::kWriteFailed;
      }
      return strcmp(row, comparisonBuffer_) == 0
                 ? ItemResult::kAlreadyAccepted
                 : ItemResult::kConflictingItem;
    }
    if (index != transferReceived_) return ItemResult::kUnexpectedIndex;
    row[rowLength++] = '\n';
    row[rowLength] = '\0';
    if (!storage_.appendFile(kTemporaryCachePath, row, rowLength)) {
      return ItemResult::kWriteFailed;
    }
    transferCrc_ = updateCrc32(transferCrc_, row, rowLength);
    ++transferReceived_;
    return ItemResult::kAccepted;
  }

  CommitResult commit(const char* generation, uint32_t itemCount) {
    if (!storage_.available()) return CommitResult::kStorageUnavailable;
    if (!validGeneration(generation)) {
      return CommitResult::kGenerationMismatch;
    }
    if (itemCount > kMaximumCacheItems) return CommitResult::kCountMismatch;
    if (installed_.available && installed_.itemCount == itemCount &&
        strcmp(installed_.generation, generation) == 0) {
      return CommitResult::kAlreadyCurrent;
    }
    if (!transferActive_) return CommitResult::kNoTransfer;
    if (strcmp(transferGeneration_, generation) != 0) {
      return CommitResult::kGenerationMismatch;
    }
    if (itemCount != transferExpected_ || transferReceived_ != itemCount) {
      return CommitResult::kCountMismatch;
    }
    CacheMetadata candidate = {};
    if (!validateComplete(kTemporaryCachePath, candidate)) {
      char checksumLine[32U] = {};
      const int checksumLength = snprintf(
          checksumLine, sizeof(checksumLine), "%s%08lX\n",
          kCacheChecksumPrefix,
          static_cast<unsigned long>(transferCrc_ ^ 0xFFFFFFFFUL));
      if (checksumLength <= 0 ||
          static_cast<size_t>(checksumLength) >= sizeof(checksumLine) ||
          !storage_.appendFile(kTemporaryCachePath, checksumLine,
                               static_cast<size_t>(checksumLength)) ||
          !validateComplete(kTemporaryCachePath, candidate)) {
        return CommitResult::kValidationFailed;
      }
    }
    if (candidate.itemCount != itemCount ||
        strcmp(candidate.generation, generation) != 0) {
      return CommitResult::kValidationFailed;
    }

    CacheMetadata previousActive = {};
    CacheMetadata previousBackup = {};
    const bool activeIsValid = validateComplete(kActiveCachePath, previousActive);
    const bool backupIsValid = validateComplete(kBackupCachePath, previousBackup);
    if (activeIsValid) {
      if (storage_.exists(kBackupCachePath) &&
          !storage_.remove(kBackupCachePath)) {
        refreshInstalledFromActive();
        return CommitResult::kReplacementFailed;
      }
      if (!storage_.rename(kActiveCachePath, kBackupCachePath)) {
        if (!refreshInstalledFromActive()) restoreBackupToActive();
        return CommitResult::kReplacementFailed;
      }
    } else {
      // The candidate has already passed full validation. Only now may a
      // corrupt active file be removed so it cannot block atomic promotion.
      if (storage_.exists(kActiveCachePath) &&
          !storage_.remove(kActiveCachePath)) {
        refreshInstalledFromActive();
        return CommitResult::kReplacementFailed;
      }
      if (!backupIsValid && storage_.exists(kBackupCachePath) &&
          !storage_.remove(kBackupCachePath)) {
        refreshInstalledFromActive();
        return CommitResult::kReplacementFailed;
      }
    }
    if (!storage_.rename(kTemporaryCachePath, kActiveCachePath)) {
      CacheMetadata promotedDespiteError = {};
      if (validateComplete(kActiveCachePath, promotedDespiteError) &&
          promotedDespiteError.itemCount == candidate.itemCount &&
          strcmp(promotedDespiteError.generation, candidate.generation) == 0) {
        installed_ = promotedDespiteError;
        clearTransfer();
        return CommitResult::kCommitted;
      }
      if (!restoreBackupToActive()) refreshInstalledFromActive();
      return CommitResult::kReplacementFailed;
    }

    CacheMetadata installed = {};
    if (!validateComplete(kActiveCachePath, installed) ||
        installed.itemCount != candidate.itemCount ||
        strcmp(installed.generation, candidate.generation) != 0) {
      if ((!storage_.exists(kActiveCachePath) ||
           storage_.remove(kActiveCachePath)) &&
          restoreBackupToActive()) {
        return CommitResult::kReplacementFailed;
      }
      refreshInstalledFromActive();
      return CommitResult::kReplacementFailed;
    }
    installed_ = installed;
    // Retain the previous valid generation as a recovery source. A later boot
    // can restore it if the newly promoted active file becomes corrupt.
    clearTransfer();
    return CommitResult::kCommitted;
  }

 private:
  void resetRuntimeState() {
    installed_ = CacheMetadata{};
    clearTransfer();
  }

  void clearTransfer() {
    transferActive_ = false;
    transferGeneration_[0] = '\0';
    transferExpected_ = 0U;
    transferReceived_ = 0U;
    transferCrc_ = 0xFFFFFFFFUL;
  }

  void activateTransfer(const char* generation, uint32_t expected,
                        uint32_t received, uint32_t runningCrc) {
    transferActive_ = true;
    snprintf(transferGeneration_, sizeof(transferGeneration_), "%s", generation);
    transferExpected_ = expected;
    transferReceived_ = received;
    transferCrc_ = runningCrc;
  }

  bool refreshInstalledFromActive() {
    CacheMetadata active = {};
    if (!validateComplete(kActiveCachePath, active)) {
      installed_ = CacheMetadata{};
      return false;
    }
    installed_ = active;
    return true;
  }

  bool restoreBackupToActive() {
    CacheMetadata backup = {};
    if (!validateComplete(kBackupCachePath, backup)) return false;
    if (storage_.exists(kActiveCachePath) &&
        !storage_.remove(kActiveCachePath)) {
      return false;
    }
    if (!storage_.rename(kBackupCachePath, kActiveCachePath)) {
      return refreshInstalledFromActive();
    }
    CacheMetadata restored = {};
    if (!validateComplete(kActiveCachePath, restored) ||
        restored.itemCount != backup.itemCount ||
        strcmp(restored.generation, backup.generation) != 0) {
      installed_ = CacheMetadata{};
      return false;
    }
    installed_ = restored;
    return true;
  }

  bool validateComplete(const char* path, CacheMetadata& metadata) {
    metadata = CacheMetadata{};
    if (!storage_.available() || !storage_.beginRead(path)) return false;
    lineBuffer_[0] = '\0';
    bool valid = storage_.readLine(lineBuffer_, kCacheLineCapacity) ==
                     ReadLineResult::kLine &&
                 parseMetadataLine(lineBuffer_, metadata);
    uint32_t runningCrc = 0xFFFFFFFFUL;
    if (valid) runningCrc = updateCrc32Line(runningCrc, lineBuffer_);
    if (valid) {
      valid = storage_.readLine(lineBuffer_, kCacheLineCapacity) ==
                  ReadLineResult::kLine &&
              strcmp(lineBuffer_, kCacheColumns) == 0;
      if (valid) runningCrc = updateCrc32Line(runningCrc, lineBuffer_);
    }
    for (uint32_t index = 0U; valid && index < metadata.itemCount; ++index) {
      CacheProduct product = {};
      valid = storage_.readLine(lineBuffer_, kCacheLineCapacity) ==
                  ReadLineResult::kLine &&
              parseProductCsv(lineBuffer_, product);
      if (valid) {
        runningCrc = updateCrc32Line(runningCrc, lineBuffer_);
      }
    }
    uint32_t storedChecksum = 0U;
    if (valid) {
      valid = storage_.readLine(lineBuffer_, kCacheLineCapacity) ==
                  ReadLineResult::kLine &&
              parseChecksumLine(lineBuffer_, storedChecksum) &&
              storedChecksum == (runningCrc ^ 0xFFFFFFFFUL);
    }
    if (valid) {
      valid = storage_.readLine(lineBuffer_, kCacheLineCapacity) ==
              ReadLineResult::kEnd;
    }
    storage_.endRead();
    if (!valid) metadata = CacheMetadata{};
    return valid;
  }

  bool readProductLine(uint32_t requestedIndex, char* line, size_t capacity) {
    if (!storage_.beginRead(kTemporaryCachePath)) return false;
    char ignored[256U] = {};
    bool valid = storage_.readLine(ignored, sizeof(ignored)) == ReadLineResult::kLine &&
                 storage_.readLine(ignored, sizeof(ignored)) == ReadLineResult::kLine;
    for (uint32_t index = 0U; valid && index <= requestedIndex; ++index) {
      valid = storage_.readLine(line, capacity) == ReadLineResult::kLine;
    }
    storage_.endRead();
    return valid;
  }

  CacheStorage& storage_;
  CacheMetadata installed_ = {};
  bool transferActive_ = false;
  char transferGeneration_[kGenerationCapacity] = {};
  uint32_t transferExpected_ = 0U;
  uint32_t transferReceived_ = 0U;
  uint32_t transferCrc_ = 0xFFFFFFFFUL;
  char lineBuffer_[kCacheLineCapacity] = {};
  char comparisonBuffer_[kCacheLineCapacity] = {};
};

}  // namespace cache
}  // namespace dental
