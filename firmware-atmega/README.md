# ATmega migration Step 1

Separate primary-controller foundation. The working ESP32 project remains in
`../firmware/` and is intentionally unchanged. No desktop changes are required.

## Build and startup

PlatformIO Atmel AVR 5.1.0, AVR-GCC/avr-libc, bare-metal C++11 (no Arduino runtime
or third-party libraries). Target `ATmega328P`, explicitly `F_CPU = 16000000UL`.
The AVR runtime supplies reset/startup and calls `main()`. Startup drives only
the four status pins OFF; all other GPIOs and peripherals are left unconfigured.
The status APIs write both bits of each group together, preserving other bits.
No dynamic allocation, periodic cycling, Serial, or ATmega/ESP32 transport exists.

```powershell
pio run --project-dir firmware-atmega --environment atmega328p
```

Setting `F_CPU` describes the expected clock to the compiler; it does **not**
select the oscillator or program fuses. The standalone hardware requires its
16 MHz external crystal circuit and separately verified fuse configuration.
No bootloader is assumed. Do not run upload, fuse, or bootloader targets for Step 1.

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

## Future programmer (not used in this step)

Arduino Uno R3 running ArduinoISP is the development programmer only. Conceptual
connections: Uno D10 to target RESET; D11 to PB3/MOSI; D12 to PB4/MISO; D13 to
PB5/SCK; 5V to target VCC; GND to common GND. The Uno is not the final controller.
This is not a complete standalone-chip wiring checklist; power, AVCC, crystal,
reset, decoupling, fuse settings, and ISP procedure must be verified at bring-up.
No COM port or physical upload is configured/performed by this step.

## Focused host tests

`tests/status_encoding_test.cpp` tests all seven states, the reserved Big 01
exclusion, startup OFF defaults, determinism, invalid-value fail-OFF, and masked
port updates. It tests pure mapping, not physical LEDs or reset-time behavior.
Use an existing host C++ compiler, for example the workspace's ignored Zig setup:

```powershell
& .\.runtime\ziglang\ziglang\zig.exe c++ -std=c++11 -Ifirmware-atmega/include firmware-atmega/tests/status_encoding_test.cpp -o .runtime/firmware-tests/atmega_status_encoding_test.exe
& .\.runtime\firmware-tests\atmega_status_encoding_test.exe
```

Generated `.pio/` and `.runtime/` files are already ignored by the root rules.
