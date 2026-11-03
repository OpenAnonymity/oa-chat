# Client-rendered charts (generative UI, first increment)

oa-chat can show one chart inside an assistant response. The model never
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
request they received before. Quick Ask, Parallel lanes and Council stay
text-only in this increment.

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

Limits (`chat/domain/chartArtifacts.js`): 8 series, 500 points, labels
80 characters, title 120, spec 64 KiB, tool arguments 128 KiB while
streaming (`chat/domain/streamingToolCalls.js`). Every series must match the
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
an unknown tool, two calls, an over-limit payload or a failed validation
become an italic note appended to the text (`clientToolError`), never markup.

## Later turns

`processMessagesForApi` replays an assistant message that carries a chart as
an assistant `tool_calls` message followed by a `tool` result
("Rendered a bar chart titled … in the chat."), so provider tool ordering
stays valid and the next reply does not re-describe the chart.
`formatChatCompletionMessage` in `api.js` keeps those fields on the wire.

## Rendering

`chat/components/chartSvg.js` is dependency-free: the validated spec in, a
`<figure class="oa-chart-card">` out with the SVG, a legend for two or more
series, native `<title>` hover text per mark and a "Show data" table. Every
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

Cards (`render_cards`), Quick Ask / Council lanes, widget → chat postback,
multi-model eval of when the model chooses a chart, and usage counters.

## Staging release review (2026-11-03)

The release integrates the feature into the current staging client so daemon
authorization remains present. Axis generation is bounded and handles adjacent,
subnormal and extreme finite values; chart scaling and pie weights avoid
overflow. The data table and mark tooltips retain exact numeric values. Terminal
Stop/error cleanup clears a pending chart placeholder before persisting it.
