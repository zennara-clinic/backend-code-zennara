# Zenoti CRM integration

Zennara's system of record for customers is the **Zenoti** CRM. This integration
lets an existing Zenoti guest sign in to the app **without registering**, and
reads their profile and history (appointments, purchases, memberships, packages)
from Zenoti on demand.

> **Verified live against the production Zenoti org (Aug 2026).** The endpoints
> and response shapes below were confirmed by probing real guests. Two data types
> this org does **not** expose are deliberately excluded from the app: **loyalty
> points** (`/loyaltypoints` → 404, programme not enabled) and **gift cards**
> (401, not permitted for this key). Per product decision, we never show a
> section the CRM can't populate.

## How it works

```
App login (phone) ──► /api/auth/login
                         │
                         ├─ local User with this phone?  ── yes ─► send OTP (as before)
                         │
                         └─ no ─► Zenoti guest search by phone
                                     │
                                     ├─ found ─► mirror a local User (source:'zenoti',
                                     │            linked by zenotiGuestId) ─► send OTP
                                     │
                                     └─ not found ─► 404 "please sign up"
```

- The **local User mirror** exists so the rest of the app (bookings, orders,
  packages — all keyed by our `userId`) keeps working unchanged.
- The guest's **live history stays in Zenoti** and is read through `/api/zenoti/*`.
- Linking is idempotent: resolved by Zenoti guest id, then phone, then email, so
  repeated logins never create duplicates or trip unique indexes.
- OTP delivery is resilient: app accounts get email + WhatsApp; Zenoti guests
  with no real email get WhatsApp only. Login succeeds if **either** channel sends.

## Environment

Set in `Backend/.env` (already present — values are secret, keep them server-side):

```
ZENOTI_API_KEY=...          # organisation API key (Authorization: apikey <KEY>)
ZENOTI_APPLICATION_ID=...   # reserved for future OAuth token flows
ZENOTI_SECRET=...           # reserved for future OAuth token flows
# write-back:
ZENOTI_WRITE_MODE=dryrun     # off | dryrun | live  (default dryrun)
# optional overrides:
# ZENOTI_API_BASE=https://api.zenoti.com
# ZENOTI_RATE_LIMIT=50       # requests/minute ceiling (Zenoti org limit is 60)
# ZENOTI_ZEN_MEMBERSHIP_NAMES=Zen Membership
# ZENOTI_SERVICE_MAP={"our-consultation-slug":"zenoti-service-id"}
# ZENOTI_PRODUCT_MAP={"our-product-id":"zenoti-product-id"}
```

> ⚠️ The API key + secret were shared in chat/email during scoping. **Rotate them
> in Zenoti before production** and only ever store the new values in the server
> environment (never in the app bundle, git, or logs).

## Centers → branches

Mapping lives in [`config/zenoti.js`](config/zenoti.js) (`CENTERS`). Live centres:

| Zenoti center | Code | App branch |
|---|---|---|
| Jubilee Hills | ZENJH | Jubilee Hills |
| Financial District | ZNFD | Financial District |
| Kondapur | ZNKD | Kondapur |
| Training Centre | TC | Jubilee Hills (fallback) |
| *…Pharmacy centres* | ZNJHP/ZNFDP/ZNKDP | their parent clinic |

A guest's Zenoti home center sets their mirrored `location`. If it can't be
mapped, `resolveBranchName` falls back to an active branch.

## Files

**Backend**
- `config/zenoti.js` — base URL, center↔branch map, gender/phone normalisers.
- `services/zenotiService.js` — API client: apikey auth, 60/min rate limiter,
  429/Retry-After + transient retries, centres + catalog cache, normalised reads.
- `services/zenotiSyncService.js` — provision/link/sync the local User mirror +
  Zen-membership mapping.
- `services/zenotiWriteService.js` — write-back: `ensureGuest`, `syncBooking`,
  `syncOrder`, catalog resolvers; gated by `ZENOTI_WRITE_MODE`.
- `models/{User,Booking,ProductOrder}.js` — Zenoti sync fields + post-save hooks
  that fire the write-back (fire-and-forget).
- `controllers/authController.js` — `login` calls `findOrProvisionByPhone`;
  `verifyOTP` background-syncs linked guests. `serializeUser` adds
  `source` + `zenotiLinked`.
- `models/User.js` — `source`, `zenotiGuestId` (sparse unique), `zenotiCenterId`,
  `zenotiSyncedAt`; DOB/gender required only for `source:'app'`.
- `controllers/zenotiController.js` + `routes/zenoti.js` — per-customer reads,
  mounted at `/api/zenoti` in `server.js`.

**Frontend — mobile app** (`Zennara App/`)
- `services/api.ts` — `zenotiApi` module + `Zenoti*` types; `User.source` / `User.zenotiLinked`.
- `app/profile/clinic-history.tsx` — the **Clinic History** screen: calls
  `/zenoti/overview` and renders treatments, purchases, packages (sessions
  used/left) and memberships. Only sections Zenoti returns are shown.
- `app/main/profile.tsx` — a **Clinic History** row in the Account group, shown
  only when `user.zenotiLinked` (so it never opens an empty screen).

**Frontend — staff panel** (`Panels/`)
- `src/pages/zenoti.tsx` (route `/zenoti`) + `src/lib/api.ts` `zenoti.overview`.

## API — `/api/zenoti/*` (all `protect`ed, scoped to the signed-in guest)

| Method | Route | Returns |
|---|---|---|
| GET | `/api/zenoti/profile` | full Zenoti profile |
| GET | `/api/zenoti/appointments?from=&to=` | appointment/treatment history |
| GET | `/api/zenoti/orders` | product/retail purchase history |
| GET | `/api/zenoti/memberships` | membership history (needs the guest's home center id — added automatically) |
| GET | `/api/zenoti/packages` | series / day packages (with per-service sessions used/left) |
| GET | `/api/zenoti/overview` | all of the above in one call — powers the app's **Clinic History** screen |
| POST | `/api/zenoti/sync` | force re-sync of the local mirror |
| GET | `/api/zenoti/write-status` | current write mode + guest-link status |
| POST | `/api/zenoti/ensure-guest` | create/link this account's Zenoti guest |
| POST | `/api/zenoti/bookings/:id/resync` | re-push a booking to Zenoti |
| POST | `/api/zenoti/orders/:id/resync` | re-push an order to Zenoti |

`404 { code: 'NOT_LINKED' }` when the account has no `zenotiGuestId`.

### Admin / panel (staff)

| Method | Route | Returns |
|---|---|---|
| GET | `/api/admin/zenoti/overview?phone=&email=&guestId=` | a customer's full Zenoti record (profile, appointments, purchases, packages, memberships, loyalty) |

Staff-authenticated (`protectAdmin`). This is the **authorised way to inspect any
customer's records** — used by the panel's **Clinic data (CRM)** page
(`Panels/ src/pages/zenoti.tsx`, route `/zenoti`). It does not sign in as the
customer and sends them no notification. Never expose a customer's login or OTP
for impersonation; use this staff view instead.

### Zen membership auto-assignment

On login (background) and on `POST /api/zenoti/sync`, if the guest holds an
**active** Zenoti membership whose name matches the Zen tier, the local account
is upgraded to `memberType: 'Zen Member'` with the membership's start/expiry.
Configure the exact product name(s):

```
ZENOTI_ZEN_MEMBERSHIP_NAMES="Zen Membership"   # default 'zen' (substring, case-insensitive)
```

We only upgrade here, never auto-downgrade (so an in-app purchase isn't wiped by
a sync). Downgrade-on-expiry is a deliberate follow-up if you want it.

## Verifying

```bash
# read-only, no PII — centres + not-found path
node scripts/zenotiSmokeTest.js

# full read path against a REAL customer — prints only counts/booleans, no PII
node scripts/zenotiValidate.js 9876543210

# write-back (Phase 2) — forces dryrun, writes NOTHING; proves flows + resolvers
node scripts/zenotiWriteDryRunTest.js
```

**Confirmed live against real guests (Aug 2026):** `GET /v1/centers` (7 centres),
guest search, and every guest sub-resource the app uses —
`/guests/{id}` (profile), `/appointments`, `/products`, `/memberships`
(with `center_id`) and `/packages`. Response shapes are handled as Zenoti really
returns them (appointments come as GROUPS with nested `appointment_services`;
packages are a bare array; memberships live under `guest_memberships`). Normaliser
output was validated against populated records.

**Confirmed NOT available on this org** (excluded from the app on purpose):
`/loyaltypoints` (404), `/giftcards` (401), `/wallet` (404).

## Write-back (Phase 2) — app → Zenoti

Zenoti is the source of truth; app activity is pushed back so it shows in Zenoti
and the `Panels/` admin panel. Implemented and gated by **`ZENOTI_WRITE_MODE`**
(`off` / `dryrun` / `live`, default `dryrun`).

| App event | → Zenoti | Trigger |
|---|---|---|
| Fresh app signup (new `User`) | create/link a guest | `User` post-save hook |
| Booking created (treatment / doctor consultation) | create an appointment | `Booking` post-save hook |
| Product order created | create a product invoice | `ProductOrder` post-save hook |

- **Model post-save hooks** (not per-controller edits) guarantee *every* creation
  path — app, payment, admin, package — is covered uniformly.
- **Best-effort & non-blocking**: hooks are fire-and-forget; a Zenoti failure
  never breaks signup/booking/order. Errors land in `zenotiSyncStatus` /
  `zenotiSyncError` on the record.
- **Idempotent**: each record stores its Zenoti id (`zenotiGuestId` /
  `zenotiAppointmentId` / `zenotiInvoiceId`); a repeat push is a no-op. Guests are
  linked-not-duplicated (searched by phone first).
- **Catalog mapping**: bookings/orders resolve our consultation/product → a Zenoti
  service/product id by code then name, per centre (cached), with optional
  `ZENOTI_SERVICE_MAP` / `ZENOTI_PRODUCT_MAP` overrides. Unresolved → status
  `skipped` (never a hard failure).

### Going live safely
1. Confirm the write endpoints/fields against **one disposable guest** in dryrun
   (payloads are logged), then set `ZENOTI_WRITE_MODE=live`.
2. `dryrun` logs everything and writes nothing — leave it there until validated.
3. Payment/tender is intentionally **not** pushed (invoice records the sale only);
   money reconciliation is a separate, deliberate step.

Verified in dryrun against live data: guest payload builds correctly, 529
services + 258 products fetched for a clinic centre, and the resolver maps a real
service/product name back to its Zenoti id. The live POSTs (guest/appointment/
invoice create) are built to Zenoti's documented shapes but not yet exercised
against a real record — do that in `dryrun`→one live test before broad rollout.
