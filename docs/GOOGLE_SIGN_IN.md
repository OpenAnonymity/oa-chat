# Google Sign-In

Google OAuth/OpenID Connect is an optional OA account authenticator. It
authorizes access to opaque account records without becoming the encryption key
or entering the unlinkable-inference path. See
[Encryption Passkeys](ENCRYPTION_PASSKEYS.md) for the shared keyring design.

## User flows

- **New SSO account:** Continue with Google, authorize the app, then create an
  encryption passkey. No OA account number or recovery code is shown.
- **Returning browser:** Google authenticates first. A logged-out or new browser
  then uses the synced PRF passkey to decrypt the account master key locally.
  A browser that retains the non-extractable local keys restores without another
  passkey prompt.
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

For local development use `http://localhost:8005/auth/google/callback` as the
authorized redirect URI. The org—not browser JavaScript—performs the code
exchange, so a JavaScript origin is not required for the Google client.
`npm run dev` serves the chat on port `8080`; browser API calls go directly to
the local org on port `8005`, while the OAuth popup callback remains on
canonical `localhost:8005`. Allow the chat origin in the local org's CORS and
OAuth return-origin settings. The commercial wrapper uses `localhost:8081`.
Do not open either client as `127.0.0.1`: Google returns to the configured
`localhost` callback, and OAuth nonce cookies are host-specific.

## Regression checks

1. Create a Google-first account; verify the only post-OAuth secret step is
   creating a PRF passkey and encrypted sync succeeds.
2. Log out, sign in with Google, unlock with the passkey, and verify no account
   number or recovery code is requested.
3. Exercise the legacy SSO recovery migration and verify later unlocks use only
   the new encryption passkey.
4. Create an account with an existing local wallet, then verify that wallet and
   later ticket additions/clears restore on a second passkey-unlocked browser.
   Verify redemption itself schedules no immediate sync, its consumed state
   restores after a periodic/next-login sync, and tickets/preferences do not
   cross account scopes.
5. Reject an unallowlisted return origin, missing/mismatched nonce, replayed
   OAuth state, every link request, and a keyring overwrite.
