# Google Sign-In

Google OAuth/OpenID Connect is an optional OA account authenticator. It
authorizes access to opaque account records without becoming the encryption key
or entering the unlinkable-inference path. See
[Encryption Passkeys](ENCRYPTION_PASSKEYS.md) for the shared keyring design.

## User flows

- **Commercial landing handoff:** `/chat/?auth=google` is a one-use UI intent,
  not proof of authentication and not a Membership request. The chat waits for
  initial account restoration before routing it. A restored Google account may
  continue directly when verified and unlocked, or show its encryption-passkey
  surface when locked. If the restored identity is a username or legacy account,
  the handoff logs it out, clears the saved local binding, and then shows the
  Google sign-in surface without a switch confirmation. The client removes
  `auth` with `history.replaceState`, preserving unrelated query parameters and
  the hash. It never opens the signed-in Account summary automatically. The
  neighboring username field uses its own
  `/chat/?auth=username#username=...` handoff and never enters Google OAuth.
- **Registration picker:** Account entry offers Google or a pseudonymous
  username. Legacy account-number passkey login remains available through its
  explicit alternate mode; recovery controls appear only in that legacy mode.
- **New SSO account:** Continue with Google, authorize the app, then create an
  encryption passkey. No OA account number or recovery code is shown.
- **Returning browser:** Google authenticates first. A logged-out or new browser
  then uses the synced PRF passkey to decrypt the account master key locally.
  A browser that retains the non-extractable local keys restores without another
  passkey prompt. Until that unlock succeeds, the sidebar says **Unlock encrypted
  data** rather than presenting the Google session as a fully unlocked account.
  Closing the unlock dialog does not end the Google session; tickets and
  preferences stay locked, and the dialog's explicit **Log out** action ends it.
- **Desktop app:** Continue with Google opens one system-browser tab. On capable
  deployments, that tab completes Google and then creates or unlocks the
  encryption passkey before returning a one-use PKCE-bound code and local PRF
  result to Desktop. Older deployments retain the two-step browser handoff.
- **Switching Desktop accounts:** A signed-out device still binds Google sign-in
  to its saved OA account to prevent silent identity replacement. The Account
  dialog exposes an explicit **Forget saved account** action when the user
  intends to switch to a different Google account. The action is driven by a
  boolean saved-binding state rather than requiring the signed-out dialog to
  display or otherwise expose the saved account identifier.
- **Legacy SSO migration:** Accounts created by the recovery-wrapper build enter
  their five-word code once, then replace that unlock path with an encryption
  passkey.
- **Existing passkey-only account:** The legacy account-number/recovery system
  remains compatible, but Google cannot be attached to it. OAuth uses a
  separate identity account partition.

Google credentials are server-visible and replaceable, so they cannot be the
encryption key. Losing every copy of the encryption passkey makes new SSO
accounts' encrypted data unrecoverable even when Google authentication succeeds.

## OAuth boundary

- `POST /auth/google/start` creates a single-use, ten-minute Redis state record,
  PKCE verifier/challenge, and state-specific HttpOnly `SameSite=Lax` browser
  nonce.
- Google is requested with `openid email`. The org exchanges the code, calls
  the OpenID Connect userinfo endpoint, and retains `sub` plus the verified
  email before discarding the access token.
- The callback stores `(provider=google, provider_subject=sub, email,
  account_id)`. The authenticated session returns the email so the browser can
  use it as the encryption passkey's WebAuthn username. The popup returns no
  token or profile data to JavaScript; it sets the HttpOnly OA refresh cookie
  and posts a fixed result to the exact allowlisted app origin.
- `GET /auth/keyring` returns opaque PRF-passkey wrappers only to the
  authenticated account. `POST /auth/keyring` appends a client-produced wrapper;
  it never receives WebAuthn registration or assertion data.
- Refresh sessions preserve the original authentication method and time.
- The Electron renderer receives no OAuth code or rotating session token.
  State, PKCE, code exchange, header-mode refresh, and encrypted credential
  storage live behind the context-isolated desktop bridge.
- `link` mode is rejected. A provider identity cannot be attached to a legacy
  account namespace with different identity and recovery semantics.
- If the browser remembers a different local OA account, login carries it as an
  expected account and is resolve-only. The callback cannot create a new Google
  mapping before the client rejects an account mismatch.
- Identity-backed accounts sync encrypted active/archived ticket wallets and
  preferences using the same opaque blob format as legacy accounts. Existing
  device tickets are adopted when the Google account is first created.
- Ticket redemption does not trigger an immediate identity-authenticated sync.
  Consumed-state tombstones propagate on the next initial/periodic sync. This
  reduces direct timing correlation, but identity-bound sync timing and blob
  sizes remain observable metadata.

## Deployment configuration

Create a Google Auth Platform web client with the org callback:

```text
https://<org-host>/auth/google/callback
```

Configure the org:

```dotenv
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_OAUTH_CALLBACK_URL=https://<org-host>/auth/google/callback
GOOGLE_OAUTH_RETURN_ORIGINS=["https://<chat-host>"]
```

Build the web client embedded in OA Desktop for the same org environment:

```bash
OA_ORG_ORIGIN=https://<org-host> npm run build
```

The value is compiled into the artifact and must be an exact HTTPS origin.
Desktop additionally enforces its own exact allowlist in the main process, so
renderer code cannot redirect account credentials to another service.

For local development use `http://localhost:8005/auth/google/callback` as the
authorized redirect URI. The org—not browser JavaScript—performs the code
exchange, so a JavaScript origin is not required for the Google client.
`npm run dev` proxies browser API calls to the local org, while the OAuth popup
callback remains on canonical `localhost:8005`.

## Regression checks

1. From the commercial landing page, verify Google opens exactly one Google
   sign-in surface, a remembered unlocked session opens no dialog,
   and a remembered locked session opens only its passkey surface. No signed-
   out or Account-summary dialog may flash while authentication is unresolved,
   and `auth=google` must be removed without dropping unrelated URL state.
2. Create a Google-first account; verify the only post-OAuth secret step is
   creating a PRF passkey and encrypted sync succeeds. Account closes without
   an intermediate success screen; commercial builds open Membership through
   the first-account-ready extension seam.
3. Log out, sign in with Google, unlock with the passkey, and verify no account
   number or recovery code is requested.
4. Exercise the legacy SSO recovery migration and verify later unlocks use only
   the new encryption passkey.
5. Create an account with an existing local wallet, then verify that wallet and
   later ticket additions/clears restore on a second passkey-unlocked browser.
   Verify redemption itself schedules no immediate sync, its consumed state
   restores after a periodic/next-login sync, and tickets/preferences do not
   cross account scopes.
6. Reject an unallowlisted return origin, missing/mismatched nonce, replayed
   OAuth state, every link request, and a keyring overwrite.
7. In OA Desktop, verify the system-browser handoff returns to both a running
   and cold-started app; reject a wrong state, wrong PKCE verifier, replayed
   code, arbitrary callback host/path, and unallowlisted org origin.
