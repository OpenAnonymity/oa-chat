const ID_VERSION = 'v1';

function encodePart(value) {
    if (value === null || value === undefined) return '';
    return encodeURIComponent(String(value));
}

function decodePart(value) {
    if (!value) return null;
    return decodeURIComponent(value);
}

export function encodeVectorId({
    namespace,
    type,
    entityId,
    chunkId,
    field,
    variant
} = {}) {
    if (entityId === null || entityId === undefined) {
        throw new Error('encodeVectorId requires entityId.');
    }

    const parts = [
        ID_VERSION,
        encodePart(namespace),
        encodePart(type),
        encodePart(entityId),
        encodePart(chunkId),
        encodePart(field),
        encodePart(variant)
    ];

    while (parts.length > 0 && parts[parts.length - 1] === '') {
        parts.pop();
    }

    return parts.join('::');
}

export function decodeVectorId(id) {
    if (!id || typeof id !== 'string') return null;
    const parts = id.split('::');
    if (parts[0] !== ID_VERSION) return null;

    return {
        version: parts[0],
        namespace: decodePart(parts[1]),
        type: decodePart(parts[2]),
        entityId: decodePart(parts[3]),
        chunkId: decodePart(parts[4]),
        field: decodePart(parts[5]),
        variant: decodePart(parts[6])
    };
}

export const VECTOR_ID_VERSION = ID_VERSION;
