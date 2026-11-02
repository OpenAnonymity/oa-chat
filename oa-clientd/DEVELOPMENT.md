# Developing oa-clientd

`oa-clientd/` is its own Go module, `github.com/OpenAnonymity/oa-chat/oa-clientd`,
inside the `OpenAnonymity/oa-chat` repository. The user guide is
[README.md](README.md).

## Layout

| Path | Holds |
| --- | --- |
| `cmd/oa-clientd` | The command: setup, login, logout, serve, sync, status, models, MCP, config |
| `internal/oa/account` | Authorization (device flow, envelope), session, encrypted sync and leases; the only package that names account routes |
| `internal/oa/tickets` | Ticket selection, redemption on `/api/request_key/nonce`, key checks, the inference gateway; never imports `account` |
| `internal/oa/wallet` | The local replica of the encrypted ticket wallet |
| `internal/oa/profile` | Profile, reviewed deployments, port and settings |
| `internal/oa/securefile` | Owner-only atomic files and locks |
| `internal/oa/oatest` | Test helpers |
| `pkg/activity` | Process-local key lifecycle events for diagnostics |
| `pkg/cover` | Optional cover traffic over Tor |
| `pkg/delegatemcp` | The stdio MCP adapter for a running daemon's strict delegation |
| `pkg/relay` | Direct, relay and Tor (SOCKS5) transports |
| `pkg/rewriter` | The optional prompt rewriter and its transcript |
| `pkg/server` | The local OpenAI-compatible HTTP API, local authentication, queueing and logging |
| `packaging/systemd/oa-clientd.service` | The systemd user unit |
| `scripts/build-oa-clientd.sh` | Release tarballs for the four supported targets |

## `pkg/` is a public API

The six `pkg/` packages are payment-independent. This command imports them, and
other modules import them too. Rules:

- Dependencies point into this module only. Nothing here imports another
  client, an Ethereum library or a payment wallet:
  `TestModuleCannotReachAPaymentWallet` in
  [cmd/oa-clientd/main_test.go](cmd/oa-clientd/main_test.go) fails if any source,
  `go.mod` or `go.sum` names one of the module prefixes it lists.
- Account, ticket and wallet code stays in `internal/oa`, which the Go toolchain
  keeps out of other modules' reach.
- `pkg/` keeps the defaults its existing importers rely on (product labels, the
  default delegation route and MCP tool names, error wording). A caller sets its
  own through options, as `cmd/oa-clientd` does for the `oa` label,
  `/v1/oa/delegate`, its MCP tools and their wording. Changing a default changes
  every importer.
- Importers pin this module by an immutable pseudo-version of a pushed commit
  (`go get github.com/OpenAnonymity/oa-chat/oa-clientd@<commit>`). There is no
  `replace` directive or `go.work` in shipped source. A change to `pkg/` reaches an
  importer only when it moves its pin, so run its tests when you do.

## Tests

```sh
cd oa-clientd
go vet ./...
go test -race ./...
```

Most packages start loopback `httptest` servers, so the tests need permission to
listen on `127.0.0.1`/`::1`. Opt-in live tests stay off unless their environment
variables are set; the variables are read in
[pkg/relay/relay_test.go](pkg/relay/relay_test.go),
[pkg/rewriter/rewriter_test.go](pkg/rewriter/rewriter_test.go),
[pkg/rewriter/transcript_live_test.go](pkg/rewriter/transcript_live_test.go) and
[pkg/rewriter/instruction_eval_test.go](pkg/rewriter/instruction_eval_test.go).

`internal/oa/account/testdata/daemon-auth-v1.json` is a copy of the web app's
`test/fixtures/daemon-auth-v1.json`, so the module tests stand alone;
`TestBrowserVectorMatchesTheWebAppFixture` fails in a repository checkout when the
two differ. Regenerate both together.

## Releases

```sh
OA_CLIENTD_ENV=staging scripts/build-oa-clientd.sh 0.1.0-staging.1 /path/outside/the/repository
```

Each tarball ships `README.md` and `DEVELOPMENT.md`. Links between them stay
relative; links to source files and to the web app's `docs/` are rewritten to
`https://github.com/OpenAnonymity/oa-chat/blob/<commit>/...`, where `<commit>` is
`OA_CLIENTD_SOURCE_REV` or, by default, this checkout's `HEAD`. Build from a
committed tree and push that commit before publishing, or those links will not
open. Write artifacts outside the repository; nothing under `oa-clientd/` is deployed
with the web app (`.vercelignore` admits only the web app's paths).
