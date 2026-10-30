# PurainaMart

Customer storefront, Admin operations and Rider delivery application using MongoDB as the only runtime data store. New orders use Cash on Delivery (COD). The server does not seed data, automatically import files or offer online payments.

## Local setup

Use Node.js 24.7 or newer within the Node 24 release line and npm. Supply your own non-production MongoDB replica set or sharded cluster; a standalone MongoDB server cannot execute checkout transactions. The URI must explicitly select the **purainamart** database. Startup pings MongoDB, verifies topology and installs the collection validators and indexes, so the database identity needs permissions for these operations as well as application reads and writes.

PowerShell:

```powershell
Set-Location 'C:\Users\Nishant Jaiswal\Documents\blnkk'
node --version
npm ci
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
node scripts/hash-password.mjs
```

Edit your private .env with your own values:

```dotenv
MONGODB_URI=mongodb://<your-host>:<your-port>/purainamart?replicaSet=<your-replica-set>
NODE_ENV=development
PORT=4173
DEV_HOST=127.0.0.1
ADMIN_PHONE=<your-10-digit-admin-mobile>
ADMIN_PASSWORD_HASH=<hash-from-the-interactive-helper>
ADMIN_NAME=Administrator
```

For an SRV deployment use your provider's connection string with /purainamart explicitly included; keep its credentials in .env. Retain provider-required authentication and TLS options. Do not point local testing at production. The hash helper reads your password interactively; do not paste secrets into shell command arguments or chat.

```powershell
npm run check
npm test
npm run build
npm start
```

Open [Customer](http://127.0.0.1:4173/), [Admin](http://127.0.0.1:4173/admin) or [Rider](http://127.0.0.1:4173/rider). Stop with Ctrl+C. Missing MONGODB_URI fails before a listener is opened. An unavailable database fails startup without a fallback. Production mode additionally requires Admin credentials and should be served through HTTPS.

An empty database has no products, delivery areas or riders. Sign in to Admin, create categories/products and delivery areas, create an authenticated rider, and select that rider in dispatch settings. Customers register with a phone number and password, then save an address in an enabled delivery area. Phone registration does not verify phone ownership: no SMS/OTP provider or fixed OTP login is configured.

## Order and inventory workflow

Orders start at **Order received** in every mode. Admin moves an order to **Being packed**, then **Ready for pickup**. The designated online rider can accept it; Admin can assign an eligible ready order. The rider records pickup, out-for-delivery, COD collection and delivery. COD remains unpaid until the collection action records the server-calculated amount. Customer cancellation is allowed before rider acceptance. Later cancellation records reconciliation requirements where appropriate.

Products can use a legacy single price, packed variants or loose quantity tiers. Configure selling price, optional verified MRP, measurement unit, stock and availability explicitly. Packed stock uses pack counts; loose stock uses g or ml. Both the shared product stock and the selected tier's stock limit apply. Custom loose quantities consume shared stock and use the current price per kg/litre, rounded to paise. Order item/address/area/price snapshots preserve checkout values. Editing a price cannot replenish stock; changing options needed to restore a pending order is blocked.

Coupons support fixed amounts, percentages, delivery discounts, expiry, global/customer limits and individual assignments. Referral campaigns support coupons or free-product rewards, qualifying delivered orders, expiry and redemption limits. Campaigns start paused. Configure the public origin in Admin before sharing referral links.

## Pages and build

Direct customer routes: /, /cart, /account, /referral, /orders, /checkout, /categories, /categories/:id, /products/:id, /orders/:id, /rewards/:id/checkout, /search?q=..., /wishlist, /offers and /notifications. Nested refresh and browser Back/Forward use the same application. Protected routes request sign-in and hydrate after login.

The frontend uses native HTML/CSS/ES modules. The production build validates JavaScript and HTML asset references, copies static assets to dist/public, and writes dist/frontend-manifest.json with hashes. Local npm start serves public directly. This build does not bundle external optional SDKs or change server routing.

## Optional integrations

- Google sign-in: configure GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET for a Google OAuth web client and allow the exact browser origin. Password login remains available without Google. OAuth code exchange runs outside retryable database callbacks. No live Google exchange was performed in this audit.
- Images: local /assets/ images remain supported. CLOUDINARY_URL enables signed browser uploads. Never put this secret into static JavaScript.
- Notifications: in-app history works without Firebase. Web push requires FCM_PROJECT_ID, the FCM_WEB_* fields in .env.example and backend Application Default Credentials. Use HTTPS (localhost is permitted), the exact PUBLIC_APP_ORIGIN, and explicitly enable notifications in each signed-in browser. GOOGLE_APPLICATION_CREDENTIALS, if used, should point to a private service-account file outside the repository. No SQL migration is part of setup.

The bounded notification worker uses durable outbox jobs, per-device delivery logs and retries, and sends only after database commit. Provider acceptance does not prove display/read receipt. A process crash after provider acceptance but before logging can cause a duplicate push; exactly-once external delivery is not promised. Native Android/Capacitor push is not implemented.

## Optional legacy JSON import

Runtime never reads data/store.json. The separate importer is opt-in and defaults to a dry run that performs no database connection:

```powershell
npm run db:mongodb:dry-run -- --file=<path-to-reviewed-legacy-json>
```

Review counts and blockers, select authoritative data, and back up your target first. Dry runs omit sessions/challenges, normalize blank unique identifiers, validate required fields/types/unique keys, flag non-COD historical orders and block suspected demo products. Historical orders and snapshots retain their original payment metadata. Only after your review, an explicit import command is:

```powershell
npm run db:mongodb:import -- --file=<path-to-reviewed-legacy-json> --confirm-target=purainamart
```

Import uses one transaction with insert-only upserts; it never replaces existing documents. Conflicts with target unique keys abort it. It is intended for a reviewed legacy store small enough for one transaction. No import or real MongoDB connection was performed during this audit. Preserved originals remain under tmp/migration-originals.

## Verification and limits

See [MONGODB-MIGRATION-AUDIT.md](MONGODB-MIGRATION-AUDIT.md) for the final architecture, feature/route coverage and exact check results. Tests use synthetic in-process MongoDB doubles and local HTTP fixtures. They do not validate real database concurrency, transactions, durability or a live COD workflow. Supply your own instance and perform those checks before operational use. Backups, monitoring, restore drills, load testing and external-provider delivery are environment-specific and are not configured by this repository.

## Asset provenance

The following records describe earlier visual research and asset choices, not verification of the current backend:

## Rider package evidence and limits

The supplied `com.zepto.rider_26.10.0.xapk` was inspected with REA. It contains `com.zepto.rider.apk`, arm64-v8a, English, and mdpi splits, plus its manifest and icon; no OBB was present. Package metadata identifies `com.zepto.rider`, version `26.10.0` (code `334`), min SDK 26, and target SDK 36. The base inventory and extracted files were complete and reported no integrity contradictions. No executable code was copied into this project. The focused asset pass below reused selected visual files at the user's direction.

Static Hermes bundle names indicate React Native features related to OTP/onboarding, rider check-in/out and shifts, order scanning and bin/pickup handover, delivery updates, earnings, profile documents/selfie verification, support/chat, and SOS. These are bundle indications, not verified runtime screens or exact service rules: the APK was not run, APKTool was unavailable, and JADX was not configured (`REA_JADX_MCP_JAR` was unset). The independent recreation therefore implements only the shared order and basic rider flows described above; other indicated features remain unimplemented or simulated.

## Rider visual assets

The focused asset pass used REA to inventory and safely extract the supplied XAPK and its base and mdpi APKs. The Rider UI reuses the package's `icon.png` as the brand image; its base APK's `assets/fonts/TT Norms Pro Normal.ttf`, `TT Norms Pro Medium.ttf`, and `TT Norms Pro DemiBold.ttf`; and the mdpi split's `feed_active.png`, `feed_inactive.png`, `new_task_active.png`, and `bar_chart_active.png` for Home, Orders, and Earnings navigation. These files are under `public/assets/rider/` and retain their original proportions and colors.

The available image/font inventory did not provide a matching Rider profile, location, refresh, back, or empty-state icon set, nor a separate horizontal wordmark suitable for the header. The package's small splash background and unrelated/library icons were not reused. The header/auth logo uses the original square app icon; profile, location, refresh/back, and empty-state symbols use independent inline SVG substitutes. No asset was found or used for additional unimplemented rider screens.

## Reverse engineering evidence and limits

The supplied XAPK was inspected with REA. XAPK SHA-256: `a78f82440fb173b262c796e544caee5b80a2424fded41aff841eace19898ab45`.

- REA found a valid ZIP/XAPK container and 12 embedded APK entries: the base package, ABI splits, density splits, and dynamic Chucker/performance-overlay modules. No top-level OBB was present. The container inventory was complete for central-directory entries; it does not represent non-entry bytes.
- The base APK inventory included the binary Android manifest, `resources.arsc`, five DEX files, and a 15.8 MB Hermes React Native bundle. Base package metadata identifies `com.zeptoconsumerapp`, version `26.9.2` (version code `756`), min SDK 24, target SDK 35. Extracted APK contents were kept outside this project; original package assets and code were not copied into the recreation.
- Bundle string evidence and package resources support the presence of shopping, search, cart, coupon, address, authentication, payment, order, and tracking concepts. Static strings do not establish every screen or workflow, and some strings may come from dependencies. The original package could not be run here for runtime observation.
- Wishlist-related strings indicated a saved-products feature, but the original persistence, guest behavior, and screens could not be confirmed. This app's heart controls, dedicated page, and guest-to-account merge are implementation decisions for the local demo.
- REA's Android decompilation capability was unavailable because `REA_JADX_MCP_JAR` was not configured with a caller-supplied `jadx-headless-mcp 0.7.1` JAR. No JADX, APKTool, ADB, emulator, or Android SDK command was available locally. The Hermes bundle is bytecode; no decompilation was performed. The inspected XAPK and split APK inventories were integrity-clean, but this is not a signature/provenance attestation.
- Therefore this recreation implements evidence-supported observable concepts, with clearly labeled local demo behavior where the package's server-side behavior and runtime UI could not be verified. It is not a pixel-perfect or service-compatible clone.

Useful REA evidence IDs from the analysis session:

- XAPK inventory: `ev_32e1bdf27a4ae1f8eb27abf7836e457f18e18d264cef9bc9078126cb5bc57481`
- Base APK inventory: `ev_69a3c77738d5c0e72563cea1ad168663cdc9ce5712b3591d1d0c91be331fdc45`
- Base APK extracted contents: `ev_ead21b58f5cfc132fdf0e31484fa16517d4d290a7a245556777532bb42b694b5`
