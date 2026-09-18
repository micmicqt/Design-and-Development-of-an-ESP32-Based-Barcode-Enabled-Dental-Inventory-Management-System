# ATmega migration: Uno main-controller foundation and UART link

Separate primary-controller foundation. The working ESP32 project remains in
`../firmware/` and retains existing functionality except the disabled legacy
scanner during migration. Step 2 adds a UART responder; Step 3A adds bounded
GM65 capture/forwarding only. No desktop changes are required.

## Build and startup

PlatformIO Atmel AVR 5.1.0, AVR-GCC/avr-libc, bare-metal C++11 (no Arduino runtime
or third-party libraries). Target Arduino Uno R3's **onboard ATmega328P**,
explicitly `F_CPU = 16000000UL`.
The AVR runtime supplies reset/startup and calls `main()`. Startup drives only
the four status pins OFF. Step 2 initializes the D6/D7 software UART, Timer1
and Timer0. Step 3A additionally initializes hardware USART0 for GM65 on D0/D1.
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
Hardware USART0 D0/PD0 RX and D1/PD1 TX belong permanently to GM65; its driver
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

Case-sensitive lines contain at most 69 printable ASCII characters excluding
terminators (five-byte SCAN prefix plus 64 barcode bytes). Optional CRLF is
accepted; empty lines are ignored. Binary, malformed or oversized frames are
discarded through LF, with fixed 70-byte storage.
Software-UART stop-bit/framing and queue-overrun errors quarantine the current frame. Partial frames
expire with their attempt; responses outside a waiting state are ignored. This
is a bring-up protocol, not authenticated or transaction-grade transport.

### Confirmed ESP32 mapping

Final ownership is **UART1 RX GPIO16 / TX GPIO17** for ATmega communication.
This supersedes the earlier GPIO34/25 link and legacy GM65 UART2 mapping.
Debug UART0 remains unchanged. GM65 UART initialization is disabled with no
replacement pins assigned. Its implementation is preserved, but scanner
migration of scanner-trigger/transaction behavior to ATmega is a later TODO.
RESTOCK/CHECKOUT report scanner-unavailable
feedback; registration capture returns HTTP 503 `scanner_unavailable`.
`DENTAL_ATMEGA_LINK_RX_GPIO` and `DENTAL_ATMEGA_LINK_TX_GPIO` can be overridden
with PlatformIO build flags; setting BOTH to `-1` disables the link.
Compile-time checks reject incomplete, identical,
invalid or existing peripheral/flash pin assignments. GPIO16/17 are permanently
reserved for the ATmega link, not GM65 or any other peripheral.

Required direction through the confirmed voltage/interface path:

- ESP32 GPIO17 TX → LV2 → level shifter HV2 → ATmega D6/PD6 RX.
- ATmega D7/PD7 TX → level shifter HV1 → LV1 → ESP32 GPIO16 RX.
- Common GND. Never connect ATmega's 5V TX directly to ESP32 RX.

Uno D0/D1 are reserved for GM65 and shared with the USB interface, not this link.
Before future scanner activation/uploads, its interface must prevent competing
USB/GM65 transmitters on D0. The ESP32 link on D6/D7 does not share USB UART pins.
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
writing. Only PING produces PONG; SCAN only produces a temporary USB debug line.
At most one five-byte reply is buffered; extra
PINGs arriving while TX is busy are ignored rather than queued without bound.
The responder has no inventory, FIFO, offline journal, RTC, MicroSD, HTTP or
Electron callback. Existing ESP32 workflows coexist; scanner-dependent operations
fail safely until the GM65 transaction migration is completed.

## Step 3A: GM65 capture only

GM65 TX connects to **Uno D0/PD0 RX**, and GM65 RX to **D1/PD1 TX**,
with the confirmed appropriate electrical interface and common GND. Hardware
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

This confirms GM65 -> ATmega USART0 D0/D1 -> bounded capture -> D7/D6
controller link -> ESP32 GPIO16/GPIO17 -> exact barcode reception.
Physical leading-zero verification was not performed; leading-zero preservation
is covered by automated tests only. No new diagnostic behavior was added.

No SCAN callback enters online event FIFO, offline pending journal, CSV logging,
inventory, SQLite or Electron. ESP32 direct GM65 UART remains disabled; its
scanner-dependent production workflows remain unavailable. Buttons, RTC, LCD,
MicroSD and inventory transaction migration are not part of Step 3A.

### Physical test procedure (not performed automatically)

1. With power off, check the existing common GND, scanner supply/interface,
   D0/D1 scanner wiring and D7/D6 controller-link level-shifter wiring.
2. Before Uno USB upload, isolate GM65 TX from D0 so the scanner cannot compete
   with the Uno USB-to-serial transmitter/bootloader. Use the existing normal
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
& .\.runtime\ziglang\ziglang\zig.exe c++ -std=c++11 -Wall -Wextra -Werror -Ifirmware/include firmware/tests/atmega_link_test.cpp -o .runtime/firmware-tests/esp32_atmega_link_test.exe
& .\.runtime\firmware-tests\esp32_atmega_link_test.exe
```

Current focused coverage: eight requester, eight software-UART and eight ESP32
baseline responder scenarios plus five scanner integration scenarios and thirteen
ATmega scanner capture/forwarding scenarios. Software-UART coverage includes D6/D7 ownership,
all 256 byte encodings, start/stop bits, false starts, framing errors, queue
bounds, timer wrap and a software PING/PONG path. Host tests do not prove actual
ISR latency margins or electrical timing; the physical round-trip passed, but
future peripheral integration requires timing verification. Generated `.pio/`, `.vscode/` and `.runtime/`
files remain ignored.
