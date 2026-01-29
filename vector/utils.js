export const METRICS = new Set(['cosine', 'ip', 'l2']);

export function normalizeMetric(metric) {
    const resolved = (metric || 'cosine').toLowerCase();
    if (!METRICS.has(resolved)) {
        throw new Error(`Unsupported metric: ${metric}`);
    }
    return resolved;
}

export function toId(value) {
    if (value === null || value === undefined) {
        throw new Error('Vector item id is required.');
    }
    return String(value);
}

export function toFloat32Array(input, dimension) {
    if (input === null || input === undefined) {
        throw new Error('Vector is required.');
    }

    let data;
    if (input instanceof Float32Array) {
        data = input;
    } else if (ArrayBuffer.isView(input)) {
        data = Float32Array.from(input);
    } else if (input instanceof ArrayBuffer) {
        data = new Float32Array(input);
    } else if (Array.isArray(input)) {
        data = Float32Array.from(input);
    } else {
        throw new Error('Unsupported vector type.');
    }

    if (data.length !== dimension) {
        throw new Error(`Vector dimension mismatch (expected ${dimension}, got ${data.length}).`);
    }

    return data;
}

export function prepareVector(input, dimension, normalize) {
    const source = toFloat32Array(input, dimension);
    const output = new Float32Array(dimension);
    let sum = 0;

    for (let i = 0; i < dimension; i += 1) {
        const value = source[i];
        output[i] = value;
        sum += value * value;
    }

    if (normalize) {
        if (sum > 0) {
            const scale = 1 / Math.sqrt(sum);
            for (let i = 0; i < dimension; i += 1) {
                output[i] *= scale;
            }
        }
    }

    return output;
}

export function ensurePositiveInteger(value, fallback) {
    if (!Number.isFinite(value)) return fallback;
    const coerced = Math.floor(value);
    if (coerced <= 0) return fallback;
    return coerced;
}
