import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = process.cwd();

function read(relativePath) {
    return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('app entrypoint does not import concrete UI components directly', () => {
    const appSource = read('chat/app.js');
    assert.equal(
        /from ['"]\.\/components\//.test(appSource),
        false,
        'chat/app.js should depend on chat/ui, not concrete component files'
    );
});

test('domain and application layers do not import UI components', () => {
    const dirs = ['chat/domain', 'chat/application'];
    for (const dir of dirs) {
        const absoluteDir = path.join(repoRoot, dir);
        for (const file of fs.readdirSync(absoluteDir)) {
            if (!file.endsWith('.js')) continue;
            const source = read(`${dir}/${file}`);
            assert.equal(
                /from ['"].*components\//.test(source),
                false,
                `${dir}/${file} must not import UI components`
            );
        }
    }
});

test('vanilla UI adapter is the owner of concrete component construction', () => {
    const uiSource = read('chat/ui/vanilla/VanillaChatUi.js');
    const requiredComponents = [
        'ChatArea',
        'ChatInput',
        'Sidebar',
        'ModelPicker',
        'RightPanel',
        'MessageNavigation'
    ];

    for (const component of requiredComponents) {
        assert.equal(
            uiSource.includes(`new ${component}(`),
            true,
            `VanillaChatUi should construct ${component}`
        );
    }
});

test('shell components use injected persistence instead of IndexedDB', () => {
    const components = [
        'chat/components/ChatArea.js',
        'chat/components/ChatHistoryImportModal.js',
        'chat/components/ChatInput.js',
        'chat/components/MemoryEditor.js',
        'chat/components/MessageNavigation.js',
        'chat/components/RightPanel.js'
    ];

    for (const componentPath of components) {
        const source = read(componentPath);
        assert.equal(
            /from ['"].*\.\.\/db\.js['"]/.test(source),
            false,
            `${componentPath} must use the UI data interface, not chatDB directly`
        );
        assert.equal(
            /\bchatDB\b/.test(source),
            false,
            `${componentPath} must not reference chatDB directly`
        );
    }
});

test('shell components use injected backend services instead of importing gateways', () => {
    const components = [
        'chat/components/AccountModal.js',
        'chat/components/ChatInput.js',
        'chat/components/MemoryEditor.js',
        'chat/components/ShareModals.js',
        'chat/components/RightPanel.js',
        'chat/components/TLSSecurityModal.js',
        'chat/components/ThanksPanel.js',
        'chat/components/VerifierAttestationModal.js',
        'chat/components/WelcomePanel.js'
    ];
    const forbiddenImports = /from ['"].*\.\.\/services\/(ticketClient|networkLogger|networkProxy|inference\/inferenceService|verifier|shareService|accountService|syncService)\.js['"]/;

    for (const componentPath of components) {
        const source = read(componentPath);
        assert.equal(
            forbiddenImports.test(source),
            false,
            `${componentPath} must use app.services, not import backend gateways directly`
        );
    }
});

test('component templates do not reach through backend globals', () => {
    const source = read('chat/components/MessageTemplates.js');
    assert.equal(
        /window\.(inferenceService|networkLogger|ticketClient|networkProxy)/.test(source),
        false,
        'MessageTemplates should receive backend data through configuration, not window globals'
    );
});
