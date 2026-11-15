// Public proof assets are cache-versioned without relaxing their pinned SHA-256 check.
export default {
    name: 'proof-cache-integrity-v1',
    revision: '3342c95871e8422bb878ad40072687c241a68a5b',
    files: [{
        file: 'sdk/services/zkapiWasmWorker.js',
        beforeSha256: 'a694715acdc96e3342ecccc2340d04717cfa12dec3667131b0fb5a753e0588be',
        afterSha256: 'e21bb0352ee780e679b0183a816a3f7af38fe0ab62ad4755d44aaf9d30b420b2',
        replacements: [{
            before: `        const response = await fetch(descriptor.url, { cache: 'force-cache', credentials: 'same-origin' });
        if (!response.ok) throw new Error(\`Unable to load proving key (\${response.status}).\`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (descriptor.sha256) {
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
            if (bytesToHex(digest) !== descriptor.sha256.toLowerCase()) {
                throw new Error('The downloaded proving key failed its SHA-256 integrity check.');
            }
        }
        return bytes;`,
            after: `        // Stable asset paths can retain an older circuit in the browser cache.
        // Scope cached bytes to the public pin and retry a mismatch once from
        // the network. Every returned byte still passes the original hash check.
        const expectedHash = descriptor.sha256?.toLowerCase();
        const keyUrl = new URL(descriptor.url);
        if (expectedHash) keyUrl.searchParams.set('sha256', expectedHash);
        for (const cache of ['force-cache', 'reload']) {
            const response = await fetch(keyUrl.href, { cache, credentials: 'omit' });
            if (!response.ok) throw new Error(\`Unable to load proving key (\${response.status}).\`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (expectedHash) {
                const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
                if (bytesToHex(digest) !== expectedHash) {
                    if (cache === 'force-cache') continue;
                    throw new Error('The downloaded proving key failed its SHA-256 integrity check.');
                }
            }
            return bytes;
        }`
        }]
    }]
};
