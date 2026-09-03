# Encryption Passkeys

Google accounts use SSO as the account authenticator and a separate WebAuthn
PRF passkey to unlock encryption locally. Pseudonymous username accounts use a
single WebAuthn credential for both account authentication and local PRF
unlock. In both cases, authentication authorizes access to opaque sync records
but never supplies an encryption key.

Error reporting follows the same boundary: “passkey unavailable” applies only
when the WebAuthn credential request itself returns `NotFoundError`. Storage,
scope activation, and encrypted-ticket synchronization failures retain their
own errors. After unwrapping and persisting the master key, OA keeps the account
unlocked and retries a failed initial synchronization instead of asking for the
passkey again. The unlock path awaits that first synchronization result so an
activation, initialization, or pull failure actually schedules the bounded
retry; ordinary startup keeps synchronization in the background. This
distinction is especially important in private browsing,
where credential availability and IndexedDB behavior can differ independently.
Lock, logout, account-switch, and token-invalidation boundaries cancel both
pending synchronization and the in-memory commit of an older key-persistence
operation, so stale async work cannot repopulate a replacement account.

## New-account flow

1. The org completes OAuth and maps the provider's stable subject to an internal
   OA account ID.
2. The browser generates a random 256-bit account master key.
3. The browser creates a resident, user-verified WebAuthn credential with the
   `prf` extension. Its WebAuthn username and display name are the verified
   email returned by the selected SSO provider, matching the account label the
   user recognizes in their passkey manager. The credential remains scoped to
   the app's WebAuthn RP/origin.
4. The PRF output is imported directly as a non-extractable AES-GCM key. It wraps
   the random account master key with a fresh 96-bit IV and fixed versioned AAD.
5. The browser uploads only `{ credentialId, type, version, wrappedKey }` to
   `POST /auth/keyring`.

Some authenticators report `prf.enabled` during `credentials.create()` without
returning a PRF result. In that case the client immediately performs a
`credentials.get()` for the new credential to evaluate the PRF.

The WebAuthn registration and assertions are not sent to the org. The encryption
passkey is not an account-authentication credential; OAuth already performed
that job.

OA Desktop can perform OAuth and this PRF evaluation in one system-browser tab.
The relay receives a one-use server context containing only the required
operation, passkey label, or account-bound credential IDs. It returns the PRF
output over a nonce-bound loopback callback; oa-chat performs the same local
wrap/unwrap operations used by the ordinary browser flow.

## Username-account flow

The browser sends a normalized pseudonymous username to `/auth/init`. The org
atomically maps it to a new opaque 16-digit account ID, and the browser creates
a resident, user-verified PRF credential. WebAuthn `user.id` is the opaque
account ID; the username is used only for `user.name` and `user.displayName`.

The browser wraps the random master key only with the credential's PRF output.
On login, the same WebAuthn assertion is verified by the org and its PRF output
decrypts the master-key wrapper locally, so the user sees one passkey prompt.
Cryptographic PRF input, local key bundles, sessions, and sync scope remain
bound to the opaque account ID, not the user-chosen name. Username accounts do
not create a recovery wrapper or verifier; losing every synced passkey copy
makes their encrypted data unrecoverable.

Username and Google identities are separate account types and cannot be linked
in this version. See [USERNAME_PASSKEYS.md](USERNAME_PASSKEYS.md) for the full
protocol and compatibility contract.

## Returning-device flow

After OAuth authentication, the browser reads `GET /auth/keyring`, supplies the
returned credential IDs as `allowCredentials`, evaluates the PRF locally, and
decrypts the matching master-key wrapper. A synced passkey can therefore unlock
the same data on another device without an OA account number or recovery code.

The org sees the opted-in identity mapping, verified provider email, internal
account ID, passkey credential ID, wrapper format metadata, and ciphertext. It
never receives the PRF output or plaintext master key.

## Local key handling

After a successful unlock, the raw master-key buffer is erased best-effort. The
browser imports it into three non-extractable `CryptoKey` objects with the
minimum usages required by the existing sync format:

- AES-GCM for direct account encryption operations.
- HKDF for per-blob encryption-key derivation.
- HMAC-SHA-256 for opaque sync blob IDs.

Those non-extractable keys are persisted together in an account-bound IndexedDB
bundle. The stored account ID must match the active account before any key is
accepted, preventing a stale key object from being reused after an account
switch. A page reload therefore does not prompt again. Explicit logout or token
invalidation deletes the bundle. A fresh device or logged-out browser must use
the encryption passkey again.

Google authentication may remain valid when a user closes an unsuccessful
encryption-passkey prompt. That state is deliberately shown as locked, not as a
fully logged-in account: OAuth can identify the account and fetch its opaque
keyring wrappers, but it cannot decrypt the master key or expose tickets and
preferences. Reloading may therefore restore the Google session while still
requiring the same encryption passkey.

The encrypted-sync blob format remains compatible: HKDF-derived AES-GCM keys and
HMAC-derived opaque IDs still use the same version-1 labels. This change replaces
the SSO key-unlock mechanism; it does not re-encrypt existing sync blobs into a
new wire format.

## Recovery and migration

New SSO and username accounts do not receive a recovery code in the UI and do
not upload a recovery wrapper. Losing every copy of the encryption passkey
means the encrypted data cannot be recovered; a Google session or public
username alone is intentionally insufficient.

SSO accounts created by the previous recovery-code build receive a one-time
migration screen. After OAuth, the browser decrypts the legacy wrapper with the
existing five-word code, immediately creates a PRF passkey wrapper for the same
master key, and proves knowledge of the stored recovery hash with that first
keyring write. The server atomically creates the PRF wrapper and deletes the
legacy recovery wrapper and hash. Direct legacy recovery endpoints reject SSO
accounts both before and after migration, so an old client cannot bypass or
restore the PRF path. The legacy passkey-only account flow remains available
separately for compatibility.

The server exposes an explicit encryption mode:

- `PRF_PENDING`: a new identity account must create its encryption passkey.
- `PRF`: an identity account has an encryption-passkey keyring.
- `LEGACY_SSO`: a pre-keyring identity account must migrate once with recovery.
- `LEGACY_PASSKEY`: the authenticated-passkey wire/storage mode. Legacy
  account-number accounts retain recovery; username accounts use the passkey
  wrapper without a recovery row.

## Account isolation

Tickets, syncable preferences, preference timestamps, and last-sync metadata
use account-scoped local snapshots. Logout snapshots and hides the active
account's values; signing into another account cannot expose the previous
account's wallet or preferences.

Identity-backed accounts use the same encrypted ticket sync as legacy
account-number accounts. Active and archived ticket wallets are encrypted
client-side with per-blob AES-GCM keys and stored under HMAC-derived opaque IDs;
the org receives ciphertext, not finalized ticket contents. Add/import/clear
mutations schedule sync. Redemption consumption is persisted locally without an
immediate sync for identity-backed accounts; its encrypted archive record is
uploaded by the next
initial/periodic sync so redemption is not followed by a deterministic
identity-authenticated request. Identity-free legacy accounts retain immediate
consumption sync. Empty arrays are encrypted. Clear/export operations erase the
redeemable secrets locally and sync encrypted SHA-256 deletion tombstones;
remote merges honor those hashes and immediately invalidate other tabs without
letting stale account notifications clear the current cache.

Because OAuth authorizes that opaque store, the org can associate sync request
timing, blob sizes, and stable opaque blob IDs with the identity account. It
still cannot decrypt the blobs or determine which finalized tickets they
contain. Ticket redemption remains a separate, identity-free protocol request.
However, ticket-wallet sync makes the strongest identity-unlinkability claim
inapplicable to sync metadata: a malicious org can attempt to correlate a later
identity-authenticated sync with redemption timing or wallet-size changes.
Deferring redemption-triggered sync reduces that signal but does not
cryptographically eliminate it.

Google cannot be attached to an existing legacy account. OAuth login
creates or resolves a dedicated identity account partition; `link` mode is
rejected by both client and server. This avoids silently changing the identity
and recovery semantics of an existing account namespace.

Unscoped values from an older build are adopted when a new account is created
on that device, matching legacy account creation. Returning accounts adopt only
when the browser already remembers the same account. Otherwise values are
preserved in an explicit `sync-unclaimed-data` snapshot and restored on logout;
canceling setup before a scope is activated leaves them untouched.

Scope transitions, ticket mutations, and syncable-preference writes use the same
origin-wide Web Lock. A scope switch updates the saved snapshot, live values,
and persisted active marker in one IndexedDB transaction. Store caches are
reloaded or invalidated on a scope event. Every read/write and sync verifies
that the tab's local account matches the persisted active marker, so a stale
background tab cannot read or mutate another account's live values.

Legacy WebAuthn authentication credentials and SSO encryption credentials use
separate persisted IDs. Migrating a linked legacy account therefore does not
replace the credential hint used by `/auth/challenge`.
