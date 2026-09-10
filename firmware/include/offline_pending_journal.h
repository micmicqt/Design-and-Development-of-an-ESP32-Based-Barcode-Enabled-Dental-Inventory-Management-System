#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include "offline_inventory_cache.h"
#include "transaction_event_queue.h"

namespace dental {
namespace offline {

constexpr char kPendingJournalPath[] = "/pending_sync.csv";
constexpr char kPendingJournalTemporaryPath[] = "/pending_sync.tmp";
constexpr char kPendingJournalBackupPath[] = "/pending_sync.bak";
constexpr char kPendingJournalMagic[] = "DENTAL_PENDING_SYNC";
constexpr char kPendingJournalColumns[] =
    "sequence,event_id,timestamp,product_id,barcode,action,delta,"
    "resulting_stock,resulting_status,cache_generation,record_crc32";
// Keep the journal bounded to the same maximum exposed by the desktop status
// contract. Records are streamed from storage; this is a file/count bound, not
// a RAM allocation.
constexpr uint32_t kMaximumPendingRecords = 10000U;
constexpr size_t kDeviceIdentifierCapacity = 13U;
constexpr size_t kOfflineEventIdCapacity = 40U;
constexpr size_t kTimestampCapacity = 20U;
constexpr size_t kJournalLineCapacity = 1024U;

enum class TransactionRoute : uint8_t { kOnline, kOffline };
enum class OfflineAction : uint8_t { kRestock, kCheckout };
enum class OfflineStockResult : uint8_t {
  kSuccess,
  kOutOfStock,
  kOverflow,
  kInvalid,
};

inline TransactionRoute selectTransactionRoute(bool desktopOnline) {
  return desktopOnline ? TransactionRoute::kOnline
                       : TransactionRoute::kOffline;
}

inline cache::StockStatus deriveStockStatus(uint64_t stock,
                                             uint64_t lowStockThreshold) {
  if (stock == 0ULL) return cache::StockStatus::kEmpty;
  if (stock <= lowStockThreshold) return cache::StockStatus::kLow;
  return cache::StockStatus::kHigh;
}

inline bool validOfflineAction(OfflineAction action);

inline OfflineStockResult calculateOfflineStock(
    OfflineAction action, uint64_t currentStock, uint64_t lowStockThreshold,
    uint64_t& resultingStock, cache::StockStatus& resultingStatus) {
  resultingStock = currentStock;
  resultingStatus = deriveStockStatus(currentStock, lowStockThreshold);
  if (!validOfflineAction(action) ||
      currentStock > cache::kMaximumStockValue ||
      lowStockThreshold > cache::kMaximumStockValue) {
    return OfflineStockResult::kInvalid;
  }
  if (action == OfflineAction::kRestock) {
    if (currentStock == cache::kMaximumStockValue) {
      return OfflineStockResult::kOverflow;
    }
    resultingStock = currentStock + 1ULL;
  } else {
    if (currentStock == 0ULL) return OfflineStockResult::kOutOfStock;
    resultingStock = currentStock - 1ULL;
  }
  resultingStatus = deriveStockStatus(resultingStock, lowStockThreshold);
  return OfflineStockResult::kSuccess;
}

inline const char* actionName(OfflineAction action) {
  switch (action) {
    case OfflineAction::kRestock: return "RESTOCK";
    case OfflineAction::kCheckout: return "CHECKOUT";
  }
  return "";
}

inline int8_t actionDelta(OfflineAction action) {
  switch (action) {
    case OfflineAction::kRestock: return 1;
    case OfflineAction::kCheckout: return -1;
  }
  return 0;
}

inline bool validOfflineAction(OfflineAction action) {
  return action == OfflineAction::kRestock ||
         action == OfflineAction::kCheckout;
}

inline bool validDeviceIdentifier(const char* deviceIdentifier) {
  if (deviceIdentifier == nullptr || strlen(deviceIdentifier) != 12U) {
    return false;
  }
  for (size_t index = 0U; index < 12U; ++index) {
    const char value = deviceIdentifier[index];
    if (!((value >= '0' && value <= '9') ||
          (value >= 'A' && value <= 'F'))) {
      return false;
    }
  }
  return true;
}

inline bool formatDeviceIdentifier(
    uint64_t chipIdentifier,
    char (&deviceIdentifier)[kDeviceIdentifierCapacity]) {
  const int length = snprintf(
      deviceIdentifier, sizeof(deviceIdentifier), "%04lX%08lX",
      static_cast<unsigned long>((chipIdentifier >> 32U) & 0xFFFFULL),
      static_cast<unsigned long>(chipIdentifier & 0xFFFFFFFFULL));
  return length == 12 && validDeviceIdentifier(deviceIdentifier);
}

inline bool formatOfflineEventId(
    const char* deviceIdentifier, uint64_t sequence,
    char (&eventId)[kOfflineEventIdCapacity]) {
  if (!validDeviceIdentifier(deviceIdentifier) || sequence == 0ULL) {
    return false;
  }
  const int length = snprintf(
      eventId, sizeof(eventId), "off-%s-%016llX", deviceIdentifier,
      static_cast<unsigned long long>(sequence));
  return length == 33 && static_cast<size_t>(length) < sizeof(eventId);
}

inline bool validTimestamp(const char* timestamp) {
  if (timestamp == nullptr || strlen(timestamp) != 19U ||
      timestamp[4] != '-' || timestamp[7] != '-' ||
      timestamp[10] != ' ' || timestamp[13] != ':' ||
      timestamp[16] != ':') {
    return false;
  }
  const uint8_t digitIndexes[] = {0U, 1U, 2U, 3U, 5U, 6U, 8U, 9U,
                                  11U, 12U, 14U, 15U, 17U, 18U};
  for (size_t index = 0U;
       index < sizeof(digitIndexes) / sizeof(digitIndexes[0]); ++index) {
    const char value = timestamp[digitIndexes[index]];
    if (value < '0' || value > '9') return false;
  }

  const unsigned year = static_cast<unsigned>(
      (timestamp[0] - '0') * 1000 + (timestamp[1] - '0') * 100 +
      (timestamp[2] - '0') * 10 + (timestamp[3] - '0'));
  const unsigned month = static_cast<unsigned>(
      (timestamp[5] - '0') * 10 + (timestamp[6] - '0'));
  const unsigned day = static_cast<unsigned>(
      (timestamp[8] - '0') * 10 + (timestamp[9] - '0'));
  const unsigned hour = static_cast<unsigned>(
      (timestamp[11] - '0') * 10 + (timestamp[12] - '0'));
  const unsigned minute = static_cast<unsigned>(
      (timestamp[14] - '0') * 10 + (timestamp[15] - '0'));
  const unsigned second = static_cast<unsigned>(
      (timestamp[17] - '0') * 10 + (timestamp[18] - '0'));
  if (year < 2000U || month < 1U || month > 12U || hour > 23U ||
      minute > 59U || second > 59U) {
    return false;
  }
  static const uint8_t daysPerMonth[] = {
      31U, 28U, 31U, 30U, 31U, 30U, 31U, 31U, 30U, 31U, 30U, 31U};
  unsigned maximumDay = daysPerMonth[month - 1U];
  const bool leapYear =
      (year % 4U == 0U && year % 100U != 0U) || year % 400U == 0U;
  if (month == 2U && leapYear) maximumDay = 29U;
  return day >= 1U && day <= maximumDay;
}

inline bool validScannerBarcode(const char* barcode) {
  if (barcode == nullptr) return false;
  const size_t length = strlen(barcode);
  if (length == 0U || length > cache::kMaximumBarcodeUtf16Units) {
    return false;
  }
  bool visible = false;
  for (size_t index = 0U; index < length; ++index) {
    const uint8_t value = static_cast<uint8_t>(barcode[index]);
    if (value < 0x20U || value > 0x7EU || value == ',') return false;
    if (value != ' ') visible = true;
  }
  return visible;
}

enum class JournalReadLineResult : uint8_t {
  kTerminatedLine,
  kUnterminatedLine,
  kEnd,
  kError,
  kTooLongTerminated,
  kTooLongUnterminated,
};

class PendingJournalStorage {
 public:
  virtual ~PendingJournalStorage() {}
  virtual bool available() const = 0;
  virtual bool exists(const char* path) = 0;
  virtual bool remove(const char* path) = 0;
  virtual bool rename(const char* from, const char* to) = 0;
  virtual bool writeFile(const char* path, const char* data,
                         size_t length) = 0;
  virtual bool appendFile(const char* path, const char* data,
                          size_t length) = 0;
  virtual bool beginRead(const char* path) = 0;
  virtual JournalReadLineResult readLine(char* line, size_t capacity) = 0;
  virtual void endRead() = 0;
};

struct OfflineJournalRecord {
  uint64_t sequence;
  char eventId[kOfflineEventIdCapacity];
  char timestamp[kTimestampCapacity];
  char productId[cache::kProductIdCapacity];
  char barcode[cache::kBarcodeCapacity];
  OfflineAction action;
  int8_t delta;
  uint64_t resultingStock;
  cache::StockStatus resultingStatus;
  char cacheGeneration[cache::kGenerationCapacity];
};

struct PendingJournalMetadata {
  bool available;
  uint32_t pendingCount;
  uint32_t storedCount;
  uint64_t maximumSequence;
  uint64_t compactedSequence;
  uint64_t acknowledgedSequence;
  char cacheGeneration[cache::kGenerationCapacity];
  bool recoveredTornTail;
};

enum class JournalPeekResult : uint8_t {
  kFound,
  kEmpty,
  kJournalUnavailable,
  kInvalidJournal,
};

enum class JournalAcknowledgementResult : uint8_t {
  kAcknowledged,
  kAlreadyAcknowledged,
  kEmpty,
  kMismatch,
  kJournalUnavailable,
  kInvalidJournal,
  kWriteFailed,
};

enum class JournalCompactionResult : uint8_t {
  kCompacted,
  kAlreadyCompacted,
  kNotReady,
  kJournalUnavailable,
  kInvalidJournal,
  kWriteFailed,
};

// Produces the exact Step 7.1 wire representation from a record that has
// already passed the journal's bounded integrity scan. Keeping this serializer
// shared with host tests protects exact text fields (especially barcodes) and
// uses the same strict JSON escaping as the existing online event endpoint.
template <typename Text>
void appendPendingEventJson(Text& destination,
                            const OfflineJournalRecord& record) {
  destination += "{\"eventId\":";
  events::appendJsonString(destination, record.eventId);
  destination += ",\"timestamp\":";
  events::appendJsonString(destination, record.timestamp);
  destination += ",\"productId\":";
  events::appendJsonString(destination, record.productId);
  destination += ",\"barcode\":";
  events::appendJsonString(destination, record.barcode);
  destination += ",\"action\":";
  events::appendJsonString(destination, actionName(record.action));

  char delta[4U] = {};
  snprintf(delta, sizeof(delta), "%d", static_cast<int>(record.delta));
  destination += ",\"delta\":";
  destination += delta;

  char resultingStock[24U] = {};
  snprintf(resultingStock, sizeof(resultingStock), "%llu",
           static_cast<unsigned long long>(record.resultingStock));
  destination += ",\"resultingStock\":";
  destination += resultingStock;
  destination += ",\"stockStatus\":";
  events::appendJsonString(destination,
                           cache::stockStatusName(record.resultingStatus));
  destination += ",\"cacheGeneration\":";
  events::appendJsonString(destination, record.cacheGeneration);
  destination += '}';
}

// Shared by the production HTTP handler and native tests so the Step 7.3
// response remains an exact four-key contract.
template <typename Text>
void appendOfflineAcknowledgementJson(Text& destination, const char* eventId,
                                      uint32_t pendingCount,
                                      bool alreadyAcknowledged) {
  destination += "{\"acknowledged\":true,\"eventId\":";
  events::appendJsonString(destination, eventId);
  destination += ",\"pendingSyncItems\":";
  char count[12U] = {};
  snprintf(count, sizeof(count), "%lu",
           static_cast<unsigned long>(pendingCount));
  destination += count;
  destination += ",\"alreadyAcknowledged\":";
  destination += alreadyAcknowledged ? "true" : "false";
  destination += '}';
}

enum class CacheLookupResult : uint8_t {
  kFound,
  kNotFound,
  kCacheUnavailable,
  kStorageUnavailable,
  kInvalidCache,
};

// Streams and validates the complete immutable Step 2A cache while retaining
// only the exact matching product. No full catalog is loaded into RAM.
class OfflineCacheLookup {
 public:
  explicit OfflineCacheLookup(cache::CacheStorage& storage)
      : storage_(storage) {}

  CacheLookupResult find(const cache::CacheMetadata& expectedMetadata,
                         const char* barcode,
                         cache::CacheProduct& product) {
    product = cache::CacheProduct{};
    if (!storage_.available()) return CacheLookupResult::kStorageUnavailable;
    if (!expectedMetadata.available || !cache::validGeneration(
            expectedMetadata.generation)) {
      return CacheLookupResult::kCacheUnavailable;
    }
    if (!validScannerBarcode(barcode) ||
        !storage_.beginRead(cache::kActiveCachePath)) {
      return validScannerBarcode(barcode)
                 ? CacheLookupResult::kInvalidCache
                 : CacheLookupResult::kNotFound;
    }

    cache::CacheMetadata storedMetadata = {};
    bool valid = storage_.readLine(line_, sizeof(line_)) ==
                     cache::ReadLineResult::kLine &&
                 cache::parseMetadataLine(line_, storedMetadata) &&
                 storedMetadata.itemCount == expectedMetadata.itemCount &&
                 strcmp(storedMetadata.generation,
                        expectedMetadata.generation) == 0;
    uint32_t runningCrc = 0xFFFFFFFFUL;
    if (valid) runningCrc = cache::updateCrc32Line(runningCrc, line_);

    if (valid) {
      valid = storage_.readLine(line_, sizeof(line_)) ==
                  cache::ReadLineResult::kLine &&
              strcmp(line_, cache::kCacheColumns) == 0;
      if (valid) runningCrc = cache::updateCrc32Line(runningCrc, line_);
    }

    bool found = false;
    for (uint32_t index = 0U;
         valid && index < storedMetadata.itemCount; ++index) {
      candidate_ = cache::CacheProduct{};
      valid = storage_.readLine(line_, sizeof(line_)) ==
                  cache::ReadLineResult::kLine &&
              cache::parseProductCsv(line_, candidate_);
      if (valid) {
        runningCrc = cache::updateCrc32Line(runningCrc, line_);
        if (strcmp(candidate_.barcode, barcode) == 0) {
          if (found) {
            valid = false;
          } else {
            product = candidate_;
            found = true;
          }
        }
      }
    }

    uint32_t storedChecksum = 0U;
    if (valid) {
      valid = storage_.readLine(line_, sizeof(line_)) ==
                  cache::ReadLineResult::kLine &&
              cache::parseChecksumLine(line_, storedChecksum) &&
              storedChecksum == (runningCrc ^ 0xFFFFFFFFUL);
    }
    if (valid) {
      valid = storage_.readLine(line_, sizeof(line_)) ==
              cache::ReadLineResult::kEnd;
    }
    storage_.endRead();
    if (!valid) {
      product = cache::CacheProduct{};
      return CacheLookupResult::kInvalidCache;
    }
    return found ? CacheLookupResult::kFound : CacheLookupResult::kNotFound;
  }

 private:
  cache::CacheStorage& storage_;
  char line_[cache::kCacheLineCapacity] = {};
  // CacheProduct includes bounded UTF-8 fields large enough for the desktop
  // contract. Keep the streaming scratch record with this long-lived lookup
  // object instead of consuming the Arduino loop task's small stack.
  cache::CacheProduct candidate_ = {};
};

namespace detail {

inline bool appendCharacter(char* output, size_t capacity, size_t& written,
                            char value) {
  return cache::detail::appendCharacter(output, capacity, written, value);
}

inline bool appendText(char* output, size_t capacity, size_t& written,
                       const char* value) {
  return cache::detail::appendText(output, capacity, written, value);
}

inline bool appendQuoted(char* output, size_t capacity, size_t& written,
                         const char* value) {
  return cache::detail::appendCsvQuoted(output, capacity, written, value);
}

inline bool parseHex32(const char* value, uint32_t& parsed) {
  if (value == nullptr || strlen(value) != 8U) return false;
  uint32_t result = 0U;
  for (size_t index = 0U; index < 8U; ++index) {
    const char input = value[index];
    uint8_t digit = 0U;
    if (input >= '0' && input <= '9') digit = input - '0';
    else if (input >= 'A' && input <= 'F') digit = input - 'A' + 10U;
    else return false;
    result = (result << 4U) | digit;
  }
  parsed = result;
  return true;
}

inline bool parseOfflineEventId(const char* eventId,
                                const char* deviceIdentifier,
                                uint64_t sequence) {
  char expected[kOfflineEventIdCapacity] = {};
  return formatOfflineEventId(deviceIdentifier, sequence, expected) &&
         strcmp(eventId, expected) == 0;
}

inline bool parseCanonicalUnsigned(const char* text, size_t length,
                                   size_t& index, uint64_t& value) {
  if (index >= length || text[index] < '0' || text[index] > '9') return false;
  if (text[index] == '0' && index + 1U < length &&
      text[index + 1U] >= '0' && text[index + 1U] <= '9') {
    return false;
  }
  uint64_t parsed = 0ULL;
  do {
    const uint64_t digit = static_cast<uint64_t>(text[index] - '0');
    if (parsed > (UINT64_MAX - digit) / 10ULL) return false;
    parsed = parsed * 10ULL + digit;
    ++index;
  } while (index < length && text[index] >= '0' && text[index] <= '9');
  value = parsed;
  return true;
}

// Version 1 is retained verbatim for pristine legacy journals. Version 2 adds
// a CRC-protected compacted-through floor and acknowledged-through cursor.
// Together they retain one durable ACK receipt and monotonic event IDs without
// storing an unbounded receipt collection.
inline bool formatJournalHeader(const char* deviceIdentifier,
                                uint64_t compactedSequence,
                                uint64_t acknowledgedSequence, char* output,
                                size_t capacity, size_t& length) {
  if (!validDeviceIdentifier(deviceIdentifier) ||
      compactedSequence > acknowledgedSequence) {
    return false;
  }
  if (compactedSequence == 0ULL && acknowledgedSequence == 0ULL) {
    const int written = snprintf(output, capacity, "%s,1,%s\n%s\n",
                                 kPendingJournalMagic, deviceIdentifier,
                                 kPendingJournalColumns);
    if (written <= 0 || static_cast<size_t>(written) >= capacity) return false;
    length = static_cast<size_t>(written);
    return true;
  }

  const int prefixLength = snprintf(
      output, capacity, "%s,2,%s,%llu,%llu", kPendingJournalMagic,
      deviceIdentifier, static_cast<unsigned long long>(compactedSequence),
      static_cast<unsigned long long>(acknowledgedSequence));
  if (prefixLength <= 0 || static_cast<size_t>(prefixLength) >= capacity) {
    return false;
  }
  const uint32_t crc =
      cache::updateCrc32(0xFFFFFFFFUL, output,
                         static_cast<size_t>(prefixLength)) ^
      0xFFFFFFFFUL;
  const int suffixLength = snprintf(
      output + prefixLength, capacity - static_cast<size_t>(prefixLength),
      ",%08lX\n%s\n", static_cast<unsigned long>(crc),
      kPendingJournalColumns);
  if (suffixLength <= 0 ||
      static_cast<size_t>(prefixLength + suffixLength) >= capacity) {
    return false;
  }
  length = static_cast<size_t>(prefixLength + suffixLength);
  return true;
}

inline bool parseJournalHeader(const char* line, const char* deviceIdentifier,
                               uint64_t& compactedSequence,
                               uint64_t& acknowledgedSequence) {
  compactedSequence = 0ULL;
  acknowledgedSequence = 0ULL;
  if (line == nullptr || !validDeviceIdentifier(deviceIdentifier)) return false;

  char legacy[64U] = {};
  const int legacyLength = snprintf(legacy, sizeof(legacy), "%s,1,%s",
                                    kPendingJournalMagic, deviceIdentifier);
  if (legacyLength > 0 &&
      static_cast<size_t>(legacyLength) < sizeof(legacy) &&
      strcmp(line, legacy) == 0) {
    return true;
  }

  const char* const checksumComma = strrchr(line, ',');
  if (checksumComma == nullptr || checksumComma == line) return false;
  uint32_t storedCrc = 0U;
  if (!parseHex32(checksumComma + 1U, storedCrc)) return false;
  const size_t crcPrefixLength =
      static_cast<size_t>(checksumComma - line);
  const uint32_t calculatedCrc =
      cache::updateCrc32(0xFFFFFFFFUL, line, crcPrefixLength) ^
      0xFFFFFFFFUL;
  if (calculatedCrc != storedCrc) return false;

  char expectedPrefix[64U] = {};
  const int expectedPrefixLength =
      snprintf(expectedPrefix, sizeof(expectedPrefix), "%s,2,%s,",
               kPendingJournalMagic, deviceIdentifier);
  if (expectedPrefixLength <= 0 ||
      static_cast<size_t>(expectedPrefixLength) >= sizeof(expectedPrefix) ||
      crcPrefixLength <= static_cast<size_t>(expectedPrefixLength) ||
      strncmp(line, expectedPrefix,
              static_cast<size_t>(expectedPrefixLength)) != 0) {
    return false;
  }

  size_t index = static_cast<size_t>(expectedPrefixLength);
  if (!parseCanonicalUnsigned(line, crcPrefixLength, index,
                              compactedSequence) ||
      index >= crcPrefixLength || line[index++] != ',' ||
      !parseCanonicalUnsigned(line, crcPrefixLength, index,
                              acknowledgedSequence) ||
      index != crcPrefixLength ||
      compactedSequence > acknowledgedSequence) {
    compactedSequence = 0ULL;
    acknowledgedSequence = 0ULL;
    return false;
  }
  return true;
}

}  // namespace detail

enum class JournalLoadResult : uint8_t {
  kReady,
  kRecoveredTornTail,
  kStorageUnavailable,
  kInvalid,
  kWriteFailed,
};

enum class OverlayResult : uint8_t {
  kSuccess,
  kJournalUnavailable,
  kGenerationMismatch,
  kInvalidJournal,
  kStockInvalid,
};

enum class JournalAppendResult : uint8_t {
  kCommitted,
  kJournalUnavailable,
  kGenerationMismatch,
  kFull,
  kInvalidRecord,
  kWriteFailed,
  kValidationFailed,
};

class PendingJournal {
 public:
  explicit PendingJournal(PendingJournalStorage& storage) : storage_(storage) {}

  const PendingJournalMetadata& metadata() const { return metadata_; }
  bool uncertain() const { return uncertain_; }
  bool blocksCacheReplacement() const {
    return uncertain_ || (metadata_.available && metadata_.pendingCount > 0U);
  }

  bool compatibleWith(const cache::CacheMetadata& cacheMetadata) const {
    return metadata_.available && cacheMetadata.available &&
           metadata_.storedCount < kMaximumPendingRecords &&
           (metadata_.storedCount == 0U ||
            strcmp(metadata_.cacheGeneration,
                   cacheMetadata.generation) == 0);
  }

  // Reads only one logical record into RAM but validates the complete active
  // journal before publishing it. This deliberately does not repair, rewrite,
  // acknowledge, archive, or advance the journal, so retries and reboots keep
  // returning the same oldest durable synchronization identity.
  JournalPeekResult peekOldest(OfflineJournalRecord& record) {
    memset(&record, 0, sizeof(record));
    if (uncertain_) return JournalPeekResult::kInvalidJournal;
    if (!metadata_.available || !storage_.available()) {
      return JournalPeekResult::kJournalUnavailable;
    }

    ScanState state = {};
    const ScanResult result =
        scan(kPendingJournalPath, nullptr, nullptr, state, &record);
    if (result == ScanResult::kUnavailable) {
      memset(&record, 0, sizeof(record));
      return JournalPeekResult::kJournalUnavailable;
    }
    if (result != ScanResult::kValid ||
        !scanStateMatchesMetadata(state)) {
      memset(&record, 0, sizeof(record));
      return JournalPeekResult::kInvalidJournal;
    }
    if (state.pendingCount == 0U) {
      memset(&record, 0, sizeof(record));
      return JournalPeekResult::kEmpty;
    }
    return JournalPeekResult::kFound;
  }

  // Advances only the authoritative FIFO cursor. Acknowledged rows remain in
  // the CRC-protected journal until the desktop confirms an authoritative
  // cache refresh, so a partial drain still has the complete stock overlay.
  JournalAcknowledgementResult acknowledgeOldest(const char* eventId) {
    if (uncertain_) return JournalAcknowledgementResult::kInvalidJournal;
    if (!metadata_.available || !storage_.available()) {
      return JournalAcknowledgementResult::kJournalUnavailable;
    }

    ScanState original = {};
    OfflineJournalRecord oldest = {};
    const ScanResult originalResult =
        scan(kPendingJournalPath, nullptr, nullptr, original, &oldest);
    if (originalResult == ScanResult::kUnavailable) {
      return JournalAcknowledgementResult::kJournalUnavailable;
    }
    if (originalResult != ScanResult::kValid ||
        !scanStateMatchesMetadata(original)) {
      return JournalAcknowledgementResult::kInvalidJournal;
    }

    char lastAcknowledgedEventId[kOfflineEventIdCapacity] = {};
    if (original.acknowledgedSequence > 0ULL &&
        formatOfflineEventId(deviceIdentifier_,
                             original.acknowledgedSequence,
                             lastAcknowledgedEventId) &&
        eventId != nullptr &&
        strcmp(lastAcknowledgedEventId, eventId) == 0) {
      return JournalAcknowledgementResult::kAlreadyAcknowledged;
    }
    if (original.pendingCount == 0U) {
      return JournalAcknowledgementResult::kEmpty;
    }
    if (eventId == nullptr || strcmp(oldest.eventId, eventId) != 0) {
      return JournalAcknowledgementResult::kMismatch;
    }

    const bool rewriteReportedSuccess = rewritePrefix(
        kPendingJournalPath, original.storedCount,
        original.compactedSequence, oldest.sequence);
    ScanState installed = {};
    const ScanResult installedResult =
        scan(kPendingJournalPath, nullptr, nullptr, installed);
    if (installedResult == ScanResult::kValid &&
        installed.storedCount == original.storedCount &&
        installed.pendingCount + 1U == original.pendingCount &&
        installed.maximumSequence == original.maximumSequence &&
        installed.compactedSequence == original.compactedSequence &&
        installed.acknowledgedSequence == oldest.sequence &&
        strcmp(installed.cacheGeneration,
               original.cacheGeneration) == 0) {
      accept(installed, false);
      return JournalAcknowledgementResult::kAcknowledged;
    }
    if (installedResult == ScanResult::kValid &&
        scanStatesEqual(installed, original)) {
      accept(installed, false);
      if (storage_.exists(kPendingJournalTemporaryPath)) {
        storage_.remove(kPendingJournalTemporaryPath);
      }
      return JournalAcknowledgementResult::kWriteFailed;
    }
    if (!storage_.available()) {
      return JournalAcknowledgementResult::kJournalUnavailable;
    }
    (void)rewriteReportedSuccess;
    invalidate();
    return JournalAcknowledgementResult::kWriteFailed;
  }

  // Called only after a cache refresh is authoritatively accepted and no
  // unacknowledged rows remain. It drops the retained overlay prefix but keeps
  // both the monotonic sequence floor and the last durable ACK receipt.
  JournalCompactionResult compactAcknowledgedPrefix() {
    if (uncertain_) return JournalCompactionResult::kInvalidJournal;
    if (!metadata_.available || !storage_.available()) {
      return JournalCompactionResult::kJournalUnavailable;
    }

    ScanState original = {};
    const ScanResult originalResult =
        scan(kPendingJournalPath, nullptr, nullptr, original);
    if (originalResult == ScanResult::kUnavailable) {
      return JournalCompactionResult::kJournalUnavailable;
    }
    if (originalResult != ScanResult::kValid ||
        !scanStateMatchesMetadata(original)) {
      return JournalCompactionResult::kInvalidJournal;
    }
    if (original.pendingCount != 0U) {
      return JournalCompactionResult::kNotReady;
    }
    if (original.storedCount == 0U &&
        original.compactedSequence == original.acknowledgedSequence) {
      return JournalCompactionResult::kAlreadyCompacted;
    }

    const bool rewriteReportedSuccess = rewritePrefix(
        kPendingJournalPath, 0U, original.acknowledgedSequence,
        original.acknowledgedSequence);
    ScanState installed = {};
    const ScanResult installedResult =
        scan(kPendingJournalPath, nullptr, nullptr, installed);
    if (installedResult == ScanResult::kValid &&
        installed.storedCount == 0U && installed.pendingCount == 0U &&
        installed.maximumSequence == original.acknowledgedSequence &&
        installed.compactedSequence == original.acknowledgedSequence &&
        installed.acknowledgedSequence == original.acknowledgedSequence &&
        installed.cacheGeneration[0] == '\0') {
      accept(installed, false);
      return JournalCompactionResult::kCompacted;
    }
    if (installedResult == ScanResult::kValid &&
        scanStatesEqual(installed, original)) {
      accept(installed, false);
      if (storage_.exists(kPendingJournalTemporaryPath)) {
        storage_.remove(kPendingJournalTemporaryPath);
      }
      return JournalCompactionResult::kWriteFailed;
    }
    if (!storage_.available()) {
      return JournalCompactionResult::kJournalUnavailable;
    }
    (void)rewriteReportedSuccess;
    invalidate();
    return JournalCompactionResult::kWriteFailed;
  }

  JournalLoadResult loadOrCreate(const char* deviceIdentifier) {
    reset();
    if (!storage_.available()) return JournalLoadResult::kStorageUnavailable;
    if (!validDeviceIdentifier(deviceIdentifier)) return JournalLoadResult::kInvalid;
    snprintf(deviceIdentifier_, sizeof(deviceIdentifier_), "%s",
             deviceIdentifier);

    const bool activeExisted = storage_.exists(kPendingJournalPath);
    const bool temporaryExisted =
        storage_.exists(kPendingJournalTemporaryPath);
    const bool backupExisted = storage_.exists(kPendingJournalBackupPath);

    ScanState active = {};
    const ScanResult activeResult =
        activeExisted
            ? scan(kPendingJournalPath, nullptr, nullptr, active)
            : ScanResult::kUnavailable;
    ScanState backup = {};
    const ScanResult backupResult =
        backupExisted
            ? scan(kPendingJournalBackupPath, nullptr, nullptr, backup)
            : ScanResult::kUnavailable;
    const bool activeRecoverable = activeResult == ScanResult::kValid ||
                                   activeResult == ScanResult::kTornTail;
    const bool backupRecoverable = backupResult == ScanResult::kValid ||
                                   backupResult == ScanResult::kTornTail;
    const bool backupPreferred =
        backupRecoverable &&
        (!activeRecoverable ||
         scanStateIsNewer(backup, active) ||
         (!scanStateIsNewer(active, backup) &&
           activeResult != ScanResult::kValid &&
           backupResult == ScanResult::kValid));

    if (activeResult == ScanResult::kValid && !backupPreferred) {
      accept(active, false);
      cleanupRecoveryFiles();
      return JournalLoadResult::kReady;
    }

    // Repair the recoverable source with the greatest durable sequence. This
    // comparison is essential because every incremental temporary prefix is
    // itself syntactically valid; a shorter temp/active must never delete a
    // fuller backup after an interrupted repair.
    const char* recoverySource = nullptr;
    ScanState recoveryState = {};
    ScanResult recoveryResult = ScanResult::kUnavailable;
    if (backupPreferred) {
      recoverySource = kPendingJournalBackupPath;
      recoveryState = backup;
      recoveryResult = backupResult;
    } else if (activeRecoverable) {
      recoverySource = kPendingJournalPath;
      recoveryState = active;
      recoveryResult = activeResult;
    } else if (backupRecoverable) {
      recoverySource = kPendingJournalBackupPath;
      recoveryState = backup;
      recoveryResult = backupResult;
    }
    if (recoverySource != nullptr) {
      if (repairPrefix(recoverySource, recoveryState.storedCount,
                       recoveryState.compactedSequence,
                       recoveryState.acknowledgedSequence)) {
        ScanState restored = {};
        if (scan(kPendingJournalPath, nullptr, nullptr, restored) ==
                ScanResult::kValid &&
            scanStatesEqual(restored, recoveryState)) {
          const bool recoveredTail =
              recoveryResult == ScanResult::kTornTail;
          accept(restored, recoveredTail);
          cleanupRecoveryFiles();
          return recoveredTail ? JournalLoadResult::kRecoveredTornTail
                               : JournalLoadResult::kReady;
        }
      }
      uncertain_ = true;
      return JournalLoadResult::kWriteFailed;
    }

    // A standalone complete temp can finish an interrupted temp-to-active
    // rename. If an authoritative active/backup path still exists but is
    // malformed, fail closed rather than letting a shorter temp mask it.
    if (!storage_.exists(kPendingJournalPath) &&
        !storage_.exists(kPendingJournalBackupPath) &&
        storage_.exists(kPendingJournalTemporaryPath)) {
      ScanState temporary = {};
      if (scan(kPendingJournalTemporaryPath, nullptr, nullptr, temporary) ==
              ScanResult::kValid &&
          promoteTemporary()) {
        ScanState installed = {};
        if (scan(kPendingJournalPath, nullptr, nullptr, installed) ==
            ScanResult::kValid) {
          accept(installed, false);
          cleanupRecoveryFiles();
          return JournalLoadResult::kReady;
        }
      }
    }

    if (!storage_.exists(kPendingJournalPath) &&
        !storage_.exists(kPendingJournalTemporaryPath) &&
        !storage_.exists(kPendingJournalBackupPath) && !activeExisted &&
        !temporaryExisted && !backupExisted) {
      if (!writeEmptyJournal(kPendingJournalPath, 0ULL, 0ULL)) {
        return JournalLoadResult::kWriteFailed;
      }
      ScanState empty = {};
      if (scan(kPendingJournalPath, nullptr, nullptr, empty) ==
          ScanResult::kValid) {
        accept(empty, false);
        return JournalLoadResult::kReady;
      }
    }

    uncertain_ = activeExisted || temporaryExisted || backupExisted ||
                 storage_.exists(kPendingJournalPath) ||
                 storage_.exists(kPendingJournalTemporaryPath) ||
                 storage_.exists(kPendingJournalBackupPath);
    return JournalLoadResult::kInvalid;
  }

  OverlayResult deriveCurrentStock(const cache::CacheProduct& product,
                                   const char* cacheGeneration,
                                   uint64_t& currentStock) {
    currentStock = product.currentStock;
    if (!metadata_.available || uncertain_ ||
        !cache::validGeneration(cacheGeneration)) {
      return OverlayResult::kJournalUnavailable;
    }
    ScanState state = {};
    const ScanResult result = scan(kPendingJournalPath, &product,
                                   cacheGeneration, state);
    if (result == ScanResult::kTornTail) {
      if (!repairPrefix(kPendingJournalPath, state.storedCount,
                        state.compactedSequence,
                        state.acknowledgedSequence)) {
        invalidate();
        return OverlayResult::kInvalidJournal;
      }
      state = ScanState{};
      if (scan(kPendingJournalPath, &product, cacheGeneration, state) !=
          ScanResult::kValid) {
        invalidate();
        return OverlayResult::kInvalidJournal;
      }
      state.recoveredTornTail = true;
    } else if (result != ScanResult::kValid) {
      invalidate();
      return OverlayResult::kInvalidJournal;
    }
    accept(state, state.recoveredTornTail);
    if (state.generationMismatch) return OverlayResult::kGenerationMismatch;
    if (state.stockInvalid) return OverlayResult::kStockInvalid;
    currentStock = state.currentStock;
    return OverlayResult::kSuccess;
  }

  JournalAppendResult append(OfflineAction action, const char* timestamp,
                             const cache::CacheProduct& product,
                             const char* cacheGeneration,
                             uint64_t resultingStock,
                             cache::StockStatus resultingStatus,
                             OfflineJournalRecord& committedRecord) {
    committedRecord = OfflineJournalRecord{};
    if (!metadata_.available || uncertain_) {
      return JournalAppendResult::kJournalUnavailable;
    }
    if (timestamp == nullptr || cacheGeneration == nullptr ||
        !validOfflineAction(action) || !validTimestamp(timestamp) ||
        !cache::validProduct(product)) {
      return JournalAppendResult::kInvalidRecord;
    }
    if (metadata_.storedCount >= kMaximumPendingRecords ||
        metadata_.maximumSequence == UINT64_MAX) {
      return JournalAppendResult::kFull;
    }
    if (!cache::validGeneration(cacheGeneration) ||
        (metadata_.storedCount > 0U &&
         strcmp(metadata_.cacheGeneration, cacheGeneration) != 0)) {
      return JournalAppendResult::kGenerationMismatch;
    }

    // Re-derive the authoritative current stock from the immutable cache plus
    // every durable journal row. Never trust the caller to supply a transition
    // that could poison the replay chain.
    uint64_t authoritativeCurrentStock = 0ULL;
    const OverlayResult overlay = deriveCurrentStock(
        product, cacheGeneration, authoritativeCurrentStock);
    if (overlay == OverlayResult::kGenerationMismatch) {
      return JournalAppendResult::kGenerationMismatch;
    }
    if (overlay != OverlayResult::kSuccess) {
      return JournalAppendResult::kValidationFailed;
    }
    uint64_t expectedResultingStock = 0ULL;
    cache::StockStatus expectedResultingStatus = cache::StockStatus::kEmpty;
    if (calculateOfflineStock(action, authoritativeCurrentStock,
                              product.lowStockThreshold,
                              expectedResultingStock,
                              expectedResultingStatus) !=
            OfflineStockResult::kSuccess ||
        resultingStock != expectedResultingStock ||
        resultingStatus != expectedResultingStatus) {
      return JournalAppendResult::kInvalidRecord;
    }

    appendRecord_ = OfflineJournalRecord{};
    appendRecord_.sequence = metadata_.maximumSequence + 1ULL;
    snprintf(appendRecord_.timestamp, sizeof(appendRecord_.timestamp), "%s",
             timestamp);
    snprintf(appendRecord_.productId, sizeof(appendRecord_.productId), "%s",
             product.id);
    snprintf(appendRecord_.barcode, sizeof(appendRecord_.barcode), "%s",
             product.barcode);
    appendRecord_.action = action;
    appendRecord_.delta = actionDelta(action);
    appendRecord_.resultingStock = resultingStock;
    appendRecord_.resultingStatus = resultingStatus;
    snprintf(appendRecord_.cacheGeneration,
             sizeof(appendRecord_.cacheGeneration), "%s",
             cacheGeneration);
    if (!formatOfflineEventId(deviceIdentifier_, appendRecord_.sequence,
                              appendRecord_.eventId) ||
        !validRecord(appendRecord_, deviceIdentifier_)) {
      return JournalAppendResult::kInvalidRecord;
    }

    size_t lineLength = 0U;
    if (!formatRecord(appendRecord_, deviceIdentifier_, line_, sizeof(line_),
                      lineLength)) {
      return JournalAppendResult::kInvalidRecord;
    }
    const uint32_t previousCount = metadata_.pendingCount;
    const uint32_t previousStoredCount = metadata_.storedCount;
    const uint64_t previousMaximumSequence = metadata_.maximumSequence;
    // The newline is the commit marker and is flushed in a separate append.
    // A reset during the record-body write therefore leaves an unterminated
    // tail that can be discarded without invalidating older committed rows.
    const bool bodyWriteReportedSuccess =
        storage_.appendFile(kPendingJournalPath, line_, lineLength);
    const char terminator = '\n';
    const bool terminatorWriteReportedSuccess =
        bodyWriteReportedSuccess &&
        storage_.appendFile(kPendingJournalPath, &terminator, 1U);
    const bool writeReportedSuccess =
        bodyWriteReportedSuccess && terminatorWriteReportedSuccess;
    ScanState installed = {};
    const ScanResult result = scan(kPendingJournalPath, nullptr, nullptr,
                                   installed);
    if (result == ScanResult::kValid &&
        installed.pendingCount == previousCount + 1U &&
        installed.storedCount == previousStoredCount + 1U &&
        installed.maximumSequence == appendRecord_.sequence) {
      // The durable bytes are authoritative even if a storage adapter reported
      // an ambiguous write failure after the complete record reached media.
      accept(installed, false);
      committedRecord = appendRecord_;
      return JournalAppendResult::kCommitted;
    }
    if (result == ScanResult::kValid &&
        installed.pendingCount == previousCount &&
        installed.storedCount == previousStoredCount &&
        installed.maximumSequence == previousMaximumSequence) {
      accept(installed, false);
      return writeReportedSuccess ? JournalAppendResult::kValidationFailed
                                  : JournalAppendResult::kWriteFailed;
    }
    if (result == ScanResult::kTornTail &&
        installed.pendingCount == previousCount &&
        installed.storedCount == previousStoredCount &&
        installed.maximumSequence == previousMaximumSequence &&
        repairPrefix(kPendingJournalPath, previousStoredCount,
                     installed.compactedSequence,
                     installed.acknowledgedSequence)) {
      ScanState repaired = {};
      if (scan(kPendingJournalPath, nullptr, nullptr, repaired) ==
              ScanResult::kValid &&
          repaired.pendingCount == previousCount &&
          repaired.storedCount == previousStoredCount &&
          repaired.maximumSequence == previousMaximumSequence) {
        accept(repaired, true);
        return writeReportedSuccess ? JournalAppendResult::kValidationFailed
                                    : JournalAppendResult::kWriteFailed;
      }
    }
    invalidate();
    return writeReportedSuccess ? JournalAppendResult::kValidationFailed
                                : JournalAppendResult::kWriteFailed;
  }

 private:
  enum class ScanResult : uint8_t {
    kValid,
    kTornTail,
    kUnavailable,
    kInvalid,
  };

  struct ScanState {
    uint32_t pendingCount;
    uint32_t storedCount;
    uint64_t maximumSequence;
    uint64_t compactedSequence;
    uint64_t acknowledgedSequence;
    char cacheGeneration[cache::kGenerationCapacity];
    bool generationMismatch;
    bool stockInvalid;
    uint64_t currentStock;
    bool recoveredTornTail;
  };

  static bool scanStatesEqual(const ScanState& left,
                              const ScanState& right) {
    return left.pendingCount == right.pendingCount &&
           left.storedCount == right.storedCount &&
           left.maximumSequence == right.maximumSequence &&
           left.compactedSequence == right.compactedSequence &&
           left.acknowledgedSequence == right.acknowledgedSequence &&
           strcmp(left.cacheGeneration, right.cacheGeneration) == 0;
  }

  static bool scanStateIsNewer(const ScanState& candidate,
                               const ScanState& baseline) {
    if (candidate.maximumSequence != baseline.maximumSequence) {
      return candidate.maximumSequence > baseline.maximumSequence;
    }
    if (candidate.acknowledgedSequence != baseline.acknowledgedSequence) {
      return candidate.acknowledgedSequence > baseline.acknowledgedSequence;
    }
    return candidate.compactedSequence > baseline.compactedSequence;
  }

  bool scanStateMatchesMetadata(const ScanState& state) const {
    return state.pendingCount == metadata_.pendingCount &&
           state.storedCount == metadata_.storedCount &&
           state.maximumSequence == metadata_.maximumSequence &&
           state.compactedSequence == metadata_.compactedSequence &&
           state.acknowledgedSequence == metadata_.acknowledgedSequence &&
           strcmp(state.cacheGeneration, metadata_.cacheGeneration) == 0;
  }

  static bool validRecord(const OfflineJournalRecord& record,
                          const char* deviceIdentifier) {
    return record.sequence > 0ULL &&
           detail::parseOfflineEventId(record.eventId, deviceIdentifier,
                                       record.sequence) &&
           validTimestamp(record.timestamp) &&
           cache::validDecimalProductId(record.productId) &&
           validScannerBarcode(record.barcode) &&
           record.delta == actionDelta(record.action) &&
           record.resultingStock <= cache::kMaximumStockValue &&
           (record.resultingStatus == cache::StockStatus::kHigh ||
            record.resultingStatus == cache::StockStatus::kLow ||
            record.resultingStatus == cache::StockStatus::kEmpty) &&
           cache::validGeneration(record.cacheGeneration);
  }

  static bool formatRecord(const OfflineJournalRecord& record,
                           const char* deviceIdentifier, char* output,
                           size_t capacity, size_t& length) {
    if (!validRecord(record, deviceIdentifier) || capacity == 0U) return false;
    output[0] = '\0';
    size_t written = 0U;
    char sequence[24U] = {};
    char stock[24U] = {};
    snprintf(sequence, sizeof(sequence), "%llu",
             static_cast<unsigned long long>(record.sequence));
    snprintf(stock, sizeof(stock), "%llu",
             static_cast<unsigned long long>(record.resultingStock));
    const char* delta = record.delta > 0 ? "+1" : "-1";
    const bool prefixOk =
        detail::appendText(output, capacity, written, sequence) &&
        detail::appendCharacter(output, capacity, written, ',') &&
        detail::appendQuoted(output, capacity, written, record.eventId) &&
        detail::appendCharacter(output, capacity, written, ',') &&
        detail::appendQuoted(output, capacity, written, record.timestamp) &&
        detail::appendCharacter(output, capacity, written, ',') &&
        detail::appendQuoted(output, capacity, written, record.productId) &&
        detail::appendCharacter(output, capacity, written, ',') &&
        detail::appendQuoted(output, capacity, written, record.barcode) &&
        detail::appendCharacter(output, capacity, written, ',') &&
        detail::appendQuoted(output, capacity, written,
                             actionName(record.action)) &&
        detail::appendCharacter(output, capacity, written, ',') &&
        detail::appendText(output, capacity, written, delta) &&
        detail::appendCharacter(output, capacity, written, ',') &&
        detail::appendText(output, capacity, written, stock) &&
        detail::appendCharacter(output, capacity, written, ',') &&
        detail::appendQuoted(output, capacity, written,
                             cache::stockStatusName(record.resultingStatus)) &&
        detail::appendCharacter(output, capacity, written, ',') &&
        detail::appendQuoted(output, capacity, written,
                             record.cacheGeneration);
    if (!prefixOk) return false;
    const uint32_t crc =
        cache::updateCrc32(0xFFFFFFFFUL, output, written) ^ 0xFFFFFFFFUL;
    char checksum[9U] = {};
    snprintf(checksum, sizeof(checksum), "%08lX",
             static_cast<unsigned long>(crc));
    if (!detail::appendCharacter(output, capacity, written, ',') ||
        !detail::appendText(output, capacity, written, checksum)) {
      return false;
    }
    length = written;
    return true;
  }

  static bool parseRecord(char* line, const char* deviceIdentifier,
                          OfflineJournalRecord& record) {
    record = OfflineJournalRecord{};
    char* const checksumComma = strrchr(line, ',');
    if (checksumComma == nullptr || checksumComma == line) return false;
    uint32_t storedCrc = 0U;
    if (!detail::parseHex32(checksumComma + 1U, storedCrc)) return false;
    const size_t prefixLength = static_cast<size_t>(checksumComma - line);
    const uint32_t calculatedCrc =
        cache::updateCrc32(0xFFFFFFFFUL, line, prefixLength) ^ 0xFFFFFFFFUL;
    if (calculatedCrc != storedCrc) return false;
    *checksumComma = '\0';

    size_t index = 0U;
    if (!cache::detail::parseCsvUnsigned(line, index, UINT64_MAX,
                                         record.sequence) ||
        !cache::detail::consumeCsvComma(line, index) ||
        !cache::detail::parseCsvQuoted(line, index, record.eventId,
                                       sizeof(record.eventId)) ||
        !cache::detail::consumeCsvComma(line, index) ||
        !cache::detail::parseCsvQuoted(line, index, record.timestamp,
                                       sizeof(record.timestamp)) ||
        !cache::detail::consumeCsvComma(line, index) ||
        !cache::detail::parseCsvQuoted(line, index, record.productId,
                                       sizeof(record.productId)) ||
        !cache::detail::consumeCsvComma(line, index) ||
        !cache::detail::parseCsvQuoted(line, index, record.barcode,
                                       sizeof(record.barcode)) ||
        !cache::detail::consumeCsvComma(line, index)) {
      return false;
    }
    char action[9U] = {};
    if (!cache::detail::parseCsvQuoted(line, index, action,
                                       sizeof(action)) ||
        !cache::detail::consumeCsvComma(line, index)) {
      return false;
    }
    if (strcmp(action, "RESTOCK") == 0) {
      record.action = OfflineAction::kRestock;
      record.delta = 1;
      if (strncmp(line + index, "+1", 2U) != 0) return false;
    } else if (strcmp(action, "CHECKOUT") == 0) {
      record.action = OfflineAction::kCheckout;
      record.delta = -1;
      if (strncmp(line + index, "-1", 2U) != 0) return false;
    } else {
      return false;
    }
    index += 2U;
    if (!cache::detail::consumeCsvComma(line, index) ||
        !cache::detail::parseCsvUnsigned(line, index,
                                         cache::kMaximumStockValue,
                                         record.resultingStock) ||
        !cache::detail::consumeCsvComma(line, index)) {
      return false;
    }
    char status[6U] = {};
    if (!cache::detail::parseCsvQuoted(line, index, status,
                                       sizeof(status)) ||
        !cache::detail::parseStatus(status, record.resultingStatus) ||
        !cache::detail::consumeCsvComma(line, index) ||
        !cache::detail::parseCsvQuoted(line, index, record.cacheGeneration,
                                       sizeof(record.cacheGeneration)) ||
        line[index] != '\0') {
      return false;
    }
    return validRecord(record, deviceIdentifier);
  }

  ScanResult scan(const char* path, const cache::CacheProduct* target,
                  const char* expectedGeneration, ScanState& state,
                  OfflineJournalRecord* oldestRecord = nullptr) {
    state = ScanState{};
    if (target != nullptr) state.currentStock = target->currentStock;
    if (!storage_.available() || !storage_.beginRead(path)) {
      return ScanResult::kUnavailable;
    }

    JournalReadLineResult lineResult =
        storage_.readLine(line_, sizeof(line_));
    bool valid = lineResult == JournalReadLineResult::kTerminatedLine &&
                 detail::parseJournalHeader(
                     line_, deviceIdentifier_, state.compactedSequence,
                     state.acknowledgedSequence);
    if (valid) {
      lineResult = storage_.readLine(line_, sizeof(line_));
      valid = lineResult == JournalReadLineResult::kTerminatedLine &&
              strcmp(line_, kPendingJournalColumns) == 0;
    }
    if (!valid) {
      storage_.endRead();
      return ScanResult::kInvalid;
    }

    uint64_t previousSequence = state.compactedSequence;
    state.maximumSequence = state.compactedSequence;
    while (true) {
      lineResult = storage_.readLine(line_, sizeof(line_));
      if (lineResult == JournalReadLineResult::kEnd) break;
      if (lineResult == JournalReadLineResult::kUnterminatedLine ||
          lineResult == JournalReadLineResult::kTooLongUnterminated) {
        storage_.endRead();
        return ScanResult::kTornTail;
      }
      if (lineResult != JournalReadLineResult::kTerminatedLine ||
          state.storedCount >= kMaximumPendingRecords) {
        storage_.endRead();
        return ScanResult::kInvalid;
      }
      scanRecord_ = OfflineJournalRecord{};
      if (!parseRecord(line_, deviceIdentifier_, scanRecord_) ||
          previousSequence == UINT64_MAX ||
          scanRecord_.sequence != previousSequence + 1ULL) {
        storage_.endRead();
        return ScanResult::kInvalid;
      }
      if (scanRecord_.sequence > state.acknowledgedSequence &&
          state.pendingCount == 0U && oldestRecord != nullptr) {
        *oldestRecord = scanRecord_;
      }
      previousSequence = scanRecord_.sequence;
      if (state.storedCount == 0U) {
        snprintf(state.cacheGeneration, sizeof(state.cacheGeneration), "%s",
                 scanRecord_.cacheGeneration);
      } else if (strcmp(state.cacheGeneration,
                        scanRecord_.cacheGeneration) != 0) {
        storage_.endRead();
        return ScanResult::kInvalid;
      }

      if (target != nullptr) {
        if (strcmp(scanRecord_.cacheGeneration, expectedGeneration) != 0) {
          state.generationMismatch = true;
        }
        const bool idMatches =
            strcmp(scanRecord_.productId, target->id) == 0;
        const bool barcodeMatches =
            strcmp(scanRecord_.barcode, target->barcode) == 0;
        if (idMatches != barcodeMatches) {
          storage_.endRead();
          return ScanResult::kInvalid;
        }
        if (idMatches) {
          uint64_t expectedStock = state.currentStock;
          if (scanRecord_.action == OfflineAction::kRestock) {
            if (expectedStock >= cache::kMaximumStockValue) {
              state.stockInvalid = true;
            } else {
              ++expectedStock;
            }
          } else if (expectedStock == 0ULL) {
            state.stockInvalid = true;
          } else {
            --expectedStock;
          }
          if (state.stockInvalid ||
              expectedStock != scanRecord_.resultingStock ||
              deriveStockStatus(expectedStock, target->lowStockThreshold) !=
                  scanRecord_.resultingStatus) {
            state.stockInvalid = true;
          } else {
            state.currentStock = expectedStock;
          }
        }
      }
      ++state.storedCount;
      if (scanRecord_.sequence > state.acknowledgedSequence) {
        ++state.pendingCount;
      }
      state.maximumSequence = scanRecord_.sequence;
    }
    storage_.endRead();
    if (state.acknowledgedSequence > state.maximumSequence ||
        (state.storedCount == 0U &&
         state.compactedSequence != state.acknowledgedSequence)) {
      return ScanResult::kInvalid;
    }
    return ScanResult::kValid;
  }

  void accept(const ScanState& state, bool recoveredTornTail) {
    metadata_ = PendingJournalMetadata{};
    metadata_.available = true;
    metadata_.pendingCount = state.pendingCount;
    metadata_.storedCount = state.storedCount;
    metadata_.maximumSequence = state.maximumSequence;
    metadata_.compactedSequence = state.compactedSequence;
    metadata_.acknowledgedSequence = state.acknowledgedSequence;
    snprintf(metadata_.cacheGeneration, sizeof(metadata_.cacheGeneration),
             "%s", state.cacheGeneration);
    metadata_.recoveredTornTail = recoveredTornTail;
    uncertain_ = false;
  }

  void reset() {
    metadata_ = PendingJournalMetadata{};
    uncertain_ = false;
    deviceIdentifier_[0] = '\0';
  }

  void invalidate() {
    metadata_ = PendingJournalMetadata{};
    uncertain_ = true;
  }

  bool writeEmptyJournal(const char* path, uint64_t compactedSequence,
                         uint64_t acknowledgedSequence) {
    size_t length = 0U;
    if (!detail::formatJournalHeader(
            deviceIdentifier_, compactedSequence, acknowledgedSequence,
            line_, sizeof(line_), length)) {
      return false;
    }
    return storage_.writeFile(path, line_, length);
  }

  bool rewritePrefix(const char* sourcePath, uint32_t recordCount,
                     uint64_t compactedSequence,
                     uint64_t acknowledgedSequence) {
    if (storage_.exists(kPendingJournalTemporaryPath) &&
        !storage_.remove(kPendingJournalTemporaryPath)) {
      return false;
    }
    if (!writeEmptyJournal(kPendingJournalTemporaryPath, compactedSequence,
                           acknowledgedSequence) ||
        !storage_.beginRead(sourcePath)) {
      return false;
    }
    uint64_t sourceCompactedSequence = 0ULL;
    uint64_t sourceAcknowledgedSequence = 0ULL;
    bool copied =
        storage_.readLine(line_, sizeof(line_)) ==
            JournalReadLineResult::kTerminatedLine &&
        detail::parseJournalHeader(line_, deviceIdentifier_,
                                   sourceCompactedSequence,
                                   sourceAcknowledgedSequence) &&
        storage_.readLine(line_, sizeof(line_)) ==
            JournalReadLineResult::kTerminatedLine &&
        strcmp(line_, kPendingJournalColumns) == 0;
    for (uint32_t index = 0U; copied && index < recordCount; ++index) {
      copied = storage_.readLine(line_, sizeof(line_)) ==
               JournalReadLineResult::kTerminatedLine;
      if (copied) {
        const size_t length = strlen(line_);
        const char terminator = '\n';
        copied = storage_.appendFile(kPendingJournalTemporaryPath, line_,
                                     length) &&
                 storage_.appendFile(kPendingJournalTemporaryPath,
                                     &terminator, 1U);
      }
    }
    storage_.endRead();
    if (!copied) return false;
    ScanState candidate = {};
    if (scan(kPendingJournalTemporaryPath, nullptr, nullptr, candidate) !=
            ScanResult::kValid ||
        candidate.storedCount != recordCount ||
        candidate.compactedSequence != compactedSequence ||
        candidate.acknowledgedSequence != acknowledgedSequence) {
      return false;
    }
    return promoteTemporary();
  }

  bool repairPrefix(const char* sourcePath, uint32_t validRecordCount,
                    uint64_t compactedSequence,
                    uint64_t acknowledgedSequence) {
    return rewritePrefix(sourcePath, validRecordCount, compactedSequence,
                         acknowledgedSequence);
  }

  bool promoteTemporary() {
    ScanState candidate = {};
    if (scan(kPendingJournalTemporaryPath, nullptr, nullptr, candidate) !=
        ScanResult::kValid) {
      return false;
    }

    const bool hadActive = storage_.exists(kPendingJournalPath);
    bool hadBackup = storage_.exists(kPendingJournalBackupPath);
    if (hadActive) {
      if (hadBackup) {
        ScanState active = {};
        ScanState backup = {};
        const ScanResult activeResult =
            scan(kPendingJournalPath, nullptr, nullptr, active);
        const ScanResult backupResult =
            scan(kPendingJournalBackupPath, nullptr, nullptr, backup);
        const bool activeRecoverable =
            activeResult == ScanResult::kValid ||
            activeResult == ScanResult::kTornTail;
        const bool backupRecoverable =
            backupResult == ScanResult::kValid ||
            backupResult == ScanResult::kTornTail;
        const bool preserveActive =
            activeRecoverable &&
            (!backupRecoverable || !scanStateIsNewer(backup, active));
        if (preserveActive) {
          // Retire a stale backup before rotating the current active file. A
          // reset at any following point can therefore roll back at most this
          // one operation, never an earlier acknowledged cursor.
          if (!storage_.remove(kPendingJournalBackupPath) ||
              !storage_.rename(kPendingJournalPath,
                               kPendingJournalBackupPath)) {
            return false;
          }
          hadBackup = true;
        } else if (!storage_.remove(kPendingJournalPath)) {
          return false;
        }
      } else if (!storage_.rename(kPendingJournalPath,
                                  kPendingJournalBackupPath)) {
        return false;
      } else {
        hadBackup = true;
      }
    }
    if (!storage_.rename(kPendingJournalTemporaryPath,
                         kPendingJournalPath)) {
      if (!storage_.exists(kPendingJournalPath) &&
          storage_.exists(kPendingJournalBackupPath)) {
        storage_.rename(kPendingJournalBackupPath, kPendingJournalPath);
      }
      return false;
    }

    ScanState installed = {};
    if (scan(kPendingJournalPath, nullptr, nullptr, installed) !=
            ScanResult::kValid ||
        !scanStatesEqual(installed, candidate)) {
      storage_.remove(kPendingJournalPath);
      if (hadBackup && storage_.exists(kPendingJournalBackupPath)) {
        storage_.rename(kPendingJournalBackupPath, kPendingJournalPath);
      }
      return false;
    }
    if (storage_.exists(kPendingJournalBackupPath)) {
      storage_.remove(kPendingJournalBackupPath);
    }
    return true;
  }

  void cleanupRecoveryFiles() {
    if (storage_.exists(kPendingJournalTemporaryPath)) {
      storage_.remove(kPendingJournalTemporaryPath);
    }
    if (storage_.exists(kPendingJournalBackupPath)) {
      storage_.remove(kPendingJournalBackupPath);
    }
  }

  PendingJournalStorage& storage_;
  PendingJournalMetadata metadata_ = {};
  bool uncertain_ = false;
  char deviceIdentifier_[kDeviceIdentifierCapacity] = {};
  char line_[kJournalLineCapacity] = {};
  // Journal rows carry a maximum-size barcode. Separate persistent scratch
  // records avoid nested ~1.2 KiB automatic allocations during append->scan.
  OfflineJournalRecord appendRecord_ = {};
  OfflineJournalRecord scanRecord_ = {};
};

}  // namespace offline
}  // namespace dental
