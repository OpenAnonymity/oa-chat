// Stay below the 4 MiB desktop sync-only envelope. Count the exact UTF-8 JSON
// body (including envelope and commas), not decoded ciphertext or item count.
export const MAX_SYNC_UPLOAD_BYTES = 3.5 * 1024 * 1024;
export const MAX_SYNC_BLOBS_PER_REQUEST = 100;
const encoder = new TextEncoder();
const envelopeBytes = encoder.encode('{"blobs":[]}').byteLength;

export function buildSyncUploadBatches(blobs) {
    const batches = [];
    let batch = [];
    let serialized = [];
    let bytes = envelopeBytes;
    const flush = () => {
        if (batch.length) batches.push({ blobs: batch, body: `{"blobs":[${serialized.join(',')}]}` });
        batch = [];
        serialized = [];
        bytes = envelopeBytes;
    };
    // Prepare every batch before the caller sends anything. A single oversized
    // history item requires a compatible format change, never silent omission.
    for (const blob of blobs) {
        const item = JSON.stringify(blob);
        if (typeof item !== 'string') throw new Error('Invalid sync upload item');
        const itemBytes = encoder.encode(item).byteLength;
        if (envelopeBytes + itemBytes > MAX_SYNC_UPLOAD_BYTES) {
            throw new Error('A sync item is too large to upload safely. Your local data is kept; sync needs a compatible storage update.');
        }
        if (batch.length === MAX_SYNC_BLOBS_PER_REQUEST ||
            bytes + itemBytes + (batch.length ? 1 : 0) > MAX_SYNC_UPLOAD_BYTES) flush();
        bytes += itemBytes + (batch.length ? 1 : 0);
        batch.push(blob);
        serialized.push(item);
    }
    flush();
    return batches;
}
