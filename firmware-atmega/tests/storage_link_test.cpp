#include "../include/sd_card.h"

#include <assert.h>
#include <stdio.h>
#include <string>
#include <vector>

namespace {
struct FakeCard {
  dental_atmega::storage::State current = dental_atmega::storage::State::kReady;
  dental_atmega::storage::Diagnostic diag;
  dental_atmega::storage::ReadTrace trace;
  uint8_t sector[512] = {};
  uint16_t position = 0U;
  bool reading = false;
  bool writing = false;
  bool initializeSucceeds = true;
  bool failRead = false;
  bool failWrite = false;
  unsigned abortCount = 0U;
  bool initialize() {
    current = initializeSucceeds ? dental_atmega::storage::State::kReady
                                 : dental_atmega::storage::State::kUnavailable;
    return initializeSucceeds;
  }
  dental_atmega::storage::State state() const { return current; }
  bool sync() { return current == dental_atmega::storage::State::kReady; }
  bool beginRead(uint32_t requested) {
    trace.start(requested, true);
    if (failRead || requested == UINT32_MAX ||
        current != dental_atmega::storage::State::kReady) return false;
    position = 0U; reading = true; return true;
  }
  bool readChunk(uint8_t* out, uint8_t capacity, uint8_t& length, bool& complete) {
    if (!reading) return false;
    const uint16_t remaining = static_cast<uint16_t>(512U - position);
    length = static_cast<uint8_t>(remaining < capacity ? remaining : capacity);
    memcpy(out, sector + position, length); position = static_cast<uint16_t>(position + length);
    complete = position == 512U; if (complete) reading = false; return true;
  }
  bool beginWrite(uint32_t requested) {
    if (failWrite || requested != 0x1234ABCDUL ||
        current != dental_atmega::storage::State::kReady) return false;
    position = 0U; writing = true; return true;
  }
  bool writeChunk(const uint8_t* input, uint8_t length, bool& complete) {
    if (!writing || position + length > 512U) return false;
    memcpy(sector + position, input, length); position = static_cast<uint16_t>(position + length);
    complete = position == 512U; if (complete) writing = false; return true;
  }
  void abort() { reading = writing = false; position = 0U; ++abortCount; }
  const dental_atmega::storage::Diagnostic& diagnostic() const { return diag; }
  const dental_atmega::storage::ReadTrace& readTrace() const { return trace; }
};
struct Tx {
  std::string output;
  bool tryWrite(uint8_t byte) { output.push_back(char(byte)); return true; }
  void resetQueueMetrics() {}
  uint8_t queueHighWater() const { return 1U; }
};

struct ThrottledTx {
  std::string output;
  unsigned busyCycles = 0U;
  unsigned stallAfterFrames = 0U;
  unsigned stallCycles = 0U;
  unsigned frames = 0U;
  bool stallInjected = false;
  bool tryWrite(uint8_t byte) {
    if (busyCycles != 0U) { --busyCycles; return false; }
    output.push_back(static_cast<char>(byte));
    if (byte == '\n') {
      ++frames;
      if (!stallInjected && frames == stallAfterFrames) {
        stallInjected = true; busyCycles = stallCycles;
      }
    }
    return true;
  }
  void resetQueueMetrics() {}
  uint8_t queueHighWater() const { return stallInjected ? 16U : 1U; }
};

template <typename Link>
void feed(Link& link, const char* text) {
  while (*text) link.receive(static_cast<uint8_t>(*text++), false);
}
template <typename Link>
std::string drain(Link& link) {
  Tx tx;
  for (unsigned guard = 0; guard < 10000U && link.transmitting(); ++guard) link.service(tx);
  return tx.output;
}

template <typename Link, typename Writer>
void drainWith(Link& link, Writer& writer) {
  for (unsigned guard = 0U; guard < 200000U && link.transmitting(); ++guard)
    link.service(writer);
  assert(!link.transmitting());
}

void verifyReadOutput(const std::string& output, const uint8_t* expected) {
  dental_link::storage::Parser parser;
  uint8_t recovered[512] = {};
  dental_link::storage::SectorAssembler assembler(recovered);
  unsigned okCount = 0U;
  for (char value : output) {
    const dental_link::storage::Frame response =
        parser.receive(static_cast<uint8_t>(value));
    if (response.operation == dental_link::storage::Operation::kData)
      assert(assembler.accept(response));
    else if (response.operation == dental_link::storage::Operation::kOk) {
      assert(assembler.complete());
      ++okCount;
    }
  }
  assert(assembler.complete() && assembler.received() == 512U &&
         assembler.chunks() == 22U && assembler.lastOffset() == 504U &&
         assembler.lastLength() == 8U && okCount == 1U);
  assert(memcmp(recovered, expected, 512U) == 0);
}

void backpressureScenario(unsigned initialBusy, unsigned stallAfterFrames,
                          unsigned stallCycles) {
  FakeCard card;
  for (uint16_t i = 0U; i < 512U; ++i)
    card.sector[i] = static_cast<uint8_t>(i);
  dental_atmega::storage::Link<FakeCard> link(card);
  ThrottledTx tx;
  tx.busyCycles = initialBusy;
  tx.stallAfterFrames = stallAfterFrames;
  tx.stallCycles = stallCycles;
  feed(link, "SD:R:1234ABCD\n");
  drainWith(link, tx);
  verifyReadOutput(tx.output, card.sector);
  const auto& metrics = link.streamMetrics();
  assert(dental_atmega::storage::plausibleStreamMetrics(metrics));
  assert(metrics.framesAttempted == 22U && metrics.framesAccepted == 22U &&
         metrics.framesRejected == 0U && metrics.finalGeneratedOffset == 504U &&
         metrics.finalAcceptedOffset == 504U && metrics.okAttempted == 1U &&
         metrics.okAccepted == 1U);
  assert(metrics.deferred == initialBusy + stallCycles);
  dental_atmega::storage::StreamMetrics corrupted = metrics;
  corrupted.framesAttempted = 222U;
  corrupted.finalGeneratedOffset = 12596U;
  corrupted.finalAcceptedOffset = 12848U;
  assert(!dental_atmega::storage::plausibleStreamMetrics(corrupted));
  corrupted = metrics;
  corrupted.finalGeneratedOffset = 480U;
  assert(!dental_atmega::storage::plausibleStreamMetrics(corrupted));
}
}

int main() {
  using namespace dental_link::storage;
  static_assert(dental_atmega::hardware::kMicroSdChipSelectBit == 2U, "D10 CS");
  static_assert(dental_atmega::hardware::kMicroSdMosiBit == 3U, "D11 MOSI");
  static_assert(dental_atmega::hardware::kMicroSdMisoBit == 4U, "D12 MISO");
  static_assert(dental_atmega::hardware::kMicroSdClockBit == 5U, "D13 SCK");

  char command[16];
  assert(encodeSector(Operation::kReadSector, 0x1234ABCDUL, command, sizeof(command)));
  assert(strcmp(command, "SD:R:1234ABCD\n") == 0);
  Parser parser;
  Frame parsed;
  for (const char* p = command; *p; ++p) parsed = parser.receive(static_cast<uint8_t>(*p));
  assert(parsed.operation == Operation::kReadSector && parsed.sector == 0x1234ABCDUL);

  uint8_t bytes[24]; for (uint8_t i = 0U; i < 24U; ++i) bytes[i] = i;
  char dataLine[64];
  assert(encodeData(0x018U, bytes, sizeof(bytes), dataLine, sizeof(dataLine)));
  // Longest DATA line: 60 printable characters + newline + null terminator.
  assert(strlen(dataLine) == 61U);
  static_assert(kMaximumFrameLength >= 60U,
                "Parser must hold a maximum DATA line before newline");
  for (const char* p = dataLine; *p; ++p) parsed = parser.receive(static_cast<uint8_t>(*p));
  assert(parsed.operation == Operation::kData && parsed.offset == 0x018U &&
         parsed.length == 24U &&
         memcmp(parsed.data, bytes, 24U) == 0);

  Parser malformedParser;
  for (const char* p = "SD:DATA:000:0\n"; *p; ++p)
    parsed = malformedParser.receive(static_cast<uint8_t>(*p));
  assert(parsed.operation == Operation::kRejected &&
         malformedParser.lastLineWasStorage() &&
         malformedParser.lastRejectionReason() == RejectionReason::kMalformed);
  for (const char* p = "SD:DATA:000:0G\n"; *p; ++p)
    parsed = malformedParser.receive(static_cast<uint8_t>(*p));
  assert(parsed.operation == Operation::kRejected &&
         malformedParser.lastRejectionReason() == RejectionReason::kInvalidHex);
  Parser overflowParser;
  for (const char* p = "SD:"; *p; ++p)
    overflowParser.receive(static_cast<uint8_t>(*p));
  for (uint8_t index = 0U; index < kMaximumFrameLength - 2U; ++index)
    overflowParser.receive('X');
  parsed = overflowParser.receive('\n');
  assert(parsed.operation == Operation::kRejected &&
         overflowParser.lastLineWasStorage() &&
         overflowParser.lastLineLength() == kMaximumFrameLength &&
         overflowParser.lastRejectionReason() == RejectionReason::kLineOverflow);

  FakeCard card;
  for (uint16_t i = 0U; i < 512U; ++i) card.sector[i] = static_cast<uint8_t>(i);
  dental_atmega::storage::Link<FakeCard> link(card);
  feed(link, "SD:STATUS\n"); assert(drain(link) == "SD:READY\n");
  feed(link, "SD:SYNC\n"); assert(drain(link) == "SD:OK\n");
  for (uint8_t i = 0U; i < dental_atmega::storage::Diagnostic::kLength; ++i)
    card.diag.bytes[i] = i;
  feed(link, "SD:DIAG\n");
  const std::string diagnosticOutput = drain(link);
  for (char value : diagnosticOutput)
    parsed = parser.receive(static_cast<uint8_t>(value));
  assert(parsed.operation == Operation::kDiagnostic &&
         parsed.length == dental_atmega::storage::Diagnostic::kLength &&
         memcmp(parsed.data, card.diag.bytes, parsed.length) == 0);
  assert(card.abortCount == 0U && card.current == dental_atmega::storage::State::kReady);

  feed(link, "SD:TRACE\n");
  assert(drain(link) == "SD:ERROR\n"); // No failed CMD17 snapshot yet.
  card.trace.start(34816UL, true);
  card.trace.argument = 34816UL;
  card.trace.finish(true, diagnostic::ReadFailureReason::kCmd17R1);
  feed(link, "SD:TRACE\n");
  const std::string traceOutput = drain(link);
  for (char value : traceOutput)
    parsed = parser.receive(static_cast<uint8_t>(value));
  uint8_t expectedTrace[dental_atmega::storage::ReadTrace::kLength];
  card.trace.encode(expectedTrace);
  assert(parsed.operation == Operation::kDiagnostic &&
         parsed.length == read_trace::kLength &&
         memcmp(parsed.data, expectedTrace, parsed.length) == 0 &&
         card.abortCount == 0U &&
         card.current == dental_atmega::storage::State::kReady);

  feed(link, "PING\n"); assert(drain(link).empty());
  feed(link, "SD:BAD\n"); assert(drain(link) == "SD:ERROR\n");

  feed(link, "SD:R:1234ABCD\n");
  const std::string readOutput = drain(link);
  Parser responseParser;
  uint8_t recovered[512] = {};
  SectorAssembler assembler(recovered);
  unsigned okCount = 0U;
  for (char value : readOutput) {
    const Frame response = responseParser.receive(static_cast<uint8_t>(value));
    if (response.operation == Operation::kData) {
      assert(assembler.accept(response));
    }
    else if (response.operation == Operation::kOk) ++okCount;
  }
  assert(assembler.complete() && assembler.received() == 512U &&
         assembler.chunks() == 22U && assembler.lastOffset() == 504U &&
         assembler.lastLength() == 8U && okCount == 1U);
  for (uint16_t i = 0U; i < 512U; ++i) assert(recovered[i] == static_cast<uint8_t>(i));

  // Byte-level backpressure never advances a pending frame/offset. These
  // reproduce the physical stop points while preserving every frame exactly.
  backpressureScenario(0U, 0U, 0U);
  backpressureScenario(5U, 0U, 0U);   // First attempts for offset 0 deferred.
  backpressureScenario(0U, 3U, 7U);  // Resume after 72 bytes.
  backpressureScenario(0U, 9U, 11U); // Resume at offset 216.
  backpressureScenario(0U, 12U, 13U);// Resume at offset 288.

  // Inspect the commit point while chunk zero remains pending.
  FakeCard pendingCard;
  dental_atmega::storage::Link<FakeCard> pendingLink(pendingCard);
  ThrottledTx pendingTx; pendingTx.busyCycles = 4U;
  feed(pendingLink, "SD:R:1234ABCD\n");
  pendingLink.service(pendingTx); // Generate offset zero.
  for (unsigned i = 0U; i < 4U; ++i) pendingLink.service(pendingTx);
  assert(pendingLink.streamMetrics().framesAttempted == 1U &&
         pendingLink.streamMetrics().framesAccepted == 0U &&
         pendingLink.streamMetrics().finalGeneratedOffset == 0U &&
         pendingLink.streamMetrics().finalAcceptedOffset == 0xFFFFU);
  assert(pendingTx.output.find("SD:OK\n") == std::string::npos);
  feed(pendingLink, "PONG\nRTC_TIME?\n"); // Unrelated traffic cannot complete it.
  assert(pendingLink.transmitting());
  drainWith(pendingLink, pendingTx);
  verifyReadOutput(pendingTx.output, pendingCard.sector);

  // The one-transfer diagnostic is observational and reports the completed
  // final DATA frame before SD:OK.
  feed(pendingLink, "SD:STREAM?\n");
  const std::string streamOutput = drain(pendingLink);
  Frame streamFrame;
  for (char value : streamOutput)
    streamFrame = parser.receive(static_cast<uint8_t>(value));
  assert(streamFrame.operation == Operation::kStreamDiagnostic &&
         streamFrame.length == stream_diagnostic::kLength &&
         streamFrame.data[stream_diagnostic::kFramesAttempted] == 22U &&
         streamFrame.data[stream_diagnostic::kFramesAccepted] == 22U &&
         streamFrame.data[stream_diagnostic::kOkAccepted] == 1U);

  // An abort received while a DATA line is under backpressure takes effect at
  // the frame boundary, so SD:OK cannot be joined to a truncated DATA line.
  FakeCard abortCard;
  dental_atmega::storage::Link<FakeCard> abortLink(abortCard);
  ThrottledTx abortTx;
  feed(abortLink, "SD:R:1234ABCD\n");
  abortLink.service(abortTx); // Generate offset zero.
  for (unsigned i = 0U; i < 8U; ++i) abortLink.service(abortTx);
  feed(abortLink, "SD:ABORT\n");
  drainWith(abortLink, abortTx);
  Parser abortParser; unsigned abortData = 0U, abortOk = 0U;
  for (char value : abortTx.output) {
    const Frame frame = abortParser.receive(static_cast<uint8_t>(value));
    if (frame.operation == Operation::kData) ++abortData;
    if (frame.operation == Operation::kIdle) ++abortOk;
    assert(frame.operation != Operation::kRejected);
  }
  assert(abortData == 1U && abortOk == 1U && abortCard.abortCount == 1U &&
         abortCard.current == dental_atmega::storage::State::kReady);

  uint8_t partialBytes[512] = {};
  SectorAssembler missingTail(partialBytes);
  for (uint16_t offset = 0U; offset < 504U; offset += 24U) {
    Frame chunk; chunk.operation = Operation::kData; chunk.offset = offset;
    chunk.length = 24U;
    assert(missingTail.accept(chunk));
  }
  assert(missingTail.received() == 504U && !missingTail.complete());
  Frame finalChunk; finalChunk.operation = Operation::kData;
  finalChunk.offset = 504U; finalChunk.length = 8U;
  assert(missingTail.accept(finalChunk) && missingTail.complete());

  SectorAssembler duplicate(partialBytes);
  Frame firstChunk; firstChunk.operation = Operation::kData;
  firstChunk.offset = 0U; firstChunk.length = 24U;
  assert(duplicate.accept(firstChunk));
  assert(!duplicate.accept(firstChunk));
  Frame outOfOrder = firstChunk; outOfOrder.offset = 48U;
  assert(!duplicate.accept(outOfOrder));

  memset(card.sector, 0, sizeof(card.sector));
  feed(link, "SD:W:1234ABCD\n"); assert(drain(link) == "SD:OK\n");
  for (uint16_t offset = 0U; offset < 512U;) {
    const uint8_t length = static_cast<uint8_t>((512U - offset) < 24U ? 512U - offset : 24U);
    uint8_t chunk[24];
    for (uint8_t i = 0U; i < length; ++i) chunk[i] = static_cast<uint8_t>(offset + i);
    assert(encodeData(offset, chunk, length, dataLine, sizeof(dataLine)));
    feed(link, dataLine); assert(drain(link) == "SD:OK\n"); offset += length;
  }
  for (uint16_t i = 0U; i < 512U; ++i) assert(card.sector[i] == static_cast<uint8_t>(i));

  card.current = dental_atmega::storage::State::kUnavailable;
  feed(link, "SD:STATUS\n"); assert(drain(link) == "SD:REINIT_READY\n");
  dental_link::storage::Parser statusParser;
  dental_link::storage::Frame statusFrame;
  for (const char* p = "SD:REINIT_READY\n"; *p; ++p)
    statusFrame = statusParser.receive(static_cast<uint8_t>(*p));
  assert(statusFrame.operation ==
         dental_link::storage::Operation::kReinitializedReady);

  // A duplicate/out-of-order write chunk is rejected and aborts the transfer.
  feed(link, "SD:W:1234ABCD\n"); assert(drain(link) == "SD:OK\n");
  assert(encodeData(24U, bytes, sizeof(bytes), dataLine, sizeof(dataLine)));
  feed(link, dataLine); assert(drain(link) == "SD:ERROR\n");
  assert(card.abortCount != 0U && !card.writing);

  // STATUS cannot replace an owned write; only ABORT retires it.
  feed(link, "SD:W:1234ABCD\n"); assert(drain(link) == "SD:OK\n");
  feed(link, "SD:STATUS\n"); assert(drain(link).empty());
  assert(card.writing);
  feed(link, "SD:ABORT\n"); assert(drain(link) == "SD:IDLE\n");
  assert(!card.writing);

  // Empty, oversized and malformed DATA frames fail closed.
  feed(link, "SD:DATA:000:\n"); assert(drain(link) == "SD:ERROR\n");
  feed(link, "SD:DATA:200:00\n"); assert(drain(link) == "SD:ERROR\n");
  feed(link, "SD:DATA:00G:00\n"); assert(drain(link) == "SD:ERROR\n");

  // ATmega command parser fits the exact 60-byte maximum write frame, while
  // a longer line fails closed without writing beyond its fixed buffer.
  dental_link::storage::BasicParser<60U> compactParser;
  assert(encodeData(0U, bytes, sizeof(bytes), dataLine, sizeof(dataLine)));
  dental_link::storage::Frame compactFrame;
  for (const char* p = dataLine; *p; ++p)
    compactFrame = compactParser.receive(static_cast<uint8_t>(*p));
  assert(compactFrame.operation == Operation::kData &&
         compactFrame.length == 24U);
  for (uint8_t index = 0U; index < 60U; ++index)
    compactFrame = compactParser.receive(static_cast<uint8_t>(dataLine[index]));
  compactParser.receive('0');
  compactFrame = compactParser.receive('\n');
  assert(compactFrame.operation == Operation::kRejected);

  card.current = dental_atmega::storage::State::kUnavailable;
  card.initializeSucceeds = false;
  feed(link, "SD:STATUS\n"); assert(drain(link) == "SD:UNAVAILABLE\n");
  card.initializeSucceeds = true;
  feed(link, "SD:STATUS\n"); assert(drain(link) == "SD:REINIT_READY\n");

  card.failRead = true;
  feed(link, "SD:R:1234ABCD\n"); assert(drain(link) == "SD:ERROR\n");
  card.failRead = false;
  card.failWrite = true;
  feed(link, "SD:W:1234ABCD\n"); assert(drain(link) == "SD:ERROR\n");
  card.failWrite = false;

  // 100 adjacent/repeated-sector reads with byte-level backpressure.
  FakeCard repeatedCard;
  dental_atmega::storage::Link<FakeCard> repeated(repeatedCard);
  for (unsigned cycle = 0U; cycle < 100U; ++cycle) {
    for (unsigned index = 0U; index < 512U; ++index)
      repeatedCard.sector[index] = static_cast<uint8_t>(index + cycle / 2U);
    assert(encodeSector(Operation::kReadSector, 34816U + cycle / 2U,
                        command, sizeof(command)));
    feed(repeated, command);
    ThrottledTx tx; tx.busyCycles = cycle % 7U;
    drainWith(repeated, tx);
    verifyReadOutput(tx.output, repeatedCard.sector);
  }
  // Timeout at each requested stop point, including lost final OK. A new
  // command cannot overwrite an active stream even in an inter-frame gap.
  for (unsigned stop : {1U, 8U, 21U, 22U}) {
    FakeCard faultCard;
    dental_atmega::storage::Link<FakeCard> fault(faultCard);
    ThrottledTx tx;
    feed(fault, "SD:R:1234ABCD\n");
    while (tx.frames < stop) fault.service(tx);
    const unsigned framesAtTimeout = tx.frames;
    const uint16_t cardPosition = faultCard.position;
    feed(fault, "SD:R:00008801\n"); // No overwrite/reset in the DATA gap.
    assert(faultCard.position == cardPosition);
    uint8_t target[512] = {};
    SectorAssembler fresh(target);
    Frame stale; stale.operation = Operation::kData;
    stale.offset = 216U; stale.length = 24U;
    assert(!fresh.accept(stale));
    stale.offset = 240U; assert(!fresh.accept(stale));
    feed(fault, "SD:ABORT:12345678\n");
    drainWith(fault, tx);
    Parser fenceParser;
    unsigned fences = 0U;
    for (char value : tx.output) {
      Frame response = fenceParser.receive(static_cast<uint8_t>(value));
      if (response.operation == Operation::kIdle) {
        assert(response.sector == 0x12345678U); ++fences;
      }
    }
    assert(fences == 1U && tx.frames == framesAtTimeout + 1U);
    feed(fault, "SD:STREAM?\n");
    Parser metricsParser; Frame metrics;
    for (char value : drain(fault)) metrics = metricsParser.receive(static_cast<uint8_t>(value));
    assert(metrics.operation == Operation::kStreamDiagnostic);
    assert(metrics.data[stream_diagnostic::kVersion] == 2U);
    assert((metrics.data[stream_diagnostic::kFlags] & 1U) != 0U);
    assert(metrics.data[stream_diagnostic::kFramesAccepted] == stop);
    assert(metrics.data[stream_diagnostic::kSector + 2U] == 0xABU &&
           metrics.data[stream_diagnostic::kSector + 3U] == 0xCDU);
    feed(fault, "SD:R:00008801\n");
    verifyReadOutput(drain(fault), faultCard.sector);
  }
  // Delayed terminal from a previous abort is not a new fence reply.
  Frame oldFence;
  Parser fenceParser;
  for (char byte : std::string("SD:IDLE:12345678\n"))
    oldFence = fenceParser.receive(static_cast<uint8_t>(byte));
  assert(oldFence.operation == Operation::kIdle && oldFence.sector != 0x12345679U);
  assert(!matchesIdleFence(oldFence, 0x12345679U));
  assert(matchesIdleFence(oldFence, 0x12345678U));
  Frame oldOk; oldOk.operation = Operation::kOk;
  assert(!matchesIdleFence(oldOk, 0x12345678U));
  ResponseMailbox mailbox;
  assert(mailbox.publish(firstChunk));
  assert(!mailbox.publish(finalChunk));
  assert(!mailbox.publish(oldOk));
  assert(mailbox.frame.offset == 0U && mailbox.available);
  mailbox.available = false;
  assert(mailbox.publish(finalChunk) && mailbox.frame.offset == 504U);
  puts("ATmega MicroSD block transport: 50 scenarios + 100 sector cycles PASSED");
}
