# Disposable Integrated Demo — 2026-08-11

This is the secret-free run record for the disposable SSO, SuperTokens,
Stripe billing, monthly ticket-key rotation, and OpenRouter chat demo. The
environment is test-only. Teardown was originally planned for 2026-08-12; the
user requested a final upgrade-flow repair on that date, so it remains
live only for this validation and must be torn down when the user confirms the
demo is no longer needed.

## Resolved source

- deployed oa-chat runtime: `3f64525a73ddca28634ecbd9478fb609313d73b0`
  (`codex/integrated-subscription-rotation`)
- user-facing upgrade/registration fix: `12d2f31ea5dbea8057a25397bc660494476f8cc6`;
  Vercel symlink-target packaging and final nested metadata/env deny rules are
  the two following commits included in the deployed runtime above.
- oa-org: `c21f179acffce5b6c0be61fed5be0ac24652c081`
- oa-station: `627556f5d933f34881c801fd451d7160a00a508d`
- Services: `oa-org`, `oa-org-tunnel`, `oa-station`, and the local
  `current-supertokens-*` Docker Compose services.

## AWS resources

- Account/profile: `427880590996` / `PowerUserAccess-427880590996`
- Region/AZ: `us-west-2` / `us-west-2a`
- VPC/subnet: `vpc-0a3ab48f5972d7331` /
  `subnet-0b8aa4c0c622cabf6`
- oa-org: `i-00260443022bfb718`, `t3.small`, public
  `18.236.111.64`, private `172.31.33.213`, security group
  `sg-0aa04203a116b6a1b`, encrypted 16-GiB volume
  `vol-0badb5310390f428e`.
- oa-station: `i-0df039bb513c6969f`, `t3.small`, public
  `52.36.189.137`, private `172.31.34.102`, security group
  `sg-0edb5659bf0266f7e`, encrypted 16-GiB volume
  `vol-0e962f36589319653`.
- Both public addresses are auto-assigned and can change after stop/start.
  SSH is restricted to `64.124.162.234/32`. Port 8005 is allowed only from
  the station security group, and port 8000 only from the org security group.
- IMDSv2 is required and no instance profile is attached.

Approximate idle cost is about US$1.35/day for two on-demand `t3.small`
instances, 32 GiB of gp3 storage, and two public IPv4 addresses, before
traffic, Vercel, Stripe, or OpenRouter usage. Consult the AWS bill for the
authoritative amount.

## Frontend and external test resources

- Production demo URL:
  <https://oa-integrated-demo-20260807.vercel.app>
- Vercel project/deployment:
  `prj_ifs4YkKjGnUq5tmzvl5KPG6i4LYh` /
  `dpl_3L4VjDV2fkKm87RsK5TZUXRz9RQa`.
- Vercel build marker: `6OYETOED`.
- Org quick tunnel:
  `https://gather-imperial-kruger-challenge.trycloudflare.com`.
  It has no durable Cloudflare DNS resource; stopping the tunnel invalidates
  this hostname, and a restarted quick tunnel requires regenerated Vercel
  rewrites and a production redeploy.
- Stripe sandbox product/price IDs:
  `prod_V3W3uObhCZGEB0` / `price_1U3P1bA0v0eJ5dSdjctjx6nl` and
  `prod_V3W41whdmNWoPA` / `price_1U3P20A0v0eJ5dSdoEQLYu26`.
- Stripe sandbox webhook: `we_1U3P5kA0v0eJ5dSdRb66BGnk`.
- An accidental live product `prod_V3VlW3JD1fC1WG` was archived immediately;
  no live Price, customer, or charge was created.
- OpenRouter management key name:
  `oa-integrated-demo-20260811-v2`. The credential exists only in the
  station's protected environment file. The obsolete predecessor was deleted.

## Immutable release deployment note

Both Python services run from SHA-addressed release directories behind a
`current` symlink. A clean station archive needs one additional, secret-free
marker before the first service start: create
`/opt/oa-station/current/station/.env` as a zero-byte `root:root` file at mode
`0444`. The application checks for this local marker even though all real
configuration comes from systemd's `/etc/oa-station.env`. Omitting it causes a
restart loop. The marker contains no values and the protected systemd env file
remains `root:root` mode `0600`.

For example, after switching `current` and before starting the service:

```bash
sudo install -o root -g root -m 0444 /dev/null \
  /opt/oa-station/current/station/.env
```

## Enabled capabilities and validation

- Same-origin Vercel routing for `/auth/*`, `/api/*`, and `/chat/*` passed.
  The demo verifier bypass is compile-time, test-only, fail-closed on every
  `*.openanonymity.ai` hostname, and does not contact the production verifier.
- SuperTokens and its Postgres container are healthy. WebAuthn and cookie
  origins use the stable Vercel origin. An unauthenticated refresh correctly
  returned 401 and cleared the session-cookie boundary.
- Google OAuth is enabled for the stable Vercel origin and its exact callback.
  A real browser E2E passed Google account selection, PKCE/state/nonce
  validation, the 60-second one-time completion-token exchange, SuperTokens
  SDK interception, and the authenticated provider-session read. The popup
  disclosed neither provider tokens nor the OA account identifier. OAuth start
  also recovered from a stale invalid SuperTokens access cookie.
- On 2026-08-12, the prior quick-tunnel hostname had expired while Vercel still
  routed to it, which caused the user-visible `Premium billing is unavailable`
  and Google `Request failed` errors. The production rewrite now targets the
  current healthy tunnel. A new live browser run loaded the exact US$35/month,
  300-ticket plan without an error and completed Google account selection and
  the one-time OAuth callback exchange.
- Signed-out navigation and the premium CTA now say `Register and upgrade`.
  The registration chooser exposes only `Continue with Google`; direct
  passkey creation, passkey login, and standalone recovery are absent from
  that surface. The separate post-SSO encryption-passkey ceremony remains
  required to protect synced data and completed successfully with the real
  macOS authenticator. Pending-upgrade continuation is covered by browser-unit
  tests. The original one-time intent was lost when its browser tab closed
  during the physical-authenticator handoff, so the final live check reopened
  `Upgrade to Premium` from the authenticated account and reached hosted
  Stripe Checkout successfully.
- The OA account now retains the authenticated Google identity for this
  disposable demo. A real encryption passkey is installed, and the originating
  browser reports `Encrypted with your passkey` and a completed sync. A
  second-device restore was not performed, so cross-device encrypted Google
  wallet recovery is not claimed as E2E validated. No mock authenticator or
  mock Google credential was used.
- The superseded Google client secret was disabled and deleted after the live
  flow proved the replacement. Only the replacement remains enabled, only the
  protected org environment stores it, and the temporary local copy was
  removed.
- Stripe is in test mode. The public plan reports US$35/month for 300 tickets
  and US$7 for a 50-ticket pack. A correctly signed webhook was processed and
  its exact replay was classified as duplicate. An unsigned webhook returned
  400. A sandbox customer-portal session succeeded and the throwaway customer
  was deleted. On 2026-08-12 a real Stripe sandbox Checkout completed with
  Stripe's standard Visa test payment method: the US$21.51 prorated first
  charge succeeded and the US$35/month subscription became active, with the
  next period beginning on 2026-08-31. No real funds or live payment method
  were used. The browser restored the existing SuperTokens account after the
  Stripe return, reconciled the webhook-created 184-ticket prorated allowance,
  and privately imported exactly 184 tickets. Its visible wallet rose from 1
  to 185; a full reload remained at 185 and did not duplicate the allowance.
- The paid-return validation exposed and fixed an initialization race in which
  the billing component could reconcile before the persisted account session
  finished background verification. Checkout success and saved-session
  recovery now wait for the verified account context, and explicit cancellation
  waits fail-closed for the restored account scope. The focused billing tests
  pass 25/25 and the full oa-chat suite passes 402/402; a fresh adversarial
  review approved the change with no remaining findings.
- The global ticket generation is anchored to the first instant of each UTC
  month. Redis reports billing month `2026-08`; spent-nonce retention is 400
  days. The public issuer endpoint reports `can_issue=true`.
- The station is registered and certified. OrgAuth uses its 64-hex-character
  Ed25519 heartbeat fallback key. Provider telemetry is disabled; provider
  child-key cleanup remains enabled.
- Browser E2E passed: client-side blinding, two-ticket redemption, signed
  station-bound child-key issuance, TLS-over-WebSocket relay, and a real
  OpenRouter completion returning `OA demo ready`.
- Post-payment browser E2E also passed from the 184-ticket paid allowance:
  client-side tickets redeemed into a new station-bound key, TLS-over-WebSocket
  relay connected, and GPT-4o-mini returned a live OpenRouter response. Two
  other catalog selections returned upstream provider/no-endpoint errors before
  the stable model was selected; billing, issuance, and station redemption had
  already succeeded in those attempts.
- Post-hardening revalidation issued two blinded tickets, provisioned a real
  station-bound child key, completed a provider request, replayed the exact
  request successfully, and rejected cross-scope ticket reuse.
- Throwaway cleanup removed the two child keys created by the final paid E2E
  and their two station replay rows. The
  station has zero tracked/replay rows and the OpenRouter account is back at
  its pre-test baseline of one preserved unrelated child key. Invitation state
  is active 0 and used 0; the final invitation record and request replay were
  removed. The spent-nonce ledger and two completed-attempt tombstones remain
  intentionally for anti-replay retention; they contain no recoverable child
  key. Values are intentionally not recorded.
- Automated suites: deployed oa-chat runtime 402/402, including registration,
  plan-failure, OAuth-continuation, Vercel packaging, verified-session Checkout
  recovery, and slow cancellation restoration regressions; oa-org 177/177;
  oa-station 25/25.

The release env files are `root:root` mode `0600`. Journals on both disposable
hosts were rotated and vacuumed after the final redaction releases. The org
journal was rotated again after the live OAuth test so the earlier pre-filter
callback query record was removed. Current all-unit scans found zero OAuth
query material, credential values, or credential-derived prefixes. Local and
remote release archives, OAuth secret copies, temporary test scripts, response
bodies, build env files, replay-test directories, and failed Vercel deployments
were removed. No temporary Vercel token was created; the existing authenticated
session was used. The task-specific SSH private key is intentionally retained
at mode 0600 only while the environment remains live.

After the final frontend deployment, both `oa-org` and `oa-station` reported
`active`, `Result=success`, and `NRestarts=0`. Their local listeners returned
the expected org billing-plan HTTP 200 and station unmounted-root HTTP 404.
The current all-unit journal credential-pattern scans remained at zero after
the paid browser E2E and child-key cleanup.

The Stripe setup is disposable and test-only. It currently uses a broad test
secret enforced by backend test-mode checks, plus stripe-python 12.5.1 with API
version `2025-08-27.basil`. Before any production promotion, replace that key
with a least-privilege restricted key and upgrade/revalidate the Stripe SDK and
API version.

## Stop and teardown

Stop both instances (public IPs and the quick-tunnel hostname may rotate on
restart):

```bash
aws ec2 stop-instances \
  --profile PowerUserAccess-427880590996 --region us-west-2 \
  --instance-ids i-00260443022bfb718 i-0df039bb513c6969f
```

Terminate the exact disposable instances and wait:

```bash
aws ec2 terminate-instances \
  --profile PowerUserAccess-427880590996 --region us-west-2 \
  --instance-ids i-00260443022bfb718 i-0df039bb513c6969f
aws ec2 wait instance-terminated \
  --profile PowerUserAccess-427880590996 --region us-west-2 \
  --instance-ids i-00260443022bfb718 i-0df039bb513c6969f
```

After termination, remove the dedicated cross-references and security groups:

```bash
aws ec2 revoke-security-group-ingress \
  --profile PowerUserAccess-427880590996 --region us-west-2 \
  --group-id sg-0aa04203a116b6a1b --protocol tcp --port 8005 \
  --source-group sg-0edb5659bf0266f7e
aws ec2 revoke-security-group-ingress \
  --profile PowerUserAccess-427880590996 --region us-west-2 \
  --group-id sg-0edb5659bf0266f7e --protocol tcp --port 8000 \
  --source-group sg-0aa04203a116b6a1b
aws ec2 delete-security-group \
  --profile PowerUserAccess-427880590996 --region us-west-2 \
  --group-id sg-0aa04203a116b6a1b
aws ec2 delete-security-group \
  --profile PowerUserAccess-427880590996 --region us-west-2 \
  --group-id sg-0edb5659bf0266f7e
```

The two volumes are deletion-on-termination roots; verify they are absent
after the instance wait. Remove the local SSH material only after AWS teardown:

```bash
unlink /tmp/oa-integrated-demo.n6Gvy1/oa-integrated-demo-20260808-ed25519
unlink /tmp/oa-integrated-demo.n6Gvy1/oa-integrated-demo-20260808-ed25519.pub
unlink /tmp/oa-integrated-demo.n6Gvy1/known_hosts
```

Remove the disposable Vercel project from the already authenticated team:

```bash
vercel remove oa-integrated-demo-20260807 --yes \
  --scope team_RuDlwCKuvIERVUIsjPe4dElB
```

Before removing Stripe catalog resources, cancel every sandbox subscription
whose line item uses either exact demo price listed above, then delete only the
corresponding sandbox demo customer records. This includes the active
subscription created by the paid browser E2E; preserve every customer and
subscription that does not reference those exact demo prices. Then delete the
demo webhook, archive/delete both sandbox prices and products, and revoke
`oa-integrated-demo-20260811-v2` from OpenRouter Management Keys. Preserve all
other Stripe/OpenRouter resources and the pre-existing Vercel/AWS logins.

Delete the dedicated Google OAuth web client named `OA SSO Vercel Demo`
(`506663162190-4v4200umr5k3s29ms90me0aa8aohois9.apps.googleusercontent.com`)
from project `stoked-mapper-503821-u8`. This removes the remaining replacement
client secret and the demo callback/origin registration. Preserve every other
Google Cloud client, credential, project, and resource.
