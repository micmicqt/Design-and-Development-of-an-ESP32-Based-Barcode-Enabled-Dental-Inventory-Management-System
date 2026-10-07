# Design and Development of an ESP32-Based Barcode-Enabled Dental Inventory Management System

Phase 7 safe, exactly-once offline synchronization for the capstone **Design and Development of an ESP32-Based Barcode-Enabled Dental Inventory Management System**.

## Current integrated architecture

The **ATmega328P main controller** owns the GM65 scanner, RESTOCK/CHECKOUT
buttons, 20x4 I2C LCD, DS3231 RTC, encoded status outputs, and MicroSD SPI.
The **ESP32 connectivity bridge** provides optional Wi-Fi STA plus the local
`Design` access point, HTTP API, controller transport, online/offline routing,
and the remote-sector FatFs/cache/journal layer. The **Electron + React +
TypeScript desktop application** owns authoritative SQLite inventory/history
and exactly-once reconciliation.

The system supports online quantity-confirmed transactions, durable one-unit
offline transactions, barcode registration, stock feedback, device setup, and
oldest-first pending synchronization followed by authoritative cache publication.
See [the current storage guide](docs/atmega-step5-storage-migration.md),
[identity and feedback notes](docs/offline-event-identity-and-feedback.md), and
[Windows packaging guide](apps/desktop/PACKAGING.md). Earlier phase-specific
instructions below are historical where superseded by these current guides.

Fresh installations create the first administrator through the application's
first-run setup. No default account, developer database, or credentials are
bundled. Existing accounts and AppData storage remain unchanged. The credential
CLI below is an optional development/maintenance tool, not a clinic deployment
prerequisite.

Before building ESP32 firmware, copy `firmware/include/secrets.example.h` to the
ignored `firmware/include/secrets.h` and configure deployment-local values.
`DENTAL_AP_PASSWORD` supplies the hotspot password; the SSID remains `Design`.
Never publish that file, local `.env` files, device settings, or database copies.

This repository currently provides:

- a secure Electron + React + TypeScript desktop inventory application;
- SQLite-backed product inventory, stock corrections, and movement history;
- application-managed product images stored as files beside the database;
- search, fixed-category filtering, fixed product unit types, derived stock status,
  safe editing, and soft deletion;
- SQLite migrations and one preconfigured-administrator credential slot;
- shared, versioned TypeScript protocol types and JSON Schema validation;
- a local-network ESP32 `HardwareGateway` with status, FIFO scan delivery, result feedback, and acknowledgement;
- atomic online RESTOCK/CHECKOUT persistence with durable event and delivery-state idempotency;
- the verified ESP32 PlatformIO hardware integration from Phases 3 and 4;
- a renewable desktop-presence heartbeat that is separate from Wi-Fi connectivity;
- a bounded, durable MicroSD snapshot of authoritative active inventory;
- fixed-quantity offline RESTOCK/CHECKOUT with a durable pending journal that
  has been physically verified across ESP32 reset and complete power loss; and
- bounded, oldest-first offline synchronization with exactly-once SQLite
  reconciliation, power-safe ESP32 retirement, and a final authoritative cache refresh.

Committed online results drive the kiosk LCD plus SUCCESS and stock-status
indicators before the ESP32 event is acknowledged. When the authenticated
desktop-presence lease is unavailable, the ESP32 can instead apply one-unit
RESTOCK/CHECKOUT operations against its last-known inventory snapshot and append
them to a durable pending journal. Phase 7 applies each oldest record to current
SQLite stock exactly once, acknowledges and retires it power-safely, then
refreshes the kiosk from final authoritative inventory. Item registration now
supports a dedicated scan-first barcode capture flow with manual fallback. That
authenticated capture path only returns exact barcode text (including leading
zeroes); it cannot select RESTOCK/CHECKOUT, change stock, write movement history,
or create an offline pending event.

## Repository layout

```text
apps/desktop/       Electron main/preload processes and React renderer
packages/protocol/  Shared protocol types, JSON Schema, and validator
firmware/           ESP32 PlatformIO firmware and host-native protocol tests
firmware-atmega/    Bare-metal Uno/ATmega main-controller firmware and tests
docs/               Hardware validation gate and unresolved questions
```

The root uses npm workspaces. Generated output, runtime databases, local images, PlatformIO downloads, and secrets are excluded by `.gitignore`.

## Prerequisites

- Windows 10 or Windows 11
- Node.js 22.12 or newer; Node.js 24 LTS is recommended
- npm supplied with Node.js
- Git
- Python 3.9 or newer with `pip` (only needed to install PlatformIO Core)
- PlatformIO Core 6.1.19 for firmware compilation

The pinned `better-sqlite3` release includes its Windows native binaries and does not require Visual Studio Build Tools for a normal install.

Confirm the JavaScript toolchain:

```powershell
node --version
npm --version
```

## Install

From the repository root:

```powershell
npm install
```

Do not place an administrator password or future device token in source files.

## First development administrator

The schema permits exactly one administrator record. No account or password is created by migration; the credential CLI defaults the username to `admin`. A chosen password is hashed with Node's `scrypt` in the Electron main-process code before it is stored.

For a workspace-local development database:

```powershell
New-Item -ItemType Directory -Force .runtime | Out-Null
$env:DENTAL_DATABASE_PATH = Join-Path (Resolve-Path .runtime) 'inventory.db'
$securePassword = Read-Host 'Choose the administrator password' -AsSecureString
$credential = [System.Management.Automation.PSCredential]::new('admin', $securePassword)
$env:DENTAL_ADMIN_PASSWORD = $credential.GetNetworkCredential().Password
npm run admin:credentials --workspace "@dental-inventory/desktop" -- init --db "$env:DENTAL_DATABASE_PATH" --username admin
Remove-Item Env:DENTAL_ADMIN_PASSWORD
```

The password must contain at least eight characters. Keep `DENTAL_DATABASE_PATH` set in the terminal used to start the development application.

To replace the configured credential, repeat the command with `reset`:

```powershell
$securePassword = Read-Host 'Choose the replacement password' -AsSecureString
$credential = [System.Management.Automation.PSCredential]::new('admin', $securePassword)
$env:DENTAL_ADMIN_PASSWORD = $credential.GetNetworkCredential().Password
npm run admin:credentials --workspace "@dental-inventory/desktop" -- reset --db "$env:DENTAL_DATABASE_PATH" --username admin
Remove-Item Env:DENTAL_ADMIN_PASSWORD
```

The CLI deliberately refuses password command-line arguments so a password is not copied into shell history.

For the normal Windows application database, initialize the administrator before starting the app for the first time:

```powershell
$productionDatabase = Join-Path $env:APPDATA 'Dental Inventory System\data\inventory.db'
$securePassword = Read-Host 'Choose the administrator password' -AsSecureString
$credential = [System.Management.Automation.PSCredential]::new('admin', $securePassword)
$env:DENTAL_ADMIN_PASSWORD = $credential.GetNetworkCredential().Password
npm run admin:credentials --workspace "@dental-inventory/desktop" -- init --db "$productionDatabase" --username admin
Remove-Item Env:DENTAL_ADMIN_PASSWORD
```

Use the same command with `reset` to replace that credential. Close the desktop application first so the maintenance operation has exclusive ownership of the database.

## Run the Phase 2 Windows desktop application

In the same PowerShell terminal where `DENTAL_DATABASE_PATH` is set:

```powershell
npm run dev
```

Then:

1. Sign in as `admin` with the password chosen during initialization.
2. Invalid credentials display exactly `Access Denied`.
3. Use **ADD NEW ITEM** to register a product. Barcode text retains leading zeroes, the category must be one of the six fixed choices, and stock values must be non-negative integers.
4. Use **ITEM INVENTORY** to search by name or barcode, filter by category, and edit or safely delete products. A manual stock change creates a permanent `STOCK_CORRECTION` movement.
5. Use **MOVEMENT HISTORY** to review persisted stock corrections newest first. **SYNC OFFLINE** processes pending kiosk transactions sequentially and reports completion only after device retirement and authoritative cache refresh.
6. Select **Logout** to return to the login screen.

React communicates only through narrow authentication, inventory, hardware-status, pending-event inspection, and parameter-free synchronization methods exposed by the preload. It cannot provide reconciliation event data or access SQLite, Node.js, the filesystem, generic Electron APIs, or hardware sockets directly.

### Local ESP32 status connection

During the incremental ATmega migration, Step 5 makes the ATmega the physical
MicroSD SPI owner on D10-D13 while the ESP32 retains the proven FAT/file and
desktop protocol layers over a bounded sector bridge. Existing cache, journal,
timestamp, idempotency, and synchronization semantics remain unchanged. See
[the ATmega Step 5 storage guide](docs/atmega-step5-storage-migration.md).

Phase 7 Step 3 drains the durable journal one event at a time. Each event is
atomically reconciled (or recognized by its Step 7.2 receipt) before Electron
acknowledges that exact firmware FIFO head. Durable cursor-based retirement is
safe across retry and reboot. After the pending count reaches zero, Electron
installs a fresh authoritative SQLite cache; only then does the UI report
**Sync Complete**. See [the synchronization completion guide](docs/phase7-step3-offline-sync-completion.md)
and [the SQLite reconciliation guide](docs/phase7-step2-sqlite-reconciliation.md).
The underlying non-destructive transport remains documented in
[the Step 7.1 guide](docs/phase7-step1-offline-sync-transport.md).

Phase 6 Step 2B freezes each accepted scan as either ONLINE or OFFLINE based on
the desktop-presence lease. The existing online FIFO and quantity workflow are
unchanged. Offline scans use exact barcode text, derive stock from the immutable
`/inventory_cache.csv` snapshot plus prior valid `/pending_sync.csv` deltas, and
append one durable `+1` RESTOCK or `-1` CHECKOUT record without touching SQLite.
Firmware blocks cache-generation replacement while pending rows exist, and
`/status` can report `pendingSyncItems` and `offlineReady` without breaking
older desktop clients. Phase 7 synchronization is not part of this step. See
[the offline transaction guide](docs/phase6-step2b-offline-transactions.md).

Phase 6 Step 3 physically verified that the cache, journal count, effective
stock, and monotonic offline event sequence recover after both EN/RESET and a
complete power cycle. See
[the power-loss recovery record](docs/phase6-step3-power-loss-recovery.md).

Phase 6 Step 2A builds an active-product snapshot from authoritative SQLite data
and installs it on MicroSD through bounded `begin` → one-item → `commit`
requests. Refreshes occur after initial authenticated availability and inventory
changes, not on every heartbeat. Temporary-file validation and backup recovery
preserve the previous valid cache after an incomplete or failed replacement.
This adds no offline transaction or synchronization behavior. The firmware HTTP
route is trusted-local-LAN only and must not be exposed to the public Internet.
See [the offline inventory-cache guide](docs/phase6-step2a-offline-inventory-cache.md).

Phase 6 Step 1 adds an authenticated, backend-only desktop heartbeat. While the
authenticated application shell is active, Electron immediately posts to the
fixed `/desktop/heartbeat` route and renews it about every four seconds. The
ESP32 treats the desktop as available for a 12-second lease, clears that state
on lease expiry or Wi-Fi loss, and waits for a new heartbeat after reconnect.
This detection does not yet enable offline stock processing or synchronization.
See [the desktop-presence guide](docs/phase6-step1-desktop-presence.md).

Phase 5 Step 3 completes online result feedback: after the existing atomic SQLite
commit, Electron sends the committed quantity, stock, and status to the matching
ESP32 event. The kiosk accepts identical retries safely, updates its LCD and LED
logic, and only then is the event acknowledged. Migration 4 durably distinguishes
result-delivery retry from acknowledgement-only recovery after a desktop restart.
See [the online result-feedback guide](docs/phase5-step3-online-feedback.md).
The [Step 2 atomic transaction guide](docs/phase5-step2-atomic-transactions.md)
documents the underlying stock, history, and event-receipt transaction.
The earlier [Step 1 guide](docs/phase5-step1-quantity-workflow.md) remains useful
background for lookup, validation, deferred review, and unknown-scan behavior.

Phase 4 Step 3 adds temporary hardware scan delivery over this same gateway. See
[the event delivery contract and verification guide](docs/phase4-step3-event-delivery.md)
for the current firmware/desktop behavior and RAM-queue limitations. Earlier phase
descriptions below are historical; this guide describes the active Step 3 firmware.

For local development, copy `apps/desktop/.env.example` to `apps/desktop/.env.local` and replace the example address with the ESP32's current LAN address:

```env
DENTAL_ESP32_BASE_URL=http://192.168.1.100
DENTAL_DEVICE_TOKEN=replace-with-the-same-random-token-as-firmware
```

The local file is ignored by Git because it contains deployment-local settings.
Electron main—not React—uses this URL only through the fixed status, presence,
event, cache, and RTC-recovery routes. The device token must match
`DENTAL_DEVICE_TOKEN` in the ignored `firmware/include/secrets.h`; it is used only
by Electron main to authenticate the dedicated RTC synchronization request and
is never exposed through preload or React. Status requests time out after 2.5
seconds and appear as **Offline** without interrupting inventory features.

When firmware detects a DS3231 oscillator-stop/lost-power condition, it reports
`needs_sync` and blocks timestamped transactions. The next authenticated desktop
heartbeat causes Electron main to send its system time and UTC offset. Firmware
writes and rereads the RTC, verifies that the oscillator-stop flag cleared, and
only then reports the RTC ready. Healthy retained time is never rewritten during
normal heartbeats.

## Product images

The native image picker accepts PNG, JPG/JPEG, and WEBP files. A selected image is previewed in the renderer through a short-lived opaque token; when the product is saved, Electron copies it under:

```text
<database directory>/product-images/
```

The database stores only an application-managed relative path. Generated filenames are collision-safe, missing files render a placeholder, and replacing or deleting a product removes its obsolete managed image on a best-effort basis. Development databases therefore keep their images under `.runtime/product-images/`; normal Windows installations use `%APPDATA%\Dental Inventory System\data\product-images\`.

## Database location and migrations

Packaged/normal execution stores SQLite at:

```text
<Electron userData>/data/inventory.db
```

On Windows this is normally:

```text
%APPDATA%\Dental Inventory System\data\inventory.db
```

Development may override the file with `DENTAL_DATABASE_PATH`, as shown above. Migrations run automatically whenever the writable database is opened. Migration 1 creates:

- `schema_migrations`
- `configured_admin`
- `products`
- `transactions`

Product status is derived by code and is not persisted.

Migration 2 adds soft deletion to `products` and safely rebuilds `transactions` to permit `STOCK_CORRECTION`. Product barcodes remain immutable through normal editing and unique across active and retired rows. Transaction rows retain barcode, item-name, and category snapshots, so movement history remains readable after a product is retired.

Migration 3 adds `processed_hardware_events`, a minimal durable link from an
ESP32 `eventId` to its committed movement and resulting status. This is the
database-level idempotency guard for online hardware transactions.

Migration 4 adds the nullable `result_delivered_at` boundary to that receipt.
It is set only after the ESP32 accepts the committed result, allowing a restart
to retry result delivery when null and perform acknowledgement only when set.

Migration 5 adds `offline_reconciliation_receipts`, keyed by the durable
offline event ID and linked to its immutable `OFFLINE` movement. It retains the
exact device audit fields for replay-conflict detection while SQLite
`previous_stock`, `new_total`, and derived status remain authoritative.

## Desktop checks and production bundle

Run all Phase 2 JavaScript checks from the root:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

`npm run build` builds the shared protocol first and then creates Electron main, preload, and renderer bundles under `apps/desktop/out`. To open the built bundle for a local check:

```powershell
npm run preview --workspace "@dental-inventory/desktop"
```

Creating a Windows installer is deferred; Phase 2 produces a runnable Electron development/preview application and production bundles.

## ESP32 firmware compilation

Install PlatformIO Core if `pio --version` is unavailable. If Python's scripts directory is not on `PATH`, use `py -m platformio` in place of `pio` in the commands below:

```powershell
py -m pip install --user "platformio==6.1.19"
```

Compile without flashing:

```powershell
pio run --project-dir firmware
```

or through the root npm helper:

```powershell
npm run firmware:build
```

The project pins `platformio/espressif32@7.0.1` in `firmware/platformio.ini`; PlatformIO resolves that platform's compatible ESP32 Arduino framework and compiler packages during the first compile.

On Windows, keep PlatformIO's core/toolchain directory on an ASCII-only path. The default `%USERPROFILE%\.platformio` path works when the Windows profile path contains only ASCII characters. If it does not, set `PLATFORMIO_CORE_DIR` to another writable ASCII-only directory before installing the platform and compiling; the legacy Xtensa compiler cannot reliably open framework source paths containing non-ASCII characters.

Do **not** upload this Phase 1 image to the assembled PCB as a hardware test. Its only runtime behavior is UART0 development logging:

```text
Dental Inventory ESP32 firmware 0.1.0-phase1
Protocol version: 1
Hardware activation disabled pending verification.
```

The scanner must be physically disconnected if this Serial-only build is ever run on a development board because UART0 GPIO1/GPIO3 are also the unresolved scanner nets in the schematic.

## Shared device token

Phase 1 implements no Wi-Fi transport. Future ESP32/desktop communication will use a configurable shared token carried in `X-Device-Token`; it must remain in Electron main-process configuration and the firmware's ignored `secrets.h`, never React source. `firmware/include/secrets.example.h` contains placeholders only.

## Hardware safety restrictions

Phase 1 does not call `pinMode`, `digitalRead`, `digitalWrite`, or initialize the barcode scanner, switches, LED logic, RTC, LCD, MicroSD, or Wi-Fi. GPIO constants document schematic nets only.

The following remain unresolved and block physical activation:

- scanner TX/RX direction and UART0/USB contention;
- unsafe/unverified SW1/SW2 voltage, pull configuration, active level, and RESTOCK/CHECKOUT meaning;
- D1/D2 SUCCESS/ERROR mapping;
- D3/D4/D5 HIGH/LOW/EMPTY mapping;
- I2C pull-up voltage and module addresses;
- MicroSD module voltage/level shifting and GPIO5 boot behavior;
- ESP32 GPIO12 boot-strapping risk, power budget, decoupling, and PCB/netlist verification.

See [docs/hardware-validation.md](docs/hardware-validation.md) for the evidence required before Phase 2 hardware work.
