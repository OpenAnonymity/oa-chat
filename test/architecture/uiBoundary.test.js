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

test('initial model load drains pinned availability refreshes', () => {
    const source = read('chat/app.js');
    const initialLoadMatch = source.match(/this\.loadModels\(\)\.then\(async \(\) => \{([\s\S]*?)\}\)\.catch/);

    assert.ok(initialLoadMatch, 'initial model load should use an async completion handler');

    const initialLoadBody = initialLoadMatch[1];
    assert.ok(
        initialLoadBody.includes('await this.refreshDefaultModelPreferenceForAvailabilityUpdate();'),
        'initial model load should rerun default preference upgrade after models are available'
    );
    assert.ok(
        /if \(this\.pendingModelAvailabilityRefresh\) \{[\s\S]*?await this\.refreshModelsForAvailabilityUpdate\(\);/.test(initialLoadBody),
        'initial model load should drain pinned updates that arrived while models were loading'
    );
});

test('cached provider metadata stays display-only and hydrates before the saved-model render', () => {
    const appSource = read('chat/app.js');
    const modelPickerSource = read('chat/components/ModelPicker.js');
    const serviceSource = read('chat/services/inference/inferenceService.js');
    const backendSource = read('chat/services/inference/backends/openRouterBackend.js');
    const initSource = appSource.slice(
        appSource.indexOf('    async init() {'),
        appSource.indexOf('    setupInputAreaObserver()')
    );
    const switchSessionSource = appSource.slice(
        appSource.indexOf('    async switchSession(sessionId) {'),
        appSource.indexOf('    async clearCurrentSession(options = {})')
    );
    const clearSessionSource = appSource.slice(
        appSource.indexOf('    async clearCurrentSession(options = {})'),
        appSource.indexOf('    async updateSessionTitle(')
    );
    const hydrationIndex = initSource.indexOf('this.cachedModelDisplayMetadata = inferenceService.getCachedModels(this.getCurrentSession())');
    const savedModelRenderIndex = initSource.lastIndexOf('this.renderCurrentModel();');

    assert.ok(backendSource.includes('getCachedModels:'), 'OpenRouter backend should expose its local catalog cache');
    assert.ok(serviceSource.includes('getCachedModels(session)'), 'inference service should expose backend cache reads');
    assert.equal(
        /this\.state\.models\s*=\s*[^;]*getCachedModels/.test(initSource),
        false,
        'cached display metadata must not become request-authoritative state.models'
    );
    assert.ok(hydrationIndex >= 0, 'app initialization should hydrate display-only cached metadata');
    assert.ok(
        hydrationIndex < savedModelRenderIndex,
        'cached provider metadata must be available before the saved-model render'
    );
    assert.ok(
        modelPickerSource.includes('this.app.cachedModelDisplayMetadata'),
        'current-model provider lookup should use display-only cached metadata as a fallback'
    );
    assert.ok(
        switchSessionSource.includes('this.cachedModelDisplayMetadata = inferenceService.getCachedModels(session);'),
        'switching sessions should refresh display metadata for the restored backend'
    );
    assert.ok(
        clearSessionSource.includes('this.cachedModelDisplayMetadata = inferenceService.getCachedModels();'),
        'clearing a session should restore default-backend display metadata'
    );
});

test('inline quick ask preserves scrubber and session lifecycle constraints', () => {
    const appSource = read('chat/app.js');
    const apiSource = read('chat/api.js');
    const chatAreaSource = read('chat/components/ChatArea.js');
    const templatesSource = read('chat/components/MessageTemplates.js');
    const stylesSource = read('chat/styles.css');

    assert.ok(
        templatesSource.includes('data-scrubber-restored="true"'),
        'restored assistant scrubber content should be marked in rendered DOM'
    );
    assert.ok(
        chatAreaSource.includes("messageEl.dataset.scrubberRestored === 'true'"),
        'quick ask selection should be disabled for restored scrubber content'
    );

    const inlineQuickAskMatch = appSource.match(/async inlineQuickAsk\([\s\S]*?\n    updateTypingIndicator/);
    assert.ok(inlineQuickAskMatch, 'inlineQuickAsk method should be present');
    const quickAskModelResolverMatch = appSource.match(/async resolveModelForQuickAsk\([\s\S]*?\n    async inlineQuickAsk/);
    assert.ok(quickAskModelResolverMatch, 'resolveModelForQuickAsk method should be present');
    assert.ok(
        /onStatus\?\.\('requesting-key'\)[\s\S]*?acquireAndSetAccess[\s\S]*?abortController\.signal\.aborted[\s\S]*?inferenceService\.streamCompletion/.test(inlineQuickAskMatch[0]),
        'inline quick ask should acquire access for expired past sessions and re-check cancellation before inference'
    );
    assert.ok(
        inlineQuickAskMatch[0].includes('signal: abortController.signal'),
        'quick ask access acquisition should receive the panel abort signal'
    );
    assert.ok(
        inlineQuickAskMatch[0].includes('const { modelId, modelName } = await this.resolveModelForQuickAsk(session);') &&
        inlineQuickAskMatch[0].includes('modelIdOverride: modelId') &&
        inlineQuickAskMatch[0].includes('modelNameOverride: modelName'),
        'quick ask should resolve the pinned instant model before key acquisition and use it for ticket cost'
    );
    assert.ok(
        quickAskModelResolverMatch[0].includes('getDefaultModelConfig()') &&
        appSource.includes('getQuickAskPinnedInstantModel') &&
        appSource.includes('isQuickAskPinnedInstantModel') &&
        appSource.includes("name.includes('instant')") &&
        !quickAskModelResolverMatch[0].includes('chatDB.saveSession'),
        'quick ask model resolution should prefer pinned GPT instant without mutating the session model'
    );
    assert.ok(
        appSource.includes('accessAcquisitionInFlight') &&
        appSource.includes('reserveAccessAcquisitionHandoff') &&
        appSource.includes('waitForAccessAcquisition') &&
        appSource.includes('entry.controller.abort()'),
        'session access acquisition should be shared and cancellable to avoid duplicate ticket redemption'
    );
    assert.ok(
        inlineQuickAskMatch[0].includes('getSessionStreamingState(session.id).isStreaming'),
        'inline quick ask should not run concurrently with the main session stream'
    );
    assert.ok(
        /buildQuickAskMessages[\s\S]*?abortController\.signal\.aborted[\s\S]*?inferenceService\.streamCompletion/.test(inlineQuickAskMatch[0]),
        'inline quick ask should re-check cancellation immediately before starting inference'
    );
    assert.ok(
        /abortController\?\.signal\?\.aborted[\s\S]*?isAndroidNativeInferenceAvailable/.test(apiSource),
        'streamCompletion should reject already-aborted requests before Android native transport starts'
    );

    const renderMatch = chatAreaSource.match(/async render\(\) \{[\s\S]*?const session = this\.app\.getCurrentSession\(\);/);
    assert.ok(renderMatch, 'ChatArea.render should be present');
    assert.ok(
        chatAreaSource.includes('if (!preserveQuickAskWindow)') &&
        chatAreaSource.includes('this.closeQuickAskWindow({ abort: true, reset: true });'),
        'full message rerenders should still abort and reset quick ask windows when they are not preserved'
    );
    assert.ok(
        chatAreaSource.includes('!this.quickAsk.window.isConnected') &&
        chatAreaSource.includes('shouldPreserveQuickAskWindowForRender') &&
        chatAreaSource.includes('detachQuickAskWindowForRender') &&
        chatAreaSource.includes('restoreQuickAskWindowAfterRender'),
        'same-session renders should preserve and reconnect quick ask windows during no-key acquisition'
    );
    assert.ok(
        chatAreaSource.includes('document.body.appendChild(this.quickAsk.window)') &&
        chatAreaSource.includes('document.body.appendChild(panel)') &&
        chatAreaSource.includes('windowAnchor') &&
        chatAreaSource.includes('syncQuickAskWindowToScroll') &&
        chatAreaSource.includes('preserveAnchor') &&
        chatAreaSource.includes('quick-ask-layer-active') &&
        /\.quick-ask-window\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?z-index:\s*45;/.test(stylesSource) &&
        /\.quick-ask-popover\s*\{[\s\S]*?z-index:\s*45;/.test(stylesSource) &&
        /body\.quick-ask-layer-active #input-card[\s\S]*?z-index:\s*40 !important;/.test(stylesSource),
        'quick ask window should portal above chat chrome but below app modals while preserving a scroll anchor'
    );

    const sendMessageMatch = appSource.match(/async sendMessage\(\) \{[\s\S]*?const abortController = new AbortController\(\);/);
    assert.ok(sendMessageMatch, 'sendMessage should be present');
    assert.ok(
        sendMessageMatch[0].includes('this.reserveAccessAcquisitionHandoff(session);') &&
        sendMessageMatch[0].includes('this.chatArea?.closeQuickAskWindow?.();'),
        'starting a normal send should hand off key acquisition before hiding any active quick ask'
    );

    assert.ok(
        chatAreaSource.includes("this.updateQuickAskReasoning('');") &&
        chatAreaSource.includes('this.updateQuickAskCitations(null);'),
        'new quick ask requests and errors should clear stale reasoning and sources'
    );
    assert.ok(
        chatAreaSource.includes('activeKey') &&
        chatAreaSource.includes("panel.classList.remove('hidden');") &&
        !chatAreaSource.includes('quick-ask-close-btn') &&
        !chatAreaSource.includes('quick-ask-stop-btn'),
        'quick ask should hide without inline close/stop controls and allow reopening the same selection state'
    );
    assert.ok(
        chatAreaSource.includes('buildReasoningTrace(') &&
        chatAreaSource.includes('pending-response-line'),
        'quick ask pending and reasoning states should reuse main chat formatting'
    );
    assert.ok(
        chatAreaSource.includes('quick-ask-assistant-pending') &&
        chatAreaSource.includes('this.closeQuickAskWindow();'),
        'quick ask should add pending breathing room and hide when clicking elsewhere'
    );
});
