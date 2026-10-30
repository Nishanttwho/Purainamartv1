# PurainaMart — final MongoDB migration audit

Audit date: 2026-10-30. Work continued in the existing local working tree. No reset, commit, push, deployment, Docker, database provisioning, import or real MongoDB connection was performed. All database-backed execution below used synthetic test doubles. All 60 files in `tmp/migration-originals` still match their saved SHA-256 hashes.

## A. Architecture

`server.mjs` starts `lib/http-server.mjs` and `lib/application.mjs` after `lib/mongodb.mjs` initializes MongoDB. MongoDB is the only runtime persistence source. No handler loads the legacy JSON store or chooses an alternative database. Test injection is explicit; the production entrypoint defaults to the real MongoDB driver and refuses missing configuration.

One shared MongoClient connects to the explicitly selected `purainamart` database. The pool is bounded at 20 connections, with connection/server-selection/socket timeouts. Startup pings, checks for a replica set or sharded cluster, installs strict validators and creates indexes before opening HTTP. Missing configuration and connection failures fail closed. Shutdown stops HTTP, waits for active notification work and closes MongoDB; concurrent initialization/shutdown and HTTP bind failure have mock coverage.

The centralized definitions contain **28 collections and 65 explicit indexes**, in addition to MongoDB's default `_id` indexes:

| Area | Collections | Principal indexes |
|---|---|---|
| Identity | users, admins, riders, sessions, authAttempts | Unique IDs; customer phone/email/Google subject/referral code; rider phone; session kind/token hash and owner; session and throttle expiry TTL |
| Catalogue | products, categories, deliveryAreas | Unique IDs; category/active/rank; product text index; category parent/position |
| Shopping | carts, wishlists, addresses, shoppingPreferences | Unique owner; cart product lookup; unique customer/address; address delivery area |
| Commerce | orders, coupons, couponRedemptions | Unique order ID and customer/idempotency key; customer/date, customer/coupon, rider/status and dispatch; unique coupon code; coupon owner/active; redemption order and customer history |
| Referrals | referrals, rewards, referralEvents | Unique referred customer, unique qualifying-order reward; referrer/time, qualifying order, reward owner/status and event time |
| Notifications | notifications, riderNotifications, notificationOutbox, notificationPreferences, notificationDevices, notificationEvents, notificationCampaigns, notificationDeliveryLogs | Owner/history/unread; unique event/outbox job; pending and expired claims; unique preference owner and device installation; campaign schedule; event/device and campaign delivery logs |
| Operations | settings, adminAuditLog | Unique setting key and audit ID; customer/audit time |

`MongoRepository` tracks explicitly queried documents within each request/transaction using AsyncLocalStorage. It writes changed top-level fields, not whole-store snapshots. Read memoization exists only within an individual GET request, and repeated Admin customer summaries are reused within that request. Lists use bounded database pages; frontend pagination preserves existing list/filter screens. Addresses, wishlist selections, delivery metadata and eligible coupon lists traverse internal pages instead of silently truncating them.

Customer, authentication, Admin catalogue/operations and Rider routes dispatch to `api-customer.mjs`, `api-auth.mjs`, `api-admin-catalogue.mjs`, `api-admin.mjs` and `api-rider.mjs`. These call the Mongo repository or the same Mongo database directly. Notifications/referrals use `mongo-notifications.mjs` and `mongo-referrals.mjs`. The route-registration test covers the preserved non-OTP route inventory and dynamic route families.

Mutations use Mongo sessions with `readConcern: snapshot`, `writeConcern: majority` and primary reads. Driver transaction callbacks can retry. OAuth exchange is outside retryable callbacks; notification provider sends occur after durable fan-out commits. Password verification and other local computations may repeat on callback retry, but external sends are not executed inside it.

## B. PostgreSQL removal

PostgreSQL is no longer required at runtime, startup, build or test time. Removed dependencies: `pg`, `pg-cloudflare`, `pg-connection-string`, `pg-int8`, `pg-pool`, `pg-protocol`, `pg-types`, `pgpass`, `postgres-array`, `postgres-bytea`, `postgres-date`, `postgres-interval`, `split2` and `xtend`. The installed tree and lockfile now agree on `mongodb@7.7.0`, `firebase-admin@14.5.0` and `qrcode@1.5.4` as direct dependencies.

The existing migration's removals were retained:

- SQL files `db/migrations/001_initial_schema.sql`, `002_fcm_notifications.sql`, `003_quantity_pricing.sql`, `004_nullable_loose_product_mrp.sql`.
- `lib/postgres-config.mjs`, `postgres-store.mjs`, `postgres-test-safety.mjs`, `serial-request-queue.mjs`.
- `scripts/import-catalogue.mjs`, `import-json-store.mjs`, `migrate-postgres.mjs`.
- Obsolete PostgreSQL/config/store/integration/request-queue tests and legacy JSON-backed functional harnesses. Their active business coverage is provided by the Mongo API, audit, notification, startup, frontend and route-registration suites; backups remain intact.

README, `.env.example`, package scripts and lockfile now describe MongoDB. Two obsolete PostgreSQL test keys were also removed from ignored `.env.test`, preserving other content without displaying values. No CI configuration was present to update.

The active-source scan found only two intentional references: the dependency guard that rejects PostgreSQL packages and a configuration test that rejects a PostgreSQL URI. Neither is a runtime dependency or fallback. Historical originals and local audit artifacts retain migration history. Ignore rules for private database dumps remain protective exclusions.

## C. Functional coverage and fixes

“Verified” in this section means source inspection plus synthetic tests, not real MongoDB execution.

| Feature | Handler integration and verification |
|---|---|
| Authentication/sessions | Registration, password login/set/change, Google start/callback, three separate roles, hashed session tokens, expiry, logout and revocation use MongoDB. Normalized durable throttling, blocked accounts, initial Rider password changes and production origin checks covered. Google token verification uses synthetic keys; no live exchange. |
| Customer accounts | Profile validation, unique email checks, Admin customer details/block/unblock, audit history and customer coupon assignment remain integrated. Passwordless legacy records cannot be claimed using an arbitrary new password. |
| Products/categories | CRUD, availability, images, category edits, search, stock and quantity variants remain integrated. Used variant IDs/units cannot be removed or resized before inventory can safely be reconciled. Admin preserves variant IDs and shared stock during price-only edits. |
| Packed/loose products | Pack counts, g/ml base quantities, explicit tier prices and custom quantities are recalculated server-side. Money rounds to paise. Custom millilitres now match the quantity control; preset prices no longer get incorrectly recalculated from the per-1000 price in the UI. |
| Cart/wishlist | Guest ownership, authenticated persistence, login merge, selected variants, stale product lines, coupon cleanup and pagination covered. Invalid guest cookies are replaced. Customer coupon choice takes precedence during merge. |
| Addresses/areas | Ownership, default/selected address, named delivery-area eligibility, minimum/fee/free threshold, disabled areas and historical snapshots covered. Missing area returns a validation error. Existing address/area relations survive edits. |
| Coupons/rewards/referrals | Fixed/percentage/delivery coupons, caps/expiry/ownership, individual assignment/notification/revocation, qualifying delivery, coupon/free-product rewards, repeat redemption limits and cancellation reversal covered. Invalid attribution attempts now appear in referral event history. |
| COD checkout | Current product reads, safe integer quantities, atomic conditional shared/tier deductions, immutable order snapshots, unique idempotency, coupon/reward guards, cart version guard and post-commit notification outbox covered. Successful replay returns the original order. |
| Orders/cancellation | Order lifecycle, customer visibility, pre-acceptance cancellation, permitted Admin/Rider cancellation, one-time restocking, post-pickup inventory review and collected-cash reconciliation covered. Regular promotional coupons remain consumed after cancellation; eligible referral rewards return once. |
| Notifications | In-app preferences, ownership, campaign create/estimate/schedule/duplicate/cancel, device registration/reassignment, per-device retries, invalid installations and shutdown tested. Claimed campaigns cannot be cancelled. Overlapping worker ticks no longer lose the pending send during shutdown. |
| Rider operations | Separate credentials, online state, designated rider, ready-order inbox, acceptance/rejection/assignment, pickup/out-for-delivery/delivery, COD proof and delivery summaries covered. State transitions cannot be skipped. |
| Admin operations | Catalogue/inventory, categories, banners/hero images, delivery areas, customers/coupons, Rider credentials/dispatch, orders, referrals and notification operations use MongoDB. Responses remain usable by the existing Admin UI. |

Checkout/cancellation inspection confirmed that all related writes use the same transaction. An error during deduction, coupon/reward reservation, order insertion, notification creation or cart clearing rolls back the transaction. Conditional updates and unique keys guard stock and idempotency. The mock transaction replay test verifies callback replay leaves one committed order and one event; the mock serializes transactions and cannot establish actual MongoDB conflict/isolation behavior.

The original special Admin correction of a delivered order that issued a referral reward is retained. It marks inventory/cash or consumed rewards for review instead of fabricating a refund or return. Unsupported status transitions are rejected.

## D. Frontend verification

Browser smoke checks used a localhost HTTP fixture backed exclusively by `test/support/fake-mongo.mjs`, with notification workers disabled. Verified `/`, `/cart`, `/account`, `/referral`, `/orders`, `/checkout`, `/products/loose`, `/categories/pantry`, and the newly created `/orders/:id` route. Automated HTTP checks also cover reward checkout URLs and all portals.

Verified guest add-to-cart, refresh persistence, Back then Forward, protected orders deep link, password login, guest-cart merge, retained login on account navigation, referral page, COD-only checkout, a synthetic ₹122 order, nested order refresh, and custom 750 g cart pricing at ₹75. Admin and Rider synthetic login/dashboard rendering succeeded. Browser console inspection returned no warnings or errors during the checked flows.

Desktop/default and narrow layouts were inspected. The narrow viewport request was 390 × 844; the browser reported 487 CSS px width due to its scaling, with document scroll width 468, so this is responsive smoke coverage rather than exact physical-device certification. No design redesign was introduced. Screenshots are in `tmp/migration-audit/browser-order-desktop.png` and `browser-order-mobile.png`; they precede the final wording-only removal of the sample-order subtitle.

Duplicate bootstrap catalogue requests were removed. Router restoration now invalidates obsolete asynchronous results after new navigation, protected deep links hydrate after login, and completed checkout renders before ancillary refreshes. Customer/Admin/Rider lists retrieve subsequent database pages. Reward placement has an in-flight guard and a persistent idempotency key.

Unknown extensionless document routes retain the original home redirect. Missing assets/APIs remain 404; malformed document URLs redirect home; path traversal is forbidden. HEAD, conditional caching, nested refresh and security headers have HTTP regression coverage.

## E. Exact local results

| Check | Result |
|---|---|
| `npm test` | **118 total; 118 passed; 0 failed; 0 skipped; 0 cancelled; 0 todo** |
| `node --test 'test/mongodb*.test.mjs'` | **87 total; 87 passed; 0 failed; 0 skipped** — included in the full total, not additional tests |
| `npm run check` | **61 active JS/MJS/CJS modules** passed `node --check`; **26 backend/server imports** loaded; manifest/lockfile consistent |
| `npm run build` | **87 static files** validated/copied; SHA-256 manifest generated under `dist/` |
| `npm ls --all` and `npm ls --depth=0` | Passed; no missing/invalid dependencies or PostgreSQL packages |
| `git diff --check` | Passed; no whitespace errors. Git's LF/CRLF conversion notices are informational. |
| Preserved-original hash verification | **60 unchanged; 0 changed** |
| Browser fixture | Customer, Admin and Rider smoke checks described above; synthetic fixture stopped and browser tab closed |

The baseline had 80 tests, 79 passed and one failed. A reward-checkout fixture supplied raw product documents without a quantity; it was corrected to provide a valid order line. A coupon-limit fixture that could pass on an unrelated quantity error was also corrected and its assertion strengthened. No tests were skipped or converted into unconditional passes. New coverage replaces the obsolete persistence harnesses and tests identified regressions.

Logs and local evidence are under `tmp/migration-audit/`: `npm-test.log`, `mongodb-tests.log`, `npm-ls.log`, `reference-audit.json`, original hashes, screenshots and a preserved starting diff. Generated directories are ignored. Syntax/import checks deliberately exclude dependencies, generated build output and preserved historical originals from the active-module count. No online vulnerability/advisory audit was run, so dependency consistency is not a security-advisory result.

## F. MongoDB verification boundary

| Claim | Status |
|---|---|
| MongoDB-only code and handler integration implemented | Yes; source and mocks checked |
| Connection to a real MongoDB deployment tested | **No** |
| Validators/indexes created on a real database | **No** |
| Real MongoDB transactions, write conflicts or crash durability tested | **No** |
| Real COD checkout against MongoDB tested | **No** |
| Synthetic HTTP/COD/business transactions and browser workflow tested | Yes |

## G. Startup instructions

Use Node.js `>=24.7.0 <25`. In PowerShell:

```powershell
Set-Location 'C:\Users\Nishant Jaiswal\Documents\blnkk'
npm ci
if (-not (Test-Path -LiteralPath .env)) { Copy-Item -LiteralPath .env.example -Destination .env }
node scripts/hash-password.mjs
```

Privately edit `.env`: set `MONGODB_URI` to your own replica-set/SRV/sharded deployment with `/purainamart` explicitly selected, `ADMIN_PHONE` to your ten-digit Admin number, and `ADMIN_PASSWORD_HASH` to the helper's output. Keep `NODE_ENV=development`, `DEV_HOST=127.0.0.1`, `PORT=4173` for local HTTP. Preserve your deployment's required auth/TLS options. For example, a non-secret URI shape is `mongodb://<host>:<port>/purainamart?replicaSet=<set-name>`.

```powershell
npm start
```

Open `http://127.0.0.1:4173/`, `/admin` and `/rider`. An empty database needs categories/products, enabled delivery areas, authenticated Rider credentials and dispatch configuration entered through Admin. New orders start at **Order received** in all modes. Stop with Ctrl+C. See README for optional Google/FCM/Cloudinary configuration and the separate opt-in legacy importer; neither importing nor seeding occurs at startup.

## H. Remaining issues and limits

1. Real topology, permissions, unique-index creation on existing data, MongoDB validator compatibility, concurrency/rollback/durability and restart recovery await your instance. Existing duplicate identifiers can correctly prevent index creation; no real records were inspected or repaired.
2. Real Google OAuth, Firebase provider delivery, Cloudinary upload and physical mobile browsers were not exercised. No SMS/OTP recovery, online payment or native Android push service is configured.
3. External push has an unavoidable acceptance-before-log crash window; a retry may deliver twice. The worker is bounded and retries failed devices, but provider acceptance does not prove display.
4. High-volume Admin/referral dashboards still perform some per-related-record reads, although repeated reads and customer summaries are request-cached and core lists are paged. Client screens collect pages to preserve existing local filtering. Large datasets need load measurements and may benefit from server-side filtering/cursor pagination. Substring product search is not equivalent to a text-index query and may scan matches.
5. The opt-in importer has synthetic mapping/schema checks only, uses a single transaction and insert-only upserts, and requires review against the actual authoritative legacy source/target. It does not reconcile pre-existing target records or remove historical payment metadata.
6. Backups, monitoring, restore drills and operational capacity testing remain deployment work. No current automated test failure or known blocker to beginning local MongoDB testing remains.

## I. Final assessment

The code migration is integrated, MongoDB-only and ready for you to begin local functional testing with your own non-production MongoDB instance. This is code-and-mock readiness, not certification of a live database or production operation. No real database verification or real COD transaction is claimed.
