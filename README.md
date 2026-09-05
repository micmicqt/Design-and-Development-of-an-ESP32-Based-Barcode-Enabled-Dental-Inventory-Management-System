# Dental Inventory System

Phase 5 Step 2 implementation for the capstone **Design and Development of an ESP32-Based Barcode-Enabled Dental Inventory Management System**.

This repository currently provides:

- a secure Electron + React + TypeScript desktop inventory application;
- SQLite-backed product inventory, stock corrections, and movement history;
- application-managed product images stored as files beside the database;
- search, fixed-category filtering, derived stock status, safe editing, and soft deletion;
- SQLite migrations and one preconfigured-administrator credential slot;
- shared, versioned TypeScript protocol types and JSON Schema validation;
- a local-network ESP32 `HardwareGateway` with status, FIFO scan delivery, and acknowledgement;
- atomic online RESTOCK/CHECKOUT persistence with durable event idempotency; and
- the verified ESP32 PlatformIO hardware integration from Phases 3 and 4.

ESP32 result feedback, database-driven stock LEDs/LCD messages, offline operation,
and synchronization remain outside this step. Manual barcode entry remains
available for item registration; physical scans use the hardware event path.

## Repository layout

```text
apps/desktop/       Electron main/preload processes and React renderer
packages/protocol/  Shared protocol types, JSON Schema, and validator
firmware/           ESP32 PlatformIO project (hardware disabled)
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
5. Use **MOVEMENT HISTORY** to review persisted stock corrections newest first. **SYNC OFFLINE** remains inactive in Phase 2.
6. Select **Logout** to return to the login screen.

React communicates only through narrow authentication, inventory, and hardware-status methods exposed by the preload. It cannot access SQLite, Node.js, the filesystem, generic Electron APIs, or hardware sockets directly.

### Local ESP32 status connection

Phase 5 Step 2 completes the online desktop transaction: an exact barcode match
and confirmed quantity are applied to stock and movement history in one SQLite
transaction, then—and only then—the ESP32 event is acknowledged. A durable event
receipt makes retries safe after an acknowledgement failure or desktop restart.
See [the atomic transaction guide](docs/phase5-step2-atomic-transactions.md).
The earlier [Step 1 guide](docs/phase5-step1-quantity-workflow.md) remains useful
background for lookup, validation, deferred review, and unknown-scan behavior.

Phase 4 Step 3 adds temporary hardware scan delivery over this same gateway. See
[the event delivery contract and verification guide](docs/phase4-step3-event-delivery.md)
for the current firmware/desktop behavior and RAM-queue limitations. Earlier phase
descriptions below are historical; this guide describes the active Step 3 firmware.

For local development, copy `apps/desktop/.env.example` to `apps/desktop/.env.local` and replace the example address with the ESP32's current LAN address:

```env
DENTAL_ESP32_BASE_URL=http://192.168.1.100
```

The local file is ignored by Git because the address can change with DHCP. Electron main—not React—uses this URL to call the ESP32 `/health` and `/status` endpoints. Status requests time out after 2.5 seconds and appear as **Offline** without interrupting inventory features. No Wi-Fi credential or device token is stored in the desktop configuration.

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
