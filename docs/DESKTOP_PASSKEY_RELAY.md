# Desktop Passkey Relay

OA Desktop cannot evaluate an encryption passkey inside its `app://` renderer
because WebAuthn credentials are scoped to a normal HTTPS relying-party origin.
It opens a small, static page in the system browser instead.

## Combined sign-in flow

New Desktop builds negotiate flow version 2 with oa-org. When the server gate is
enabled, one system-browser tab performs both account authentication and local
encryption unlock:

1. Desktop starts a one-use listener on a random `127.0.0.1` port and opens the
   relay with a 128-bit nonce plus the exact same-origin Desktop authorization
   URL in the fragment.
2. The relay saves only the nonce, port, and creation time in tab-scoped
   `sessionStorage`, removes the fragment, and navigates that tab through Google.
3. After OAuth, oa-org returns the tab to the relay with an opaque, one-use
   completion code and passkey-context token in a fragment. The relay removes
   it immediately.
4. The relay consumes the context from oa-org without cookies. It receives only
   the operation, the verified email needed to label a new credential, or the
   account's registered credential IDs.
5. Touch ID or the passkey manager evaluates the PRF locally. The relay sends
   the OAuth code and PRF result directly to Desktop through the nonce-bound
   loopback listener. Desktop exchanges the PKCE-bound code, then oa-chat uses
   the PRF output to wrap or unwrap the account master key locally.

The PRF output and plaintext master key never reach oa-org. If the server does
not negotiate flow 2, or if the combined passkey step cannot finish, Desktop
retains the existing two-step flow below.

## Legacy passkey-only flow

1. Desktop starts a one-use HTTP listener on a random `127.0.0.1` port and
   creates a random nonce.
2. Desktop opens the configured HTTPS relay with the nonce, port, operation,
   and serialized WebAuthn options in the URL fragment. Fragments are not sent
   to the web server, and the relay removes the fragment immediately.
3. The relay invokes the browser WebAuthn API. Touch ID or the user's passkey
   manager evaluates the PRF extension for the relay page's RP/origin.
4. The relay form-posts the serialized credential result to the one-use
   loopback listener. Desktop validates the request origin and nonce before
   returning the result to oa-chat.

In the legacy flow the relay has no account or org API calls. In the combined
flow its only org call atomically consumes the sanitized, account-bound context;
the WebAuthn assertion and PRF output still return only to Desktop.

## Build configuration

The production relay remains the default. A staging Desktop package must build
its pinned oa-chat artifact with the exact staging relay page:

```bash
OA_ORG_ORIGIN=https://oa-staging-main.vercel.app \
OA_WEBAUTHN_RELAY_URL=https://oa-staging-main.vercel.app/passkey-relay.html \
npm run package
```

`OA_WEBAUTHN_RELAY_URL` is recorded in `dist/build.json`; OA Desktop validates
and reads that packaged value. Changing a deployed frontend domain therefore
requires rebuilding Desktop with that domain's exact relay URL and configuring
oa-org's `WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` for the same HTTPS origin.
