# Hardware Validation Gate

Status: **historical Phase 1 gate; not the current controller pin map**.
The active migration pin map and remaining acceptance checks are in
`firmware-atmega/README.md` and `docs/atmega-step5-storage-migration.md`.

This document records what can be read from the supplied final PCB schematic and what must still be proven before Phase 2 firmware may initialize physical hardware. A GPIO appearing in the schematic is not evidence that its voltage, direction, active level, connector orientation, or application meaning is safe or correct.

Phase 1 firmware must not call `pinMode`, `digitalWrite`, `Wire.begin`, `SPI.begin`, `SD.begin`, RTC/LCD initialization, scanner initialization, button initialization, LED-logic initialization, or Wi-Fi initialization. It initializes only the required development `Serial` log and prints that hardware activation is disabled.

> Safety note: the required ESP32 development `Serial` log uses UART0 on GPIO1/GPIO3, which are also the scanner nets visible in the schematic. Until the scanner direction and USB-UART interaction are resolved, boot Phase 1 firmware only on a bare/disconnected development board or with the scanner UART physically disconnected.

## Schematic nets recorded in Phase 1

These names describe schematic connectivity only; they do not authorize peripheral activation.

| Schematic function | ESP32 net | Phase 1 status |
|---|---:|---|
| Shared I2C SDA for LCD and DS3231 | GPIO21 | Pin visible; voltage and pull-ups unverified |
| Shared I2C SCL for LCD and DS3231 | GPIO22 | Pin visible; voltage and pull-ups unverified |
| MicroSD CS | GPIO5 | Pin visible; module interface and strapping behavior unverified |
| MicroSD SCK | GPIO18 | Pin visible; module interface unverified |
| MicroSD MOSI | GPIO23 | Pin visible; module interface unverified |
| MicroSD MISO | GPIO19 | Pin visible; module interface unverified |
| SW1 net | GPIO14 | Electrical behavior and application meaning unconfirmed |
| SW2 net | GPIO12 | Electrical behavior, boot-strapping behavior, and application meaning unconfirmed |
| Two-indicator control A | GPIO32 | D1/D2 semantic assignment and polarity unconfirmed |
| Two-indicator control B | GPIO33 | D1/D2 semantic assignment and polarity unconfirmed |
| Three-indicator control A | GPIO26 | D3/D4/D5 semantic assignment and polarity unconfirmed |
| Three-indicator control B | GPIO27 | D3/D4/D5 semantic assignment and polarity unconfirmed |
| Scanner schematic U0TXD net | GPIO1 | Connector direction/crossing and USB-UART interaction unconfirmed |
| Scanner schematic U0RXD net | GPIO3 | Connector direction/crossing and USB-UART interaction unconfirmed |

The raster schematic appears to connect ESP32 U0TXD/GPIO1 to a scanner connector pin labelled `TX`, and U0RXD/GPIO3 to a pin labelled `RX`. Connector labels alone do not establish whether they describe the scanner signals or the host signals. Confirm this against the exact GM65 module/adapter documentation and physical connector orientation; do not assume that UART is correctly crossed.

## External LED logic trace to verify

The following is only a provisional visual trace of the supplied schematic, not an approved LED mapping. It must be checked against the native schematic/netlist and then confirmed with an unpowered continuity test:

- D1 logic input appears to be `GPIO32 AND GPIO33`.
- D2 logic input appears to be `GPIO32 AND NOT GPIO33`.
- D3 logic input appears to be `GPIO26 AND NOT GPIO27`.
- D4 logic input appears to be `NOT GPIO26 AND GPIO27`.
- D5 logic input appears to be `GPIO26 AND GPIO27`.

Even if those equations are confirmed, the following meanings remain unknown:

- whether D1 or D2 represents SUCCESS versus ERROR;
- whether D3, D4, or D5 represents HIGH, LOW, or EMPTY;
- whether a high gate output visibly turns each LED on, considering LED orientation and the common rail;
- the safe/reset state required on each ESP32 control input.

No `setStockStatus` or `setTransactionStatus` truth table may be finalized until all of those facts are recorded from the assembled PCB.

## UART / GM65 questions

The Step 3C prototype used GM65 TX -> A0/PC0; that receive path was physically
verified for RESTOCK and CHECKOUT with barcode `4806016001569`. The final PCB
instead assigns GM65 TX -> D0/PD0 hardware USART RX and D1/PD1 USART TX ->
GM65 RX. D6/PD6 RX and D7/PD7 TX are the ESP32 controller link. This final
serial routing is implemented but not yet physically verified on the PCB.
Production sends no GM65 command. The repository still lacks an exact scanner/adapter
part revision and a current final schematic/netlist showing UART conditioning.
Do not infer that the ATmega's 5 V D1 output is safe for scanner RX from the
generic `TTL` label alone. Confirm the actual module's UART input rating and any
existing divider/series/level-conversion network before physical connection.

- What is the exact GM65 scanner module and adapter-board part number and datasheet revision?
- Do the connector labels `TX` and `RX` name signals driven by the scanner, or signals expected from the host?
- Is the final D1 -> scanner RX electrical interface safe for the exact GM65 adapter revision?
- What voltage levels does the actual scanner use on TX and RX? Are they 3.3 V TTL, 5 V TTL, RS-232, or level-shifted on the module?
- What supply voltage and peak current does the scanner require?
- What baud rate, data bits, parity, stop bits, terminator, encoding, and scanner output mode are configured?
- What maximum barcode length and inter-byte/frame timeout should firmware support?
- D0/D1 belong to GM65; isolate scanner wiring if it interferes with Uno
  bootloader uploads. D7 -> ESP32 GPIO16 and GPIO17 -> D6 through the level
  shifter, with common ground.

## ATmega SW1 / SW2 source of truth

The final main-controller schematic assigns both switches to the ATmega328P,
not to the legacy ESP32 switch nets listed in the Phase 1 table:

- SW1 RESTOCK: +5 V -> pushbutton -> D2/PD2; R7 10 kOhm from D2 to GND.
- SW2 CHECKOUT: +5 V -> pushbutton -> D3/PD3; R8 10 kOhm from D3 to GND.

Both inputs are active HIGH: released is LOW and pressed is HIGH. DDRD bits 2
and 3 remain clear for input operation, and PORTD bits 2 and 3 remain clear so
the AVR internal pull-ups are disabled. The external resistors establish the
released LOW state. Firmware provides 50-ms debounce, release-before-rearm and
simultaneous-button protection. The old GPIO14/GPIO12 ESP32 switch entries are
historical Phase 1 schematic observations and are not the current runtime
button ownership.

## D1-D5 / 74LS04 / 74LS08 questions

- Confirm the provisional Boolean trace using the native schematic/netlist and unpowered PCB continuity measurements.
- Map D1-D5 physically and visibly to HIGH, LOW, EMPTY, SUCCESS, and ERROR.
- Confirm LED polarity, the common LED rail, and whether a logic-high or logic-low gate output illuminates each LED.
- Confirm the 74LS04 and 74LS08 supply voltage on the assembled PCB.
- Verify that 3.3 V ESP32 outputs meet the actual LS-family input thresholds with adequate margin in all operating conditions.
- Verify that each ESP32/reset/floating state produces a safe, deterministic visible indication.
- Verify that every unused TTL input is biased to a defined level.
- Check the output-current budget. The shown 220-ohm LED resistors and LS-family high-level source-current capability must be evaluated against the exact LED wiring and component datasheets.
- Confirm that each logic IC has local decoupling and that switching noise does not reset the ESP32 or corrupt the SD card.

## Shared I2C / LCD / DS3231 questions

### ATmega Step 4B ownership update

The software source of truth now assigns the LCD (`0x27`) and DS3231 (`0x68`)
to the shared ATmega A4/PC4 SDA and A5/PC5 SCL bus at 100 kHz. ESP32 GPIO21/22
are no longer active RTC pins. Shared-bus ownership, standalone retained-time
boot, the advancing ATmega LCD clock, authenticated online synchronization, and
offline RTC timestamp retrieval have all been physically verified. The current
transaction boundary is the expected unmigrated MicroSD dependency; Step 5 owns
MicroSD/offline-storage migration.

The repository still does not contain the exact breakout revisions or pull-up
values/rails, so the electrical questions below remain a required pre-power
inspection. In particular, the Step 4A LCD was verified at 5 V while the RTC was
previously powered at 3.3 V; those two facts alone do not prove that their SDA/
SCL pull-ups may be joined safely. Do not infer resistor removal, replacement,
or a level-shifter value without the exact module documentation/final schematic.

- What are the exact LCD backpack/controller and DS3231 module part numbers?
- What supply voltage is used by each module on the assembled PCB?
- Which modules contain SDA/SCL pull-ups, what are their values, and to which voltage rail are they connected?
- Measure the idle SDA/SCL high voltage. It must be safe for the ESP32; do not assume a 5 V-powered LCD backpack has 3.3 V-safe pull-ups.
- Is a bidirectional I2C level shifter required?
- What are the actual LCD and RTC I2C addresses? Do not assume a common LCD address such as `0x27` or `0x3F`.
- Is the total pull-up resistance/bus capacitance appropriate, and what bus speed is reliable with the installed wiring?
- Is the DS3231 oscillator running, is its backup battery installed with correct chemistry/polarity, and is its time valid after loss of main power?
- How will an invalid RTC time be detected, displayed, and corrected without substituting PC time silently?

## MicroSD / SPI questions

### ATmega Step 5 ownership update

The active software source of truth now assigns MicroSD CS/MOSI/MISO/SCK to
ATmega PB2/PB3/PB4/PB5 (Uno D10/D11/D12/D13). The ESP32 legacy GPIO5/18/19/23
SPI path is disabled. The ATmega performs conservative card initialization and
bufferless sector I/O; FAT/cache/journal coordination remains on the ESP32 over
the bounded GPIO16/17 controller link. This preserves the established logical
filenames and recovery formats without allocating a 512-byte sector buffer in
the ATmega's 2 KB SRAM. Physical acceptance subsequently covered raw card
readiness, remote sector reads, FAT32 mount, online/offline transactions, and
exactly-once synchronization.

The original Phase 1 ESP32 table above is historical schematic context, not
current ownership.

- Is MOD2 a bare socket, a 3.3 V breakout, or a nominal 5 V module with an onboard regulator and level shifting?
- What voltage is connected to its VCC pin, and are every input/output level and the MISO high level safe for ESP32?
- Verify CS/SCK/MOSI/MISO connectivity and connector numbering against the physical module.
- GPIO5 is an ESP32 strapping pin. Does the module or card pull it to a level that can affect boot?
- Is CS held inactive deterministically during reset and when no card is installed?
- What SPI frequency and mode are reliable for the exact module, card, trace length, and supply?
- Is card-detect available, and what happens on removal or insertion during a write?
- Are local bulk and high-frequency decoupling adequate for SD-card current transients?
- Define and bench-test power-loss behavior for cache replacement, pending-record append, recovery, and archive operations before relying on offline inventory.

## ESP32 board, power, and PCB questions

- Confirm the exact ESP32-DevKitC/module revision, pin count, footprint orientation, and that every schematic symbol pin maps to the intended physical header pin.
- Obtain the native final schematic, PCB layout, bill of materials, and netlist revision; the supplied raster image is insufficient for final sign-off.
- Confirm common ground and every 5 V/3.3 V rail connection with the board unpowered first.
- Confirm power-source priority and protection when USB and the external 5 V supply are connected together. Rule out regulator backfeed and USB-host backfeed.
- Calculate and measure peak/steady current for the ESP32 Wi-Fi radio, scanner, LCD/backlight, RTC, SD card, and TTL/LED network.
- Verify regulator capacity, voltage drop, brownout margin, wiring/trace current, and heat.
- Verify bulk capacitance and one local bypass capacitor per IC/module as required by the component datasheets.
- Record GPIO voltage at reset, boot, upload, and application start. Visible logic circuitry must remain safe before firmware takes control.
- Check all ESP32 strapping pins used by the PCB, especially GPIO5 and GPIO12, under every connected-module and switch state.
- Confirm ESD protection, connector polarity/keying, and whether long external wires need filtering or transient protection.

## Evidence required to close the gate

Before any Phase 2 hardware activation, update this document with all of the following:

1. Native schematic/PCB revision identifier and approved netlist.
2. Exact manufacturer part numbers and datasheets for the DevKitC, GM65 assembly, LCD backpack, DS3231 module, MicroSD module, 74LS04/74LS08, and LEDs.
3. Unpowered continuity results for UART, switches, I2C, SPI, logic controls, power, and ground.
4. Powered voltage measurements made with the ESP32 or vulnerable peripheral disconnected where necessary.
5. Confirmed SW1/SW2 and D1-D5 application mappings.
6. Confirmed UART direction, voltage, framing, and upload/debug isolation procedure.
7. Confirmed I2C pull-up voltage, addresses, and safe bus arrangement.
8. Confirmed SD voltage/level shifting and boot-safe CS behavior.
9. Reviewed power budget, backfeed protection, decoupling, boot straps, and reset-state behavior.
10. A signed hardware configuration/truth table that can replace the unresolved names in `firmware/include/hardware_config.h`.

Only after this evidence is reviewed should a later phase add peripheral initialization or drive any GPIO.
