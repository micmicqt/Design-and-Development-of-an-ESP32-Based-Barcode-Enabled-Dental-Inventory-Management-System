#pragma once

#include <stdint.h>

namespace dental { namespace storage {

// SD:STATUS may perform the ATmega's bounded CMD0 and ACMD41 sequences.
// The first initialization may also wait for the remainder of a 500 ms card
// power-up interval. 20 * (100 ms + <=2 ms command) plus
// 300 * (10 ms + <=4 ms for CMD55/ACMD41) remains below the 8 s timeout.
// Reserve transport margin
// without changing HTTP or ordinary controller-link timeouts.
constexpr uint32_t kInitializationRequestTimeoutMs = 8000UL;
constexpr uint32_t kBoundedInitializationWorstCaseMs =
    500UL + 20UL * 102UL + 300UL * 14UL;
static_assert(kInitializationRequestTimeoutMs >
                  kBoundedInitializationWorstCaseMs + 1000UL,
              "SD:STATUS must outlast legal bounded card initialization");

// 65000 byte polls * 8 bits / 125 kHz = 4160 ms. A read may use
// two token polls and one retry-ready poll, before its first DATA appears.
constexpr uint32_t kRawPollBudgetMs = (65000UL * 8UL * 1000UL) / 125000UL;
// DATA: 12 prefix/offset/separator + 48 hex + newline = 61 bytes;
// final 8-byte DATA = 29 bytes. READ command = 14, terminal OK = 6.
constexpr uint32_t kSectorWireBytes = 14UL + 21UL * 61UL + 29UL + 6UL;
constexpr uint32_t kSectorWireMs = (kSectorWireBytes * 10UL * 1000UL + 9599UL) / 9600UL;
constexpr uint32_t kSectorSpiMs = (518UL * 8UL * 1000UL + 124999UL) / 125000UL;
// SD:W plus 22 DATA frames each acknowledged, including initial command OK.
constexpr uint32_t kWriteWireBytes = 14UL + 21UL * 61UL + 29UL + 23UL * 6UL;
constexpr uint32_t kWriteWireMs = (kWriteWireBytes * 10UL * 1000UL + 9599UL) / 9600UL;
constexpr uint32_t kSchedulerMarginMs = 2000UL;
constexpr uint32_t kReadSectorTimeoutMs =
    3UL * kRawPollBudgetMs + kSectorWireMs + kSectorSpiMs + kSchedulerMarginMs;
// CMD24 has a pre-data ready poll AND a post-write programming busy poll.
constexpr uint32_t kWriteSectorTimeoutMs =
    2UL * kRawPollBudgetMs + kWriteWireMs + kSectorSpiMs + kSchedulerMarginMs;
constexpr uint32_t kSyncTimeoutMs = kRawPollBudgetMs + 20UL + kSchedulerMarginMs;
static_assert(kReadSectorTimeoutMs > 15000UL, "Read must include raw bootstrap and wire cost");

} }
