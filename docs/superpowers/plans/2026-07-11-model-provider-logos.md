# Model Provider Logos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand model-catalog logo coverage with self-hosted provider assets, documented OpenRouter latest-alias handling, and safe visual fallbacks.

**Architecture:** Add a focused provider registry that canonicalizes catalog author slugs and exposes display/icon metadata. The OpenRouter adapter derives providers through that registry; the icon renderer consumes canonical display names and emits resilient local-image markup without knowing OpenRouter routing syntax.

**Tech Stack:** Browser ES modules, Node.js built-in test runner, local SVG/PNG assets, esbuild production bundle.

## Global Constraints

- Runtime logo rendering must not request provider websites or icon CDNs.
- `~author/family-latest` handling is scoped to OpenRouter catalog normalization.
- `openrouter/*` uses OpenRouter branding.
- Unknown or malformed providers must render a neutral text badge, never a guessed company logo.
- Provider assets live under `chat/img/` and use relative paths resolved by the app's `<base href="/">`.

---

### Task 1: Canonical provider registry and catalog normalization

**Files:**
- Create: `chat/services/providerRegistry.js`
- Modify: `chat/api.js`
- Create: `test/services/providerRegistry.test.js`

**Interfaces:**
- Produces: `resolveProviderFromModelId(modelId: string): { slug: string|null, displayName: string }`
- Produces: `resolveProvider(value: string): { slug: string|null, displayName: string }`
- Produces: `getProviderAsset(displayName: string): string|null`
- Consumed by: `chat/api.js` and `chat/services/providerIcons.js`

- [ ] **Step 1: Write failing provider normalization tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveProvider,
    resolveProviderFromModelId
} from '../../chat/services/providerRegistry.js';

test('normalizes known OpenRouter author slugs', () => {
    assert.deepEqual(resolveProviderFromModelId('meta-llama/llama-4'), {
        slug: 'meta-llama',
        displayName: 'Meta'
    });
    assert.equal(resolveProviderFromModelId('openrouter/auto').displayName, 'OpenRouter');
    assert.equal(resolveProviderFromModelId('x-ai/grok-4').displayName, 'xAI');
});

test('latest aliases inherit the documented author provider', () => {
    assert.equal(
        resolveProviderFromModelId('~anthropic/claude-sonnet-latest').displayName,
        'Anthropic'
    );
});

test('unknown and malformed authors degrade to safe provider names', () => {
    assert.deepEqual(resolveProviderFromModelId('future-lab/model'), {
        slug: 'future-lab',
        displayName: 'Future Lab'
    });
    assert.deepEqual(resolveProviderFromModelId('~/broken'), {
        slug: null,
        displayName: 'Unknown'
    });
    assert.deepEqual(resolveProvider(''), {
        slug: null,
        displayName: 'Unknown'
    });
});
```

- [ ] **Step 2: Run the focused test and confirm the module is missing**

Run: `node --test test/services/providerRegistry.test.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `providerRegistry.js`.

- [ ] **Step 3: Implement the registry and safe slug parsing**

Create a registry of canonical catalog author slugs with display names and optional
asset paths. Validate author slugs with `^[a-z0-9][a-z0-9._-]*$`; remove one leading
`~` only inside `resolveProviderFromModelId`. Humanize unknown valid slugs by replacing
hyphens/underscores with spaces and title-casing words. Return `{ slug: null,
displayName: 'Unknown' }` for invalid input.

- [ ] **Step 4: Route OpenRouter model formatting through the registry**

Import `resolveProviderFromModelId` in `chat/api.js`, replace `capitalizeProvider`, and
set `provider` from the returned `displayName`. Keep cached/fallback model shapes
unchanged.

- [ ] **Step 5: Run focused and catalog-related tests**

Run: `node --test test/services/providerRegistry.test.js test/domain/modelSelection.test.js`

Expected: all tests PASS.

### Task 2: Self-hosted provider assets and resilient icon rendering

**Files:**
- Modify: `chat/services/providerRegistry.js`
- Modify: `chat/services/providerIcons.js`
- Create: `test/services/providerIcons.test.js`
- Add: `chat/img/<provider>.svg` or `chat/img/<provider>.png` for selected catalog providers
- Create: `chat/img/PROVIDER_ASSETS.md`

**Interfaces:**
- Consumes: `resolveProvider(value)` and `getProviderAsset(displayName)` from Task 1
- Produces: existing `getProviderIcon(provider, classes): { html: string, hasIcon: boolean }`

- [ ] **Step 1: Write failing icon resolution tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { getProviderIcon } from '../../chat/services/providerIcons.js';

test('known providers use local assets', () => {
    const xai = getProviderIcon('xAI');
    assert.equal(xai.hasIcon, true);
    assert.match(xai.html, /src="img\/xai\.svg"/);
    assert.doesNotMatch(xai.html, /https?:\/\//);
});

test('OpenRouter uses a self-hosted asset', () => {
    const icon = getProviderIcon('OpenRouter');
    assert.match(icon.html, /src="img\/openrouter\.(svg|png)"/);
    assert.doesNotMatch(icon.html, /openrouter\.ai/);
});

test('unknown and malformed providers use escaped neutral badges', () => {
    assert.deepEqual(getProviderIcon('Future Lab').hasIcon, false);
    assert.match(getProviderIcon('Future Lab').html, />F<\/span>/);
    assert.match(getProviderIcon('<script>').html, />S<\/span>/);
    assert.match(getProviderIcon('').html, />A<\/span>/);
});

test('image markup includes a local failure fallback', () => {
    const icon = getProviderIcon('xAI');
    assert.match(icon.html, /data-provider-icon/);
    assert.match(icon.html, /data-provider-icon-fallback/);
    assert.doesNotMatch(icon.html, /onerror=/);
});
```

- [ ] **Step 2: Run the focused test and confirm missing coverage**

Run: `node --test test/services/providerIcons.test.js`

Expected: FAIL because xAI has no configured local asset and OpenRouter still uses a
remote favicon.

- [ ] **Step 3: Acquire and document self-hosted assets**

Download SVGs from official brand repositories or Simple Icons' versioned GitHub
sources; use official favicons only when no suitable vector mark exists. Save assets
with lowercase stable filenames, inspect that each is a valid image, and record brand,
filename, source URL, and source/license note in `chat/img/PROVIDER_ASSETS.md`.

- [ ] **Step 4: Populate major-provider asset entries**

Add local asset paths for the existing providers plus major missing catalog publishers
identified from the live catalog and asset research. Map provider naming aliases to the
same canonical entry; do not map downstream publishers to an architecture vendor.

- [ ] **Step 5: Make image failures fall back to the neutral badge**

Update `getProviderIcon` to obtain metadata from the registry, emit only local `img/`
URLs, escape provider-derived attribute text, and render a hidden sibling initial
badge. Install one capture-phase `error` listener for `[data-provider-icon]` images
that hides a failed image and reveals that sibling. Do not use inline `onerror`, so
the fallback remains compatible with a future strict `script-src 'self'` CSP. Preserve
the existing return shape so all picker/message consumers remain unchanged.

- [ ] **Step 6: Run icon and message-template tests**

Run: `node --test test/services/providerIcons.test.js test/components/messageTemplates.test.js`

Expected: all tests PASS.

### Task 3: Documentation, full verification, and visual preview

**Files:**
- Modify: `docs/APP_STATE.md`
- Modify: `docs/superpowers/plans/2026-07-11-model-provider-logos.md` (check completed steps)

**Interfaces:**
- Consumes: completed registry, catalog adapter, icon renderer, and local assets.
- Produces: verified production build and local preview instance.

- [ ] **Step 1: Document the provider-logo boundary**

Add an APP_STATE entry stating that OpenRouter latest aliases normalize in the catalog
adapter, provider display/icon metadata lives in the registry, all runtime assets are
local, and unknown/missing providers fall back to neutral initials.

- [ ] **Step 2: Run the complete unit suite**

Run: `npm test`

Expected: exit code 0 with all unit tests passing.

- [ ] **Step 3: Run the production build**

Run: `npm run build`

Expected: exit code 0 and a populated `dist/` without build errors.

- [ ] **Step 4: Inspect the final diff for accidental remote logo URLs and asset errors**

Run: `rg -n "https?://" chat/services/providerIcons.js chat/services/providerRegistry.js`

Expected: no matches.

Run: `find chat/img -maxdepth 1 -type f -print0 | xargs -0 file`

Expected: every new asset is identified as valid SVG, PNG, or icon data.

- [ ] **Step 5: Start the local UI for user review**

Run: `npm run dev`

Expected: server remains running and serves the chat app at
`http://localhost:8080/` (or the next available explicitly reported port).
