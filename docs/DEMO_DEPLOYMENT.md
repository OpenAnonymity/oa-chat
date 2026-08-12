# Disposable Demo Frontend Routing

Production builds use `https://org.openanonymity.ai`. Disposable AWS demos must
instead keep browser account, billing, ticket, and sync traffic on the Vercel
frontend origin so SuperTokens cookies remain first-party and the build cannot
silently contact production.

After the mock oa-org HTTPS tunnel is healthy, generate a deployment-only
Vercel configuration at an explicit temporary path:

```bash
OA_DEMO_ORG_ORIGIN=https://mock-org-tunnel.example \
  OA_DEMO_VERIFIER_BYPASS=true \
  npm run vercel:demo-config -- /tmp/oa-demo-vercel.json
vercel deploy --prod --local-config /tmp/oa-demo-vercel.json --project <demo-project>
```

Use the disposable project's stable production hostname for every backend
origin below. A preview deployment has a unique hostname and will not receive
cookies or OAuth callbacks configured for the stable project domain.

The generator accepts only an exact HTTPS origin. Its build command compiles
`OA_ORG_SAME_ORIGIN=true`, and its ordered rewrites proxy only `/auth/*`,
`/api/*`, and `/chat/*` before the SPA fallback. Never put org, OAuth, Stripe,
station, provider, ticket, or SuperTokens secrets in the frontend build or
Vercel environment.

The deploy upload includes the initialized `nanomem` source and the root
`vector/` and `local_inference/` targets referenced by symlinks under `chat/`,
but deliberately excludes all `.git` metadata. `npm run build` therefore skips
submodule setup when `nanomem/src` is already present. Initialize the submodule
locally before deploying; do not upload repository metadata or add a Git
credential to the Vercel build merely to repeat submodule setup. Keep the final
nested `.git` and `.env*` deny rules after every broad allowlist in
`.vercelignore`; their ordering prevents a future vendored directory from
reintroducing local metadata or environment files.

`OA_DEMO_VERIFIER_BYPASS=true` is an explicit test-only deviation for a
disposable station that is not registered with the production hardware
verifier. It works only in an HTTPS same-origin build, is rejected on
`openanonymity.ai` and every subdomain, never contacts the production verifier, marks keys as
unverified, and prevents sharing them. Omit it when an isolated verifier is
available; provider-backed chat will otherwise remain fail-closed. Deployment
must not enable this flag without the user's explicit acceptance.

Configure the backend with the stable Vercel origin consistently:

- `SUPERTOKENS_API_DOMAIN` and `SUPERTOKENS_WEBSITE_DOMAIN`: Vercel origin
- `WEBAUTHN_ORIGIN`: Vercel origin; `WEBAUTHN_RP_ID`: its hostname
- `GOOGLE_OAUTH_CALLBACK_URL`: `<vercel-origin>/auth/google/callback`
- Google authorized JavaScript/callback origins: the same Vercel origin

Verify the secure nonce cookie on OAuth start, callback completion, account
cookie refresh, billing authentication, and encrypted wallet sync after every
tunnel or frontend redeploy.

The generated file is ephemeral deployment state because the tunnel hostname
may rotate. Regenerate it after a tunnel restart, verify the three destinations,
and remove it during teardown.
