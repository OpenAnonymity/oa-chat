# Phone Pairing: "Sync from your computer"

> 2026-10-27 local hardening: fresh assertion enforcement, atomic mailbox operations, transactional retries and cancellation/account guards are implemented and independently reviewed. Pairing remains disabled and undeployed; physical camera/Face ID end-to-end validation is still outstanding. Current evidence: workspace `deployment/phone-pairing-20261027/local-hardening/VALIDATION.md`. The earlier `REVIEW.md` records the original findings.


Status: specification, 2026-10-27, with the computer side and the org
implemented against it the same day (see *Implementation* at the end). Step 1
(the phone no longer gets the system's cross-device QR; it shows its own
"passkey isn't on this phone" state) ships on its own in the iOS app; see
`oa-ios/docs/07-delivery/passkey-not-on-device/`.

## What this is

A computer that has the account's wallet unlocked gives the phone a passkey for
the same account. Afterwards the phone unlocks on its own, with Face ID, like a
phone whose passkey arrived through iCloud Keychain. It exists for the people
whose passkey never reaches the phone: it was created in Chrome on a Mac, in
Windows Hello, or in a desktop-only password manager. Nothing changes for
anyone else: the ordinary unlock and sign-in paths are untouched, and the
pairing screens appear only after the phone's own passkey request found
nothing (`OAPasskeyAvailability`).

In keyring terms it is one more wrapper. The account master key already lives
behind each passkey as a separate wrapper (`ENCRYPTION_PASSKEYS.md`,
`POST /auth/keyring`). The phone creates a PRF passkey, wraps the master key
with it, and appends that wrapper. The one thing the existing design does not
have is a way for the master key to reach the phone, and that is what the
protocol below does. The org never sees the key, before or after.

## Terms

| Term | Meaning |
|---|---|
| Computer | The device with the wallet unlocked: the master key is in memory there (web client, or OA Desktop through its oa-chat). |
| Phone | The OA iOS app on a device holding none of the account's passkeys. |
| Tunnel | A short-lived mailbox on the org, named by a random id, that carries two opaque messages. |
| `qrSecret` | 32 random bytes shown only in the QR. Whoever reads the QR holds it; the org never does. |
| `K1`, `K2` | The two message keys derived below. |
| Grant | Username accounts only: a one-use token the computer's session mints so the phone may register a login credential. |

## Does this work for both account types?

Yes, with one difference.

- **Google accounts.** Google is the login. The phone signs in with Google first
  (that is step 1 of the existing flow and gives it a session), then pairing
  supplies the encryption passkey. The phone appends its wrapper with its own
  session: `POST /auth/keyring` with `operation: "ADD"`. No new org endpoint
  beyond the tunnel.
- **Username accounts.** The passkey *is* the login (`USERNAME_PASSKEYS.md`),
  and each credential carries its own `wrappedKeyPasskey`. The phone has no
  session until it has a credential, and it cannot register one without
  authorization. So the computer's session mints a one-use **grant** at
  approval time, sends it to the phone inside the encrypted message, and the
  phone registers its new credential (with its own wrapped key) against that
  grant. One new org endpoint pair. After that the phone signs in with its
  own passkey like any username device.

## Threat model

Adversaries and what each must not get. "The key" is the account master key.

| Adversary | Has | Must not get | Why not |
|---|---|---|---|
| The org, including its Redis and logs | Both tunnel messages, the tunnel owner's account id, timing, sizes, the phone's IP, and (username) the grant. | The key; the phone's passkey PRF; the ability to insert itself as the phone or the computer. | Both messages are AEAD ciphertext under keys that include `qrSecret`, which exists only in the QR image on the computer's screen and the phone's camera. The org is a dumb mailbox: it can drop or delay, not read or forge. |
| Someone who photographs the QR within its 2-minute life | `qrSecret`, the tunnel id, the computer's ephemeral public key. | The key. | They can play the phone's part and post a message; the computer then shows "Is this your phone?" for a scan the person did not make. The person must approve, with user verification, for the key to be sent. This is the residual risk: see *Residual risks*. |
| Someone at the unlocked computer | Everything the computer has, already. | A silent way to enrol their own phone permanently. | Approval requires user verification on the computer (the computer's own passkey assertion). They could read tickets anyway; what this blocks is a lasting foothold without a Touch ID. |
| A stale or replayed QR | An old `qrSecret` and tunnel id. | Anything. | Tunnels live 2 minutes, accept one phone message and one computer message, and are deleted after the phone's read. A second scan of a used QR gets `410`. |
| A phone on the wrong account | A session for a different account. | A wrapper on the computer's account. | The phone's first message names its account; the computer refuses a mismatch before showing anything. The org separately refuses a `POST /auth/keyring` whose session does not own the tunnel's account (Google), or a grant minted for another account (username). |
| A device that received the key but never finished (Face ID cancelled, upload failed) | The key, in memory. | A lasting unwrapped copy. | The key is held only in memory until the wrapper upload is acknowledged, then zeroed; the encrypted wrapper is journaled before upload exactly as the web client's keyring append is. |

What this protocol does **not** protect against: a person approving a pairing
they did not initiate; a compromised computer or phone OS; a phone app that is
not OA's (the App Store binary is the trust boundary, as for the passkey code
already there).

## Protocol

Modeled on CTAP 2.2 hybrid transport ("caBLE"): the QR carries a secret and an
ephemeral public key, the first message is protected by the QR secret alone,
the second by a Diffie-Hellman agreement bound to that secret. Encryption is
HPKE's base mode (RFC 9180) done by hand on the web with WebCrypto, and
natively with CryptoKit on iOS; the shared test vectors (step 3) pin the two to
the same bytes.

Primitives: P-256 ECDH; HKDF-SHA256; AES-256-GCM with a 12-byte random nonce;
SHA-256. All byte strings on the wire are base64url without padding.

### 1. Computer creates a tunnel and shows the QR

Preconditions: signed in, wallet unlocked (master key in memory),
`PHONE_PAIRING` flag on.

1. Computer generates `qrSecret` (32 bytes) and an ephemeral P-256 key pair
   `(cPriv, cPub)`.
2. `POST /auth/pairing` (session cookie) → `{ tunnelId, expiresAt }`. The org
   stores `{ tunnelId, accountId, createdAt }` with a 120 s TTL. `tunnelId` is
   16 random bytes made by the org. Rate limit: 3 open tunnels per account,
   10 per account per hour.
3. The QR encodes one line:
   `OAPAIR/1/<env>/<tunnelId>/<qrSecret>/<cPub>` where `env` is `prod` or
   `staging` (the phone refuses a QR for another environment), `cPub` is the
   65-byte uncompressed point. Nothing else: no account id, no email, no URL.
4. The computer polls `GET /auth/pairing/{tunnelId}` every 2 s until the phone
   message arrives or the tunnel expires. The screen shows the QR and the
   three phone instructions (canvas, board 5).

Derived keys:

```
K1 = HKDF-SHA256(ikm = qrSecret, salt = tunnelId, info = "oa-pairing/v1/phone->computer", L = 32)
```

### 2. Phone scans and answers

Preconditions: Google account — signed in with Google on the phone (has a
session, `accountId` known); username account — the person typed the username
and the login found no passkey on the device (`accountId` from the challenge
response, no session).

1. Phone parses the QR; refuses a wrong `env` or malformed line.
2. Phone generates an ephemeral P-256 pair `(pPriv, pPub)`.
3. Phone message, plaintext JSON:
   `{ "v": 1, "pPub": <65 bytes>, "account": { "kind": "google"|"username", "accountId": <opaque id> }, "device": "iPhone" }`
   `device` is the model family only (`iPhone`, `iPad`), never a name the
   person typed.
4. `msg1 = AES-256-GCM(K1, nonce1, plaintext, aad = "msg1" || tunnelId)`.
5. `POST /auth/pairing/{tunnelId}/phone` with `{ nonce1, msg1 }`, no cookie.
   The org accepts exactly one phone message per tunnel (second → `409`),
   requires the tunnel to be live (`404`/`410` otherwise), and rate-limits by
   IP. It stores the bytes as given.
6. Phone shows "Code scanned — Approve on your computer to continue" (board 7)
   and polls `GET /auth/pairing/{tunnelId}/computer` every 2 s.

### 3. Computer verifies, the person approves

1. The poll returns `{ nonce1, msg1 }`. Computer decrypts under `K1`. A
   failure (wrong QR secret, tampering) is shown as "This code was not scanned
   by a phone that saw this screen" and the tunnel is closed.
2. Computer checks `account.accountId == its own accountId` and that
   `account.kind` matches its own account type. A mismatch is shown as "That
   phone is signed in to a different account" and the tunnel is closed.
3. Computer shows "Is this your phone? iPhone · scanned just now" with
   **Not my phone** and **Approve with Touch ID** (board 8).
4. Approve runs user verification on the computer: the computer's own passkey
   assertion for this account (`requestPrf` with its existing credential ids,
   `userVerification: "required"`). The PRF output unwraps the existing
   master key locally; it is never sent to the org. OA Desktop does this through its relay as
   for any passkey step. A cancelled or failed assertion closes the tunnel and
   nothing is sent.
5. Derived key:

```
shared = ECDH(cPriv, pPub)                      // 32-byte x-coordinate
K2 = HKDF-SHA256(ikm = shared || qrSecret, salt = tunnelId,
                 info = "oa-pairing/v1/computer->phone" || cPub || pPub, L = 32)
```

6. Computer message, plaintext JSON:
   `{ "v": 1, "masterKey": <32 bytes>, "grant": <string, username accounts only> }`.
   For a username account the computer first calls
   `POST /auth/credentials/grant/challenge` with `{tunnelId}` (session),
   then signs that challenge with an existing account credential and posts
   `{tunnelId, challengeId, assertion}` to `/auth/credentials/grant`.
   The org verifies the signature, RP/origin and user verification, and binds
   approval to the account, tunnel, phone message and auth generation.
   It returns `{grant, expiresAt, accountId, wrappedKeyPasskey}`; the wrapper
   is decrypted locally with the same assertion's PRF. No login/session
   replacement occurs. A session alone cannot mint the 120-second grant.
7. `msg2 = AES-256-GCM(K2, nonce2, plaintext, aad = "msg2" || tunnelId)`.
8. `POST /auth/pairing/{tunnelId}/computer` (session cookie; the org checks the
   session owns the tunnel) with `{ nonce2, msg2 }`. One per tunnel.
9. Computer zeroes `cPriv` and `qrSecret`, shows "Phone added" (board 8, done
   state). Its own wrappers are untouched; it keeps working as before.

### 4. Phone finishes

1. The poll returns `{ nonce2, msg2 }`; the org deletes the tunnel on this
   read. Phone computes `K2` with `pPriv`, decrypts, zeroes `pPriv`.
2. Phone creates its passkey: the existing `createWrapper` path on iOS
   (resident, user-verified, PRF; label = email for Google, username for
   username accounts), Face ID (board 9). **The passkey is created before the
   key is persisted anywhere**, so a cancelled Face ID means the key is zeroed
   and the phone returns to "passkey isn't on this phone" with the computer
   side already done; the person scans again. (Creating the passkey *before*
   scanning was considered; it would leave an orphan credential on every
   abandoned attempt, so the order is scan → approve → Face ID → wrap.)
3. Phone wraps `masterKey` with the PRF output (`OAAccountWalletCrypto.wrapMasterKey`)
   and journals the encrypted wrapper locally before upload, as the web keyring
   append does.
4. Upload:
   - Google: `POST /auth/keyring` with `{ credentialId, expectedAccountId, operation: "ADD", type: "PASSKEY", version: 1, wrappedKey }`
     using the phone's own session. The org's existing checks apply
     (`KEYRING_LIMIT_EXCEEDED`, `KEYRING_WRAPPER_CONFLICT`).
   - Username: `POST /auth/credentials/register` with `{grant, credential:
     {id, rawId, type, response: {clientDataJSON, attestationObject}}, wrappedKeyPasskey}`.
     The challenge comes from `/auth/credentials/challenge` and is stable for
     that grant. The first registration freezes a recursively canonical body
     hash plus challenge for 24-hour exact retries; it cannot enroll a second
     credential. Unprepared grants still expire after 120 seconds. PostgreSQL
     commits credential + wrapper in one transaction, checking account status,
     auth generation, approving credential and credential limit under a row lock.
     Registration returns no session. iOS uses a cookie-free, non-intercepted
     ordinary login request next, validates/unwraps the reply, then checks the
     current attempt/account and synchronously installs the session and wallet.
5. Phone adopts the unlocked key (`adoptUnlockedKey`), zeroes the plaintext
   copy, and runs the normal first sync. "You're in — tickets are syncing to
   this phone" (board 10). From now on this phone unlocks with its own passkey;
   if iCloud Keychain later delivers the original passkey too, the account
   simply has one more working wrapper.

### Abort rules

| Event | Phone | Computer | Org |
|---|---|---|---|
| 120 s pass with no phone message | — | "Code expired", new QR on tap | Tunnel gone (TTL) |
| Phone scans an expired/used QR | "This code has expired. Ask for a new one on your computer." | — | `410` |
| Computer: Not my phone, or verification cancelled | Poll gets `410`: "Your computer declined. Try again." | Back to Account | `DELETE /auth/pairing/{tunnelId}` by owner |
| Phone: Face ID cancelled after the key arrived | Key zeroed; back to "passkey isn't on this phone" | Already shows done | — |
| Phone: wrapper upload fails | Plaintext key is not persisted. Device-only encrypted registration journal survives relaunch; explicit Try again resumes its exact upload, then the local passkey unlocks. Start over discards only this scoped record. | — | — |
| Phone closes the app mid-flow | Same as above; the tunnel expires | Poll times out | TTL |
| Network error anywhere | Shown as a retryable error on that device; never silently retried past the TTL | | |

Nothing in this table changes the computer's own wrappers or the account's
sync data. The only lasting change on success is one appended wrapper (Google)
or one appended credential (username).

### Message versioning

Both plaintexts carry `v`. A receiver rejects an unknown `v`. `v: 2` is
reserved for whatever the username grant turns into if the org later gains
general "add credential" support; nothing in `v: 1` needs to change for that.

## Org endpoints (summary)

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /auth/pairing` | session | Create tunnel for the session's account → `{ tunnelId, expiresAt }` |
| `GET /auth/pairing/{tunnelId}` | session, owner | Computer poll for the phone message |
| `POST /auth/pairing/{tunnelId}/phone` | none (IP-limited) | Phone posts `msg1` |
| `POST /auth/pairing/{tunnelId}/computer` | session, owner | Computer posts `msg2` |
| `GET /auth/pairing/{tunnelId}/computer` | none | Phone poll for `msg2`; deletes the tunnel on success |
| `DELETE /auth/pairing/{tunnelId}` | session, owner | Decline |
| `POST /auth/credentials/grant/challenge` | session, tunnel owner | Fresh assertion challenge bound to this pairing |
| `POST /auth/credentials/grant` | session + verified assertion | Mint a one-registration grant |
| `POST /auth/credentials/challenge` | grant | Registration challenge for the grant's account |
| `POST /auth/credentials/register` | grant | Transactionally add credential + wrapper; exact retry; no session |

Storage is Redis only: `pairing:{tunnelId}` → `{ account_id, created_at, msg1?, msg2? }`
with a 120 s TTL; `credgrant:{sha256(grant)}` → `{ account_id }` with a 120 s
TTL before preparation; the frozen first-body retry record lasts 24 hours and retries never extend it. Neither value is ever logged. Sizes: `msg1` ≤ 512 bytes, `msg2` ≤ 1024
bytes, enforced.

## Test vectors (step 3)

One JSON fixture, `test/fixtures/phone-pairing-v1.json`, generated once and
checked in: fixed `qrSecret`, `tunnelId`, `cPriv/cPub`, `pPriv/pPub`,
`nonce1`, `nonce2`, both plaintexts; the expected `K1`, `K2`, `msg1`, `msg2`.
A Node test (`oa-chat/test/services/phonePairing.test.js`) and an XCTest
(`PhonePairingVectorTests.swift`) must both produce and accept those bytes.
That, not a device run, is what proves the two implementations agree.

## What the person sees

The screens are the ones on the canvas "OA Add Phone Flow", boards 3–10, with
the copy as approved: "Sync from your computer" on the phone; "Sync with your
iPhone — Add phone" in the Account dialog's *Your tickets* panel on the web;
"Is this your phone? iPhone · scanned just now — Approve with Touch ID".
No verification code is shown (see *Residual risks* for what that trades).

## Residual risks, stated plainly

1. **A photographed QR, used within 2 minutes, plus a person who approves a
   scan they did not make.** The protocol cannot tell the attacker's phone
   from the real one; the person can, because their own phone did not advance.
   A short visible code on both screens (the "47 82" the design dropped) would
   close this; it was dropped for simplicity. If the support population turns
   out to include people who approve anything, add it back: it is a 6-digit
   HKDF output of `K2` shown on both devices, nothing else changes.
2. **An unlocked, unattended computer.** Approval needs user verification, so
   enrolling a phone needs the owner's finger. Reading tickets never did. This
   is the same boundary the rest of the app has.
3. **The org can see that pairing happened**: which account, when, from which
   IP the phone posted, and the ciphertext sizes. It is one more line in the
   metadata the opt-in account flows already concede (`PRIVACY_MODEL.md`).

## What this changes in the privacy documents

`PRIVACY_MODEL.md`: section 5 gains an item for pairing; the "What each
component can see" row for the org and the metadata table gain the pairing
events. `UNLINKABILITY_PROOF.md` is about blind signatures and does not
mention sync or relays; nothing there becomes untrue, so it is unchanged.
`ENCRYPTION_PASSKEYS.md` gains a pointer here.

## Implementation

| Piece | Where | Tests |
|---|---|---|
| Cryptography (keys, both messages, QR line) | `chat/services/phonePairing.js` (WebCrypto); iOS `OAPhonePairingCrypto.swift` (CryptoKit) | `test/services/phonePairing.test.js` and iOS `PhonePairingVectorTests` against `test/fixtures/phone-pairing-v1.json` (`npm run pairing:fixture` regenerates both copies) |
| Computer side state machine | `chat/services/phonePairingSession.js`; exposed to the host as `context.pairing` from `app.js` | `test/services/phonePairingSession.test.js` (fake org, real crypto; a simulated phone opens the sent key) |
| The passkey prompt at approval | `accountService.revealMasterKeyForPairing` (Google keyring unlock), `approveUsernamePairing` (server-verified assertion + local unwrap), `pairingRequest` (paths restricted to `/auth/pairing`) | — |
| QR rendering | `chat/services/phonePairingQr.js` (`qrcode`, level M) | — |
| Account dialog row and Add phone view | oa-commercial `src/billing/BillingModal.js`, `commercial.css` | oa-commercial `test/billingModal.test.js` |
| Org tunnel and grants | oa-org `auth/passkey/pairing.py` | oa-org `tests/test_phone_pairing.py` (incl. "the org holds only ciphertext it cannot open") |
| Phone side | iOS implemented; simulator validated, physical camera/Face ID pending | Local private build only |

The computer side is behind the build flag `OA_PHONE_PAIRING=true`
(`__OA_PHONE_PAIRING__` in `scripts/build.mjs`) and, at runtime,
`context.pairing.available()`: an unlocked Google or username account in a
browser. OA Desktop is excluded for now: its passkey evaluation goes through
the system-browser relay, and the approval step would need the relay to carry
one more operation; the row does not appear there.


## Local hardening — 2026-10-27 (not deployed)

Web attempts capture account, login generation, tunnel, abort signal and timers;
all async boundaries check that binding. Old create/delete/prompt completions
cannot publish into a newer attempt; expiry applies during approval too.
Redis Lua transitions make posts, one-read consumption and decline atomic and
preserve the original TTL. Logs omit account IDs, tunnel URLs, grants and keys.

The iOS journal is device-only Keychain (`WhenUnlockedThisDeviceOnly`), scoped to
exact org URL + account kind + normalized username/account ID. It holds only the
registration request/encrypted wrapper and completion marker, never QR secret,
PRF/ECDH output, session tokens or master key. Explicit Try again resumes;
Start over discards only that scope's record and permits a new scan. It does not
delete platform passkeys or other accounts. There is no background enrollment.
Google retries first compare the existing wrapper and bind ADD to expectedAccountId.
A cancelled task or changed account generation cannot adopt a key/session.

Validation/provenance and limits: workspace
`deployment/phone-pairing-20261027/local-hardening/VALIDATION.md`.
Flags remain off and phone2705 is unchanged. No production restart/deployment.
The original staging-lineage web/org source contains the forbidden production timing
experiment: do not promote wholesale to production or include it in mobile.


Production candidate, 2026-10-27: pairing-only deltas are applied to production
web/client revisions 6302c7c / 5ba13ac5 and the actual deployed org source snapshot.
No request-timing experiment source is included. New org routes require explicit
OA_PHONE_PAIRING=true and return 404 otherwise. The existing production keyring
ADD account-binding requirement is preserved. This candidate is local and
undeployed; server activation requires resolving the no-restart constraint.
The web success state acknowledges key delivery only; enrollment finishes on the
phone. Closing/destroying the view cancels the session, and QR data is not cached.
