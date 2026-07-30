# Encryption Passkeys

Google and GitHub are account authenticators. They authorize access to an OA
account's opaque sync records, but they are never used as encryption keys. New
SSO accounts use a separate WebAuthn PRF passkey to unlock encryption locally.

## New-account flow

1. The org completes OAuth and maps the provider's stable subject to an internal
   OA account ID.
2. The browser generates a random 256-bit account master key.
3. The browser creates a resident, user-verified WebAuthn credential with the
   `prf` extension. The credential is scoped to the app's WebAuthn RP/origin.
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

## Returning-device flow

After OAuth authentication, the browser reads `GET /auth/keyring`, supplies the
returned credential IDs as `allowCredentials`, evaluates the PRF locally, and
decrypts the matching master-key wrapper. A synced passkey can therefore unlock
the same data on another device without an OA account number or recovery code.

The org sees the opted-in identity mapping, internal account ID, passkey
credential ID, wrapper format metadata, and ciphertext. It never receives the
PRF output or plaintext master key.

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

The encrypted-sync blob format remains compatible: HKDF-derived AES-GCM keys and
HMAC-derived opaque IDs still use the same version-1 labels. This change replaces
the SSO key-unlock mechanism; it does not re-encrypt existing sync blobs into a
new wire format.

## Recovery and migration

New SSO accounts do not receive an account number or recovery code in the UI and
do not upload a recovery wrapper. Losing every copy of the encryption passkey
means the encrypted data cannot be recovered; successful OAuth authentication
alone is intentionally insufficient.

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
- `LEGACY_PASSKEY`: an identity-free account keeps its existing WebAuthn
  authentication and account-number recovery flow.

## Account isolation

Tickets, syncable preferences, preference timestamps, and last-sync metadata
use account-scoped local snapshots. Logout snapshots and hides the active
account's values; signing into another account cannot expose the previous
account's wallet or preferences.

Identity-backed accounts deliberately exclude inference tickets from encrypted
sync. Ticket blobs and their opaque IDs are never built, pushed, or applied for
those accounts, and ticket changes do not schedule an identity-authenticated
sync request. Tickets remain device-local while preferences can sync. This
prevents encrypted-sync timing or blob-size metadata from joining a provider
identity to ticket activity.

For the same reason, GitHub or Google cannot be attached to an existing legacy
account. OAuth login creates or resolves a dedicated identity account partition;
`link` mode is rejected by both client and server. This avoids retroactively
joining an identity to a namespace that may contain historical ticket-sync
metadata.

Unscoped values from an older build are adopted only when the browser already
remembers the same account. Otherwise they are preserved in an explicit
`sync-unclaimed-data` snapshot and restored on logout; canceling setup before a
scope is activated leaves them untouched.

Scope transitions, ticket mutations, and syncable-preference writes use the same
origin-wide Web Lock. A scope switch updates the saved snapshot, live values,
and persisted active marker in one IndexedDB transaction. Store caches are
reloaded or invalidated on a scope event. Every read/write and sync verifies
that the tab's local account matches the persisted active marker, so a stale
background tab cannot read or mutate another account's live values.

Legacy WebAuthn authentication credentials and SSO encryption credentials use
separate persisted IDs. Migrating a linked legacy account therefore does not
replace the credential hint used by `/auth/challenge`.
