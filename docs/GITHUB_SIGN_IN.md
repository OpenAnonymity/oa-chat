# GitHub Sign-In

GitHub OAuth is an optional account authentication method alongside passkeys.
It authorizes access to an OA sync account without changing the encrypted-sync
or unlinkable-inference boundaries.

## User flows

- **New account:** Continue with GitHub, authorize the OAuth app, then save the
  generated OA account number and five-word recovery code. The browser generates
  the master key and uploads only its recovery-code-wrapped ciphertext.
- **Existing passkey account:** Sign in with the passkey, choose **Connect
  GitHub**, confirm the passkey again, and authorize. The existing passkey and
  recovery wrappers are unchanged; either sign-in method can authenticate the
  same OA account.
- **Returning browser:** A browser that still has the locally persisted master
  key unlocks after session refresh. A new or explicitly logged-out browser must
  enter the recovery code once after GitHub authentication to decrypt the
  recovery-wrapped master key.
- **Recovery/add a passkey:** GitHub-only accounts still have a normal OA account
  number and recovery code. The existing recovery flow can add a passkey later.

GitHub authentication cannot be the encryption key: an OAuth access token is
server-visible, replaceable, and not a stable client secret. Deriving or storing
the master key at the org would violate zero knowledge.

## OAuth boundary

- `POST /auth/github/start` creates a single-use, ten-minute Redis state record,
  a PKCE verifier/challenge, and a state-specific HttpOnly `SameSite=Lax`
  browser nonce so concurrent tabs do not overwrite each other.
- GitHub is asked for no scopes. The callback exchanges the code on the org,
  calls `/user`, retains only the numeric `id`, and immediately discards the
  access token and all other response fields.
- The callback stores only `(provider=github, provider_subject=numeric_id,
  account_id)`.
- The callback returns no OAuth or OA token to JavaScript. It sets the existing
  HttpOnly OA refresh cookie and sends a fixed `postMessage` result to the exact
  allowlisted app origin.
- `POST /auth/github/setup` accepts only the client-encrypted recovery wrapper
  and Argon2id recovery verifier. `GET /auth/github/session` returns the opaque
  recovery wrapper only to an authenticated linked account.
- Linking requires an access JWT minted by a fresh passkey/recovery step-up;
  refresh-derived JWTs are rejected. A GitHub identity and an OA account are both
  unique within the provider mapping, preventing cross-account relinks.
- If the browser already remembers a different local OA account, login mode
  carries it as an expected account and becomes resolve-only: the callback never
  creates a new GitHub mapping before the client can reject an account mismatch.

## Deployment configuration

Create a GitHub OAuth App with the deployed app homepage and the org callback:

```text
https://<org-host>/auth/github/callback
```

Configure the org:

```dotenv
GITHUB_OAUTH_CLIENT_ID=...
GITHUB_OAUTH_CLIENT_SECRET=...
GITHUB_OAUTH_CALLBACK_URL=https://<org-host>/auth/github/callback
GITHUB_OAUTH_RETURN_ORIGINS=["https://<chat-host>"]
```

For local development use `http://localhost:8080` as the homepage and
`http://localhost:8005/auth/github/callback` as the callback.

## Regression checks

1. Create, log out, and sign back into a passkey account.
2. Connect GitHub to that unlocked account; verify the passkey still works.
3. Log in with GitHub on a browser without the local key; verify the recovery
   code is required and encrypted sync succeeds after unlock.
4. Create a GitHub-first account, save both recovery values, complete setup, and
   verify one encrypted sync blob is present.
5. Reject an unallowlisted return origin, a missing/mismatched nonce, replayed
   OAuth state, a link to another account, and setup without a linked JWT.
