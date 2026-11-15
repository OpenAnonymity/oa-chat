/**
 * Attachments on their way into a message.
 *
 * A picked file is kept in IndexedDB until it has been read for the model, so
 * a reload can still send it. It is kept as plain bytes, never as the File the
 * browser handed over: iPhone Safari (Private Browsing in particular) can fail
 * to store a picked File in IndexedDB, and that failed every image send before
 * the message appeared.
 */

const isBlob = value => typeof Blob === 'function' && value instanceof Blob;

/** Bytes and metadata for each picked file; anything else passes through. */
export async function toStorableFiles(files = []) {
    return Promise.all((files || []).map(async file => {
        if (!isBlob(file) || typeof file.arrayBuffer !== 'function') return file;
        return {
            name: file.name || 'attachment',
            type: file.type || '',
            size: file.size,
            lastModified: file.lastModified || Date.now(),
            bytes: await file.arrayBuffer()
        };
    }));
}

/** Files again, from what toStorableFiles kept (or File objects saved earlier). */
export function revivePendingFiles(records) {
    if (!Array.isArray(records)) return [];
    return records.map(record => {
        if (!(record?.bytes instanceof ArrayBuffer) || typeof File !== 'function') return record;
        return new File([record.bytes], record.name || 'attachment', {
            type: record.type || '',
            lastModified: record.lastModified || Date.now()
        });
    });
}

/**
 * A small preview for the composer, drawn once per file. A full-size photo
 * as a 40px thumbnail kept the whole decoded picture in the page (about 48 MB
 * for a 12 MP photo), which made phones stutter while anything moved above it.
 */
export async function createImageThumbnail(file, {
    size = 160,
    documentImpl = globalThis.document,
    URLImpl = globalThis.URL,
    ImageImpl = globalThis.Image
} = {}) {
    const url = URLImpl.createObjectURL(file);
    try {
        const image = new ImageImpl();
        image.decoding = 'async';
        image.src = url;
        await image.decode();
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        if (!width || !height) throw new Error('The image has no size.');
        // Fill the square: the shorter side becomes `size`.
        const scale = Math.min(1, size / Math.min(width, height));
        const canvas = documentImpl.createElement('canvas');
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
        return file.type === 'image/jpeg' || file.type === 'image/jpg'
            ? canvas.toDataURL('image/jpeg', 0.85)
            : canvas.toDataURL('image/png');
    } finally {
        URLImpl.revokeObjectURL(url);
    }
}
