# Model Provider Logos Design

## Goal

Show recognizable, locally hosted provider logos throughout the model picker and
assistant-message UI for substantially more of the OpenRouter catalog. Latest-model
aliases should inherit their author's logo, while unknown or malformed providers must
degrade safely to a neutral text badge.

## Catalog normalization

Provider identity is derived from the author segment of each OpenRouter model ID. The
OpenRouter catalog adapter owns OpenRouter-specific parsing:

- Ordinary IDs such as `anthropic/claude-sonnet-5` resolve through the `anthropic`
  author slug.
- Documented latest aliases such as `~anthropic/claude-sonnet-latest` remove the
  leading `~` before provider lookup.
- `openrouter/*` remains OpenRouter-branded, including OpenRouter's own routers.
- A stripped alias is accepted only when the remaining author is a non-empty,
  well-formed provider slug. Unknown but well-formed authors remain usable and fall
  back visually; malformed or empty authors use the generic fallback.

This parsing does not belong in the generic icon renderer, so that renderer remains
independent of OpenRouter URL conventions.

## Provider registry and assets

A single provider registry maps canonical author slugs to display names, recognized
aliases, and local asset paths. Existing provider mappings move behind the same
interface so the catalog, current-model button, and message headers agree.

New logo files are self-hosted under `chat/img/`. Prefer official downloadable brand
assets; use stable, reputable SVG repositories when an official downloadable mark is
not available. Record asset sources and licenses where required. Do not add runtime
requests to provider websites or icon CDNs.

The last successful model catalog is also read synchronously from local storage before
the saved model choice is rendered. Provider metadata from that cache must be normalized
in the same way as a live catalog response, so a hard refresh can show the correct local
logo immediately while a fresh catalog request continues in the background. Cached
catalog entries are display-only during startup; request-time model selection continues
to use the active backend's live catalog.

Initial coverage targets the major recognizable publishers in the current catalog,
including xAI, Z.ai, Moonshot AI, MiniMax, Microsoft, Amazon, Nous Research, Tencent,
ByteDance, IBM, AI21, and other publishers for which a trustworthy small-format mark
can be sourced. Obscure publishers without a reliable mark retain the fallback.

## Rendering and fallbacks

Known providers render their configured local image. Unknown providers render the
first meaningful character of their cleaned display name in the existing neutral
badge. Empty or malformed provider values render `A`.

Image elements include an error path that replaces a missing or unreadable asset with
the same neutral badge. The UI never guesses a parent model family or shows another
company's logo merely because a downstream model uses that company's architecture.

## Verification

Focused automated tests cover:

- ordinary provider slug normalization;
- documented `~author` latest aliases;
- OpenRouter-owned router branding;
- canonical aliases such as `meta-llama`, `mistralai`, and `x-ai`;
- unknown, empty, and malformed providers;
- known icon paths and image-error fallback markup.

Run the relevant tests and production build, then start the local development server
for visual inspection of the live model catalog in light and dark themes. Update
`docs/APP_STATE.md` with the registry boundary, alias behavior, and fallback rules.
