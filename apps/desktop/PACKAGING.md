# Windows deployment

Build the Electron production assets and per-user NSIS installer with
`npm run dist:win --workspace @dental-inventory/desktop` on the development
machine. The installer and unpacked application are written to
`apps/desktop/dist/`. The clinic computer needs neither Node.js nor the
development toolchain. This package is unsigned until a clinic code-signing
certificate is supplied; Windows may show an untrusted-publisher warning.

The visible product and executable name are **Any Time Dental Inventory
System** (version `0.1.0`, app ID `com.anytimedental.inventorysystem`). The
installer creates Start Menu and desktop shortcuts for the current user and
does not automatically launch the application after installation. The branded
Windows application and installer icon is `build/icon.ico`.

## Existing clinic data

The branded app deliberately retains the legacy per-user storage root:

`%APPDATA%\Dental Inventory System\`

SQLite stays at `data\inventory.db` below that root, with WAL/SHM sidecars
managed by SQLite. Product images stay under `data\product-images\`. The
installer does not bundle, move, overwrite, or delete these files. Ordinary
updates preserve this directory. On a new profile, the app creates this same
legacy-named directory before opening the database. Do not copy only `inventory.db` while the
application is running; a live WAL database must be backed up using SQLite's
backup mechanism or after a clean application shutdown. No file-based log or
preferences directory is currently configured.

On a fresh database, there is no default login account. The first launch shows
administrator setup; the operator creates a username and password (at least
8 characters), then signs in normally. The password is stored using the
existing salted scrypt hash. Once an administrator exists, setup is unavailable
and subsequent launches show only the normal sign-in screen. Installing on a
different Windows account does not copy credentials from the development PC.

## Device connection on the clinic PC

1. Install and launch the application.
2. On a fresh database, create the first administrator and sign in.
3. Select **Set Up Device** in the Inventory Device status card.
4. Enter the ESP32's current address, for example `http://192.168.1.105`.
   This is an example only; the ESP32 uses HTTP port 80 by default. The PC and
   ESP32 must have **different** IP addresses and a working network route.
5. Enter the private device token configured in ESP32 firmware. **Test
   Connection** checks the entered address using read-only `/health`; it does
   not validate the token or modify inventory, RTC, or MicroSD contents.
6. Select **Save**. The new gateway is used immediately without restarting.

Wi-Fi/HTTP remains the primary operational connection for inventory, RTC,
cache, and synchronization. Device Setup also offers two optional discovery
methods. With an ESP32 connected by USB, select **Refresh Ports**, choose its
Windows COM port, then **Identify Device**. A normal USB-UART driver for the
ESP32 board's USB bridge must be available in Windows; the app does not install
board-specific drivers. Close any PlatformIO/Arduino serial monitor before
identifying. Opening a COM port may reset some ESP32 boards; the bounded
handshake retries while it boots.

On a Windows PC with an enabled Bluetooth LE adapter, **Scan for Inventory
Device** lists matching BLE devices and lets the operator select one. BLE
reads only the device's non-secret identity and current Wi-Fi IPv4 address;
it is not an inventory transport. Either method's **Use This Address** button
only fills the unsaved address field. The operator must still enter the private
Device Token separately, use **Test Connection**, and select **Save**. If the
device has no Wi-Fi connection, discovery shows no usable IP and does not fill
one. Neither USB nor BLE reveals the token, Wi-Fi password, credentials, or
inventory data. No Node.js, npm, Python, PlatformIO, or Arduino IDE is needed
on the clinic PC.

The address and an Electron `safeStorage`-encrypted token are saved under the
current user's `%APPDATA%\Dental Inventory System\device-configuration.json`,
separate from `data\inventory.db`. If secure storage is unavailable, saving
fails rather than writing a plaintext token. Reopening Device Setup shows
whether a token is configured, never its value; leave the token field blank to
keep a previously saved token, or enter a replacement.

An explicitly saved in-app configuration takes precedence over the legacy
`DENTAL_ESP32_BASE_URL` and `DENTAL_DEVICE_TOKEN` environment variables. When
no in-app file exists, valid environment settings are used as a development
fallback. When neither provides an address, the device card says **Not
configured**. A saved secret that cannot be decrypted fails closed and is not
silently replaced by an environment token. Neither real values nor `.env.local`
are included in the installer; normal clinic deployment does not require
Windows environment variables.

The packaged renderer loads from `out/renderer/index.html`, not a Vite server.
Only production assets under `out/`, package metadata, and required runtime
dependencies are packaged; firmware, tests, source documents, local databases,
and temporary diagnostics are excluded.
