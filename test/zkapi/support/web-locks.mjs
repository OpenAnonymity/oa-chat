// Node has no browser Web Locks. Tests get explicit, in-process serialization;
// production deliberately fails closed instead of using this tab-local fallback.
const tails = new Map();
const locks = { async request(name, options, operation) {
    if (typeof options === 'function') { operation = options; options = {}; }
    if (options?.ifAvailable && tails.has(name)) return operation(null);
    const before = tails.get(name) || Promise.resolve();
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const tail = before.then(() => held);
    tails.set(name, tail);
    await before;
    try { return await operation({ name, mode: 'exclusive' }); }
    finally { release(); if (tails.get(name) === tail) tails.delete(name); }
} };
Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: locks });
