import test from 'node:test';
import assert from 'node:assert/strict';
import { createImageThumbnail, revivePendingFiles, toStorableFiles } from '../../chat/services/pendingFiles.js';

test('a picked file is saved as bytes, so a database that cannot hold a File still takes the message', async () => {
    const photo = new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])], 'IMG_4917.jpeg',
        { type: 'image/jpeg', lastModified: 1700000000000 });
    const [stored, plain] = await toStorableFiles([photo, { name: 'recovery.txt' }]);
    assert.ok(!(stored instanceof Blob), 'no File object reaches IndexedDB');
    assert.ok(stored.bytes instanceof ArrayBuffer);
    assert.deepEqual({ ...stored, bytes: null },
        { name: 'IMG_4917.jpeg', type: 'image/jpeg', size: 6, lastModified: 1700000000000, bytes: null });
    assert.deepEqual(plain, { name: 'recovery.txt' });

    // IndexedDB keeps a structured clone; a reload reads that back.
    const [revived, passed] = revivePendingFiles(structuredClone([stored, plain]));
    assert.ok(revived instanceof File);
    assert.equal(revived.name, 'IMG_4917.jpeg');
    assert.equal(revived.type, 'image/jpeg');
    assert.equal(revived.size, 6);
    assert.equal(revived.lastModified, 1700000000000);
    assert.deepEqual([...new Uint8Array(await revived.arrayBuffer())], [0xff, 0xd8, 0xff, 1, 2, 3]);
    assert.deepEqual(passed, { name: 'recovery.txt' });
});

test('files saved by the previous version still come back as themselves', () => {
    const earlier = new File(['x'], 'earlier.txt', { type: 'text/plain' });
    assert.equal(revivePendingFiles([earlier])[0], earlier);
    assert.deepEqual(revivePendingFiles(undefined), []);
});

test('the composer preview is drawn small from the picture, and the picture is let go', async () => {
    const urls = [];
    const drawn = [];
    const canvas = {
        getContext: () => ({ drawImage: (image, x, y, width, height) => drawn.push([width, height]) }),
        toDataURL: (type, quality) => `data:${type};q=${quality}`
    };
    class FakeImage { naturalWidth = 4032; naturalHeight = 3024; async decode() {} }
    const options = {
        documentImpl: { createElement: name => (assert.equal(name, 'canvas'), canvas) },
        URLImpl: { createObjectURL: () => 'blob:photo', revokeObjectURL: url => urls.push(url) },
        ImageImpl: FakeImage
    };
    const photo = new File(['x'], 'IMG_4917.jpeg', { type: 'image/jpeg' });
    assert.equal(await createImageThumbnail(photo, options), 'data:image/jpeg;q=0.85');
    assert.deepEqual([canvas.width, canvas.height], [213, 160], 'the short side is 160px, the shape kept');
    assert.deepEqual(drawn, [[213, 160]]);
    assert.deepEqual(urls, ['blob:photo']);

    const screenshot = new File(['x'], 'IMG_4905.png', { type: 'image/png' });
    assert.equal(await createImageThumbnail(screenshot, options), 'data:image/png;q=undefined', 'PNG keeps transparency');
});
