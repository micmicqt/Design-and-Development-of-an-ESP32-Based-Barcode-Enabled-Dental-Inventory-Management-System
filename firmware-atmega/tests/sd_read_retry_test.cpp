#include "sd_card.h"

#include <assert.h>
#include <stdio.h>

using dental_atmega::storage::ReadAttempt;
using dental_atmega::storage::ReadOperation;
using dental_atmega::storage::classifyReadAttempt;
using dental_atmega::storage::readFailureInvalidatesCard;
using dental_atmega::storage::readWithOneRetry;
using dental_link::storage::diagnostic::ReadFailureReason;

namespace {

struct Fixture {
  ReadAttempt results[2];
  uint8_t calls = 0U;
  uint8_t recoveries = 0U;
  bool recoverySucceeds = true;
  uint32_t sectors[2] = {};
  uint16_t streamStartOffset = 0xFFFFU;
  uint8_t streamStarts = 0U;

  ReadAttempt attempt(uint32_t sector) {
    sectors[calls] = sector;
    const ReadAttempt result = results[calls++];
    if (result.success) {
      streamStartOffset = 0U;
      ++streamStarts;
    }
    return result;
  }
  bool recover() {
    ++recoveries;
    return recoverySucceeds;
  }
};

ReadOperation run(Fixture& fixture, uint32_t sector = 34817UL) {
  return readWithOneRetry(
      sector,
      [&fixture](uint32_t requested) { return fixture.attempt(requested); },
      [&fixture]() { return fixture.recover(); });
}

ReadAttempt success() {
  return ReadAttempt(true, ReadFailureReason::kNone, 0x00U, 0xFEU);
}

}

int main() {
  const ReadAttempt rejectedR1 = classifyReadAttempt(0x3FU, 0xFFU);
  assert(!rejectedR1.success &&
         rejectedR1.reason == ReadFailureReason::kCmd17R1 &&
         rejectedR1.r1 == 0x3FU);
  const ReadAttempt validToken = classifyReadAttempt(0x00U, 0xFEU);
  assert(validToken.success && validToken.reason == ReadFailureReason::kNone);
  const ReadAttempt missingToken = classifyReadAttempt(0x00U, 0xFFU);
  assert(!missingToken.success &&
         missingToken.reason == ReadFailureReason::kDataTokenTimeout);
  const ReadAttempt invalidToken = classifyReadAttempt(0x00U, 0x0DU);
  assert(!invalidToken.success &&
         invalidToken.reason == ReadFailureReason::kDataTokenInvalid);

  Fixture firstSuccess;
  firstSuccess.results[0] = success();
  ReadOperation result = run(firstSuccess);
  assert(result.success && result.attempts == 1U && firstSuccess.calls == 1U &&
         firstSuccess.recoveries == 0U && firstSuccess.streamStarts == 1U &&
         firstSuccess.streamStartOffset == 0U &&
         !readFailureInvalidatesCard(result));

  Fixture r1Recovery;
  r1Recovery.results[0] = ReadAttempt(
      false, ReadFailureReason::kCmd17R1, 0x05U, 0xFFU);
  r1Recovery.results[1] = success();
  result = run(r1Recovery);
  assert(result.success && result.attempts == 2U && r1Recovery.calls == 2U &&
         r1Recovery.recoveries == 1U && r1Recovery.sectors[0] == 34817UL &&
         r1Recovery.sectors[1] == 34817UL && r1Recovery.streamStarts == 1U &&
         r1Recovery.streamStartOffset == 0U &&
         result.diagnostic.reason == ReadFailureReason::kCmd17R1 &&
         result.diagnostic.r1 == 0x05U && !readFailureInvalidatesCard(result));

  Fixture tokenRecovery;
  tokenRecovery.results[0] = ReadAttempt(
      false, ReadFailureReason::kDataTokenTimeout, 0x00U, 0xFFU);
  tokenRecovery.results[1] = success();
  result = run(tokenRecovery);
  assert(result.success && tokenRecovery.calls == 2U &&
         tokenRecovery.streamStarts == 1U &&
         result.diagnostic.reason == ReadFailureReason::kDataTokenTimeout);

  Fixture bothFail;
  bothFail.results[0] = ReadAttempt(
      false, ReadFailureReason::kCmd17R1, 0x04U, 0xFFU);
  bothFail.results[1] = ReadAttempt(
      false, ReadFailureReason::kDataTokenInvalid, 0x00U, 0x0BU);
  result = run(bothFail);
  assert(!result.success && result.attempts == 2U && bothFail.calls == 2U &&
         bothFail.recoveries == 1U && bothFail.streamStarts == 0U &&
         result.diagnostic.reason == ReadFailureReason::kDataTokenInvalid &&
         readFailureInvalidatesCard(result));

  Fixture recoveryFailure;
  recoveryFailure.results[0] = ReadAttempt(
      false, ReadFailureReason::kCmd17R1, 0x05U, 0xFFU);
  recoveryFailure.recoverySucceeds = false;
  result = run(recoveryFailure);
  assert(!result.success && result.attempts == 2U &&
         recoveryFailure.calls == 1U && recoveryFailure.recoveries == 1U &&
         result.diagnostic.reason == ReadFailureReason::kWaitReadyTimeout &&
         readFailureInvalidatesCard(result));

  Fixture notReady;
  notReady.results[0] = ReadAttempt(
      false, ReadFailureReason::kNotReady, 0xFFU, 0xFFU);
  result = run(notReady);
  assert(!result.success && result.attempts == 1U && notReady.calls == 1U &&
         notReady.recoveries == 0U && !readFailureInvalidatesCard(result));

  Fixture transferState;
  transferState.results[0] = ReadAttempt(
      false, ReadFailureReason::kTransferState, 0xFFU, 0xFFU);
  result = run(transferState);
  assert(!result.success && transferState.recoveries == 0U &&
         !readFailureInvalidatesCard(result));

  Fixture invalidTokenRecovery;
  invalidTokenRecovery.results[0] = ReadAttempt(
      false, ReadFailureReason::kDataTokenInvalid, 0x00U, 0x0DU);
  invalidTokenRecovery.results[1] = success();
  result = run(invalidTokenRecovery, 0UL);
  assert(result.success && invalidTokenRecovery.sectors[0] == 0UL &&
         invalidTokenRecovery.sectors[1] == 0UL &&
         invalidTokenRecovery.streamStarts == 1U);

  puts("ATmega raw SD read/retry: 15 focused scenarios PASSED");
}
