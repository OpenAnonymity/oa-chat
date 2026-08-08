import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const repoRoot = process.cwd();

async function readRepoFile(relativePath) {
    return fs.readFile(path.join(repoRoot, relativePath), 'utf8');
}

test('memory services do not statically import nanomem browser module', async () => {
    const files = [
        'chat/services/memoryBridge.js',
        'chat/services/memoryInstances.js',
        'chat/services/omfImporter.js'
    ];

    for (const file of files) {
        const source = await readRepoFile(file);
        assert.doesNotMatch(
            source,
            /import\s+[^;]*['"]\.\.\/nanomem\/browser\.js['"]/,
            `${file} must lazy-load nanomem only inside enabled memory operations`
        );
    }
});

test('memory storage lazy-load path checks abort signal before storage invocation', async () => {
    const source = await readRepoFile('chat/services/memoryInstances.js');

    assert.match(
        source,
        /async function getMemoryBank\(signal = null\)[\s\S]*?throwIfAborted\(signal\);[\s\S]*?loadNanomemBrowser\(signal\)[\s\S]*?throwIfAborted\(signal\);[\s\S]*?return memoryBankInstance;/,
        'getMemoryBank must re-check the operation signal around lazy nanomem loading'
    );
    assert.match(
        source,
        /async function withMemoryBank\(signal, operation\)[\s\S]*?getMemoryBank\(signal\)[\s\S]*?throwIfAborted\(signal\);[\s\S]*?operation\(bank\)/,
        'storage facade must check the signal after lazy loading and before invoking storage'
    );
    assert.match(
        source,
        /read: async \(path, options = \{\}\) => withMemoryBank\(options\?\.signal, \(bank\) => bank\.storage\.read\(path\)\)/,
        'storage read must be routed through the abort-aware memory bank wrapper'
    );
    assert.match(
        source,
        /write: async \(path, content, options = \{\}\) => withMemoryBank\(options\?\.signal, \(bank\) => bank\.storage\.write\(path, content\)\)/,
        'storage writes must be routed through the abort-aware memory bank wrapper'
    );
});

test('confidential memory bridge lazy-load path receives abort signal', async () => {
    const source = await readRepoFile('chat/services/memoryBridge.js');

    assert.match(
        source,
        /async function loadNanomemBrowser\(signal = null\)[\s\S]*?throwIfAborted\(signal\);[\s\S]*?import\('\.\.\/nanomem\/browser\.js'\)[\s\S]*?throwIfAborted\(signal\);/,
        'memoryBridge must check the active signal before and after lazy nanomem loading'
    );
    assert.match(
        source,
        /loadNanomemBrowser\(signal\)/,
        'memoryBridge must pass the active memory signal into the lazy loader'
    );
});

test('OMF importer storage adapter passes abort signal into memory storage facade', async () => {
    const source = await readRepoFile('chat/services/omfImporter.js');

    assert.match(
        source,
        /storage\.read\(path, \{ signal \}\)/,
        'OMF storage reads must pass the active signal into the memory storage facade'
    );
    assert.match(
        source,
        /storage\.write\(path, content, \{ signal \}\)/,
        'OMF storage writes must pass the active signal into the memory storage facade'
    );
    assert.match(
        source,
        /storage\.exportAll\(\{ signal \}\)/,
        'OMF storage export must pass the active signal into the memory storage facade'
    );
});
