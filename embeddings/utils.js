function decodeBase64ToFloat32(base64) {
    if (typeof base64 !== 'string' || base64.length === 0) return null;
    if (typeof globalThis.atob === 'function') {
        const binary = globalThis.atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
    }
    if (typeof Buffer !== 'undefined') {
        const buffer = Buffer.from(base64, 'base64');
        return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
    }
    return null;
}

function coerceEmbedding(item) {
    if (!item) return new Float32Array();
    if (item instanceof Float32Array) return item;
    if (Array.isArray(item)) return Float32Array.from(item);
    if (typeof item === 'string') {
        return decodeBase64ToFloat32(item) || new Float32Array();
    }
    if (item.embedding instanceof Float32Array) return item.embedding;
    if (ArrayBuffer.isView(item.embedding)) return new Float32Array(item.embedding);
    if (Array.isArray(item.embedding)) return Float32Array.from(item.embedding);
    if (typeof item.embedding === 'string') {
        return decodeBase64ToFloat32(item.embedding) || new Float32Array();
    }
    return new Float32Array();
}

export function normalizeEmbeddingResponse(payload, options = {}) {
    if (!payload) {
        throw new Error('Embedding response is empty.');
    }

    const model = payload.model || options.model || null;
    let data = [];

    if (Array.isArray(payload.data)) {
        data = payload.data;
    } else if (Array.isArray(payload)) {
        data = payload;
    } else if (Array.isArray(payload.embedding)) {
        data = [{ embedding: payload.embedding }];
    } else if (typeof payload.embedding === 'string') {
        data = [{ embedding: payload.embedding }];
    }

    const embeddings = data.map((item) => coerceEmbedding(item));

    const normalizedData = embeddings.map((embedding, index) => ({
        index: data[index]?.index ?? index,
        embedding
    }));

    return {
        model,
        data: normalizedData,
        embeddings,
        usage: payload.usage ?? null,
        raw: payload
    };
}

export function firstEmbedding(response) {
    if (!response) return null;
    if (Array.isArray(response.embeddings)) {
        return response.embeddings[0] || null;
    }
    if (Array.isArray(response.data)) {
        const item = response.data[0];
        if (!item) return null;
        const embedding = coerceEmbedding(item);
        return embedding.length ? embedding : null;
    }
    return null;
}
