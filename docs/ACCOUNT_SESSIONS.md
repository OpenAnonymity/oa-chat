# Account Sessions

The account UI uses one `sessionService` API in browser and Electron. OA still
performs passkey/WebAuthn PRF authentication and owns the encrypted master-key
and sync protocols. SuperTokens owns only access/refresh token creation,
rotation, verification, revocation, and retry.

## Browser path

`chat/services/sessionService.js` initializes the SuperTokens Session recipe in
cookie mode. Account and encrypted-sync requests go through
`sessionService.fetch(...)`; the SDK supplies HttpOnly cookies, refreshes via
`POST /auth/session/refresh` when necessary, and retries the original protected
request once.

The SDK interceptor and `sessionService.fetch(...)` are both restricted to the
org origin's `/auth` path. This is a privacy boundary, not just request routing:
account cookies must never be attached to ticket issuance/redemption, sharing,
model metadata, or other org endpoints. Those paths continue through
`networkProxy`, whose direct-fetch paths force `credentials: 'omit'`.

No account access or refresh token is present in an OA response model or stored
in IndexedDB/localStorage. The browser continues to persist the client-only
master key separately for local encrypted data, which is not session-token
storage.

## Electron path

The renderer calls the same `sessionService` methods. Its implementation
delegates to the `window.electronAPI` session bridge:

- `authSessionInit`
- `authSessionFetch` / `authSessionAbort`
- `authSessionExists`
- `authSessionRefresh`
- `authSessionSignOut`
- `onAuthSessionExpired`

The SuperTokens SDK itself runs in oa-desktop's context-isolated preload in
header mode. The renderer never receives token getters or private SuperTokens
response headers. oa-desktop encrypts the SDK token jar with OS-backed
`safeStorage` in the main process; if strong OS encryption is unavailable it is
memory-only.

The browser and desktop therefore share session semantics and endpoints while
using the transport appropriate to each runtime. `X-Client-Platform` and the
old body-token/cookie split are no longer part of account authentication.

## Account state behavior

- `accountService.init()` initializes the session SDK before restoring account
  state. A persisted master key can make local ciphertext immediately usable;
  session verification then happens in the background.
- Successful registration, passkey login, and recovery confirm session
  existence but do not read tokens.
- `syncService` keeps only the master key. All protected sync requests use
  `sessionService.fetch`; its outer retry handles transient network/server
  failures, not authentication refresh.
- A SuperTokens expired/revoked event stops sync, zeroes in-memory key bytes,
  removes the persisted master key, and leaves the account locked.
- Logout calls SuperTokens signout before clearing local state so the server can
  revoke the current refresh session.

## Build and regression guard

The plain browser development server cannot resolve npm bare imports. Run
`npm run vendor:supertokens` after upgrading `supertokens-web-js`; this bundles
the Session-only entry point into `chat/vendor/supertokens-session.js`. The
production build regenerates and consumes that same checked-in vendor module.

`test/sessionArchitecture.test.mjs` guards against reintroducing manual refresh
endpoints, bearer headers, renderer token accessors, or session interception
outside `/auth`.
