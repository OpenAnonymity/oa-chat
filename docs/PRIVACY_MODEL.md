# Privacy Model: Unlinkable Inference

This document defines the full-system unlinkability and zero-trust model for
oa-chat users. It explains why no party in the OA system can link a user's
identity to their inference activity.

For the full technical description, see the blog post:
[Unlinkable Inference as a User Privacy Architecture](https://openanonymity.ai/blog/unlinkable-inference/).

For verifier-specific claims and attestation details, see
[TRUST_MODEL.md](https://github.com/openanonymity/oa-verifier/blob/main/docs/TRUST_MODEL.md)
in oa-verifier.

## What "Unlinkable Inference" Means

No party -- including the OA system and the inference provider -- can link a
specific user's identity to their specific inference activity. The user obtains
an ephemeral API key through blind signatures, uses it to talk directly to the
inference provider, and no entity can correlate who the user is with what they
asked.

The two formal properties (defined in blog post
[Section 3.1](https://openanonymity.ai/blog/unlinkable-inference/#31-threat-model)):

- **Identity-unlinkability**: sessions cannot be linked to the user's identity.
  Blind signatures ensure no party can link ticket issuance to redemption.
- **Cross-unlinkability**: sessions cannot be linked to each other. Each session
  uses a different ephemeral key. OA stations provide inference
  **confidentiality** (no OA system can observe prompt/response content) and
  **integrity** (no OA system can tamper with it).

**What OA does NOT claim**: OA does not claim that prompts are hidden from the
inference provider. Prompts must reach the model for inference to work. The claim
is that prompts are unlinkable to your identity and to each other -- the provider
sees anonymous requests from ephemeral keys with no way to know who sent them or
link them across sessions. See blog post
[Section 3.1.1](https://openanonymity.ai/blog/unlinkable-inference/#311-adversarial-inference-provider).

## How It Works End-to-End

### 1. Ticket issuance (blind signatures)

See blog post [Section 1: Blind Signatures](https://openanonymity.ai/blog/unlinkable-inference/#1-blind-signatures)
for the full cryptographic explanation.

The user obtains inference tickets using an invitation code. During issuance:

1. The client generates a random token and blinds it locally (via @cloudflare/privacypass-ts).
2. The blinded request is sent to the org/station via `/api/alpha-register`
  along with the invitation code (credential).
3. The org/station signs the blinded request without seeing the underlying token.
4. The client receives the signed blinded response and unblinds it locally to
  produce a finalized ticket.

**What the org sees at issuance**: the invitation code (which may be
identity-linked) and the blinded requests. It knows "credential X produced N
blinded requests." But it only ever sees the blinded form -- it never sees the
underlying tokens.

### 2. Requesting ephemeral API keys (ticket redemption)

The user redeems a small number of finalized tickets for an ephemeral API key
(the number depends on the model, e.g. 1, 3, or 10 -- far fewer than the bulk
batch obtained at issuance):

1. The client sends finalized tickets to the org/station via `/api/request_key`.
2. The org/station validates the tickets (not double-spent) and issues an
  ephemeral API key with station + org signatures.
3. The client receives the key.

**What the org sees at redemption**: finalized (unblinded) tickets -- for the
first time. These are cryptographically unlinkable to the blinded requests from
step 1. Even with complete records of both issuance and redemption, the org
cannot correlate "I signed blinded request B for credential X" to "finalized
ticket T was just redeemed." This is precisely what blind signatures guarantee
(see blog post [Section 3.1.3: OA-Proxy Collusion](https://openanonymity.ai/blog/unlinkable-inference/#3-putting-it-together)).

Timing side-channels (correlating issuance timing to redemption timing) are
weakened by the large volume of tickets issued across many users and the
decorrelation between bulk purchase and individual per-session redemption. Even
if such a side-channel were somehow exploited, no OA system sees prompts or
responses -- the user's queries remain unlinkable and anonymous regardless.

### 3. Inference (direct to provider)

See blog post [Section 2: Secure Inference Proxies](https://openanonymity.ai/blog/unlinkable-inference/#2-secure-inference-proxies)
for the secure proxy architecture and ephemeral access key pattern.

The user sends prompts directly to the inference provider:

1. The client sends `Authorization: Bearer <ephemeral_key>` to the provider.
2. The provider processes the request and returns the response.
3. No OA system (org, station, verifier) is in this data path.

The provider sees inference from an anonymous ephemeral key. It has zero
information about who holds that key.

### 4. Key verification (verifier)

The client submits the key to the verifier for station compliance verification:

1. The client sends the key + signatures to `POST /submit_key`.
2. The verifier uses the raw key transiently for signature verification,
  immediately hashes it (SHA-256), and checks ownership via OpenRouter's API.
3. The raw key is never stored, logged, or reported. Only a truncated hash
  prefix (16 hex chars) appears in structured logs.

Even if the verifier retained the key, it could not link it to a user identity
because the key was issued through blind signatures with no user identity attached.

## What Each Component Can and Cannot See


| Actor | What it sees | Can it identify the user? | Why not? |
|---|---|---|---|
| **Org / Station** | Blinded requests at issuance, finalized tickets + issued API keys at redemption, station governance events | No | Blind signatures make blinded requests (issuance) cryptographically unlinkable to finalized tickets (redemption). The org knows "credential X -> N blinded requests" but cannot determine which finalized tickets those became. Never sees inference content. |
| **Verifier** | API key hash (transient), station signatures, broadcast status | No | Raw key used transiently and immediately hashed. Key carries no user identity (blind signatures). |
| **Inference provider** | API key + inference content (prompts/responses) | No | Key is ephemeral and anonymous. No user identity binding. Even a malicious provider cannot link prompts to a user or across sessions. |
| **User** | Everything (their own tickets, keys, prompts, responses) | N/A | The user is the only party who can link all steps together. |


## What If Any OA Component Is Malicious?

See blog post [Section 3.1: Threat Model](https://openanonymity.ai/blog/unlinkable-inference/#31-threat-model)
for the formal analysis including collusion scenarios.

The worst case for each component:


| Component | Worst case | Can it break unlinkability? | Why not? |
|---|---|---|---|
| **Malicious org / station (even if closed-source)** | Denial of service | No | Blinding is client-side (@cloudflare/privacypass-ts, open-source pure JS). Org/station sees blinded requests (issuance) and finalized tickets (redemption) which are cryptographically unlinkable. Cannot see prompts/responses. Being closed-source is irrelevant. Verifier catches toggle/ownership violations and bans. |
| **Malicious verifier** | Denial of service | No | Cannot link key to user identity (blind signatures). Sees raw key transiently, never stores. Cannot see prompts/responses. |
| **Malicious inference provider** | Sees prompts from anonymous keys | No | Cannot link prompts to user identity. Each session uses an ephemeral key with no identity binding. |
| **All OA components colluding** | Denial of service | No | Still cannot see prompts/responses. Still cannot link finalized tickets to blinded requests. |


### Defense-in-depth

Even if every side-channel attack were to succeed (timing correlation, IP
logging, batch-size analysis) and blind signature unlinkability were somehow
weakened, **inference remains unlinkable** because:

1. No OA system (org, station, verifier) sees prompts or responses -- they are
  sent directly from the user's browser to the inference provider.
2. The verifier's attested code proves this architectural exclusion.
3. The provider sees prompts from anonymous ephemeral keys with no user identity
  binding.
4. The worst case for the org is knowing "some user obtained an API key" -- but
  it cannot know what was sent with that key.

The org being closed-source does not change this analysis. The security-critical
cryptography (blinding/unblinding) runs client-side in open-source code. The org
is an operational orchestrator, not a trust anchor.

### Public key consistency

Blind signature unlinkability requires that all users blind against the same
public key. If the org served a unique key per user, the `token_key_id`
(SHA-256 hash of the public key) embedded in finalized tickets would differ,
allowing the org to correlate issuance to redemption.

Why this is detectable: the public key endpoint (`/api/ticket/issue/public-key`)
is publicly accessible and unauthenticated. Any user or third party can call it
at any time to record the current key and compare it against:

- The key used in their own ticket issuance
- Keys observed by other users at different times

Since these verification calls are made independently and at unpredictable
times by arbitrary parties, the org cannot serve per-user keys without
detection. A single inconsistency reported by any observer would expose the
attack.

Future: automated transparency log for public key consistency, similar to
[Certificate Transparency](https://certificate.transparency.dev/) for TLS
certificates.

## Zero-Trust Scope: OA Infrastructure

In the scope of this project, we say that "Zero trust" means users do not need to trust any OA-operated component (org,
stations, verifier operators) for **unlinkable inference**, which consists of
two guarantees:

1. **Identity-unlinkability** -- blind signatures ensure no party can link
   ticket issuance to ticket redemption. The org/station that signed blinded
   requests cannot correlate them to the finalized tickets presented later.
   Sessions cannot be linked to the user's identity.
2. **Cross-unlinkability** -- different sessions cannot be linked to each other.
   Each session uses a different ephemeral key with no persistent pseudonym.
   No party can link a user's prompts or responses to their identity or across
   sessions. OA stations act as secure inference proxies with two properties:
   **confidentiality** (no OA system can observe prompt/response content) and
   **integrity** (no OA system can tamper with it). Prompts go directly from the
   browser to the provider via anonymous ephemeral keys; no OA system (org,
   station, verifier) sees prompts or responses at any point.

How OA infrastructure achieves this without requiring trust:

- The **verifier** is hardware-attested (AMD SEV-SNP) and open-source. Its code
is measured by hardware and verifiable by anyone.
- **Stations** are continuously audited by the verifier using the provider's own
APIs. A station cannot cheat on privacy toggles or use shadow accounts without
being caught and banned.
- The **org/registry** are governance infrastructure. They never see user
identity, inference content, or the identity-to-inference linkage.
- Even a compromised OA operator cannot deanonymize users because no OA
component possesses user identity in the first place.

## Frontier Model Provider

See blog post [Section 3.1.1: Adversarial Inference Provider](https://openanonymity.ai/blog/unlinkable-inference/#311-adversarial-inference-provider)
for why unlinkability holds even against a malicious provider.

Through OA's unlinkable inference layer, even if the inference provider is
malicious, your prompts are still unlinkable to your identity and unlinkable
across your sessions. Each session uses an ephemeral API key issued via blind
signatures with no identity binding -- the provider has no way to know who is
behind any given key.

OA adds enforceable accountability on top of the provider relationship:

- Toggle verification ensures the station's provider account (OpenRouter for now)
  has logging and training disabled, using the provider's own APIs as evidence.
- Shadow-account prevention ensures the station cannot issue keys from a second,
  logging-enabled account.

## Centralized Components

The registry, org backend, and verifier are currently centralized. This is an
availability concern, not a trust concern:

- No centralized OA component possesses the identity-to-inference linkage needed
for deanonymization.
- The registry gates station admission (not user identity).
- The org backend receives station governance events (not user data).
- Future roadmap: multiple verifier instances and stations operated by
independent parties (universities, other organizations).

## Metadata Considerations

See blog post [Section 2.2: Traffic Mixing](https://openanonymity.ai/blog/unlinkable-inference/#22-traffic-mixing)
for how network relays and mixing mitigate metadata leakage.

The unlinkability model covers the cryptographic and architectural layers. At the
network layer, the following metadata vectors exist and should be mitigated:


| Vector             | Status                                                                                                                                                                                                               |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IP address         | oa-chat provides a built-in in-browser network proxy on by default for all ticket issuance and redemption requests, hiding the user's IP from the org and station. Users can additionally use their own VPN/Tor. |
| Browser User-Agent | Standard browser fingerprinting concern; use a common browser or randomize UA.                                                                                                                                       |


These are transport-layer concerns orthogonal to the core unlinkability
guarantee, which holds at the cryptographic and identity layer regardless of
network metadata.

## Wrong-Conclusion Traps

The following traps have occurred in prior audits. They stem from confusing
"component X can see data item Y" with "unlinkability is broken." The correct
question is always: **can any party link a specific user's identity to specific
inference requests?** For the formal threat model and collusion analysis, see blog post
[Section 3.1: Threat Model & Security Properties](https://openanonymity.ai/blog/unlinkable-inference/#31-threat-model).


| Trap                                                                         | Correct interpretation                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Component sees data, therefore unlinkability is broken."                    | False. The station sees finalized tickets and API keys; the verifier sees API keys in `/submit_key`. Neither breaks unlinkability because neither data item carries user identity. Blind signatures ensure the station cannot correlate issuance to redemption. The verifier uses the raw key transiently for signature verification, immediately hashes it (SHA-256), and never stores, logs, or reports it. Only a truncated hash prefix (16 hex chars) appears in structured logs. |
| "OpenRouter is a trust anchor that violates zero-trust."                     | False. OpenRouter is the frontier model provider used by OA. Even a malicious provider cannot link prompts to a user's identity or to each other. Each session uses an ephemeral key issued via blind signatures with no identity binding. OA additionally enforces accountability via toggle verification and shadow-account prevention.                                                                                                                                             |
| "Centralized infrastructure contradicts zero-trust."                         | False. Centralization is an availability concern, not a trust concern. No centralized OA component (registry, org backend) possesses the identity-to-inference linkage required for deanonymization. The registry gates station admission. The org receives station governance events. Neither sees user identity or inference content.                                                                                                                                               |
| "OA systems could see or log user prompts."                                  | False. No OA system (org, station, verifier) is in the inference data path. Prompts go directly from the user's browser to the inference provider over HTTPS. The verifier's attested code proves this architectural exclusion. Station operator cookies are governance material for toggle/ownership checks, not prompt-transport credentials.                                                                                                                                        |
| "The org handles both issuance and redemption, so it can correlate them."    | False. At issuance the org sees blinded requests; at redemption it sees finalized (unblinded) tickets for the first time. These are cryptographically unlinkable -- that is the core guarantee of blind signatures. The org knows "credential X -> N blinded requests" but cannot determine which finalized tickets those became.                                                                                                                                                     |
| "The org knows the invitation code/email, so it knows who redeemed tickets." | False. The org knows identity -> credential -> N blinded requests. But it cannot link blinded requests to finalized tickets (blind signatures). The finalized tickets at redemption are unlinkable to any prior issuance step.                                                                                                                                                                                                                                                        |
| "The provider sees prompts, so zero-trust is violated."                      | False. OA's claim is unlinkable inference, not invisible inference. Prompts reach the provider (they must for inference to work), but they are unlinkable to the user's identity and to each other. The provider sees anonymous requests from ephemeral keys.                                                                                                                                                                                                                         |
| "Station operator cookies stored in verifier memory affect user privacy."    | False. Station operator credentials are governance data for compliance checks on the operator's provider account. They are not end-user data. The verifier never receives or stores any end-user identity material.                                                                                                                                                                                                                                                                   |
| "Side-channel attacks (timing, IP, batch size) break unlinkability."         | IP is mitigated by the built-in in-browser VPN proxy (on by default), and users can additionally use their own VPN/Tor. Timing correlation is weakened by the large volume of tickets issued across many users -- individual redemption events are lost in the mix. Even if these side channels were somehow exploited, inference remains unlinkable: no OA system sees prompts/responses (direct browser-to-provider), the provider sees anonymous ephemeral keys, and the worst case is the org learning "some user obtained an API key" -- but never what was sent with it. |
| "The org is closed-source, so it's an unauditable trust anchor."             | False. The org does not need to be trusted for unlinkability. Blinding/unblinding runs client-side in open-source JS (@cloudflare/privacypass-ts). The org only sees blinded requests (issuance) and finalized tickets (redemption) which are cryptographically unlinkable. Its worst case is denial of service, not privacy breach. See [UNLINKABILITY_PROOF.md](UNLINKABILITY_PROOF.md) for the formal proof. |
| "The org could serve per-user public keys to break unlinkability."           | Detectable. The public key endpoint is publicly accessible and unauthenticated. Any user or third party can call it at any time to record and compare keys. Since verification calls are independent and unpredictable, the org cannot serve per-user keys without detection. A single inconsistency reported by any observer exposes the attack. Future: automated transparency log. |
| "OpenRouter could perform traffic analysis on ephemeral keys to deanonymize users." | False. Each session uses a different ephemeral key with no user identity binding. There is no persistent pseudonym across sessions for the provider to build a longitudinal profile against. Content-based correlation has only plausible deniability -- the provider cannot distinguish Alice sending prompt X from Bob sending the same prompt. This is the cross-unlinkability guarantee (see blog post [Section 3.1.1](https://openanonymity.ai/blog/unlinkable-inference/#311-adversarial-inference-provider)). |
| "Toggle/ownership verification means trusting OpenRouter, violating zero trust to the OA system components." | False. Toggle and ownership checks enforce accountability on the *station's* provider account -- they are not about trusting the OA system. If OpenRouter lies about its own API state, it undermines itself, not OA. Regardless, user prompts remain unlinkable because blind signatures and ephemeral keys carry no user identity. |

