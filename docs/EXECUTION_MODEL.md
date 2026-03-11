# Execution Model

This document describes the standalone tool runtime now wired into `oa-chat`.

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
    hydrates execution cards, and opens/downloads artifacts.

## Current Product Behavior

- Automatic execution is still structured-tool-call only by design. The app does
  not heuristically execute plain assistant text.
- The currently shipped UI path is manual execution from assistant code blocks:
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
- Code-block tool buttons are additive and capability-gated by the active host.
- Execution cards render inside assistant messages only when runs exist.
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

- Wire structured backend tool calls into `ToolRuntime.streamTurn()` once a
  backend exposes them.
- Add explicit approval UI for auto-invoked tools.
- Add more artifact families such as Mermaid and richer file viewers.
- Keep MCP as a host-side adapter only. It should not define the runtime
  protocol or chat UI.
