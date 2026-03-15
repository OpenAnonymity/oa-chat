# Execution Model

This document describes the standalone tool runtime now wired into `oa-chat`.

In product terms, these are "skills" exposed to the model. The runtime and code
still use "tool" in many places because that matches provider APIs such as
OpenRouter tool calling, but the intended design is:

- the model sees a list of skills/functions
- the runtime decides how to execute them
- `oa-chat` renders the result
- `oa-desktop` or the browser host provides the concrete environment

## Scope

- Tool execution is modeled as a standalone shared module under
  `chat/shared/tool-runtime/`.
- The runtime has no direct dependency on DOM APIs, IndexedDB, Electron, or
  `local_inference/`.
- `oa-chat` consumes the runtime through thin adapters in `chat/services/tools/`.
- `oa-desktop` is expected to provide a privileged host at
  `window.electronAPI.tools`, but the web app continues to work without it.

## Layers

- `chat/shared/tool-runtime/`
  - Owns tool descriptors, runs, artifacts, host orchestration, and the generic
    model -> tool -> model event loop.
  - Core interfaces are `ToolRuntime`, `CompositeToolHost`, `RunStore`,
    `ArtifactStore`, and `ModelAdapter`.
- `chat/services/tools/`
  - `browserToolHost.js` exposes browser-safe tools only:
    `artifact.create`, `html.render`, `svg.render`, `download.file`.
  - `electronToolHost.js` is a renderer-side adapter for desktop-provided tools
    such as `python.exec` and `bash.exec`.
  - `OAChatModelAdapter.js` wraps the current inference path into runtime-style
    events without changing the existing chat transport.
  - `chatToolController.js` is the only chat-specific bridge. It translates
    code-block actions into tool runs, persists run/artifact refs onto messages,
    hydrates execution cards and embedded artifacts, and opens/downloads artifacts.
  - `chat/app.js` observes runtime events only for message visibility and
    streaming UI updates. It must not duplicate run/artifact persistence that
    already lives in `chatToolController.js`.
- `chat/services/inference/backends/openRouterBackend.js` now exposes structured
  tool calling through OpenRouter's native tool-calling support rather than
  inventing a parallel local protocol.

## Current Product Behavior

- Automatic execution is structured-tool-call only by design. The app does not
  heuristically execute plain assistant text.
- The OpenRouter path now exposes host skills directly to the model and the
  standalone runtime performs the model -> skill -> model loop.
- OpenRouter tool exposure is now gated per selected model using
  `supported_parameters` from the cached model catalog. If the selected model
  is unknown or does not advertise `tools`, automatic skill exposure is
  disabled and the turn stays on the plain chat path.
- To avoid regressing legacy chat behavior, the structured tool path is
  currently gated off for search-enabled turns and turns containing file parts.
  Those continue to use the existing non-tool streaming path until the
  structured path reaches feature parity for citations and file handling.
- OpenRouter's docs describe tool calling as a model capability exposed through
  `supported_parameters=tools`; they do not document unsupported models
  silently ignoring the `tools` parameter. The app therefore defaults unknown
  model capability to "no automatic tools" rather than assuming support.
- The currently shipped host/browser skill set is:
  - `artifact_create`
  - `html_render`
  - `svg_render`
  - `download_file`
  - plus any desktop-provided skills such as `python_exec` / `bash_exec`
- The currently shipped manual code-block UI is:
  - HTML -> `html.render`
  - SVG -> `svg.render`
  - ICS/calendar text -> `download.file`
  - Python/Shell -> only shown when the host advertises `python.exec` or
    `bash.exec` (desktop expected, web hidden)
- Runs and artifacts persist in IndexedDB object stores:
  - `executionRuns`
  - `artifacts`
- Messages remain backward-compatible:
  - legacy fields (`content`, `images`, `citations`, etc.) are unchanged
  - optional `parts[]` holds ordered refs to tool runs/artifacts
  - hydrated `executionRuns[]` is derived at render time

## UI Rules

- Non-tool chats must render exactly as before when no execution data exists.
- Assistant-turn orchestration should stay centralized.
  `sendMessage()` and `regenerateResponse()` must share the same assistant-turn
  helper path rather than keeping separate stream-processing state machines.
- Code-block tool buttons are additive and capability-gated by the active host.
- Manual preview/download actions must stay inline on the code block itself.
  Do not add redundant post-message "Preview" or "Download" cards for those
  actions.
- Automatic artifact skills render as embedded outputs inside the assistant
  message. Runtime/process skills render execution cards only when stdout/stderr,
  status, or rerun controls are actually useful.
- HTML artifact previews render in a sandboxed iframe with opaque origin and a
  restrictive CSP. This allows interactive previews without parent DOM access.
- Artifact open/download actions are handled in `ChatArea`; no permanent
  desktop-only execution UI should be added on top of the shared chat UI.

## Persistence and Export

- Export format is now `1.1`.
- Full local exports include `sessions`, `messages`, `executionRuns`, and
  `artifacts`.
- Import remains backward-compatible with `1.0`.
- When deleting or truncating messages, runtime rows must be deleted too to
  avoid orphaned runs/artifacts in export payloads.

## Follow-up Work

- Add explicit approval UI for auto-invoked tools.
- Add more artifact families such as Mermaid and richer file viewers.
- Keep MCP as a host-side adapter only. It should not define the runtime
  protocol or chat UI.
