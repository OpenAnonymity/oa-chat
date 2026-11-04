# Client-rendered charts (generative UI, first increment)

oa-chat can show up to four charts inside an assistant response. The model never
produces markup: a tool-capable model calls the client-side `render_chart`
function with a small typed spec, the browser validates it, stores it on the
message as a versioned artifact, and draws it as inline SVG. Nothing in this
path touches an OA service; the request goes to the provider exactly as a
text request does, with a `tools` array added.

Flag: `CLIENT_CHARTS_FEATURE_FLAG` in `chat/config.js`. Off means the request
is text-only; charts already stored on messages still render.

## Request contract

`getClientToolOptions(modelEntry)` in `app.js` advertises
`RENDER_CHART_TOOL` (with `CHART_TOOL_SYSTEM_INSTRUCTIONS` appended to the
system prompt) only when the selected catalog entry lists `tools` in
`supported_parameters`. `api.js` keeps that field from the OpenRouter
catalog; `modelCatalogCache.js` persists it. Other models receive exactly the
request they received before. Single replies, Parallel lanes, Council synthesis, and Quick Ask all offer the
same tool options. Both ticket and zkAPI adapters pass these to the shared parser.
Unsupported or unknown models receive no chart tools. Chart capability labels
are omitted from the model picker (user preference, 2026-11-04).

The function takes:

```json
{
  "chartType": "bar | line | pie",
  "title": "Short title",
  "xLabels": ["Jan", "Feb"],
  "series": [{ "name": "Spend", "values": [12, 18] }],
  "xAxisTitle": "optional", "yAxisTitle": "optional"
}
```

Limits (`chat/domain/chartArtifacts.js`): four charts per reply, 8 series per chart, 500 points, labels
80 characters, title 120, spec 64 KiB, tool arguments 128 KiB while
streaming (`chat/domain/streamingToolCalls.js`), at most eight retained calls plus bounded overflow/invalid-ID errors. Every series must match the
label count; values must be finite; a pie takes one non-negative series.
Numeric strings are read as numbers; unknown fields are dropped.

## Streaming

OpenRouter streams function arguments as fragments. `api.js` folds
`delta.tool_calls` into an accumulator keyed by index (or id), counts the
first fragment as output for the watchdog, the first-token flag and the
resend policy, and announces it once to `onChunk(null, { toolCallPending: true })`
so the message shows a placeholder in the chart slot. The finished result
carries `toolCalls`; `finish_reason: "tool_calls"` is a normal finish. A
tool-only reply is an answer, not `INFERENCE_EMPTY`.

`applyClientToolResult` in `app.js` turns the calls into the message's
`artifacts: [{ version: 1, type: "chart", spec, toolCallId }]`. Invalid JSON,
an unknown tool, an over-limit payload or a failed validation become a visible
note appended to the text (`clientToolError`). Calls validate independently: valid
charts stay visible when a sibling fails. More than four valid charts retains the
first four and explains the limit. Prompt guidance asks for separate calls and
sourced data, but this is not a guarantee that model-provided figures are verified.

## Later turns

`processMessagesForApi` replays an assistant message that carries a chart as
one assistant `tool_calls` message followed by one `tool` result per chart
("Rendered a bar chart titled … in the chat."), so provider tool ordering
stays valid and the next reply does not re-describe the chart. Replay IDs are
scoped by message and chart position to prevent collisions in provider/imported data. For a model without
catalog-declared tool support, chart history is sent as ordinary assistant text
containing the title, units and exact data table. Each Parallel lane retains its
own chart; Council sees the chart data when comparing the lane responses.
`formatChatCompletionMessage` in `api.js` keeps those fields on the wire.

## Rendering

`chat/components/chartSvg.js` is dependency-free: the validated spec in, a
`<figure class="oa-chart-card">` out with the SVG, a legend for two or more
series, an interactive exact-value tooltip and a "Show data" table. Every
string is escaped there. Colors are CSS custom properties
`--oa-chart-1..8` in `styles.css`, stepped separately for `.dark`. The
template (`MessageTemplates.js`) puts the chart after the text bubble and
before generated images; `ChatArea.syncChartSlot` settles that slot in place
after streaming, and `showPendingArtifact` places the placeholder when the
call starts after text has begun. Known limit: at phone width the SVG scales
uniformly, so tick labels get small.

Share export (`sharePayload.js`) and import (`shareService.js`) carry only
artifacts that re-validate.

## Tests

- `test/domain/streamingToolCalls.test.js` — fragment reassembly at 200 random
  chunkings, index/id matching, byte caps.
- `test/services/openRouterClientTools.test.mjs` — tools only when passed,
  transcript round trip, tool-only reply, output announced before a transport
  failure.
- `test/domain/chartArtifacts.test.js` — schema/validator agreement, every
  rejection reason, artifact normalization, transcript.
- `test/components/chartSvg.test.js` — marks per value, legend, table,
  escaping (tag allowlist), ticks, number formatting.
- `test/services/sharePayload.test.js`, `test/services/shareImportCharts.test.js`.

## Not yet

Cards (`render_cards`), widget → chat postback,
multi-model eval of when the model chooses a chart, and usage counters.

## Staging release review (2026-11-03)

The release integrates the feature into the current staging client so daemon
authorization remains present. Axis generation is bounded and handles adjacent,
subnormal and extreme finite values; chart scaling and pie weights avoid
overflow. The data table and mark tooltips retain exact numeric values. Terminal
Stop/error cleanup clears a pending chart placeholder before persisting it.

Copy, Regenerate and Fork remain below the entire chart, including its Show data
disclosure, both during live completion and after reload. The browser fixture
`test-browser/chart-layout.mjs` covers reasoning-only and text-first arrival.

## Copy and multi-model charts (2026-11-03 follow-up)

Copy includes response prose plus the chart title, units and exact values as a
tab-separated table, including chart-only replies and individual Parallel lanes.
The rendered card holds escaped copy text for synchronous Safari clipboard access.
Chart specs remain bounded and validated at rendering and share/import boundaries,
including each lane and the Council synthesis. Quick Ask renders charts in its
existing temporary answer panel; it does not add them to the saved transcript.

A chart tool fragment counts as visible output for retry safety. An interrupted
chart request is never silently resent merely because it has no prose yet.

## Interactive inspection (2026-11-03)

Hover anywhere in a line/bar plot to select the nearest category. A dashed guide
and line markers accompany an HTML tooltip with every series name and exact value,
plus the y-axis unit label. Dense lines work even when static markers are omitted.
Pie slices expose their category and value. Tab focuses one chart; Left/Right and
Home/End explore categories, Escape dismisses. Touch taps select without capturing
scroll gestures. Narrow cards put the tooltip below the plot so values stay readable.

`chartInteractions.js` delegates once per document, including restored, streamed,
Parallel/Council and Quick Ask charts. Data is validated again on first interaction;
text is inserted with textContent, never HTML. The feature adds no dependency,
network call, persistence, or telemetry. Tooltips are hidden in print; Show data
and chart copying remain available independently.

## Multiple charts and late validation text (2026-11-04)

All charts survive rendering, Copy, history, share export/import, Parallel/Council
lanes and Quick Ask. The card renderer and hover delegate work per chart. A completed
reasoning-only row may lack a text bubble: finalization now rebuilds that row when
new completion text (including validation errors) needs one. This fixes the blank
reply caused by clearing a chart placeholder without inserting the error text.
`test-browser/chart-layout.mjs` exercises two live/restored charts, exact DOM Copy,
partial/all-invalid calls after reasoning and Quick Ask. Unit tests cover bounded
accumulation, mixed-validity calls, copying, unique replay IDs and share/import.
