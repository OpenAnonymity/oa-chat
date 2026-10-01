# OpenZoo leCore context recall

OA Chat can use a browser-local context reducer inspired by the current
[leCore retrieval dispatch](https://github.com/AnOversizedMooseWithSocks/leCore/blob/5cef1aecedde57cf2bc5213d7beb5c669327e925/holographic/semantic_router/holographic_retrievaldispatch.py)
from Moose's MIT-licensed leCore v0.2.29. The [OpenZoo](https://openzoo.fun/)
site now presents a local agent product; this integration does not call its old
x402 service or require a wallet, local server, Python, or MCP connection.
The distributed browser source includes the [leCore notice](../chat/NOTICE-LECORE.txt).

## Request path

Turn on **OpenZoo leCore context recall** in Settings. The switch is off by
default and saved in this browser's existing settings store. The shared
`inferenceService` applies the reducer immediately before streaming or strict
completion requests. Those methods cover regular chat, Quick Ask, Parallel and
Council lane requests, and both ticket and zkAPI backends. Council synthesis
arrives as one prompt containing the draft answers, so the reducer passes it
through unchanged. Title generation uses a separate small prompt and is also
unchanged.

The reducer considers only the current request's already-scrubbed messages.
It preserves instructions, the latest user request, recent turns, message order,
and message objects; it retrieves relevant older text when a conversation is
long enough. Short conversations, current or historical attachments, whole-chat
questions, and non-text content pass through unchanged. The original request is
sent if retrieval fails. This is a local
port of the deterministic text retrieval path, not leCore's full persistent
memory, embedding index, or MCP tool suite.

The provider receives the selected context through OA's usual direct browser
transport and ephemeral key. There is no additional OpenZoo, OA, or third-party
request and no new storage for prompts or retrieval results. Disabling the
switch restores the full context for subsequent requests. Selecting context can
omit older details needed by a later question, so users can turn it off and
retry. This feature does not change saved chat history.

The [earlier DHH/TTFX demonstration](https://ttfx-three.vercel.app/) and its
[public run records](https://github.com/staccDOTsol/ttfx-zoo) used an older
leCore revision. The dashboard's full-context costs are extrapolated from
provider-billed corpus probes, not complete paired task runs. Those results are
background motivation, not a measured speedup or quality claim for this OA
integration. Payload reduction depends on the actual conversation and question;
the browser and provider may report different token counts. The tests exercise
retrieval invariants and both OA inference routes. A current comparison needs
the same model, questions, and corpus in full-context and retrieval arms, with
provider-billed cost, answer correctness, and latency recorded for both.
