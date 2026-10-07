#include "sd_card.h"

#include <assert.h>
#include <stdio.h>

using dental_atmega::storage::ReadTrace;
using dental_link::storage::diagnostic::ReadFailureReason;

int main() {
  static_assert(sizeof(ReadTrace) <= 28U, "CMD17 trace must stay small");
  ReadTrace trace;
  trace.start(34816UL, true);
  trace.argument = 34816UL; // The actual block-addressed CMD17 argument.
  trace.attempts[0].flags = ReadTrace::kAttempted | ReadTrace::kTokenAccepted;
  trace.attempts[0].command.candidate = 0x00U;
  trace.attempts[0].command.pollIndex = 0U;
  trace.attempts[0].token = 0xFEU;
  trace.finish(false, ReadFailureReason::kNone);
  assert((trace.flags & ReadTrace::kValid) == 0U);
  uint8_t bytes[ReadTrace::kLength];
  trace.encode(bytes);
  assert(bytes[0] == ReadTrace::kVersion && bytes[1] == ReadTrace::kBlockAddressed &&
         bytes[3] == 0U && bytes[4] == 0U && bytes[5] == 0x88U && bytes[6] == 0U &&
         bytes[7] == 0U && bytes[8] == 0U && bytes[9] == 0x88U && bytes[10] == 0U &&
         bytes[17] == 0xFEU && bytes[18] == trace.attempts[0].flags);

  trace.start(34816UL, true);
  assert(trace.attempts[0].command.pollIndex == 0xFFU &&
         trace.attempts[1].command.pollIndex == 0xFFU &&
         trace.retryReadyByte == 0xFFU);
  trace.argument = 34816UL;
  trace.attempts[0].flags = ReadTrace::kAttempted | ReadTrace::kCsRaised |
                            ReadTrace::kTrailingClock;
  trace.attempts[0].command.selectedByte = 0xFFU;
  trace.attempts[0].command.pollIndex = 2U;
  trace.attempts[0].command.precedingByte = 0xFFU;
  trace.attempts[0].command.candidate = 0x05U;
  trace.retryReadyByte = 0xFFU;
  trace.retryFlags = ReadTrace::kRetryHighClock | ReadTrace::kRetrySelected |
                     ReadTrace::kRetryReady | ReadTrace::kRetryCsRaised |
                     ReadTrace::kRetryTrailingClock;
  trace.attempts[1].flags = ReadTrace::kAttempted | ReadTrace::kTokenAccepted;
  trace.attempts[1].command.candidate = 0x00U;
  trace.attempts[1].command.pollIndex = 0U;
  trace.attempts[1].token = 0xFEU;
  trace.finish(false, ReadFailureReason::kCmd17R1);
  assert((trace.flags & ReadTrace::kValid) == 0U); // Retry succeeded.

  trace.attempts[1].flags = ReadTrace::kAttempted | ReadTrace::kCsRaised |
                            ReadTrace::kTrailingClock;
  trace.attempts[1].command.pollIndex = 1U;
  trace.attempts[1].command.precedingByte = 0xFFU;
  trace.attempts[1].command.candidate = 0x3FU;
  trace.attempts[1].token = 0xFFU; // Not reached after nonzero R1.
  trace.finish(true, ReadFailureReason::kCmd17R1);
  trace.encode(bytes);
  assert((bytes[1] & ReadTrace::kValid) != 0U &&
         bytes[2] == static_cast<uint8_t>(ReadFailureReason::kCmd17R1) &&
         bytes[11] == 0xFFU && bytes[12] == trace.retryFlags &&
         bytes[14] == 2U && bytes[15] == 0xFFU && bytes[16] == 0x05U &&
         bytes[20] == 1U && bytes[21] == 0xFFU && bytes[22] == 0x3FU &&
         bytes[23] == 0xFFU && bytes[24] == trace.attempts[1].flags);

  trace.start(34817UL, false);
  trace.argument = 34817UL * 512UL;
  trace.attempts[0].flags = ReadTrace::kAttempted | ReadTrace::kR1Timeout |
                            ReadTrace::kCsRaised | ReadTrace::kTrailingClock;
  trace.finish(true, ReadFailureReason::kCmd17R1);
  trace.encode(bytes);
  assert((bytes[1] & ReadTrace::kBlockAddressed) == 0U &&
         bytes[6] == 0x01U && bytes[7] == 0x01U && bytes[8] == 0x10U &&
         bytes[9] == 0x02U && bytes[10] == 0U &&
         bytes[14] == 0xFFU && bytes[16] == 0xFFU &&
         (bytes[18] & ReadTrace::kR1Timeout) != 0U);
  printf("CMD17 compact trace bookkeeping: 7 scenarios PASS; record=%u bytes\n",
         static_cast<unsigned>(sizeof(ReadTrace)));
}
