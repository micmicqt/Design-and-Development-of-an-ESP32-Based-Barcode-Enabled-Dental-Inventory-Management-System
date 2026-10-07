# ATmega memory-safety pass

No hardware upload, COM access, physical pending-record access, staging, commit,
or push was performed. This is a memory/layout optimization of the current
working firmware, not a redesign or physical-stability claim.

## Measured improvement

| Metric | Before | After |
| --- | ---: | ---: |
| Production flash | 26,824 | 26,086 |
| Static SRAM | 1,313 | 517 |
| `.data` / `.bss` | 900 / 413 | 104 / 413 |
| Non-LTO main frame (`-Os -fstack-usage`) | 571 | 571 |
| Main frame in production LTO disassembly, including saved Y/return PC | 635 | 632 |
| Static + non-LTO main residual, **not a complete stack reserve** | 164 | 960 |

Immutable protocol comparisons, prefixes, SD replies, RTC state/reason strings,
and the month-length table now reside in AVR flash. Received text remains SRAM.
All accesses to these immutable objects use AVR `LPM`/`*_P` operations; non-AVR
builds use ordinary reads/string operations. Protocol byte contents are unchanged.
No local object was relocated into static storage: `.bss` is unchanged.

LCD date/time lines are formatted directly into the caller's existing row.
Unsigned minimum-width/zero-padding behavior is preserved even for out-of-range
LCD field values. RTC timestamps are formatted directly into the existing,
exclusively owned reply slot. No second/shared scratch buffer was introduced.
The fixed-width RTC formatter retains validation/capacity checks and identical
20-byte timestamp-plus-NUL output. Production no longer links printf/vfprintf
or allocation routines.

The combined SRAM saving is **796 bytes**. The simultaneous changes were measured
as one build, not as independent per-edit SRAM snapshots; their static savings
must not be added again to the frame savings below.

| Optimization / relevant non-LTO function | Old frame | New frame | Static consequence |
| --- | ---: | ---: | --- |
| Flash text access | main 571 | main 571 | Combined `.data` falls 796; no new mutable storage |
| Remove RTC timestamp local and varargs formatting: `RtcLink::service` | 51 | 9 | Existing 48-byte reply retained; no added buffer |
| Direct LCD row formatting: `screenLine` | 42 + printf callees | 9 + decimal 8 | Existing 20-byte row retained; no added buffer |
| Flash RTC queue state construction | `queueParts` 24 | `queueState` 26 | Slight frame increase, outweighed by flash text and formatting savings |

## Per-function stack and realistic paths

All production `.cpp` files were compiled separately with `-mmcu=atmega328p`,
`-DF_CPU=16000000UL`, `-std=gnu++11`, `-Os`, `-fno-lto`, and `-fstack-usage`.
Reports are in ignored `.runtime/memory-safety-before/` and
`.runtime/memory-safety-after/`. These estimates include return addresses, but
do not describe final LTO inlining; production ELF disassembly was also audited.

Largest remaining non-LTO frames:

| Function | Bytes |
| --- | ---: |
| main | 571 |
| RawCard::beginRead | 44 |
| storage Link::service | 40 |
| Link::queueStreamDiagnostic | 35 |
| Link::queueReadTrace | 33 |
| RtcLink::queueState | 26 |
| LCD Display::service | 24 |
| RTC parseDateTime / PhysicalWorkflow::service | 20 each |

The production main prologue allocates 628 bytes, saves Y (2), and has its return
PC (2): **632 bytes**. Main includes inlined parsing, workflow, scanner, and
LCD/RTC paths; do not add their non-LTO frames to the LTO total a second time.
The production call graph has no indirect calls, recursion, dynamic allocation,
or printf helper prologues after this change. Tail calls were accounted without
adding another return address.

Representative production paths (foreground stack, before ISR):

| Operation | Real path / peak estimate |
| --- | --- |
| Controller RX | main contains polling, parsing and dispatch; completed SD command can enter the CMD17 path below |
| CMD17 | main 632 -> beginRead 38 -> beginReadAttempt 10 -> command 18 -> transfer/select 2 = **700** |
| CMD24 | main -> command -> SPI, or main -> writeChunk -> waitReady -> SPI: **652** |
| SD streaming / abort during streaming | main -> Link::service -> queueIdle -> queue -> flash length: **688** |
| LCD | main contains WorkflowScreen and screenLine; decimal/division **642**, submit/TWI begin/copy stays below the 700-byte overall peak |
| RTC read | main -> readTime -> calendar validation/division: **659** |
| RTC reply | main -> RtcLink::service -> queueState -> flash length: **671** |
| Scanner | capture is inlined in main; sending uses PhysicalWorkflow -> PingClient -> tryWrite -> timer scheduling: **665** |
| WAIT / buttons | state changes are inlined in main; bounded retry/transmission path is the same **665**-byte workflow path |
| Abort/fence handler | main -> resetTransfer/RawCard deselect or queueIdle; **648** or less unless entered through the streaming service path |
| Raw/stream diagnostics | main -> queueReadTrace -> hex encoder: **677**; stream diagnostic **669** |

## Interrupt contribution and reserve

USART RX: 11 bytes; USART UDRE: 9; Timer0 clock: 9. PCINT2 and Timer1 TX/RX
each have a 17-byte frame; their timer-scheduling helper adds 2, making the
largest complete ISR path **19 bytes**, including the hardware return PC.
There are no ISR arrays, formatting, dynamic allocations, or peripheral calls.
ISRs do not enable interrupts; only main enables them after initialization.
Thus ISRs do not nest with one another. They can interrupt the deepest
foreground SPI/formatting path, which is why one ISR is added to the peak.
The Timer1 TX scheduling implementation was not edited.

Estimated production peak: `700 + 19 = 719` bytes stack.
Estimated remaining SRAM: `2048 - 517 - 719 = 812` bytes.
This is a binary/source call-graph estimate, **not** a measured physical stack
high-water or a formal exhaustive control-flow proof. The previous main-only
164-byte estimate omitted both the larger LTO layout and nested calls.
The old printf library uses shared prologue helpers, so its peak cannot be
computed by naïvely counting only its entry pushes; no precise old full-stack
claim is made here.

Approximately 800 bytes of estimated reserve is reasonably suitable for the
next controlled physical tests, compared with the previous critically tight
layout. Future changes must repeat the audit. Physical combined-load testing
and, if available, a SRAM stack-watermark measurement are still required.

## Automatic storage audit (objects >=16 bytes)

Sizes below were obtained with the AVR compiler, not host `sizeof`. Member
buffers are included in their containing object and must not be double-counted.

| Function / object | Bytes | Lifetime, nesting and decision |
| --- | ---: | --- |
| main: PingClient | 37 | Whole main loop; parser survives partial lines; retain |
| main: PhysicalWorkflow | 183 | Whole loop; includes ScannerTransport 149; retain |
| ScannerCapture member barcode buffer | 65 | Inside 71-byte capture; live during pending transmit too; cannot share with outgoing barcode |
| ScannerTransport member outgoing barcode | 65 | Copied completed scan survives later scanner input; retain exact preservation/isolation |
| main: TWI Master | 31 | Includes 8-byte write + 8-byte read; shared cooperative ownership; retain |
| main: LCD Display | 35 | Includes 20-byte text used across later service calls; cannot reuse caller's row |
| main: WorkflowScreen | 28 | Persistent display timing/date/feedback state; retain |
| main: DS3231 Driver | 35 | Persistent time/target and bounded bus state; retain |
| main: RtcLink | 89 | Parser 36 + reply 48 plus state; pending frame can coexist with new RX; do not overlay |
| BasicParser receive/parseLine and Link::receive: Frame | 41 | Returned by value, immediate dispatch; compiler return/spill slots included in main; preserve parser contract |
| Link::service: data | 24 | One synchronous read/hex-encode call; may nest raw SPI/encoder; retain |
| Link::queueReadTrace: bytes | 25 | One synchronous encode; no ISR use or escaping pointer; retain small independent local |
| Link::queueStreamDiagnostic: bytes | 20 | One synchronous encode; no escaping pointer; retain |
| WorkflowScreen::service: row | 20 | One screenLine/write call; Display copies it before return; retain |
| RtcLink::service: timestamp (removed) | 20 | Replaced by direct format in idle reply slot; same owner, no ISR access or reentrancy |
| screenLine: formatted (removed) | 21 | Replaced by direct row writes; no temporary needed |

Global mutable storage retained: RawCard 65 (Diagnostic bytes 33 and ReadTrace
24), storage Link 180 (incoming line buffer 61, outgoing line buffer 76), scanner
RX ring 130, controller RX ring 34, and the two 18-byte TX rings. They do not
contribute additional stack frames. Diagnostics still preserve all raw failure
evidence. Sector/timestamp/sequence/timeout widths were not reduced; uint16
offsets remain necessary for 512, and deferred/error counters retain saturation.

## Regression and build results

- All 21 ATmega native test sources passed, including the actual RawCard SPI
  driver (five fault/register scenarios + 100 read/write/idle/read cycles).
- Full firmware harness: 31 executables passed; plus RawCard, button admission,
  inventory/journal, production FatFs and AP/STA fixtures = **36 distinct native
  test sources**. RTC, scanner, WAIT, scheduler, abort/fence, diagnostics, durable
  append/reload and cache interleavings passed.
- AVR flash-access shim variants passed for memory text, PingClient, scanner,
  physical workflow, RTC link, LCD and storage link. The shim checks code paths;
  real flash placement/LPM operations were checked in the AVR ELF separately.
- Formatting equivalence/bounds: all 36,525 valid dates, 86,400 times of day,
  65,536 LCD year values, maximum unsigned field widths, invalid dates and short
  output buffers. Undefined-behavior sanitizer passed.
- Shared TypeScript protocol: 13 tests passed. No desktop behavior/source changes.
- Uno production build PASS: flash **26,086 / 32,256**, SRAM **517 / 2,048**.
- ESP32 compatibility build PASS after shared-header changes: flash
  **1,131,705 / 1,310,720**, RAM **82,468 / 327,680**.

Run `firmware-atmega/tests/memory_text_test.ps1` for the focused formatter/access
regression using the existing ignored Zig toolchain. Temporary audit/test
artifacts remain ignored under `.runtime`.

## Files changed in this pass

- `firmware-common/include/immutable_text.h` (new)
- `firmware-common/include/controller_link_protocol.h`
- `firmware-common/include/storage_link_protocol.h`
- `firmware-common/include/rtc_link_protocol.h`
- `firmware-atmega/include/ping_client.h`
- `firmware-atmega/include/physical_workflow.h`
- `firmware-atmega/include/scanner_capture.h`
- `firmware-atmega/include/rtc_link.h`
- `firmware-atmega/include/lcd_display.h`
- `firmware-atmega/include/sd_card.h`
- `firmware-atmega/tests/memory_text_test.cpp` (new)
- `firmware-atmega/tests/memory_text_test.ps1` (new)
- `firmware-atmega/tests/flash_text_fakes/avr/pgmspace.h` (new)
- This report (new)

No production `.cpp`, UART/Timer1 timing, pin configuration, SD SPI routine,
timeout, chunk size, fence, WAIT, filesystem/journal/cache, or transaction state
machine was changed. Earlier worktree modifications remain intact.
