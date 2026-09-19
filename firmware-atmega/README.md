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
and Timer0. Step 3C supersedes the temporary USART0 scanner wiring with a
full-duplex A0/A1 software UART; D0/D1 are now free from GM65 ownership.
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
| Big | PB0 / D8 | PB1 / D9 | 00 | 10 | not defined | 11 |

These are inputs to the existing external 7400-series logic, not independent LED
drivers. The supplied truth-table **rows** are authoritative, not older schematic
labels. Big 01 is reserved/unused and never emitted by the normal API. Invalid
enum values fail to OFF. No HIGH/LOW/EMPTY or SUCCESS/error semantic assignments
are introduced in this foundation step.

## Step 2: controller UART

ATmega controller software UART: **D6/PD6 RX, D7/PD7 TX, 9600 baud, 8N1**.
Scanner software UART: **A0/PC0 RX, A1/PC1 TX, 9600 baud, 8N1**. Hardware
USART0 D0/PD0 and D1/PD1 is explicitly disabled by application startup and is
free from GM65 ownership for Uno USB/bootloader or later debug use.
Timer1 runs freely at 2 MHz (prescaler 8). Compare A advances the earliest due
TX channel; Compare B samples the earliest due RX channel. PD6 uses PCINT22/
PCINT2 and A0 uses PCINT8/PCINT1 for independent falling start edges. Each
channel carries its own phase and next deadline, so controller and scanner TX/
RX frames can overlap rather than assuming alternating use. Fixed 208-tick/
104-tick sampling yields approximately 9615 baud (+0.16%). Controller queues
have 16 slots (15 usable); scanner RX has 64 slots (63 usable), and scanner TX
has 16. Full TX returns false, RX overflow/framing errors quarantine parser
input, false starts are discarded, and ISR work remains bounded.
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
ESP32 debug UART0 remains unchanged and its direct GM65 UART stays disabled.
GM65 ownership is now implemented on ATmega A0/A1; no scanner pins are assigned
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

Uno D0/D1 are shared with the USB interface, not either software UART. The GM65
no longer connects to them, so scanner wiring need not be isolated for normal
Uno USB/bootloader uploads. The ESP32 link on D6/D7 also does not share them.
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

## Step 3C: full-duplex scanner UART on A0/A1

Step 3C moves both GM65 directions off the Uno USB USART pins:

- GM65 TX -> Uno A0 / PC0 (scanner RX into ATmega).
- Uno A1 / PC1 -> GM65 RX (scanner TX from ATmega).
- D0/PD0 and D1/PD1 have no scanner dependency.

A0 reception is physically verified. A1 transmission is implemented in
firmware and designated by the final schematic, but the A1 -> GM65 RX path has
not yet been physically verified because the exact scanner RX electrical
compatibility remains unconfirmed. Production firmware sends no GM65 command.

The A0/A1 link is bare-metal 9600 8N1 and shares the Timer1 earliest-deadline
scheduler described above with D6/D7. PCINT1 detects A0's start edge. No Arduino
SoftwareSerial, dynamic allocation, busy delay or long interrupt-disabled
section is used. The existing scanner parser still accepts printable ASCII,
preserves exact/leading-zero barcodes, supports CR/LF/CRLF, caps text at 64
characters, rejects malformed/oversized/framing/overflow input without silent
truncation and recovers after its bounded timeout. A1 implements fixed-queue
8N1 transmission but no new GM65 command or trigger is sent in this step.

The repository contains no current schematic/netlist or exact GM65 adapter
part/revision documenting an RX protection divider, series resistor or level
shifter. Consequently it does not establish resistor values or prove that a
direct 5 V A1 HIGH is safe for this exact scanner RX. The generic GM65 manual
describes a 5 V-powered TTL interface, but does not specify UART VIH/VIL or
absolute-maximum pin voltage. Before physically connecting A1, identify the
exact module/adapter, inspect its input conditioning, and confirm whether its RX
is 5 V tolerant. Measure GM65 TX HIGH and confirm it meets the ATmega328P's
5 V digital-input threshold before connecting it directly to A0. Preserve any
conditioning shown on the actual final schematic; do not add/remove a resistor
from this repository's incomplete information.

ESP32 processes at most 16 RX bytes per loop and checks TX capacity before
writing. Only PING produces PONG; barcode frames also produce temporary USB debug lines.
At most one five-byte reply is buffered; extra
PINGs arriving while TX is busy are ignored rather than queued without bound.
The responder has no inventory, FIFO, offline journal, RTC, MicroSD, HTTP or
Electron callback. ESP32 routes typed operations outside the transport parser
into the corresponding existing workflow (Step 3B).

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

### Final Step 3C / Step 4A ATmega pin map

| Uno pin | AVR pin | Current ownership |
|---|---|---|
| D0 | PD0 | Free / USART0 RX |
| D1 | PD1 | Free / USART0 TX |
| D2 | PD2 | RESTOCK, active-HIGH external-pulldown input |
| D3 | PD3 | CHECKOUT, active-HIGH external-pulldown input |
| D4 | PD4 | Small-status logic B |
| D5 | PD5 | Small-status logic A |
| D6 | PD6 | ESP32 controller-link RX |
| D7 | PD7 | ESP32 controller-link TX |
| D8 | PB0 | Big-status logic A |
| D9 | PB1 | Big-status logic B |
| D10 | PB2 | Reserved for future MicroSD CS |
| D11 | PB3 | SPI MOSI |
| D12 | PB4 | SPI MISO |
| D13 | PB5 | SPI SCK |
| A0 | PC0 | GM65 RX into ATmega; physically verified |
| A1 | PC1 | GM65 TX from ATmega; implemented, physical verification pending |
| A4 | PC4 | LCD I2C SDA |
| A5 | PC5 | LCD I2C SCL |

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
At the Step 3B checkpoint, RTC, LCD and MicroSD remained on ESP32. Step 4A below
now moves only LCD ownership; RTC/MicroSD and business processing stay there.

## Step 3B: ATmega-owned physical operations

Physical testing individually completed ONLINE RESTOCK/D2 and CHECKOUT/D3
transactions and verified barcode reception and the controller link. Button
behavior became unreliable with both GM65 UART directions connected. This
was a historical Step 3B observation under the superseded D0/D1 arrangement;
Step 3C replaces it with A0/A1 without changing transaction logic.

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

This records only the transaction behavior verified at that checkpoint. Do not
restore its scanner wiring; use A0/A1 as the current source of truth.

1. The temporary button-to-GND arrangement used by the original Step 3B test
   is superseded. For any repeat test, wire RESTOCK as +5 V -> button -> D2
   with R7 10 kOhm from D2 to GND, and CHECKOUT as +5 V -> button -> D3
   with R8 10 kOhm from D3 to GND. Use the current Step 3C A0/A1 scanner
   assignment and preserve controller D7/D6 -> GPIO16/17 level-shifter wiring.
   Only after uploads are explicitly authorized, build/upload both Uno and
   ESP32 firmware. Open ESP32 USB Serial at 115200; D0/D1 remain free from the
   scanner and available to the Uno bootloader/USB USART.
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

The old USART0 wiring procedure is intentionally retired. Repeat scanner tests
only with the current A0/PC0 receive and A1/PC1 transmit assignment. D0/D1 must
remain free from GM65 ownership.
6. Verify inventory/history/pending-event counts do not change. This is receive/
   forward bring-up only, not a stock transaction or desktop registration flow.

## Step 4A: ATmega TWI and LCD bring-up (physically verified)

The LCD now belongs exclusively to ATmega **A4 / PC4 SDA** and **A5 / PC5
SCL**. ESP32 GPIO21/GPIO22 remain the **RTC-only, 3.3 V bus**. These buses must
not be electrically joined. No RTC, SD, timestamp, offline-journal, sync or
desktop ownership is migrated in this step.

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
ESP32 LCD. The RTC still initializes on its original bus and retains all
existing trust/recovery behavior.

### Completed Step 4A physical verification

Step 4A passed on real hardware with LCD SDA -> Uno A4 / PC4, LCD SCL ->
Uno A5 / PC5, LCD VCC -> regulated 5 V and LCD GND -> common GND. The backpack
responded at 0x27 on the 100 kHz ATmega bus. The display showed `Dental
Inventory`, `ATmega Controller` and `LCD READY` at startup, then showed
`RESTOCK WAIT` from a D2 operation and `CHECKOUT WAIT` from a D3 operation.
The RTC remained on the independent ESP32 GPIO21/GPIO22 bus and was not
migrated. This establishes ATmega LCD ownership and basic workflow display
integration; final transaction-result screens remain deferred.

### Wiring and future repeat procedure

1. Power everything off before rewiring. Remove LCD SDA/SCL from ESP32 GPIO21/
   GPIO22; leave RTC SDA/SCL and its 3.3 V supply there unchanged.
2. Connect LCD SDA -> Uno A4, LCD SCL -> Uno A5, LCD GND -> common GND. For the
   5 V-rated 20x4 LCD/backpack, use regulated **5 V** for LCD VCC
   (Uno 5 V when Uno supplies this circuit). Confirm the module rating before
   changing its supply. Backpack pull-ups belong only to this ATmega bus;
   internal AVR weak pull-ups are not a substitute for external bus pull-ups.
   Do not join independent 5 V supply outputs or connect this bus to ESP32.
3. Preserve GM65 TX -> A0 and A1 -> GM65 RX only after the electrical checks in
   Step 3C above. Keep D0/D1 disconnected from GM65. Preserve the D2/D3
   active-HIGH buttons with their external 10 kOhm pull-downs, the D6/D7
   level-shifted controller link, status outputs and ESP32 RTC/SD.
4. Only when upload is explicitly authorized, use `pio run -e uno -t upload` on
   COM10. No scanner wire now competes with D0/D1. Update ESP32 firmware only
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

Focused tests: `twi_master_test.cpp` (12 scenarios), `lcd_display_test.cpp`
(15 scenarios), plus existing workflow/scanner/UART/status tests. LCD tests
cover startup timing, formatting, all row addresses, bounded copied text,
clear, busy/NACK/timeouts, clock wrap, wait screens, latest-screen coalescing,
explicit recovery and continued RESTOCK/CHECKOUT transport despite LCD failure.
Run `firmware/tests/lcd_ownership_test.ps1` for active ESP32 source integration
guards, in addition to the existing controller/routing/event regressions.

Hardware references: [Microchip ATmega328P datasheet](https://ww1.microchip.com/downloads/en/DeviceDoc/Atmel-7810-Automotive-Microcontrollers-ATmega328P_Datasheet.pdf)
and [NXP PCF8574/PCF8574A datasheet](https://www.nxp.com/docs/en/data-sheet/PCF8574_PCF8574A.pdf).

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

Current focused coverage: eight requester, eight software-UART and eight ESP32
baseline responder scenarios plus five scanner integration scenarios and fourteen
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
