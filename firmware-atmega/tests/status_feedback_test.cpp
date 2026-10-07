#include "status_feedback.h"

#include <assert.h>
#include <stdio.h>

using dental_atmega::BigStatus;
using dental_atmega::SmallStatus;
using dental_atmega::StatusFeedback;
using dental_link::Frame;

Frame parseFeedback(const char* line) {
  dental_link::BasicLineParser<20U> parser;
  Frame frame = Frame::kNone;
  for (const char* byte = line; *byte != '\0'; ++byte)
    frame = parser.receive(static_cast<uint8_t>(*byte));
  return frame;
}

int main() {
  assert(parseFeedback(dental_link::kStockHighFeedback) ==
         Frame::kStockHighFeedback);
  assert(parseFeedback(dental_link::kStockLowFeedback) ==
         Frame::kStockLowFeedback);
  assert(parseFeedback(dental_link::kStockEmptyFeedback) ==
         Frame::kStockEmptyFeedback);
  assert(parseFeedback("STOCK:X\n") == Frame::kRejected);
  assert(parseFeedback("STOCK:H:EXTRA\n") == Frame::kRejected);
  assert(dental_link::operationForMode(Frame::kStockHighFeedback) ==
         Frame::kNone);
  assert(dental_link::operationForMode(Frame::kStockLowFeedback) ==
         Frame::kNone);
  assert(dental_link::operationForMode(Frame::kStockEmptyFeedback) ==
         Frame::kNone);
  StatusFeedback feedback;
  assert(feedback.small() == SmallStatus::OFF);
  assert(feedback.big() == BigStatus::OFF);

  feedback.receive(1U, Frame::kStockHighFeedback);
  assert(feedback.small() == SmallStatus::GREEN);
  assert(dental_atmega::smallPortBits(feedback.small()) == 0x30U);
  feedback.receive(2U, Frame::kStockLowFeedback);
  assert(feedback.small() == SmallStatus::YELLOW);
  assert(dental_atmega::smallPortBits(feedback.small()) == 0x10U);
  feedback.receive(3U, Frame::kStockEmptyFeedback);
  assert(feedback.small() == SmallStatus::RED);
  assert(dental_atmega::smallPortBits(feedback.small()) == 0x20U);

  feedback.receive(100U, Frame::kRestockCommittedFeedback);
  assert(feedback.big() == BigStatus::GREEN);
  assert(dental_atmega::bigPortBits(feedback.big()) == 0x03U);
  feedback.service(1099U);
  assert(feedback.big() == BigStatus::GREEN);
  feedback.service(1100U);
  assert(feedback.big() == BigStatus::OFF);
  assert(feedback.small() == SmallStatus::RED);

  feedback.receive(200U, Frame::kCheckoutOfflineFeedback);
  assert(feedback.big() == BigStatus::GREEN);
  feedback.receive(300U, Frame::kScanErrorFeedback);
  assert(feedback.big() == BigStatus::RED);
  assert(dental_atmega::bigPortBits(feedback.big()) == 0x01U);
  feedback.receive(400U, Frame::kScanDismissedFeedback);
  assert(feedback.big() == BigStatus::OFF);
  feedback.receive(500U, Frame::kUnknownBarcodeFeedback);
  assert(feedback.big() == BigStatus::RED);
  feedback.localError(600U);
  feedback.service(1599U);
  assert(feedback.big() == BigStatus::RED);
  feedback.service(1600U);
  assert(feedback.big() == BigStatus::OFF);

  feedback.receive(0xFFFFFFF0UL, Frame::kCheckoutCommittedFeedback);
  feedback.service(0x00000010UL);
  assert(feedback.big() == BigStatus::GREEN);
  feedback.service(0x000003D8UL);
  assert(feedback.big() == BigStatus::OFF);
  feedback.receive(3000U, Frame::kPong);
  assert(feedback.small() == SmallStatus::RED);
  assert(feedback.big() == BigStatus::OFF);

  puts("ATmega status feedback: 21 focused scenarios PASSED");
}
