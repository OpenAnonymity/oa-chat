# Local Station v2 Learning Mode

This mode exercises the local access path:

```text
oa-chat -> local oa-org -> local station v2 -> OpenRouter
```

The browser never calls station directly. It redeems finalized tickets with oa-org;
oa-org verifies and reserves them, signs an OrgAuth JWT for station, and relays the
request to station. After station creates a bounded child key, oa-org commits the
ticket spend and returns the signed result to oa-chat. Inference then goes directly
from the browser to OpenRouter using that child key.

Before returning the key, oa-org validates the station ID, exact tier credit and
duration, matching UTC expiry fields, and the station's Ed25519 signature using the
public key learned from certified heartbeats. It then adds its own Ed25519 signature;
if essential response validation or signing fails, the provisional ticket spend is
rolled back. Station stores a SHA-256 digest of each used OrgAuth JWT ID atomically
in its local SQLite TTL store through JWT expiry, so replay rejection survives a
station restart and is shared by workers using that database.

For explicit loopback development, the browser may activate the station-issued child
key without calling the production verifier. This happens only when both the oa-chat
page and configured oa-org URL use exact loopback hostnames over HTTP(S). The resulting
proof is labeled `local-loopback-bypass`, not `verified`; Chat and Parallel/Council use
the same rule. The key cannot be included in a shared chat, and persisted bypass keys
are discarded when the client is later opened outside loopback.

Any non-loopback or mixed local/remote configuration follows the deployed verifier
path. The browser activates the key only after an explicit `verified` response, while
`pending`, `unverified`, `rejected`, malformed, and network-error outcomes fail closed.
A failed browser verification does not restore the ticket because station provisioning
has already succeeded; the bounded child key is discarded locally and expires after
its configured lifetime.

Local diagnostics must never contain raw tickets, authorization headers, management
keys, or child inference keys. The actual child key remains only in session access
state so the browser can call OpenRouter.

A verifier-approved key with a credit limit of $0.05 or less sets `max_tokens` to 512
for direct OpenRouter inference. Without that output bound,
OpenRouter can reject a request before generation because the model's unconstrained
maximum cost exceeds the child key's remaining credit. Keys with a larger credit
limit keep their existing output behavior.

For the current learning-mode browser check, web search, relay, and memory should be
disabled to avoid unrelated network work. The current chat revision always enables
reasoning for text inference, so select the lowest reasoning effort; this local mode
does not introduce a separate reasoning bypass.
