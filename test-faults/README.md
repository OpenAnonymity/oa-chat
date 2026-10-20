# Provider fault-injection suite

The real client UI, served unbundled from `chat/` by `scripts/dev-server.mjs`, runs in headless Chromium against two stand-ins:

| Stand-in | Port | Replaces |
|---|---|---|
| `mock-org.mjs` | 8005 | oa-org: issues a key for every `request_key`, answers the catalogue calls |
| `mock-openrouter.mjs` | 8443 (HTTPS) | `openrouter.ai`: a script of responses per request, per model |

Chromium maps `openrouter.ai` to the stand-in. Every other host fails to resolve, the relay included. Test setup explicitly selects direct transport; relay cancellation and TLS-tunnel behavior are outside this suite. Nothing real is contacted: no account, tickets, keys, relay or provider.

## Run

```sh
npm ci --prefix test-faults --ignore-scripts
npm exec --prefix test-faults -- playwright install chromium
npm run test:faults                      # every scenario, about 10 minutes
node test-faults/scenarios.mjs regenerate 429   # ids containing every word
```

Ports 8005, 8080 and 8443 must be free. `CHROME_PATH` selects a browser. Results go to `test-faults/results/`: one JSON file and one screenshot per scenario, plus `summary.json`. The exit code is non-zero on any failed check.

## What runs

Each fault runs through each way a person asks for a reply: **send**, **regenerate** (over a real answer, and over an earlier error row), a **Parallel** lane (Gemini fails, the other lane is healthy), and **quick ask**.

| Fault | The person must end up seeing | Requests |
|---|---|---|
| HTTP 429, `Retry-After: 2` | the answer, after waiting at least 2 s (at most +25 % jitter) | 2 |
| HTTP 429, `Retry-After: 6` | the answer, after 6 s; jitter stays within the cap | 2 |
| HTTP 429, `Retry-After: 7` | a plain busy error, no requested-wait sentence | 1 |
| HTTP 429 repeatedly | a plain busy error after one retry | 2 |
| HTTP 429 without a hint | the answer after the default 2 s wait plus jitter | 2 |
| HTTP 502 / 504 once | the answer after the default 1 s wait plus jitter | 2 |
| HTTP 503, `Retry-After: 2` | the answer after at least 2 s | 2 |
| HTTP 503, `Retry-After: 7` | a plain service-unavailable error | 1 |
| in-stream 429 after text | partial answer and a plain busy error | 1 |
| HTTP 429, `Retry-After: 30` | "The model is temporarily busy. Please try again." | 1 |
| in-stream 504 once | the answer | 2 |
| in-stream 504 every time | "Gateway timeout (provider 504)." | 2 |
| connection dropped before text | the answer | 2 |
| connection dropped mid-answer | the partial answer and a plain reason | 1 |
| stream stalls mid-answer | the partial answer and "stopped responding" | 1 |
| hidden thinking, then 504 | "Gateway timeout (provider 504)." (thinking had started, so no resend) | 1 |
| Stop during a 429 wait | the stopped reply, and no further request | 1 |

Every scenario also fails on: the old "previous answer was kept" box, raw "operation was aborted" or "signal is aborted" text, "after N retries", the ⚠️ fallback, the router's raw "Provider returned error", a saved replacement notice, or an uncaught page error.

## Adding a fault

Add a step kind to `mock-openrouter.mjs` (`ok`, `http`, `stream-error`, `cut`, `stall` and `withheld-then-error` exist). Then add an entry to `FAULTS` in `scenarios.mjs` with its expected outcome.

## Gate

`.github/workflows/fault-injection.yml` runs the suite on pushes and pull requests with an isolated locked Playwright install. The commercial host also runs it unconditionally in `check:release`, under its required **Release checks** status. Both commercial CI and the manual staging fallback install the browser first. Vercel itself remains browser-free.

Parallel uses the composer mode switch and model picker; quick ask uses a mouse selection and the Ask button. Stop/leaving the chat during a 429 wait is checked on all four paths. The suite has 89 scenarios. Fixture setup injects tickets, model selection, sign-in policy and a short watchdog, but does not replace inference, resend, stream parsing or rendering code. It does not prove live relay, wallet mint/settlement or native-app behavior.
