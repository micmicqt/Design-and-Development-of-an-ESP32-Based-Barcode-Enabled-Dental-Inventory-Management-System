# ATmega migration: Uno main-controller foundation and UART link

Separate primary-controller foundation. The working ESP32 project remains in
`../firmware/` and retains all existing functionality during migration. Step 2
adds only a configurable UART responder. No desktop changes are required.

## Build and startup

PlatformIO Atmel AVR 5.1.0, AVR-GCC/avr-libc, bare-metal C++11 (no Arduino runtime
or third-party libraries). Target Arduino Uno R3's **onboard ATmega328P**,
explicitly `F_CPU = 16000000UL`.
The AVR runtime supplies reset/startup and calls `main()`. Startup drives only
the four status pins OFF. Step 2 additionally initializes USART0 and Timer0.
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

ATmega USART0: D0/PD0 RX, D1/PD1 TX, **9600 baud, 8N1**. Normal-speed divider
103 yields approximately 9615 baud at 16 MHz. Timer0 CTC interrupt provides a
1 kHz millisecond clock without PWM outputs or Arduino runtime. Main polls at
most eight received bytes and attempts one nonblocking TX byte per iteration.

ATmega initiates `PING\n` after two seconds and verifies only `PONG\n` while
awaiting a response. It retries two seconds after completion/failure. Sending
and response waiting each have a one-second timeout; neither can block forever.
Internal outcome and counters record verification/timeout; the link does not
depend on USB Serial Monitor or change either status LED group.

Case-sensitive lines contain at most eight printable ASCII characters excluding
terminators. Optional CRLF is accepted; empty lines are ignored. Binary, malformed
or oversized frames are discarded through LF, with fixed nine-byte storage.
USART framing/parity/overrun errors quarantine the current frame. Partial frames
expire with their attempt; responses outside a waiting state are ignored. This
is a bring-up protocol, not authenticated or transaction-grade transport.

### Confirmed ESP32 mapping

ESP32 uses **UART1 RX GPIO34 / TX GPIO25**, enabled by default in Step 2.1;
scanner UART2 GPIO16/17 and debug UART0 remain unchanged. GPIO34 is input-only
and has no internal pull-up: the interface must maintain an idle-HIGH RX level.
`DENTAL_ATMEGA_LINK_RX_GPIO` and `DENTAL_ATMEGA_LINK_TX_GPIO` can be overridden
with PlatformIO build flags; setting BOTH to `-1` disables the link.
Compile-time checks reject incomplete, identical,
invalid or existing peripheral/flash pin assignments. Do not reuse GM65 GPIO16/17.

Required direction through the confirmed voltage/interface path:

- ESP32 GPIO25 TX → interface path → ATmega D0/PD0 RX.
- ATmega D1/PD1 TX → **5V-to-3.3V conversion** → ESP32 GPIO34 RX.
- Common GND. Never connect ATmega's 5V TX directly to ESP32 RX.

Uno D0/D1 are shared with its USB interface. Isolate the external link during
Uno USB uploads, and verify that the interface prevents simultaneous USB/ESP32
TX driving D0; voltage conversion alone does not solve driver contention.
Physical UART verification remains pending; Step 2.1 performs no upload,
fuse programming or external-target programming.

ESP32 processes at most 16 RX bytes per loop and checks TX capacity before
writing. Only PING produces PONG. At most one five-byte reply is buffered; extra
PINGs arriving while TX is busy are ignored rather than queued without bound.
The responder has no inventory, FIFO, offline journal, RTC, MicroSD, HTTP or
Electron callback. All existing ESP32 workflows continue to coexist unchanged.

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
& .\.runtime\ziglang\ziglang\zig.exe c++ -std=c++11 -Wall -Wextra -Werror -Ifirmware/include firmware/tests/atmega_link_test.cpp -o .runtime/firmware-tests/esp32_atmega_link_test.exe
& .\.runtime\firmware-tests\esp32_atmega_link_test.exe
```

Step 2 adds eight requester and eight responder/integration scenarios, including
bounded parsing, UART error rejection, timeout/retry, timer wrap and a software
end-to-end exchange. Host tests do not prove physical levels, task timing or Uno
USB contention. Generated `.pio/`, `.vscode/` and `.runtime/` files remain ignored.
