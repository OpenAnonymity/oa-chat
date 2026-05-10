import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import {
    extractDocxText,
    fileToMultimodalContent,
    getFileType,
    validateFile
} from '../../chat/services/fileUtils.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function makeZip(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const [name, content] of entries) {
        const nameBytes = Buffer.from(name, 'utf8');
        const uncompressed = Buffer.from(content, 'utf8');
        const compressed = deflateRawSync(uncompressed);

        const localHeader = Buffer.alloc(30);
        localHeader.writeUInt32LE(0x04034b50, 0);
        localHeader.writeUInt16LE(20, 4);
        localHeader.writeUInt16LE(0x0800, 6);
        localHeader.writeUInt16LE(8, 8);
        localHeader.writeUInt32LE(0, 10);
        localHeader.writeUInt32LE(0, 14);
        localHeader.writeUInt32LE(compressed.length, 18);
        localHeader.writeUInt32LE(uncompressed.length, 22);
        localHeader.writeUInt16LE(nameBytes.length, 26);
        localHeader.writeUInt16LE(0, 28);
        localParts.push(localHeader, nameBytes, compressed);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(0x02014b50, 0);
        centralHeader.writeUInt16LE(20, 4);
        centralHeader.writeUInt16LE(20, 6);
        centralHeader.writeUInt16LE(0x0800, 8);
        centralHeader.writeUInt16LE(8, 10);
        centralHeader.writeUInt32LE(0, 12);
        centralHeader.writeUInt32LE(0, 16);
        centralHeader.writeUInt32LE(compressed.length, 20);
        centralHeader.writeUInt32LE(uncompressed.length, 24);
        centralHeader.writeUInt16LE(nameBytes.length, 28);
        centralHeader.writeUInt16LE(0, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt32LE(0, 34);
        centralHeader.writeUInt32LE(0, 38);
        centralHeader.writeUInt32LE(offset, 42);
        centralParts.push(centralHeader, nameBytes);

        offset += localHeader.length + nameBytes.length + compressed.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const centralDirectoryOffset = offset;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralDirectory.length, 12);
    eocd.writeUInt32LE(centralDirectoryOffset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, centralDirectory, eocd]);
}

function makeDocxFile(name = 'sample.docx', type = DOCX_MIME) {
    const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:body>
                <w:p><w:r><w:t>Hello &amp; welcome</w:t></w:r></w:p>
                <w:p><w:r><w:t>Second</w:t></w:r><w:r><w:tab/></w:r><w:r><w:t>line</w:t></w:r></w:p>
            </w:body>
        </w:document>`;
    const zipBytes = makeZip([
        ['[Content_Types].xml', '<Types/>'],
        ['word/document.xml', documentXml]
    ]);

    return new File([zipBytes], name, { type });
}

test('getFileType detects DOCX by MIME type and extension', async () => {
    assert.equal(await getFileType(makeDocxFile()), 'docx');
    assert.equal(await getFileType(makeDocxFile('extension-only.docx', '')), 'docx');
});

test('extractDocxText reads compressed Word document XML', async () => {
    const text = await extractDocxText(makeDocxFile());

    assert.equal(text, 'Hello & welcome\nSecond\tline');
});

test('validateFile and fileToMultimodalContent accept DOCX as text content', async () => {
    const file = makeDocxFile('brief.docx');

    assert.deepEqual(await validateFile(file), { valid: true, fileType: 'docx' });

    const content = await fileToMultimodalContent(file);
    assert.equal(content.type, 'text');
    assert.ok(content.text.startsWith('--- File: brief.docx ---\n'));
    assert.ok(content.text.includes('Hello & welcome'));
});
