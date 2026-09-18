# ATmega migration: Uno main-controller foundation and UART link

Separate primary-controller foundation. The working ESP32 project remains in
`../firmware/` and retains existing functionality except the disabled legacy
scanner during migration. Step 2 adds a UART responder; Step 3A adds bounded
GM65 capture/forwarding. Step 3B adds ATmega-owned physical buttons and operation
selection. No desktop changes are required.

## Build and startup

PlatformIO Atmel AVR 5.1.0, AVR-GCC/avr-libc, bare-metal C++11 (no Arduino runtime
or third-party libraries). Target Arduino Uno R3's **onboard ATmega328P**,
explicitly `F_CPU = 16000000UL`.
The AVR runtime supplies reset/startup and calls `main()`. Startup drives only
the four status pins OFF. Step 2 initializes the D6/D7 software UART, Timer1
and Timer0. Step 3A additionally initializes hardware USART0 for GM65 receive
on D0; transmit capability on D1 is retained but physically disconnected.
Step 3B configures D2/D3 as active-LOW button inputs with internal pull-ups.
The status APIs write both bits of each group together, preserving other bits.
No dynamic allocation, periodic LED cycling or inventory functionality is added.

```powershell
pio run --project-dir firmware-atmega --environment uno
# Only when a physical upload is explicitly requested:
pio run --project-dir firmware-atmega --environment uno --target upload
```

Setting `F_CPU` describes the expected clock to the compiler; it does **not**
select the oscillator or program fuses. The Uno already runs at 16 MHz.
The normal Uno USB/bootloader upload protocol is `arduino`, on COM10. No Arduino
framework is linked, and no fuse/bootloader programming is required.

## Status pins and authoritative encoding

| Group | Input A | Input B | OFF | YELLOW | RED | GREEN |
| --- | --- | --- | --- | --- | --- | --- |
| Small | PD5 / D5 | PD4 / D4 | 00 | 01 | 10 | 11 |
| Big | PB0 / D8 | PB1 / D9 | 00 | 10 | not defined | 11 |

These are inputs to the existing external 7400-series logic, not independent LED
drivers. The supplied truth-table **rows** are authoritative, not older schematic
labels. Big 01 is reserved/unused and never emitted by the normal API. Invalid
enum values fail to OFF. No HIGH/LOW/EMPTY or SUCCESS/error semantic assignments
are introduced in this foundation step.

## Step 2: controller UART

ATmega software UART: **D6/PD6 RX, D7/PD7 TX, 9600 baud, 8N1**.
Hardware USART0 D0/PD0 RX belongs to GM65 receive; D1/PD1 TX is reserved for
future scanner commands, not connected to GM65 RX in this stage. Its driver
is initialized by Step 3A for scan capture only. The controller link never
accesses USART0.
Timer1 runs freely at 2 MHz (prescaler 8). Compare A advances TX one bit at a
time; PD6 pin-change interrupt PCINT22 detects the falling start edge and
compare B validates it at half a bit, samples eight LSB-first bits, and validates
the stop bit. Fixed 208-tick/104-us bits yield approximately 9615 baud (+0.16%).
RX and TX can operate concurrently without busy delays. Each queue has 16 fixed
slots (15 usable); full TX immediately returns false, RX overrun/framing errors
quarantine parser input, and false starts are discarded. ISR work is bounded.
Timer0 CTC supplies the 1 kHz timeout clock. Timer1/PCINT22 are reserved for this
link; no timer compare output pins/PWM are enabled. Future drivers must preserve
these resources and keep interrupt latency comfortably below a half bit (52 us).
Main polls at most eight received bytes and attempts one nonblocking TX enqueue
per iteration. Bidirectional communication has been physically verified;
future interrupt-heavy drivers still require timing/latency verification.

Normal mode initiates `PING\n` after two seconds and verifies only `PONG\n`
while awaiting a response, retrying two seconds after completion/failure. Sending
and response waiting each have a one-second timeout; neither can block forever.
Internal outcome and counters record verification/timeout; the link does not
depend on USB Serial Monitor or change either status LED group.

Case-sensitive lines contain at most 73 printable ASCII characters excluding
terminators (nine-byte CHECKOUT prefix plus 64 barcode bytes). Optional CRLF is
accepted; empty lines are ignored. Binary, malformed or oversized frames are
discarded through LF, with fixed 74-byte storage.
Software-UART stop-bit/framing and queue-overrun errors quarantine the current frame. Partial frames
expire with their attempt; responses outside a waiting state are ignored. This
is a bring-up protocol, not authenticated or transaction-grade transport.

### Confirmed ESP32 mapping

Final ownership is **UART1 RX GPIO16 / TX GPIO17** for ATmega communication.
This supersedes the earlier GPIO34/25 link and legacy GM65 UART2 mapping.
Debug UART0 remains unchanged. GM65 UART initialization is disabled with no
replacement pins assigned. Its implementation is preserved, but scanner
migration of scanner-trigger/transaction behavior to ATmega is a later TODO.
Step 3B reconnects ESP32 workflows through typed RESTOCK/CHECKOUT frames;
SCAN remains registration-only. No direct scanner UART is restored. A disabled controller link returns
scanner-unavailable feedback/HTTP 503 `scanner_unavailable`.
`DENTAL_ATMEGA_LINK_RX_GPIO` and `DENTAL_ATMEGA_LINK_TX_GPIO` can be overridden
with PlatformIO build flags; setting BOTH to `-1` disables the link.
Compile-time checks reject incomplete, identical,
invalid or existing peripheral/flash pin assignments. GPIO16/17 are permanently
reserved for the ATmega link, not GM65 or any other peripheral.

Required direction through the confirmed voltage/interface path:

- ESP32 GPIO17 TX → LV2 → level shifter HV2 → ATmega D6/PD6 RX.
- ATmega D7/PD7 TX → level shifter HV1 → LV1 → ESP32 GPIO16 RX.
- Common GND. Never connect ATmega's 5V TX directly to ESP32 RX.

Uno D0/D1 are shared with the USB interface, not the controller link. Runtime
GM65 TX connects to D0 only; D1 -> GM65 RX stays disconnected. D1 must remain
free of external connections during normal Uno USB/bootloader uploads, and
GM65 TX must be isolated from D0 to avoid competing USB/GM65 transmitters.
The ESP32 link on D6/D7 does not share USB UART pins.
The level shifter must preserve valid logic levels and edges at 9600 baud.

### Completed physical round-trip verification

Real hardware successfully produced:

```text
ATmega link RAW RX: 50 49 4E 47 0A
ATmega link RX: PING
ATmega link TX: PONG
ATmega link RX: ACK
```

The temporary PING/PONG/ACK test proved both D7 to GPIO16 and GPIO17 to D6
through the level shifter. Final Step 2 firmware removes the one-second
diagnostic schedule, ACK frame, raw hex logs and diagnostic support.
Only the normal bounded PING/PONG requester/responder remains enabled.
No inventory/peripheral functionality was migrated by this test.

ESP32 processes at most 16 RX bytes per loop and checks TX capacity before
writing. Only PING produces PONG; barcode frames also produce temporary USB debug lines.
At most one five-byte reply is buffered; extra
PINGs arriving while TX is busy are ignored rather than queued without bound.
The responder has no inventory, FIFO, offline journal, RTC, MicroSD, HTTP or
Electron callback. ESP32 routes typed operations outside the transport parser
into the corresponding existing workflow (Step 3B).

## Step 3A: GM65 capture only

Current verified runtime wiring is **receive-only**:

- GM65 TX -> **Uno D0/PD0 RX**, through the appropriate electrical interface.
- **Uno D1/PD1 TX -> GM65 RX is disconnected / not required** in this stage.
- Common GND is required.

USART0 transmit capability remains enabled for later command/trigger support.
Connect scanner RX only when that support is intentionally implemented and its
electrical interface is verified. No scanner commands are sent now. Hardware
USART0 uses 9600 baud, 8N1 (normal-speed divider 103). Its bounded RX ISR reads
status before UDR0 and records framing/parity/overrun errors. The 64-slot RX
ring has 63 usable entries; overflow drops uncertain queued input and rejects
the affected scan through a delimiter. No trigger/configuration bytes are sent.

Barcode capacity is **64 printable ASCII bytes** plus NUL. Numeric values are
never converted; leading zeroes and spaces are preserved exactly. Empty and
all-space scans, binary/control bytes, malformed and oversized input are
rejected, never truncated. CR or LF completes a scan; CRLF completes it once.
A one-second inter-byte timeout rejects a partial scan until its next delimiter.

Completed scans use **`SCAN:<barcode>\n`** over D7/D6 at 9600 8N1. An empty LF
precedes each frame to resynchronize any earlier partial controller-link input.
One scan is buffered for forwarding; additional scans while busy are dropped,
not combined. PING and SCAN bytes never interleave. TX attempts one byte per
loop, with a one-second timeout. On timeout a binary rejection marker and LF
invalidate any partial scan, preventing silent truncation. If TX remains full,
only this nonblocking resynchronization is retried; other main-loop work continues.
Normal bounded PING/PONG remains active between scan frames.

ESP32 validates SCAN separately and retains a temporary USB verification line.
Step 3A physical verification passed using a real GM65 barcode scan, observed as:

```text
ATmega scanner RX: 4806016001569
```

This confirms GM65 TX -> ATmega USART0 D0 RX -> bounded capture -> D7/D6
controller link -> ESP32 GPIO16/GPIO17 -> exact barcode reception.
Physical leading-zero verification was not performed; leading-zero preservation
is covered by automated tests only. No new diagnostic behavior was added.

Step 3A added no transaction routing into online FIFO, offline pending journal,
CSV, inventory, SQLite or Electron. ESP32 direct GM65 UART remains disabled.
Step 3B below moves physical buttons, mode selection and scan pairing to ATmega.
RTC, LCD, MicroSD and the existing business-processing paths remain on ESP32
until their later migration steps.

## Step 3B: ATmega-owned physical operations

Physical testing individually completed ONLINE RESTOCK/D2 and CHECKOUT/D3
transactions and verified barcode reception and the controller link. Button
behavior became unreliable with both GM65 UART directions connected. This
observation establishes the current receive-only wiring above; it does not
establish the electrical root cause. The scanner RX connection is deferred,
not reassigned, and no transaction logic is changed by this wiring revision.

**D2/PD2 RESTOCK and D3/PD3 CHECKOUT** connect through pushbuttons to GND.
Both inputs use internal pull-ups (released HIGH, pressed LOW), with no external
pull-down or VCC connection required. They use 50-ms stable
edge debounce and a release-before-rearm interlock. Holding a button creates
only one logical press. Simultaneous presses cancel an outstanding scan wait;
busy presses are ignored, not deferred or converted into another mode.

The bounded states are idle, waiting for RESTOCK scan, waiting for CHECKOUT
scan, dispatching and a two-second cooldown. Scan waits expire after ten
seconds using wrap-safe timing. Partial input already underway when a button
is accepted is quarantined through its delimiter. Malformed/oversized scans do
not dispatch operations. Main-loop work and fixed-buffer UART queues remain
nonblocking; Step 1 status outputs are unchanged.

A valid scan during the selected wait sends exactly one typed frame:
`RESTOCK:<barcode>\n` or `CHECKOUT:<barcode>\n`. The maximum barcode is 64
printable ASCII characters, preserved exactly including leading zeroes.
PING/PONG and operation bytes do not interleave. Scans during dispatch/cooldown
are consumed without forwarding. Idle scans may send `SCAN:<barcode>\n` solely
for registration; they never create a stock transaction.

ESP32 no longer initializes or polls legacy GPIO13/GPIO14 transaction buttons.
It accepts complete typed operations only when its existing workflow is idle
and registration capture is inactive. The ATmega-selected profile feeds the
exact barcode plus LF through the original `processBarcodeByte()` ->
`completeBarcode()` path. RTC timestamps, exact lookup, CSV, FIFO/journal,
result/ACK and desktop exactly-once protections are reused, not duplicated.
The online/offline route is frozen when ESP32 accepts the completed operation;
there is no earlier button-arm notification over the link in this step.
Additional frames during ESP32 feedback are ignored. Separate later physical
presses may legitimately use the same barcode; there is no global barcode dedup.

Registration retains its authenticated HTTP APIs and existing isolated capture
parser, started directly in barcode-wait state. Only SCAN frames can populate
registration. RESTOCK/CHECKOUT frames cannot become registration scans, and
SCAN frames cannot become stock operations. The bounded controller drain and
partial-frame quarantine at registration start prevent stale input reuse.

Use the GM65's existing manual/autonomous scan-output mode. No scanner trigger
or GM65 acknowledgement is fabricated, and ESP32 direct scanner USART remains
disabled. Controller-trigger migration and full controller lifecycle/result
ownership are pending. Dispatch/cooldown is a local sending guard, not an
application-level operation acknowledgement or reliable retransmission scheme.
No Electron/API/schema/synchronization changes are part of Step 3B.

### Completed Step 3B physical verification

Real hardware individually completed ONLINE transactions using barcode
`4806016001569`:

- D2 RESTOCK -> `RESTOCK:4806016001569` -> existing ESP32 workflow -> ONLINE PASS.
- D3 CHECKOUT -> `CHECKOUT:4806016001569` -> existing ESP32 workflow -> ONLINE PASS.

ESP32 reported the corresponding `ATmega RESTOCK RX` / `ATmega CHECKOUT RX`
line, operation receipt, and `Transaction route captured: ONLINE`.
Runtime scanner wiring was receive-only: GM65 TX -> D0; D1 -> GM65 RX
remains disconnected. D1 may be reconsidered only during a dedicated future
scanner command/trigger implementation with electrical verification.
Temporary DBG frames, queues, handlers and diagnostic-only tests are removed;
concise operation logs remain. The existing "LCD unavailable" message is outside
Step 3B and is not treated as a Step 3B failure. This checkpoint records the
reported physical ONLINE verification, not new offline or leading-zero physical
verification.

### Step 3B physical procedure (future repeat testing only)

1. With power off, connect ATmega D2 RESTOCK and D3 CHECKOUT buttons to GND;
   connect GM65 TX to D0 only; leave D1 -> GM65 RX disconnected. Preserve
   controller D7/D6 -> GPIO16/17 level-shifter wiring.
   Only after uploads are explicitly authorized, build/upload both Uno and
   ESP32 firmware. Keep D1 free and isolate GM65 TX from Uno D0 during USB upload, then
   restore runtime wiring with power off. Open ESP32 USB Serial at 115200;
   do not inject Uno USB serial bytes into the GM65 hardware UART.
2. With Electron authenticated and hardware healthy, briefly press/release
   ATmega D2 RESTOCK, then scan a known barcode within ten seconds. Expect one
   `ATmega RESTOCK RX: <barcode>` line, existing saved-event LCD/LED feedback,
   and one desktop event/dialog. The LCD cannot show the ATmega scan-wait state
   before forwarding because no arm notification is implemented.
   Complete through the existing desktop confirmation/result/ACK flow if a real
   stock change is intended. Repeat separately with ATmega D3 CHECKOUT and
   expect `ATmega CHECKOUT RX: <barcode>`.
3. Hold a button, press both together, and scan without first selecting a mode:
   no repeated/ambiguous/idle stock transaction may appear. Wait over ten
   seconds after a press without scanning; a later idle scan must not create a
   stock operation. The ATmega timeout is local and does not fabricate an ESP32
   LCD error. Release both buttons and wait for feedback/cooldown before retrying.
4. In Add/Edit Product use the existing registration-capture action, then scan:
   leave ATmega idle and only the barcode field should populate, with no
   stock/history/event change. Physical operation frames during registration
   must not populate the field or create a transaction.
   Leading-zero physical verification requires an actual leading-zero barcode;
   automated coverage alone does not count as that physical verification.
5. Offline testing is stock-changing on the device: only when explicitly
   authorized, close Electron, wait for lease expiry, then press an ATmega button
   and scan one cached
   item and verify the existing +1/-1 journal behavior without an online event.
   Do not invoke synchronization as part of this input-source test.

### Step 3A historical physical test procedure

The idle forwarding/no-stock check below remains valid for registration-only
SCAN frames; use the Step 3B procedure above for typed stock operations.

1. With power off, check the existing common GND, scanner supply/interface,
   receive-only GM65 TX -> D0 wiring (D1 -> scanner RX disconnected) and
   D7/D6 controller-link level-shifter wiring.
2. Before Uno USB upload, isolate GM65 TX from D0 so the scanner cannot compete
   with the Uno USB-to-serial transmitter/bootloader, and keep D1 free of
   external connections. Use the existing normal
   `uno` environment on COM10; no ISP/fuse changes. Upload ESP32 only when
   explicitly authorized. After uploads, power off and restore runtime wiring.
3. Power both controllers/scanner; open **ESP32** USB Serial at 115200. Do not
   open Uno USB Serial or inject USB bytes on D0/D1 during scanner operation.
4. Use a real GM65 scan, in its existing autonomous/manual scan-output mode
   with CR/LF termination. Step 3A does not send command-mode triggers; if it
   remains command-triggered, no scan output is expected until it is configured
   appropriately using the scanner's supported setup procedure.
5. Scan `0012345678905` and another known barcode; check one exact ESP32 line
   per scan. Repeat after idle periods. Do not press RESTOCK/CHECKOUT for this test.
6. Verify inventory/history/pending-event counts do not change. This is receive/
   forward bring-up only, not a stock transaction or desktop registration flow.

## Focused host tests

`tests/status_encoding_test.cpp` tests all seven states, the reserved Big 01
exclusion, startup OFF defaults, determinism, invalid-value fail-OFF, and masked
port updates. It tests pure mapping, not physical LEDs or reset-time behavior.
Use an existing host C++ compiler, for example the workspace's ignored Zig setup:

```powershell
& .\.runtime\ziglang\ziglang\zig.exe c++ -std=c++11 -Ifirmware-atmega/include firmware-atmega/tests/status_encoding_test.cpp -o .runtime/firmware-tests/atmega_status_encoding_test.exe
& .\.runtime\firmware-tests\atmega_status_encoding_test.exe
& .\.runtime\ziglang\ziglang\zig.exe c++ -std=c++11 -Wall -Wextra -Werror -Ifirmware-atmega/include firmware-atmega/tests/ping_client_test.cpp -o .runtime/firmware-tests/atmega_ping_client_test.exe
& .\.runtime\firmware-tests\atmega_ping_client_test.exe
& .\.runtime\ziglang\ziglang\zig.exe c++ -std=c++11 -Wall -Wextra -Werror -Ifirmware-atmega/include firmware-atmega/tests/software_uart_test.cpp -o .runtime/firmware-tests/atmega_software_uart_test.exe
& .\.runtime\firmware-tests\atmega_software_uart_test.exe
& .\.runtime\ziglang\ziglang\zig.exe c++ -std=c++11 -Wall -Wextra -Werror -Ifirmware-atmega/include firmware-atmega/tests/scanner_capture_test.cpp -o .runtime/firmware-tests/atmega_scanner_capture_test.exe
& .\.runtime\firmware-tests\atmega_scanner_capture_test.exe
& .\.runtime\ziglang\ziglang\zig.exe c++ -std=c++11 -Wall -Wextra -Werror -Ifirmware-atmega/include firmware-atmega/tests/physical_workflow_test.cpp -o .runtime/firmware-tests/atmega_physical_workflow_test.exe
& .\.runtime\firmware-tests\atmega_physical_workflow_test.exe
& .\.runtime\ziglang\ziglang\zig.exe c++ -std=c++17 -Wall -Wextra -Werror -Ifirmware/include firmware/tests/atmega_link_test.cpp -o .runtime/firmware-tests/esp32_atmega_link_test.exe
& .\.runtime\firmware-tests\esp32_atmega_link_test.exe
& .\.runtime\ziglang\ziglang\zig.exe c++ -std=c++17 -Wall -Wextra -Werror -Ifirmware/include firmware/tests/forwarded_scan_routing_test.cpp -o .runtime/firmware-tests/forwarded_scan_routing_test.exe
& .\.runtime\firmware-tests\forwarded_scan_routing_test.exe
```

Current focused coverage: eight requester, eight software-UART and eight ESP32
baseline responder scenarios plus five scanner integration scenarios and thirteen
ATmega scanner capture/forwarding scenarios.
Step 3B adds eighteen button/state scenarios and fourteen operation-routing/
registration scenarios, and preserves the
existing firmware event/cache/journal/RTC/registration regression coverage.
Software-UART coverage includes D6/D7 ownership,
all 256 byte encodings, start/stop bits, false starts, framing errors, queue
bounds, timer wrap and a software PING/PONG path. Host tests do not prove actual
ISR latency margins or electrical timing; the physical round-trip passed, but
future peripheral integration requires timing verification. Generated `.pio/`, `.vscode/` and `.runtime/`
files remain ignored.
