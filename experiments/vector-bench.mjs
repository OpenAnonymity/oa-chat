import { performance } from 'node:perf_hooks';
import { createVectorStore } from '../vector/index.js';

function randomVector(dimension) {
    const vec = new Float32Array(dimension);
    for (let i = 0; i < dimension; i += 1) {
        vec[i] = Math.random();
    }
    return vec;
}

function summarize(label, ms, count) {
    const per = ms / count;
    console.log(`${label}: ${ms.toFixed(2)} ms total (${per.toFixed(4)} ms/op)`);
}

async function benchBackend(name, options) {
    const dimension = options.dimension;
    const size = options.size;
    const queries = options.queries;
    const k = options.k;

    const store = await createVectorStore({
        name: `bench-${name}`,
        dimension,
        metric: 'cosine',
        backend: name,
        ...options.backendOptions
    });

    const items = [];
    for (let i = 0; i < size; i += 1) {
        items.push({ id: `${name}-${i}`, vector: randomVector(dimension) });
    }

    const t0 = performance.now();
    await store.upsert(items);
    const t1 = performance.now();

    const queryVectors = [];
    for (let i = 0; i < queries; i += 1) {
        queryVectors.push(randomVector(dimension));
    }

    const t2 = performance.now();
    for (const q of queryVectors) {
        // eslint-disable-next-line no-await-in-loop
        await store.search(q, k);
    }
    const t3 = performance.now();

    console.log(`\nBackend: ${name}`);
    summarize('Upsert', t1 - t0, size);
    summarize('Search', t3 - t2, queries);
}

async function main() {
    const config = {
        dimension: 256,
        size: 5000,
        queries: 100,
        k: 10
    };

    await benchBackend('memory', config);

    await benchBackend('orama', {
        ...config,
        backendOptions: {
            persistence: 'none',
            moduleFactory: async () => {
                const mod = await import('@orama/orama');
                return mod?.default || mod;
            }
        }
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
