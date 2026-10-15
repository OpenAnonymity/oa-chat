// Checked-in stub of the zkAPI build variant loader.
//
// In a build that carries more than one SDK (or one under a non-canonical
// package alias) the zkAPI build plugin REPLACES this module at bundle time with
// generated code whose loadVariant(id) imports exactly one SDK variant and binds
// the SDK facades to it (scripts/zkapiFacadePlugin.mjs). Everywhere else (plain
// Node, the dev server, single-version and sdk-default builds) this stub stays
// and rejects with code `no_variants`, which boot treats as "nothing to load".
//
// Keep exactly ONE export: the generated module exports exactly `loadVariant`,
// and the build refuses a stub that exports more.
export function loadVariant(id) {
    const error = new Error('This build has no alternative zkAPI SDK variants.');
    error.code = 'no_variants';
    error.variantId = typeof id === 'string' ? id : null;
    return Promise.reject(error);
}
