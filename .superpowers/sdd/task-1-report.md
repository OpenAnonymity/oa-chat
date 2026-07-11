# Task 1 implementation report

## Status

Implemented the canonical provider registry and routed live OpenRouter catalog
provider formatting through it. The cached catalog and fallback model data shapes
were not changed.

## Changes

- Added `chat/services/providerRegistry.js` with:
  - `resolveProviderFromModelId(modelId)` for OpenRouter author extraction and the
    documented single-leading-`~` alias handling.
  - `resolveProvider(value)` for canonical slug/display-name normalization.
  - `getProviderAsset(displayName)` for current local provider asset metadata.
  - strict author validation using `^[a-z0-9][a-z0-9._-]*$`.
  - safe title-cased display names for unknown valid slugs and `Unknown` for
    malformed input.
  - the pre-existing provider aliases from `api.js`, plus required OpenRouter and
    xAI entries.
- Updated `chat/api.js` to derive each live catalog model's `provider` from
  `resolveProviderFromModelId(model.id).displayName` and removed the duplicated
  `capitalizeProvider` method.
- Added focused normalization coverage in
  `test/services/providerRegistry.test.js`, including ordinary authors,
  OpenRouter branding, xAI, documented latest aliases, unknown slugs, empty
  aliases, and an uppercase malformed alias regression.

## TDD evidence

1. RED: Added the brief's provider normalization tests first, then ran:

   `node --test test/services/providerRegistry.test.js`

   Result: failed with the expected `ERR_MODULE_NOT_FOUND` for
   `chat/services/providerRegistry.js`.

2. GREEN: Added the registry and catalog integration, then ran:

   `node --test test/services/providerRegistry.test.js test/domain/modelSelection.test.js`

   Result: 11 passed, 0 failed.

3. Self-review regression RED: Added coverage proving an uppercase stripped
   alias (`~Anthropic/...`) is invalid under the required slug regex. The focused
   registry run failed because the generic display-name resolver was leaking into
   OpenRouter author validation.

4. Regression GREEN: Separated strict slug resolution from generic display-name
   resolution and reran the focused/catalog-related tests. Result: 11 passed,
   0 failed.

## Verification

- `node --test test/services/providerRegistry.test.js test/domain/modelSelection.test.js`
  - 11 passed, 0 failed.
- `git diff --check`
  - passed with no whitespace errors.

Node emits the repository's existing `MODULE_TYPELESS_PACKAGE_JSON` warning for
ES module tests because `package.json` does not declare `type: module`; this does
not affect the passing result and changing package module semantics is outside
Task 1 scope.

## Privacy and scope review

- No inference transport, credential, logging, prompt, response, persistence, or
  network behavior changed.
- No runtime third-party asset request was added. OpenRouter's asset remains
  unset in this task; self-hosted asset expansion and icon rendering are Task 2.
- No fallback catalog entries or cached catalog schema were changed.

## Adversarial review

A fresh review subagent approved the final Task 1 diff with no findings. It
independently confirmed the required parsing behavior, catalog integration,
privacy/scope boundaries, focused test result, clean diff, and existence of every
configured non-null local asset.
