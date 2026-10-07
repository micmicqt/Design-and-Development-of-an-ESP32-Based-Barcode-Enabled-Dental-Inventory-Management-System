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
the four status pins OFF. Final deployment assigns USART0 D0/D1 to GM65 and
the Timer1/PCINT2 software UART D6/D7 to the ESP32 controller link. Timer0
supplies the millisecond clock. The previous A0/A1 scanner and D0/D1 controller
routing was a physically tested prototype, not the final PCB assignment.
The final schematic configures D2/D3 as active-HIGH button inputs with external
10 kOhm pull-down resistors; AVR internal pull-ups remain disabled.
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
| Big | PB0 / D8 | PB1 / D9 | 00 | not defined | 10 | 11 |

These are inputs to the existing external 7400-series logic, not independent LED
drivers. The supplied truth-table **rows** are authoritative, not older schematic
labels. Big 01 is reserved/unused and never emitted by the normal API. Invalid
enum values fail to OFF. The Step 1 foundation initially left runtime meaning
unassigned. The current feedback path uses the small group for persistent
database-derived HIGH=GREEN, LOW=YELLOW, and EMPTY=RED; the big group gives a
brief GREEN transaction-success or RED error indication. Both start OFF.
The older graphic's big "Yellow" label is superseded by the physically
confirmed red LED; its 10 input row is unchanged.
Stock status is transported only after an online committed result or a durable
offline journal append, not inferred from a barcode by the ATmega. This runtime
LED path still requires physical acceptance on the final D4/D5 and D8/D9 wiring.
The bounded advisory controller frames `STOCK:H`, `STOCK:L`, and `STOCK:E`
carry the already-authoritative HIGH/LOW/EMPTY status. They do not arm a scan,
change stock, or acknowledge an event.

## Step 2: controller UART

ATmega controller software UART: **D6/PD6 RX, D7/PD7 TX, 9600 baud, 8N1**.
This reuses the physically verified Step 2 Timer1/PCINT2 design with the later
bounded timed sender/receiver and fixed 16-slot RX/TX queues (15 usable).
Timer1 runs freely at 2 MHz (prescaler 8): Compare A advances controller TX,
Compare B samples controller RX, and PCINT2/PCINT22 detects the D6 start edge.
A full TX ring returns false so the existing producer retries the same byte.
Framing and queue-overflow errors quarantine input through the next newline.
Timer0 CTC supplies the 1 kHz timeout clock.

GM65 uses **hardware USART0 D0/PD0 RX, D1/PD1 TX, 9600 baud, 8N1**.
Normal-speed `UBRR0=103` produces approximately 9615 baud (+0.16%). Its
RX interrupt preserves FE/DOR/UPE error status in the existing fixed scanner
queue; the TX interrupt drains a bounded queue without blocking. Production
currently sends no GM65 command.
Main polls at most eight received bytes and attempts one nonblocking TX enqueue
per iteration. Bidirectional communication has been physically verified;
the final routing has not yet been physically exercised with the Step 5 remote
sector workload. The software UART depends on Timer1 compare interrupts
arriving within each 104 us bit cell. SPI and TWI polling leave interrupts
enabled; masked D4/D5 PORTD updates are atomic so they cannot erase a D7 TX
edge. Simultaneous scanner USART RX, SD traffic, and controller RX/TX still
require stress testing on the soldered PCB before deployment acceptance.

Normal mode initiates `PING\n` after two seconds and verifies only `PONG\n`
while awaiting a response, retrying two seconds after completion/failure. Sending
and response waiting each have a one-second timeout; neither can block forever.
Internal outcome and counters record verification/timeout; the link does not
depend on USB Serial Monitor or change either status LED group.

Case-sensitive lines contain at most 73 printable ASCII characters excluding
terminators (nine-byte CHECKOUT prefix plus 64 barcode bytes). Optional CRLF is
accepted; empty lines are ignored. Binary, malformed or oversized frames are
discarded through LF, with fixed 74-byte storage.
Software-UART framing and queue-overflow errors quarantine the current frame. Partial frames
expire with their attempt; responses outside a waiting state are ignored. This
is a bring-up protocol, not authenticated or transaction-grade transport.

### Confirmed ESP32 mapping

Final ownership is **UART1 RX GPIO16 / TX GPIO17** for ATmega communication.
This supersedes the earlier GPIO34/25 link and legacy GM65 UART2 mapping.
ESP32 debug UART0 remains unchanged and its direct GM65 UART stays disabled.
GM65 ownership is now implemented on ATmega D0/D1; no scanner pins are assigned
back to ESP32.
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

Uno D0/D1 are shared with the Uno USB interface and bootloader and now belong
to GM65 at runtime. For normal COM10 bootloader uploads, isolate the scanner
RX/TX wires if they interfere; do not move the ESP32 link back to D0/D1.
Do not change the normal `arduino` upload protocol.
The level shifter must preserve valid logic levels and edges at 9600 baud.

### Completed physical round-trip verification

Real hardware successfully produced:

```text
ATmega link RAW RX: 50 49 4E 47 0A
ATmega link RX: PING
ATmega link TX: PONG
ATmega link RX: ACK
```

The temporary PING/PONG/ACK test historically proved both level-shifter
directions on D7/D6. Final deployment restores that pin ownership; the
newer Step 5 workload on this routing still requires physical validation.
Final Step 2 firmware removes the one-second
diagnostic schedule, ACK frame, raw hex logs and diagnostic support.
Only the normal bounded PING/PONG requester/responder remains enabled.
No inventory/peripheral functionality was migrated by this test.

## Historical Step 3C: prototype scanner UART on A0/A1 (superseded)

The physically tested Step 3C prototype moved both GM65 directions off the Uno USB USART pins:

- GM65 TX -> Uno A0 / PC0 (scanner RX into ATmega).
- Uno A1 / PC1 -> GM65 RX (scanner TX from ATmega).
- D0/PD0 and D1/PD1 had no scanner dependency in that prototype.

At that prototype checkpoint A0 reception was physically verified. A1
transmission was implemented but not physically verified. The final deployment
instead uses USART0 D0/D1; its scanner RX/TX wiring still needs PCB verification.
Production firmware sends no GM65 command.

The historical A0/A1 link was bare-metal 9600 8N1 and owned the Timer1
compare scheduler. PCINT1 detected A0's start edge. No Arduino
SoftwareSerial, dynamic allocation, busy delay or long interrupt-disabled
section is used. The existing scanner parser still accepts printable ASCII,
preserves exact/leading-zero barcodes, supports CR/LF/CRLF, caps text at 64
characters, rejects malformed/oversized/framing/overflow input without silent
truncation and recovers after its bounded timeout. The final USART0 transport
retains the same scanner parser and fixed-queue transmit API; no new GM65
command or trigger is sent.

The repository contains no current schematic/netlist or exact GM65 adapter
part/revision documenting an RX protection divider, series resistor or level
shifter. Consequently it does not establish resistor values or prove that a
direct 5 V output is safe for this exact scanner RX. The generic GM65 manual
describes a 5 V-powered TTL interface, but does not specify UART VIH/VIL or
absolute-maximum pin voltage. Before physically connecting D1, identify the
exact module/adapter, inspect its input conditioning, and confirm whether its RX
is 5 V tolerant. Measure GM65 TX HIGH and confirm it meets the ATmega328P's
5 V digital-input threshold before connecting it directly to D0. Preserve any
conditioning shown on the actual final schematic; do not add/remove a resistor
from this repository's incomplete information.

ESP32 processes at most 16 RX bytes per loop and checks TX capacity before
writing. Only PING produces PONG; barcode frames also produce temporary USB debug lines.
At most one five-byte reply is buffered; extra
PINGs arriving while TX is busy are ignored rather than queued without bound.
The Step 3 transport responder itself has no inventory, FIFO, offline journal,
MicroSD, HTTP or Electron callback. Step 4B adds only bounded RTC bridge frames;
ESP32 still routes typed operations outside the transport parser into the
corresponding existing workflow (Step 3B).

### Completed Step 3C physical verification

Real hardware verified GM65 TX -> A0/PC0 reception using barcode
`4806016001569` for both operation paths:

- RESTOCK: `ATmega RESTOCK RX: 4806016001569`, followed by
  `RESTOCK operation received from ATmega`.
- CHECKOUT: `ATmega CHECKOUT RX: 4806016001569`, followed by
  `CHECKOUT operation received from ATmega`.

The same physical verification used the final schematic button circuits:

- RESTOCK: +5 V -> pushbutton -> D2/PD2; R7 10 kOhm from D2 to GND.
- CHECKOUT: +5 V -> pushbutton -> D3/PD3; R8 10 kOhm from D3 to GND.

Both buttons passed with released LOW, pressed HIGH, DDRD bits 2/3 clear and
PORTD bits 2/3 clear. D0/D1 were not used by the GM65. This verifies A0 receive
only; it does not claim physical verification of the A1 transmit path.

### Final deployment ATmega pin map (software complete; PCB physical test pending)

| Uno pin | AVR pin | Current ownership |
|---|---|---|
| D0 | PD0 | GM65 scanner RX / USART0 RXD |
| D1 | PD1 | GM65 scanner TX / USART0 TXD |
| D2 | PD2 | RESTOCK, active-HIGH external-pulldown input |
| D3 | PD3 | CHECKOUT, active-HIGH external-pulldown input |
| D4 | PD4 | Small-status logic B |
| D5 | PD5 | Small-status logic A |
| D6 | PD6 | ESP32 controller-link software RX from GPIO17 |
| D7 | PD7 | ESP32 controller-link software TX to GPIO16 |
| D8 | PB0 | Big-status logic A |
| D9 | PB1 | Big-status logic B |
| D10 | PB2 | MicroSD CS (ATmega-owned) |
| D11 | PB3 | MicroSD SPI MOSI (ATmega-owned) |
| D12 | PB4 | MicroSD SPI MISO (ATmega-owned) |
| D13 | PB5 | MicroSD SPI SCK (ATmega-owned) |
| A0 | PC0 | Released from scanner; no UART initialization |
| A1 | PC1 | Released from scanner; no UART initialization |
| A4 | PC4 | Shared LCD + DS3231 I2C SDA |
| A5 | PC5 | Shared LCD + DS3231 I2C SCL |

## Historical Step 3A: GM65 capture on USART0 (superseded)

Step 3A used the following temporary receive-only wiring before Step 3C moved
the scanner to A0/A1:

- GM65 TX -> **Uno D0/PD0 RX**, through the appropriate electrical interface.
- **Uno D1/PD1 TX -> GM65 RX is disconnected / not required** in this stage.
- Common GND is required.

At that historical checkpoint, USART0 transmit capability remained enabled.
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

Completed scans used **`SCAN:<barcode>\n`** over the historical D1/D0 controller link. An empty LF
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

This historical Step 3A arrangement was superseded by the Step 3C prototype,
which in turn is superseded by the final deployment pin map above.
Physical leading-zero verification was not performed; leading-zero preservation
is covered by automated tests only. No new diagnostic behavior was added.

Step 3A added no transaction routing into online FIFO, offline pending journal,
CSV, inventory, SQLite or Electron. ESP32 direct GM65 UART remains disabled.
Step 3B below moves physical buttons, mode selection and scan pairing to ATmega.
At the Step 3B checkpoint, RTC, LCD and MicroSD remained on ESP32. Step 4A below
moved LCD ownership first. Step 4B then moves RTC ownership to the same ATmega
bus; MicroSD and business processing remain on ESP32.

## Step 3B: ATmega-owned physical operations

Physical testing individually completed ONLINE RESTOCK/D2 and CHECKOUT/D3
transactions and verified barcode reception and the controller link. Button
behavior became unreliable with both GM65 UART directions connected. This
was a historical Step 3B observation under the superseded D0/D1 arrangement;
Step 3C temporarily replaced it with A0/A1 without changing transaction logic.

**D2/PD2 RESTOCK** uses +5 V -> pushbutton -> D2, with R7 10 kOhm from
D2 to GND. **D3/PD3 CHECKOUT** uses +5 V -> pushbutton -> D3, with R8
10 kOhm from D3 to GND. Both are active-HIGH inputs: released is LOW and
pressed is HIGH. Firmware leaves DDRD bits 2/3 and PORTD bits 2/3 clear, so
the AVR internal pull-ups are disabled. They use 50-ms stable edge debounce
and a release-before-rearm interlock. Holding a button creates only one logical
press. Simultaneous presses cancel an outstanding scan wait; busy presses are
ignored, not deferred or converted into another mode.

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
The Step 3B checkpoint used temporary receive-only USART0 wiring. That wiring
is superseded by Step 3C and is not the current hardware source of truth.
Temporary DBG frames, queues, handlers and diagnostic-only tests are removed;
concise operation logs remain. The historical "LCD unavailable" message was
outside Step 3B; Step 4A below removes that legacy ESP32 prerequisite. This
checkpoint records the reported physical ONLINE verification, not new offline
or leading-zero physical verification.

### Step 3B historical physical procedure (superseded by Step 3C)

This records only the transaction behavior verified at that checkpoint. The
final deployment pin map above supersedes its scanner/controller wiring.

1. The temporary button-to-GND arrangement used by the original Step 3B test
   is superseded. For any repeat test, wire RESTOCK as +5 V -> button -> D2
   with R7 10 kOhm from D2 to GND, and CHECKOUT as +5 V -> button -> D3
   with R8 10 kOhm from D3 to GND. The A0/A1 scanner and D1/D0 controller
   wiring below describes the historical prototype only; use the final pin map.
   Only after uploads are explicitly authorized, build/upload both Uno and
   ESP32 firmware. Isolate scanner wires from D0/D1 if they interfere with the
   Uno bootloader upload, then open ESP32 USB Serial at 115200.
2. With Electron authenticated and hardware healthy, briefly press/release
   ATmega D2 RESTOCK, then scan a known barcode within ten seconds. Expect one
   `ATmega RESTOCK RX: <barcode>` line, LED feedback and one desktop event/dialog.
   With Step 4A firmware, the ATmega LCD shows local scan-wait feedback before
   forwarding; final saved/result LCD screens are deferred to a later step.
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

### Step 3A historical physical procedure

This old procedure is retained as a historical record only. New tests must use
the final USART0 GM65 assignment and D6/D7 controller link above.
6. Verify inventory/history/pending-event counts do not change. This is receive/
   forward bring-up only, not a stock transaction or desktop registration flow.

## Step 4A: ATmega TWI and LCD bring-up (physically verified)

At the Step 4A checkpoint, the LCD moved exclusively to ATmega **A4 / PC4 SDA**
and **A5 / PC5 SCL**, while the RTC temporarily stayed on ESP32 GPIO21/GPIO22.
Step 4B below supersedes only that temporary RTC arrangement. MicroSD,
offline-journal and desktop business processing remain on ESP32.

`twi_master.h` implements a cooperative hardware-TWI master, with its AVR
register adapter in `src/twi_master.cpp`. At 16 MHz, prescaler one and TWBR=72
produce 100 kHz. Only PC4/PC5 direction/pull-up bits are changed. Each write
copies at most six bytes and services one ready hardware state per main-loop
iteration. There are no polling waits, TWI interrupts, interrupt-disabled
sections or timer changes. Timer1 software UART, Timer0 clock and USART0
interrupts keep running. Every transfer, including STOP completion, has a
wrap-safe 20 ms total deadline. Address/data NACK, arbitration loss, bus error,
invalid requests and timeout are explicit results. Arbitration loss releases
the bus without STOP; timeout resets only TWI. A permanently stuck external bus
is not forcibly clocked or retried indefinitely.

`lcd_display.h` drives the existing PCF8574-style backpack at **0x27 / 20x4**.
The repository's previously used mapping is RS=P0, RW=P1, E=P2, backlight=P3,
D4..D7=P4..P7. RW stays LOW. The driver performs the delayed 3/3/3/2 nibble
initialization handshake, function/display/clear/entry commands and then
supports clear, checked cursor positioning (00/40/14/54 row offsets) and up to
20 copied printable characters, bounded by remaining row width. All delays
are cooperative millisecond settling deadlines, not blocking delays. Screen
updates are padded row writes, not repeated clears.

The temporary bring-up screen is:

```text
Dental Inventory
ATmega Controller
LCD READY
```

While ATmega is armed, line 3 changes to `RESTOCK WAIT` or `CHECKOUT WAIT`.
It returns to the bring-up screen after dispatch/timeout. Final transaction
result/error screens are **not migrated yet**. LCD READY means initialization
writes were acknowledged by the backpack, not proof that the glass displays
characters or the contrast setting is correct.

LCD failure is retained in `Display::state()/error()` and the actual firmware's
`lcdState` / `lcdLastError` globals. No debug traffic is sent on D0/D1 or on the
controller link. A failure stops LCD writes until reinitialization/reset, but
does not gate buttons, scanner capture or frame transport. An explicitly
restarted initialization resets the logical cursor and repaints the desired
screen. There is no automatic unlimited recovery loop.

ESP32's LCD object, dependency, address probe and writes are removed. Legacy
feedback call sites remain an explicit no-op migration shim, preserving
transaction timers, LED feedback and result/ACK processing without introducing
new LCD transport. Startup, online and offline readiness no longer require an
ESP32 LCD. At this historical checkpoint the RTC still initialized on its
original bus; Step 4B redirects that same trust/recovery behavior to ATmega.

### Completed Step 4A physical verification

Step 4A passed on real hardware with LCD SDA -> Uno A4 / PC4, LCD SCL ->
Uno A5 / PC5, LCD VCC -> regulated 5 V and LCD GND -> common GND. The backpack
responded at 0x27 on the 100 kHz ATmega bus. The display showed `Dental
Inventory`, `ATmega Controller` and `LCD READY` at startup, then showed
`RESTOCK WAIT` from a D2 operation and `CHECKOUT WAIT` from a D3 operation.
The RTC remained on the independent ESP32 GPIO21/GPIO22 bus and was not
migrated. This establishes ATmega LCD ownership and basic workflow display
integration at the Step 4A checkpoint; Step 4B below supersedes the temporary
RTC wiring. Brief committed/offline-save/error LCD feedback is now carried by
bounded display-only controller frames; its physical timing remains unverified.

### Wiring and future repeat procedure

1. These are the historical Step 4A instructions. Power everything off before
   rewiring. Remove LCD SDA/SCL from ESP32 GPIO21/GPIO22; at this checkpoint the
   RTC SDA/SCL and its 3.3 V supply remained there unchanged.
2. Connect LCD SDA -> Uno A4, LCD SCL -> Uno A5, LCD GND -> common GND. For the
   5 V-rated 20x4 LCD/backpack, use regulated **5 V** for LCD VCC
   (Uno 5 V when Uno supplies this circuit). Confirm the module rating before
   changing its supply. Backpack pull-ups belong only to this ATmega bus;
   internal AVR weak pull-ups are not a substitute for external bus pull-ups.
   Do not join independent 5 V supply outputs or connect this bus to ESP32.
3. This is the historical Step 4A procedure. For final deployment, preserve
   GM65 on D0/D1, D2/D3 active-HIGH buttons with external pull-downs, the
   D6/D7 level-shifted controller link, status outputs and ATmega SD.
4. Only when upload is explicitly authorized, use `pio run -e uno -t upload` on
   COM10, with scanner wiring isolated from D0/D1 if necessary during the
   upload. Reconnect it only after upload completes. Update ESP32 firmware only
   with separate explicit authorization; power off before rewiring.
5. Boot and verify the three startup lines and blank fourth row; adjust LCD
   contrast if necessary. Open ESP32 USB Serial at 115200 only, not Uno Serial.
   Check RTC/Wi-Fi/HTTP startup, and the LCD ownership migration message.
6. Press/release D2: verify RESTOCK WAIT. Do not scan yet; after 10 seconds it
   returns to ready. Press/release D3 after release/rearm: verify CHECKOUT WAIT
   and the same timeout recovery. Verify controller PING/PONG and scanner
   reception still operate while LCD updates. Host tests cannot prove ISR
   latency margins; verify these on the physical system.
7. If a real transaction is explicitly authorized, scan a known item after
   arming and verify the existing ESP32 ONLINE/OFFLINE route and result/ACK
   behavior. This can change stock/journal state; it is not required for the
   initial display-only bring-up. Do not synchronize pending offline records
   merely to test the LCD. Final LCD result screens remain deferred.
8. For an absent-LCD check, power off, disconnect only the LCD, then boot.
   Verify the core button/scanner/link path still works and ESP32 no longer
   reports LCD unavailable. Do not hot-remove powered wiring or MicroSD.

Focused tests: `twi_master_test.cpp` (13 scenarios), `lcd_display_test.cpp`
(16 scenarios), plus existing workflow/scanner/UART/status tests. LCD tests
cover startup timing, formatting, all row addresses, bounded copied text,
clear, busy/NACK/timeouts, clock wrap, wait screens, latest-screen coalescing,
explicit recovery and continued RESTOCK/CHECKOUT transport despite LCD failure.
Run `firmware/tests/lcd_ownership_test.ps1` for active ESP32 source integration
guards, in addition to the existing controller/routing/event regressions.

Hardware references: [Microchip ATmega328P datasheet](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf)
and [NXP PCF8574/PCF8574A datasheet](https://www.nxp.com/docs/en/data-sheet/PCF8574_PCF8574A.pdf).

## Step 4B: ATmega-owned DS3231 RTC (physically verified)

The DS3231 now shares the ATmega hardware-TWI bus with the LCD:

| Device | Address | SDA | SCL | Bus rate |
|---|---:|---|---|---:|
| 20x4 LCD backpack | `0x27` | A4 / PC4 | A5 / PC5 | 100 kHz |
| DS3231 RTC | `0x68` | A4 / PC4 | A5 / PC5 | 100 kHz |

The bare-metal driver performs bounded register write/read transactions through
the existing cooperative TWI master. It decodes and encodes BCD, supports valid
12-hour reads and writes explicit 24-hour values, validates calendar dates from
2000 through 2099, checks the DS3231 oscillator-stop flag, and rereads both the
flag and timestamp after a controlled write. It never substitutes compile time
or another invented timestamp. RTC failure is retained as `unavailable`,
`needs_sync` (`lost_power`, `invalid_time`, or verification failure), or `ready`.
An RTC NACK/error cannot block the LCD, and an LCD failure cannot block the RTC,
buttons, scanner, controller link, or transaction processing.

On every ATmega boot, the driver independently reads the physical DS3231 status
register and retained calendar. OSF clear plus a valid retained date/time becomes
`ready` immediately, without ESP32, Wi-Fi, backend, or Electron participation.
Normal ATmega/ESP32 reboot, controller-link restart, desktop disconnect, and
ONLINE/OFFLINE routing do not change that trust. `needs_sync` is reserved for a
real OSF/lost-power indication, invalid retained calendar, or failed write
verification; a communication failure is `unavailable`. A successful sync
writes the DS3231, clears OSF while preserving other status bits, rereads both
status and time, and therefore reconstructs `ready` from hardware on later boots.

The shared TWI master permits only one transaction at a time and retains each
completion until its initiating client consumes it. Repeated START reads and
STOP completion remain inside the existing wrap-safe 20 ms deadline. This
prevents the LCD and RTC clients from consuming one another's completion while
preserving Step 4A's 100 kHz bus and cooperative main loop.

RTC bridge frames on the existing fixed-buffer controller link are:

```text
RTC_STATUS?                     -> RTC_STATUS:<state>:<reason>
RTC_TIME?                       -> RTC_TIME:YYYY-MM-DD HH:MM:SS
RTC_SYNC:YYYY-MM-DD HH:MM:SS    -> RTC_SYNCED:<state>:<reason>
```

Each wire frame is terminated by `\n`.

They coexist with PING/PONG, SCAN, RESTOCK and CHECKOUT without byte
interleaving. The ESP32 uses a bounded 1.5-second bridge deadline and polls the
ATmega state periodically. Existing `/status` fields remain compatible. The
existing authenticated `POST /rtc/sync` endpoint still accepts only the
backend-created epoch/UTC-offset request protected by the ignored device token;
the renderer gains no arbitrary RTC-write capability. ESP32 converts the
validated desktop time to a bounded local timestamp frame, and ATmega validates,
writes and verifies it before reporting success.

Transaction timestamp ownership is also complete in Step 4B without changing
RESTOCK/CHECKOUT operation frames: immediately before CSV/event/journal work,
ESP32 requests `RTC_TIME?` and uses only the validated ATmega/DS3231 response.
If the RTC is not trusted or the controller response times out, the existing
transaction error path runs. ESP32 no longer includes RTClib, initializes Wire,
probes `0x68`, reads/writes DS3231 registers, or owns GPIO21/GPIO22 for RTC.
ESP32's cached RTC status is informational only: every transaction asks the
ATmega for `RTC_TIME?`, so a controller/link restart cannot require desktop sync
when the DS3231 itself remains valid. The original RTC timestamp is stored in
the existing online/offline record and is never replaced by later synchronization.

The ATmega LCD idle screen now uses the same hardware time source:

```text
Dental Inventory
YYYY-MM-DD
HH:MM:SS
SYSTEM READY
```

ATmega performs one bounded DS3231 refresh per second and rewrites only the LCD
time row (plus the date row when the day changes); it never clears the screen for
clock ticks. `RESTOCK WAIT` and `CHECKOUT WAIT` have explicit priority over the
clock, then the clock returns after timeout/dispatch/cooldown. `RTC NEEDS SYNC`
or `RTC UNAVAILABLE` replaces date/time when untrusted, so no fabricated time is
shown. The refresh is cooperative and shares the same serialized TWI master.

### Electrical source-of-truth note

The repository still does not identify the exact DS3231 breakout, LCD backpack
revision, onboard SDA/SCL resistor values, or their pull-up rails. The LCD was
physically verified at regulated 5 V in Step 4A; the RTC was previously operated
at 3.3 V. That does **not** prove that directly joining the two breakout buses is
safe: a 5 V LCD pull-up can place 5 V on a 3.3 V-powered RTC board or an auxiliary
EEPROM whose tolerance is unknown. AVR weak pull-ups are enabled by the retained
TWI setup but are not a documented substitute for the modules' required external
pull-ups.

Before wiring, identify both exact board revisions and inspect/measure, with
power off, which rail each onboard SDA/SCL pull-up reaches and the effective
parallel resistance. Confirm the DS3231 board and every auxiliary device are
rated for the chosen VCC and bus-high voltage. After selecting the arrangement
supported by those module documents/final schematic, power it without the data
lines connected and verify both supply rails, then connect the bus and measure
idle SDA/SCL before attaching any voltage-sensitive controller. Do not add,
remove, or choose pull-up/level-shifter values from this software document.

### Completed Step 4B physical verification

After the corrected Uno and ESP32 images were uploaded, a complete power cycle
with Electron closed brought the retained DS3231 directly to `ready`. The LCD
displayed `Dental Inventory`, retained date `2026-09-19`, an advancing
`HH:MM:SS` clock and `SYSTEM READY`. This physically verifies standalone
`DS3231 -> ATmega -> LCD` operation without desktop, backend, or Wi-Fi clock
ownership.

With Electron still closed, RESTOCK barcode `4806016001569` selected the
existing OFFLINE route and passed RTC validation/timestamp retrieval. Processing
then stopped only at `ERROR: MicroSD is unavailable; event was not started`;
there was no RTC unavailable/untrusted error. Previously verified ONLINE
RESTOCK and CHECKOUT scans of the same barcode likewise passed the ATmega RTC
stage after authenticated desktop synchronization and stopped only at the
currently unmigrated MicroSD dependency.

The MicroSD error is expected and outside Step 4B. The next migration stage is
**Step 5 — MicroSD / offline transaction storage migration**. It must restore
the mandatory original offline storage behavior without moving RTC ownership
back to ESP32.

### Step 4B repeat procedure

1. Do not upload yet. Power off the Uno, ESP32 and peripheral supply; do not
   hot-move I2C or MicroSD wiring.
2. Leave LCD SDA on A4 and LCD SCL on A5. Remove only DS3231 SDA/SCL from ESP32
   GPIO21/GPIO22. Connect DS3231 SDA to the shared A4 node and DS3231 SCL to the
   shared A5 node. Preserve common GND.
3. Connect DS3231 VCC only to the rail proven safe by the exact breakout/final
   schematic inspection above. Do not assume that its previous 3.3 V supply is
   compatible with the LCD backpack's pull-ups, and do not assume 5 V solely
   because the DS3231 IC itself supports it.
4. With firmware still absent, power the bus and verify LCD at `0x27`, RTC at
   `0x68`, and safe idle SDA/SCL voltage. Power off again before changing wires.
5. Only after explicit upload authorization, build/upload the Uno and ESP32
   images. Open ESP32 USB Serial at 115200. Expect ATmega-link readiness and an
   RTC state of `ready`, `needs_sync`, or `unavailable`; there must be no ESP32
   Wire/RTClib initialization.
6. With Electron closed and Wi-Fi optional, verify a retained DS3231 with OSF
   clear boots directly to `ready`; the LCD must show advancing date/time. Reset
   ATmega and ESP32 separately and verify no new synchronization is requested.
   Verify RESTOCK WAIT and CHECKOUT WAIT override the clock and return to it
   after timeout/cooldown. An absent/NACKing RTC must leave LCD and scan workflows
   usable; an absent/NACKing LCD must leave RTC state/sync reporting usable.
7. If `/status` reports `needs_sync`, log into Electron and allow the existing
   authenticated recovery coordinator to synchronize it. Confirm `/status`
   becomes `rtc:true`, `rtcState:"ready"`, with no renderer clock-setting API.
8. Close Electron and disconnect Wi-Fi without resetting the RTC. Perform a
   separately authorized offline test transaction and confirm its original
   stored timestamp matches the ATmega-owned DS3231. Reconnect later and confirm
   synchronization does not replace that timestamp. Repeat an online transaction
   if authorized. Preserve all existing FIFO/journal, result and ACK checks.
   Until Step 5 migrates MicroSD, reaching the explicit MicroSD-unavailable
   error after the RTC stage is the expected boundary rather than an RTC failure.

Focused Step 4B coverage adds 16 DS3231, 9 RTC-link, 4 shared-bus, LCD clock/
priority/failure-state coverage, one LCD cross-client deferral and one new TWI
read/completion-ownership scenario, plus the existing LCD, workflow,
scanner, UART, status, ESP32 controller-link and transaction regressions.

## Existing focused host tests

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

Current focused coverage includes the requester, bounded UART primitives,
controller software-UART configuration/backpressure, scanner USART0 and ESP32
baseline responder scenarios plus five scanner integration scenarios and fourteen
ATmega scanner capture/forwarding scenarios.
Step 3B adds eighteen button/state scenarios and fourteen operation-routing/
registration scenarios, and preserves the
existing firmware event/cache/journal/RTC/registration regression coverage.
Controller software-UART coverage includes all 256 byte encodings, start/stop bits,
false starts, framing errors, queue bounds and timer wrap. Controller tests
cover D6/D7 ownership, 9600 8N1 configuration, bounded backpressure and
the unchanged PING/PONG protocol. Generated `.pio/`, `.vscode/` and `.runtime/`
files remain ignored.
