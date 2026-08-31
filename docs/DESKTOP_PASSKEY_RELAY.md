# Desktop Passkey Relay

OA Desktop cannot evaluate an encryption passkey inside its `app://` renderer
because WebAuthn credentials are scoped to a normal HTTPS relying-party origin.
It opens a small, static page in the system browser instead.

## Flow

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

The relay has no account or org API calls. The WebAuthn assertion and PRF output
return only to the local Desktop process and are never sent to oa-org.

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
