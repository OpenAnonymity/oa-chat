# Google Sign-In

Google OAuth/OpenID Connect is an optional account authentication method
alongside passkeys and GitHub. It authorizes access to an OA sync account
without changing the encrypted-sync or unlinkable-inference boundaries.

## User flows

- **New account:** Continue with Google, authorize the app, then save the
  generated OA account number and five-word recovery code. The browser
  generates the master key and uploads only its recovery-code-wrapped
  ciphertext.
- **Existing account:** Sign in with a passkey, choose **Connect Google**,
  confirm the passkey again, and authorize Google. Existing passkey and
  recovery wrappers remain unchanged.
- **Returning browser:** A browser with its locally persisted master key
  unlocks normally. A new or explicitly logged-out browser must enter the
  recovery code after Google authentication.
- **Recovery/add a passkey:** Google-first accounts retain a normal OA account
  number and recovery code. The existing recovery flow can add a passkey.

Google authentication cannot be the encryption key. OAuth credentials are
server-visible and replaceable, so the browser continues to own all sync-key
generation and decryption.

## OAuth boundary

- `POST /auth/google/start` creates a single-use, ten-minute Redis state record,
  PKCE verifier/challenge, and a state-specific HttpOnly `SameSite=Lax` browser
  nonce.
- Google is requested with only the `openid` scope. The callback exchanges the
  code on the org, calls the OpenID Connect userinfo endpoint, retains only
  `sub`, and immediately discards the access token and all other fields.
- The org stores only `(provider=google, provider_subject=sub, account_id)`.
- The callback returns no OAuth or OA token to JavaScript. It sets the existing
  HttpOnly OA refresh cookie and posts a fixed completion message to the exact
  allowlisted app origin.
- `POST /auth/google/setup` accepts only the client-encrypted recovery wrapper
  and Argon2id recovery verifier. `GET /auth/google/session` returns the opaque
  recovery wrapper only to the authenticated linked account.
- Linking requires an access JWT minted by a fresh passkey/recovery step-up;
  refresh-derived JWTs are rejected.
- Login with a locally remembered account is resolve-only, so an account
  mismatch cannot create a new Google mapping.

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
`npm run dev` proxies browser API calls to the local org, while the OAuth popup
callback remains on canonical `localhost:8005` so its origin can be validated.
Requests made to the development server via `127.0.0.1` are redirected to
`localhost` before the app loads.

## Regression checks

1. Create, log out, and sign back into a passkey account.
2. Connect Google to that unlocked account; verify passkey login still works.
3. Log in with Google without a local key; verify the recovery code is required
   and encrypted sync succeeds after unlock.
4. Create a Google-first account, save both recovery values, complete setup,
   and verify an encrypted sync blob is present.
5. Reject an unallowlisted return origin, missing/mismatched nonce, replayed
   OAuth state, cross-account link, and setup without a linked JWT.
