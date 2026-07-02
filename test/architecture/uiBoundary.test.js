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

test('parallel aggregate messages omit redundant visible mode and completion labels', () => {
    const source = read('chat/components/MessageTemplates.js');
    const styles = read('chat/styles.css');
    assert.equal(
        source.includes('const displayTitle'),
        false,
        'Parallel/Council aggregate rows should use the icon without a redundant text title'
    );
    const councilMessageBlock = source.match(/function buildCouncilAssistantMessage[\s\S]*?\n}\n\n\/\*\*/)?.[0] || '';
    assert.equal(
        councilMessageBlock.includes('buildCouncilModeIconHtml()'),
        false,
        'Parallel/Council messages should not render a redundant aggregate icon header'
    );
    assert.equal(
        source.includes('${escapeHtml(displayTitle)}'),
        false,
        'Parallel/Council aggregate title text should not render in the assistant header'
    );
    assert.equal(
        source.includes("const displayModelName = isCouncil ? '' : extractShortModelName(modelName);"),
        true,
        'Parallel/Council typing indicators should hide the redundant text label'
    );
    assert.equal(
        source.includes("const hiddenStatuses = new Set(['complete', 'pending', 'running', 'waiting']);"),
        true,
        'completed and in-progress lane/synthesis statuses should be hidden while important non-complete statuses can remain visible'
    );
    assert.equal(
        source.includes('!hiddenStatuses.has(normalizedStatus)'),
        true,
        'pending/running/waiting statuses should not fall through as raw visible text'
    );
    assert.equal(
        source.includes("pending: 'Pending'"),
        false,
        'pending lane status should not render a redundant status chip'
    );
    assert.equal(
        source.includes('Waiting for this model to finish...'),
        false,
        'pending lanes should reuse the main chat waiting indicator, not custom lane copy'
    );
    assert.equal(
        source.includes('Preparing Council answer...'),
        false,
        'Council synthesis should reuse the normal waiting copy instead of custom preparation text'
    );
    assert.equal(
        source.includes('<span>Council Answer</span>'),
        false,
        'Council synthesis should not render redundant Council Answer header copy'
    );
    assert.equal(
        source.includes('buildCouncilModelLabel(synthesisModel, { includeProvider: true })'),
        false,
        'Council synthesis model labels should match lane labels by omitting provider prefixes'
    );
    assert.equal(
        source.includes("buildCouncilModelLabel(synthesisModel, { roleLabel: 'Council' })"),
        true,
        'Council synthesis should identify the selected synthesis model as the Council model'
    );
    assert.equal(
        source.includes("buildCouncilModelLabel(entry.model || entry.modelId || '')"),
        true,
        'Stage 1 lane labels should remain plain model labels without Council role text'
    );
    assert.equal(
        source.includes('council-response-role-label'),
        true,
        'Council role text should use a dedicated label class'
    );
    assert.equal(
        source.includes('(${escapeHtml(roleLabel)})'),
        false,
        'Council role text should render as a visible badge, not a subtle parenthetical suffix'
    );
    assert.equal(
        source.includes('const showMeta = !!(synthesisModelHtml || statusHtml);'),
        true,
        'Council synthesis should show the selected model row while waiting and after completion'
    );
    assert.equal(
        source.includes("const COUNCIL_SYNTHESIS_ACTION_PENDING_STATUSES = new Set(['waiting', 'pending', 'running']);"),
        true,
        'Council review should define the synthesis states that hide aggregate message actions'
    );
    assert.equal(
        source.includes('const assistantActionsRow = hasSynthesis && shouldShowCouncilAssistantActions(synthesis)'),
        true,
        'Council review should hide aggregate copy/regenerate/fork while synthesis is still pending and plain Parallel should not use aggregate actions'
    );
    assert.equal(
        source.includes('const citationScopeId = buildCitationScopeId(messageId, entry.laneId || entry.label || \'lane\');'),
        true,
        'Stage 1 lanes should render lane-scoped citation controls'
    );
    assert.equal(
        source.includes("const citationScopeId = buildCitationScopeId(messageId, 'synthesis');"),
        true,
        'Council synthesis should render its own citation controls'
    );
    assert.equal(
        source.includes('entry.reasoning'),
        true,
        'Parallel lanes should render the same reasoning trace UI when a lane returns thinking content'
    );
    assert.equal(
        source.includes('synthesis.reasoning'),
        true,
        'Council synthesis should render the same reasoning trace UI when the synthesis model returns thinking content'
    );
    assert.equal(
        source.includes('buildReasoningTrace('),
        true,
        'Council/Parallel reasoning should reuse the normal assistant reasoning trace component'
    );
    assert.equal(
        source.includes('entry.streamingReasoning'),
        true,
        'Parallel lanes should render live reasoning state while a lane stream is running'
    );
    const controllerSource = read('chat/application/councilController.js');
    const chatAreaSource = read('chat/components/ChatArea.js');
    assert.equal(
        controllerSource.includes('this.inferenceService.streamCompletion('),
        true,
        'Parallel/Council lanes should use the streaming inference path'
    );
    assert.equal(
        chatAreaSource.includes('this.councilReasoningStreams = new Map();'),
        true,
        'Parallel/Council reasoning needs lane-scoped buffers for concurrent streams'
    );
    assert.equal(
        chatAreaSource.includes('clearAllCouncilReasoningStreams()'),
        true,
        'Parallel/Council reasoning timers should be cleared when the chat area rerenders'
    );
    assert.equal(
        chatAreaSource.includes('this.clearCouncilReasoningStream(reasoningId);'),
        true,
        'Parallel/Council reasoning timers should self-clear if their DOM target disappears'
    );
    assert.equal(
        source.includes('council-response-sources-row'),
        true,
        'Council/Parallel sources should appear inside the lane or synthesis block'
    );
    assert.equal(
        source.includes('buildAssistantCitationsOnlyRow(citationsToggle);'),
        false,
        'Council/Parallel messages should not render aggregate citation controls for lane-specific sources'
    );
    assert.equal(
        source.includes("? buildAssistantActionRow(message, '', '', '', { includeFork: false })"),
        true,
        'Council review should restore aggregate copy/regenerate after final states while keeping fork disabled and sources local to the response that produced them'
    );
    assert.equal(
        source.includes('const { includeFork = true } = options;'),
        true,
        'generic assistant actions should keep normal chat fork as the default'
    );
    assert.equal(
        source.includes('${forkButtonHtml}'),
        true,
        'fork button rendering should be opt-in for council aggregate rows'
    );
    assert.equal(
        source.includes('function buildCouncilLaneActionRow(entry, messageId)'),
        true,
        'Plain Parallel should render lane-scoped response actions'
    );
    assert.equal(
        source.includes('copy-council-lane-btn'),
        true,
        'Plain Parallel lanes should expose lane copy actions'
    );
    assert.equal(
        source.includes('regenerate-council-lane-btn'),
        true,
        'Plain Parallel lanes should expose lane regenerate actions'
    );
    assert.equal(
        source.includes('fork-council-lane-btn'),
        false,
        'Plain Parallel lanes should not expose lane fork actions'
    );
    assert.equal(
        source.includes("buildPendingIndicatorContent('waiting-response')"),
        true,
        'pending lanes should reuse the main chat waiting indicator'
    );
    assert.equal(
        styles.includes('.council-synthesis-block'),
        true,
        'Council synthesis should have its own centered layout block'
    );
    assert.equal(
        styles.includes('width: min(100%, 46rem);'),
        true,
        'Council synthesis should be width-capped like the narrow transcript'
    );
    assert.equal(
        styles.includes('margin: 1.4rem auto 0;'),
        true,
        'Council synthesis should be centered with breathing room under the two lane cards'
    );
    assert.equal(
        styles.includes('border-top: 1px solid hsl(var(--color-border) / 0.7);'),
        true,
        'Council synthesis should have a subtle separator above the Council answer'
    );
    assert.equal(
        styles.includes('padding: 0.9rem clamp(0.75rem, 2vw, 1.25rem) 0;'),
        true,
        'Council synthesis should keep breathing room between the separator and model label'
    );
    assert.equal(
        styles.includes('.council-response-role-label'),
        true,
        'Council synthesis role text should be styled separately from the model name'
    );
    assert.equal(
        styles.includes('border: 1px solid hsl(var(--color-border));'),
        true,
        'Council role text should be visible as a lightweight badge'
    );
    assert.equal(
        source.includes("${escapeHtml(entry.status || 'pending')}"),
        false,
        'lane cards should not render raw complete/pending status strings directly'
    );
});

test('composer mode toggle exposes Chat and Parallel with independent Memory toggle', () => {
    const html = read('chat/index.html');
    const source = read('chat/components/ChatInput.js');
    assert.equal(html.includes('data-mode-option="chat"'), true);
    assert.equal(html.includes('data-mode-option="parallel"'), true);
    assert.equal(
        html.includes('data-mode-option="memory"'),
        false,
        'Memory should be an independent book toggle, not a third segmented mode'
    );
    assert.equal(html.includes('id="memory-context-toggle"'), true);
    assert.equal(source.includes('memoryContextToggle.addEventListener'), true);
    assert.equal(source.includes('handleMemoryContextToggleClick(event)'), true);
    assert.equal(source.includes('MEMORY_CONTEXT_DOUBLE_CLICK_MS'), false);
    assert.equal(source.includes('memoryContextToggleClickTimer'), false);
    assert.equal(source.includes('setTimeout(() => {\n            this.memoryContextToggleClickTimer'), false);
    assert.equal(source.includes('openMemoryContextPanel'), true);
    assert.equal(source.includes('this.app.memoryEditor?.open?.()'), true);
    assert.equal(html.includes('Double-click to open memory'), true);
    assert.equal(html.includes('memory-context-tooltip-detail'), true);
    assert.equal(html.includes('data-memory-tooltip-text'), true);
    assert.equal(source.includes('this.app.memoryMode = isMemory'), false);
    assert.equal(source.includes("memoryButton.setAttribute('aria-disabled', String(!memoryFeatureEnabled));"), true);
    assert.equal(source.includes("container.removeAttribute('aria-disabled');"), true);
    assert.equal(
        source.includes("container.classList.toggle('is-disabled', !memoryFeatureEnabled);"),
        false,
        'global Memory off should disable only the Memory book, not the Chat/Parallel slider'
    );
    assert.equal(
        html.includes('data-mode-option="council"'),
        false,
        'Council review should be a Parallel setting, not a visible composer mode'
    );
});

test('parallel composer keeps the Council model picker out of the input bar', () => {
    const html = read('chat/index.html');
    const chatInputSource = read('chat/components/ChatInput.js');
    assert.equal(html.includes('id="council-secondary-model-btn"'), true);
    assert.equal(
        html.includes('id="council-synthesis-model-btn"'),
        false,
        'Council model selection belongs in settings, not the Parallel composer'
    );
    assert.equal(html.includes('id="council-review-toggle"'), true);
    assert.equal(html.includes('id="council-review-model-select"'), true);
    assert.equal(html.includes('id="council-review-model-btn"'), false);
    assert.equal(
        chatInputSource.includes('this.councilReviewModelSelect = councilReviewModelSelect'),
        true,
        'Council review model should use the same settings select pattern as scrubber and memory models'
    );
    assert.equal(
        chatInputSource.includes('const label = this.getFullModelHoverName(value);'),
        true,
        'Council review model select labels should omit provider/company names while preserving raw model values'
    );
});

test('parallel layout stays wide for transcripts and forks with council output', () => {
    const appSource = read('chat/app.js');
    const chatAreaSource = read('chat/components/ChatArea.js');
    const controllerSource = read('chat/application/councilController.js');
    const chatInputSource = read('chat/components/ChatInput.js');
    const styles = read('chat/styles.css');

    assert.equal(appSource.includes('messageUsesCouncilLayout(message)'), true);
    assert.equal(appSource.includes('messagesUseCouncilLayout(messages = [])'), true);
    assert.equal(appSource.includes('session?.hasCouncilLayoutPreference === true'), true);
    assert.equal(appSource.includes('const isPendingCouncilLayoutPreference = !session'), true);
    assert.equal(appSource.includes('this.pendingCouncilLayoutPreference === true'), true);
    assert.equal(appSource.includes('session?.hasCouncilTranscript === true'), true);
    assert.equal(appSource.includes('shouldUpdateCouncilLayoutForSession(session)'), true);
    assert.equal(appSource.includes('recomputeSessionCouncilTranscriptHint(session, messages = null, options = {})'), true);
    assert.equal(appSource.includes('updateCouncilLayoutMode(session = this.getCurrentSession(), messages = null)'), true);
    assert.equal(
        appSource.includes('const outputMode = isCouncilModeEnabled ? storedOutputMode : COUNCIL_OUTPUT_PARALLEL;'),
        true,
        'synthesis layout should ignore stale council output mode when Parallel/Council is disabled'
    );
    assert.equal(
        chatAreaSource.includes('this.app.updateCouncilLayoutMode?.(session, messages);'),
        true,
        'message render should update effective wide layout from actual transcript contents'
    );
    assert.equal(
        appSource.includes('hasCouncilTranscript: this.messagesUseCouncilLayout(messagesToCopy)'),
        true,
        'forks should preserve the wide-layout hint when copied messages include Parallel/Council output'
    );
    assert.equal(
        appSource.includes('session.hasCouncilLayoutPreference = true;'),
        true,
        'turning Parallel on should make the wider layout sticky for the session'
    );
    assert.equal(
        appSource.includes('hasCouncilLayoutPreference: session.hasCouncilLayoutPreference === true'),
        true,
        'forks should preserve the sticky wide-layout preference'
    );
    assert.equal(
        chatInputSource.includes("document.documentElement.classList.toggle('council-layout-mode'"),
        false,
        'ChatInput should not override transcript layout based only on active Parallel state'
    );
    assert.equal(
        chatAreaSource.includes('this.app.recomputeSessionCouncilTranscriptHint?.(session, remainingMessages);'),
        true,
        'regenerate/resend truncation should recompute the persisted transcript layout hint'
    );
    assert.equal(
        controllerSource.includes('this.app.recomputeSessionCouncilTranscriptHint?.(session, remainingMessages);'),
        true,
        'Council regenerate pruning should recompute the persisted transcript layout hint'
    );
    assert.equal(
        styles.includes('html.wide-mode #messages-container {\n    --messages-max-width: min(92vw, 82rem);'),
        true,
        'manual wide mode should use the same message width as Parallel/Council layout'
    );
    assert.equal(
        styles.includes('html.council-layout-mode #messages-container {\n    --messages-max-width: min(92vw, 82rem);'),
        true,
        'Parallel/Council layout should stay aligned with manual wide mode width'
    );
    assert.equal(
        appSource.includes('const usesParallelLayout = this.sessionUsesCouncilLayout(this.getCurrentSession());'),
        true,
        'wide-mode button visibility should read the same Parallel/Council layout source of truth'
    );
    assert.equal(
        appSource.includes('if (hasSession && !isMobile && !usesParallelLayout)'),
        true,
        'wide-mode button should be hidden while Parallel/Council layout owns transcript width'
    );
});

test('composer model controls keep stable compact slots across Chat and Parallel', () => {
    const html = read('chat/index.html');
    const appSource = read('chat/app.js');
    const source = read('chat/components/ChatInput.js');
    const styles = read('chat/styles.css');

    assert.equal(html.includes('class="composer-left-actions'), true);
    assert.equal(html.includes('class="composer-right-actions'), true);
    const moreMenuIndex = html.indexOf('id="composer-more-menu"');
    const fileUploadIndex = html.indexOf('id="file-upload-btn"');
    const fileActionIndex = html.indexOf('id="composer-file-action"');
    const settingsControlIndex = html.indexOf('id="composer-settings-control"');
    const settingsActionsIndex = html.indexOf('id="composer-settings-actions"');
    const settingsIndex = html.indexOf('id="settings-btn"');
    const themeToggleIndex = html.indexOf('id="theme-toggle"');
    const searchIndex = html.indexOf('id="search-toggle"');
    const memoryToggleIndex = html.indexOf('id="memory-context-toggle"');
    const modeToggleIndex = html.indexOf('id="chat-mode-toggle"');
    assert.equal(html.includes('id="composer-more-btn"'), false);
    assert.equal(moreMenuIndex > -1, true);
    assert.equal(fileActionIndex > -1, true);
    assert.equal(settingsControlIndex > -1, true);
    assert.equal(settingsActionsIndex > -1, true);
    assert.equal(themeToggleIndex > -1, true);
    assert.equal(fileUploadIndex > moreMenuIndex, true);
    assert.equal(fileUploadIndex > fileActionIndex, true);
    assert.equal(settingsIndex > moreMenuIndex, true);
    assert.equal(settingsIndex > settingsControlIndex, true);
    assert.equal(settingsActionsIndex > settingsIndex, true);
    assert.equal(settingsActionsIndex > themeToggleIndex, true);
    assert.equal(searchIndex > moreMenuIndex, true);
    assert.equal(searchIndex < modeToggleIndex, true);
    assert.equal(memoryToggleIndex > -1, true);
    assert.equal(html.includes('class="composer-more-menu-item relative" role="menuitem" aria-label="Attach files"'), true);
    assert.equal(html.includes('class="composer-more-menu-item" role="menuitem" aria-label="Settings"'), true);
    assert.equal(html.includes('role="menuitemcheckbox"'), true);
    assert.equal(html.includes('role="menuitemcheckbox" aria-label="Web search"'), true);
    assert.equal(html.includes('class="composer-more-active-dot"'), false);
    assert.equal(appSource.includes('this.searchEnabled = true;'), true);
    assert.equal(appSource.includes('savedSearchEnabled !== undefined ? savedSearchEnabled : true'), true);
    const secondaryClusterIndex = html.indexOf('id="council-inline-models"');
    const primaryModelIndex = html.indexOf('id="model-picker-btn"');
    const sendButtonIndex = html.indexOf('id="send-btn"');
    assert.equal(secondaryClusterIndex > -1, true);
    assert.equal(primaryModelIndex > -1, true);
    assert.equal(sendButtonIndex > -1, true);
    assert.equal(
        searchIndex < memoryToggleIndex && memoryToggleIndex < modeToggleIndex && modeToggleIndex < sendButtonIndex,
        true,
        'Memory should sit immediately to the left of the Chat/Parallel toggle, before send'
    );
    assert.equal(
        primaryModelIndex < secondaryClusterIndex
            && secondaryClusterIndex < fileActionIndex
            && fileActionIndex < settingsControlIndex
            && settingsControlIndex < sendButtonIndex,
        true,
        'Parallel composer should render model chips on the left and keep file/settings/send anchored on the right'
    );
    assert.equal(html.includes('id="model-picker-btn" class="composer-model-chip'), true);
    assert.equal(html.includes('<span class="model-name-container">Select Model</span>'), true);
    assert.equal(html.includes('council-secondary-model-btn composer-model-chip'), true);
    assert.equal(html.includes('id="council-inline-models" class="hidden council-inline-models"'), true);
    assert.equal(html.includes('council-inline-divider'), false);
    assert.equal(source.includes("inlineContainer.classList.toggle('hidden', !isEnabled);"), true);
    assert.equal(source.includes("inlineContainer.classList.toggle('flex', isEnabled);"), true);
    assert.equal(source.includes("primaryModelButton.classList.remove('model-picker-icon-only');"), true);
    assert.equal(source.includes("primaryModelButton.classList.add('composer-model-chip');"), true);
    assert.equal(source.includes("inlineButton.classList.remove('council-model-icon-only');"), true);
    assert.equal(source.includes("inlineButton.classList.add('composer-model-chip');"), true);
    assert.equal(source.includes('getComposerModelDisplayName(modelName)'), true);
    assert.equal(source.includes('getProviderlessModelDisplayName(modelName)'), true);
    assert.equal(source.includes("primaryModelButton.setAttribute('data-tooltip', primaryHoverName);"), true);
    assert.equal(source.includes("inlineButton.setAttribute('data-tooltip', secondaryHoverName);"), true);
    assert.equal(source.includes('const availableModels = models.filter((model) => model?.name);'), true);
    assert.equal(source.includes('primaryEntry?.id && model.id === primaryEntry.id'), false);
    assert.equal(source.includes('COMPOSER_VARIANTS'), false);
    assert.equal(source.includes('DEFAULT_COMPOSER_VARIANT'), false);
    assert.equal(source.includes("new URLSearchParams(window.location.search).get('composerVariant')"), false);
    assert.equal(source.includes('DEFAULT_COMPOSER_WIDTH'), false);
    assert.equal(source.includes('COMPOSER_WIDTH_MODES'), false);
    assert.equal(source.includes("new URLSearchParams(window.location.search).get('composerWidth')"), false);
    assert.equal(source.includes('resolveSendGap()'), false);
    assert.equal(source.includes("new URLSearchParams(window.location.search).get('sendGap')"), false);
    assert.equal(source.includes('document.documentElement.dataset.composerVariant'), false);
    assert.equal(source.includes('document.documentElement.dataset.composerTools'), false);
    assert.equal(source.includes('document.documentElement.dataset.composerParallelModels'), false);
    assert.equal(source.includes('document.documentElement.dataset.composerWidth'), false);
    assert.equal(source.includes('document.documentElement.dataset.sendGap'), false);
    assert.equal(source.includes('document.documentElement.dataset.composerMode = mode;'), true);
    assert.equal(source.includes('setComposerModeDataset(isCouncilEnabled)'), true);
    assert.equal(source.includes('this.setComposerModeDataset(isEnabled);'), true);
    assert.equal(source.includes('applyComposerLayout()'), true);
    assert.equal(source.includes('placeComposerToolControls()'), true);
    assert.equal(source.includes('toolsContainer.append(fileAction, settingsControl, searchToggle);'), false);
    assert.equal(source.includes('toolsContainer.append(fileAction, settingsControl);'), true);
    assert.equal(source.includes('settingsActions.append(searchToggle);'), true);
    assert.equal(source.includes("e.target.closest('#file-upload-btn, #search-toggle')"), true);
    assert.equal(source.includes('inlineButton.disabled = !isEnabled || availableModels.length === 0;'), true);
    assert.equal(source.includes('toggleComposerMoreMenu()'), false);
    assert.equal(source.includes('closeComposerMoreMenu()'), false);
    assert.equal(source.includes('updateComposerMoreButtonUI()'), false);
    assert.equal(appSource.includes('composerMoreBtn'), false);
    assert.equal(styles.includes('.composer-right-actions'), true);
    assert.equal(styles.includes('.composer-right-actions #send-btn'), true);
    assert.equal(styles.includes('.composer-right-actions .chat-mode-toggle-container'), true);
    assert.equal(styles.includes('.memory-context-tooltip-detail.hidden'), true);
    assert.equal(styles.includes('html[data-send-gap='), false);
    assert.equal(styles.includes('margin-left: 0.9rem;'), true);
    assert.equal(styles.includes('margin-left: 0.35rem;'), true);
    assert.equal(styles.includes('.composer-left-actions'), true);
    assert.equal(styles.includes('overflow: visible;'), true);
    assert.equal(styles.includes('.composer-more-menu'), true);
    assert.equal(styles.includes('.composer-more-menu-item'), true);
    assert.equal(styles.includes('.composer-more-btn.composer-more-active'), false);
    assert.equal(styles.includes('.composer-more-active-dot'), false);
    assert.equal(styles.includes('.council-response-sources-row'), true);
    assert.equal(styles.includes('.council-inline-models.council-inline-reserved'), false);
    assert.equal(styles.includes('.council-inline-divider'), false);
    assert.equal(styles.includes('#model-picker-btn.composer-model-chip,'), true);
    assert.equal(styles.includes('--composer-model-chip-max-width: 12.25rem;'), true);
    assert.equal(styles.includes('--composer-model-chip-gap: 0.4rem;'), true);
    assert.equal(styles.includes('gap: var(--composer-model-chip-gap);'), true);
    assert.equal(styles.includes('flex: 0 1 auto;'), true);
    assert.equal(styles.includes('width: fit-content;'), true);
    assert.equal(styles.includes('max-width: var(--composer-model-chip-max-width);'), true);
    assert.equal(styles.includes('html[data-composer-mode="chat"] #model-picker-btn.composer-model-chip'), true);
    assert.equal(styles.includes('width: max-content;'), true);
    assert.equal(styles.includes('max-width: calc(var(--composer-model-chip-max-width) + var(--composer-model-chip-max-width) + var(--composer-model-chip-gap));'), true);
    assert.equal(styles.includes('html[data-composer-width='), false);
    assert.equal(styles.includes('--composer-model-chip-width'), false);
    assert.equal(styles.includes('white-space: nowrap;'), true);
    assert.equal(styles.includes('text-overflow: ellipsis;'), true);
    assert.equal(styles.includes('line-height: 1.25;'), true);
    assert.equal(styles.includes('#model-picker-btn.composer-model-chip[data-tooltip]:hover::after'), true);
    assert.equal(styles.includes('max-width: min(32rem, calc(100vw - 2rem));'), false);
    assert.equal(styles.includes('.composer-settings-actions'), true);
    assert.equal(styles.includes('border-top: 1px solid hsl(var(--color-border));'), true);
    assert.equal(styles.includes('#composer-more-menu > #composer-settings-control'), true);
    assert.equal(styles.includes('flex-wrap: nowrap;'), true);
    assert.equal(styles.includes('html[data-composer-parallel-models='), false);
    assert.equal(styles.includes('.model-picker-icon-only .model-name-container'), false);
});

test('prompt edit model chips mirror active Parallel model lanes', () => {
    const appSource = read('chat/app.js');
    const chatAreaSource = read('chat/components/ChatArea.js');
    const messageTemplatesSource = read('chat/components/MessageTemplates.js');
    const modelPickerSource = read('chat/components/ModelPicker.js');
    const appInterfaceSource = read('chat/ui/appInterface.js');
    const styles = read('chat/styles.css');

    assert.equal(
        messageTemplatesSource.includes('const isParallelEdit = options.editParallelEnabled === true;'),
        true,
        'edit prompt template should render secondary model controls only when Parallel/Council is active'
    );
    assert.equal(messageTemplatesSource.includes('id="edit-model-picker-btn"'), true);
    assert.equal(messageTemplatesSource.includes('id="edit-secondary-model-picker-btn"'), true);
    assert.equal(messageTemplatesSource.includes('data-edit-model-lane="primary"'), true);
    assert.equal(messageTemplatesSource.includes('data-edit-model-lane="secondary"'), true);
    assert.equal(
        appSource.includes('editParallelEnabled = this.isCouncilModeActive(session)'),
        true,
        'edit template options should follow the current session response mode'
    );
    assert.equal(
        appSource.includes('await this.refreshEditMessage(this.editingMessageId);'),
        true,
        'mode changes should re-render an open edit box so primary/secondary chips match the next regeneration mode'
    );
    assert.equal(appSource.includes('editPrimaryModelName'), true);
    assert.equal(appSource.includes('editSecondaryModelName'), true);
    assert.equal(
        chatAreaSource.includes("this.app.modelPicker.open({ selectionMode: 'council-secondary' });"),
        true,
        'secondary edit model chip should open the same secondary model picker as the composer'
    );
    assert.equal(chatAreaSource.includes('updateEditModelPickerChip('), true);
    assert.equal(chatAreaSource.includes("document.getElementById('council-secondary-model-btn')"), true);
    assert.equal(chatAreaSource.includes('label.textContent = modelName;'), true);
    assert.equal(
        /updateEditModelPickerChip[\s\S]*?targetButton\.innerHTML/.test(chatAreaSource),
        false,
        'external model labels should not be inserted into edit chips through innerHTML'
    );
    assert.equal(
        modelPickerSource.includes('this.app.refreshEditModelPickerButton?.();'),
        true,
        'model changes should refresh edit prompt chips while edit mode is open'
    );
    assert.equal(appInterfaceSource.includes('refreshEditModelPickerButton'), true);
    assert.equal(appSource.includes('this.chatArea?.updateEditModelPickerButton?.();'), true);
    assert.equal(styles.includes('.edit-prompt-model-group'), true);
    assert.equal(styles.includes('.edit-prompt-model-chip'), true);
});

test('right panel shows lane-scoped ephemeral keys for Parallel and Council', () => {
    const source = read('chat/components/RightPanel.js');
    const appSource = read('chat/app.js');

    assert.equal(source.includes('getCouncilAccessRows()'), true);
    assert.equal(source.includes('getPendingCouncilAccessConfig()'), true);
    assert.equal(source.includes('this.app.getPendingCouncilConfig?.()'), true);
    assert.equal(source.includes('this.app.buildPersistedParallelCouncilConfig?.()'), true);
    assert.equal(source.includes("label: 'Model 1'"), true);
    assert.equal(source.includes("label: 'Model 2'"), true);
    assert.equal(source.includes("label: 'Council'"), true);
    assert.equal(source.includes('session?.councilAccess'), true);
    assert.equal(source.includes('generateCouncilAccessKeyPanelHTML'), true);
    assert.equal(source.includes('Ephemeral Access Keys'), true);
    assert.equal(source.includes('Keys persist until expiry or exhaustion.'), true);
    assert.equal(source.includes('this.generateAccessKeyPanelHTML(hasApiKey)'), true);
    assert.equal(source.includes('hasAnyActiveAccessKey()'), true);
    assert.equal(source.includes("if (config.outputMode === 'council')"), true);
    assert.equal(source.includes("|| access?.synthesis?.apiKey"), false);
    assert.equal(source.includes('model: members'), false);
    assert.equal(source.includes('row.model'), false);
    assert.equal(source.includes('maskCouncilAccessToken(access)'), true);
    assert.equal(source.includes('currentEphemeralKeyId: null'), true);
    assert.equal(source.includes('getLaneAttestationAccessInfo(access)'), true);
    assert.equal(source.includes('data-council-attestation-lane'), true);
    assert.equal(source.includes('button.dataset.councilAttestationLane'), true);
    assert.equal(source.includes('ensureLaneExpirationTimer()'), true);
    assert.equal(source.includes('refreshLaneExpiryPanelIfNeeded()'), true);
    assert.equal(source.includes('this.refreshLaneExpiryPanelIfNeeded(true);'), true);
    assert.equal(source.includes('(this.expiresAt && !this.isExpired)'), true);
    assert.equal(source.includes("document.getElementById('api-key-expiry')"), true);
    assert.equal(source.includes('setInterval(() =>'), true);
    assert.equal(appSource.includes('this.rightPanel?.onSessionChange?.(null);'), true);
});

test('completed assistant content uses shared markdown finalization path', () => {
    const source = read('chat/components/ChatArea.js');
    const appSource = read('chat/app.js');

    assert.equal(source.includes('renderCompletedAssistantContent(message, scopeId = message?.id)'), true);
    assert.equal(source.includes('async finalizeStreamingMessage(message, options = {})'), true);
    assert.equal(source.includes('const forceFullRender = options.forceFullRender === true;'), true);
    assert.equal(source.includes('if (isReasoningFinalized && !forceFullRender)'), true);
    assert.equal(source.includes('window.MessageTemplates.insertRawCitationMarkers'), true);
    assert.equal(source.includes('this.app.processContentWithLatex(processedContent)'), true);
    assert.equal(source.includes('window.MessageTemplates.addInlineCitationMarkers'), true);
    assert.equal(source.includes('window.MessageTemplates.enhanceInlineLinks(processedContent, scopeId)'), true);
    assert.equal(source.includes('contentEl.innerHTML = this.renderCompletedAssistantContent(message, message.id);'), true);
    assert.equal(
        /Re-render the completed message[\s\S]*?await this\.chatArea\.finalizeStreamingMessage\(streamingMessage\);[\s\S]*?Finalize reasoning display/.test(appSource),
        true,
        'normal send completion should run the final render pass before reasoning finalization'
    );
    assert.equal(
        appSource.includes('Re-render message if no content (to show "no response" notice and clean up empty bubbles)'),
        false,
        'completed text responses must not be left on partial streaming markdown DOM'
    );
    assert.equal(
        appSource.includes('this.chatArea.finalizeStreamingMessage(message, { forceFullRender: true });'),
        true,
        'citation enrichment should rebuild Sources UI even when reasoning was already finalized'
    );
});

test('council review setting drives synthesis output mode in ChatInput', () => {
    const source = read('chat/components/ChatInput.js');
    const appSource = read('chat/app.js');
    assert.equal(source.includes('council-review-toggle'), true);
    assert.equal(source.includes('council-review-model-select'), true);
    assert.equal(source.includes('this.councilReviewModelSelect = councilReviewModelSelect'), true);
    assert.equal(source.includes('setCouncilReviewEnabledFromSettings'), true);
    assert.equal(source.includes('currentlyMultiModelEnabled'), true);
    assert.equal(source.includes('closeSettingsMenu()'), true);
    assert.equal(source.includes('openCouncilSynthesisModelPicker({ closeSettings: true })'), false);
    assert.equal(source.includes('this.councilSynthesisInlineSelect.value = event.target.value;'), true);
    assert.equal(source.includes('this.multiModelSynthesisSelect.value = event.target.value;'), true);
    assert.match(
        source,
        /enabled \? COUNCIL_OUTPUT_SYNTHESIS : COUNCIL_OUTPUT_PARALLEL/,
        'Council review on should persist synthesis output mode, and off should persist parallel'
    );
    assert.match(
        source,
        /const nextMultiModelEnabled = enabled \|\| currentlyMultiModelEnabled;/,
        'Turning Council review on should also turn Parallel mode on'
    );
    assert.match(
        source,
        /enabled: nextMultiModelEnabled/,
        'Council review should persist the auto-enabled Parallel state'
    );
    assert.match(
        source,
        /const outputMode = isEnabled \? storedOutputMode : COUNCIL_OUTPUT_PARALLEL;/,
        'Disabled Parallel should display Council review as off even if stale stored outputMode was council'
    );
    assert.match(
        source,
        /const outputMode = enabled\s*\?\s*\(options\.outputMode \|\| this\.getMultiModelOutputModeForSelection\(\)\)\s*:\s*COUNCIL_OUTPUT_PARALLEL;/,
        'Switching the composer back to Chat should clear Council review so the next Parallel use starts plain Parallel'
    );
    assert.match(
        appSource,
        /const requestedOutputMode = !requestedEnabled\s*\?\s*COUNCIL_OUTPUT_PARALLEL\s*:\s*\(options\.outputMode !== undefined/,
        'Disabling Parallel should normalize stored council output mode back to plain Parallel'
    );
    assert.equal(
        appSource.includes('delete session.councilAccess.synthesis'),
        false,
        'Changing the Council review model should not proactively clear the synthesis lane key'
    );
    assert.equal(
        /setCouncilReviewEnabledFromSettings[\s\S]*?saveSetting\?\.\('memoryMode', false\)/.test(source),
        false,
        'Council review should not silently turn off the independent Memory toggle'
    );
});

test('Parallel mode and secondary model persist as new-session defaults', () => {
    const appSource = read('chat/app.js');
    const chatInputSource = read('chat/components/ChatInput.js');
    const appInterfaceSource = read('chat/ui/appInterface.js');

    assert.equal(appSource.includes("chatDB.getSetting('parallelModeEnabled')"), true);
    assert.equal(appSource.includes("chatDB.getSetting('parallelSecondaryModel')"), true);
    assert.equal(appSource.includes("chatDB.getSetting('parallelSynthesisModel')"), true);
    assert.equal(appSource.includes("chatDB.getSetting('parallelOutputMode')"), true);
    assert.equal(appSource.includes('this.parallelModeEnabled = savedParallelModeEnabled === true;'), true);
    assert.equal(appSource.includes('this.parallelSecondaryModel = typeof savedParallelSecondaryModel ==='), true);
    assert.equal(appSource.includes('this.parallelOutputMode = normalizeCouncilOutputMode(savedParallelOutputMode);'), true);
    assert.equal(appSource.includes('buildPersistedParallelCouncilConfig(fallbackModelName = null)'), true);
    assert.equal(appSource.includes('applyPersistedParallelPendingConfig(fallbackModelName = null)'), true);
    assert.match(
        appSource,
        /clearCurrentSession[\s\S]*?this\.state\.pendingModelName = normalizedSelectedModelName \|\| null;[\s\S]*?this\.applyPersistedParallelPendingConfig\(this\.state\.pendingModelName\);/,
        'New Chat should rebuild pending Parallel config before rendering the empty composer'
    );
    assert.equal(
        appSource.includes('const pendingCouncilConfig = this.pendingCouncilConfig')
            && appSource.includes(': this.buildPersistedParallelCouncilConfig(modelNameForNewSession);'),
        true,
        'new sessions should inherit persisted Parallel defaults when there is no explicit pending config'
    );
    assert.equal(
        appSource.includes('councilConfig: pendingCouncilConfig || buildDefaultCouncilConfig(modelNameForNewSession)'),
        true,
        'new sessions should preserve persisted secondary defaults even when Parallel is currently off'
    );

    assert.equal(chatInputSource.includes('async persistParallelDefaults(options = {})'), true);
    assert.equal(chatInputSource.includes("this.app.data.saveSetting('parallelModeEnabled', enabled)"), true);
    assert.equal(chatInputSource.includes("this.app.data.saveSetting('parallelSecondaryModel', secondaryModel)"), true);
    assert.equal(chatInputSource.includes("this.app.data.saveSetting('parallelSynthesisModel', synthesisModel)"), true);
    assert.equal(chatInputSource.includes("this.app.data.saveSetting('parallelOutputMode', outputMode)"), true);
    assert.equal(chatInputSource.includes('this.app.setParallelDefaults?.({'), true);
    assert.equal(chatInputSource.includes('this.app.parallelModeEnabled = enabled'), false);
    assert.equal(chatInputSource.includes('this.app.parallelSecondaryModel = secondaryModel'), false);
    assert.equal(appInterfaceSource.includes("'setParallelDefaults'"), true);
    assert.match(
        chatInputSource,
        /setCouncilModeFromComposer[\s\S]*?await this\.persistParallelDefaults\(\{/,
        'Chat/Parallel mode changes should persist globally'
    );
    assert.match(
        chatInputSource,
        /persistCouncilSelectionFromControls[\s\S]*?await this\.persistParallelDefaults\(\{/,
        'secondary and Council model changes should persist globally'
    );
    assert.match(
        appInterfaceSource,
        /app\.state\.pendingModelName = normalizedModelName;[\s\S]*?app\.applyPersistedParallelPendingConfig\?\.\(normalizedModelName\);/,
        'changing the primary model before first send should keep pending Parallel config aligned'
    );
});

test('turning off Parallel restores primary lane access to single chat', () => {
    const source = read('chat/app.js');
    const modeSetter = source.match(/async setCouncilModeForCurrentSession\([\s\S]*?\n    getPendingCouncilConfig/);

    assert.ok(modeSetter, 'setCouncilModeForCurrentSession should be present');
    assert.ok(
        /if \(!requestedEnabled && this\.councilController\) \{[\s\S]*?seedSessionAccessFromPrimaryLane\(session\);/.test(modeSetter[0]),
        'disabling Parallel should seed normal session access from the valid primary lane'
    );
});

test('memory augmentation runs once before Parallel fan-out and clears the one-shot override', () => {
    const source = read('chat/app.js');
    const regenerateStart = source.indexOf('async regenerateResponse');
    const sendStart = source.indexOf('async sendMessage()');
    const regenerateEnd = source.indexOf('/**\n     * Sends a user message', regenerateStart);
    const sendEnd = source.indexOf('/**\n     * Shows a typing indicator', sendStart);
    const regenerateBlock = source.slice(regenerateStart, regenerateEnd);
    const sendBlock = source.slice(sendStart, sendEnd);

    assert.equal(
        source.includes('this.memoryMode && !this.isCouncilModeActive(session)'),
        false,
        'send-time memory augmentation should not be disabled for Parallel/Council'
    );
    assert.equal(
        source.includes('!options.skipMemoryAugment && !this.isCouncilModeActive(session)'),
        false,
        'regenerate memory augmentation should not be disabled for Parallel/Council'
    );
    assert.ok(
        sendBlock.indexOf('await this.runMemoryAugmentFlow(content, userMessage, session') <
            sendBlock.indexOf('await this.councilController.runSendTurn'),
        'send should run Memory once before the Parallel/Council controller fans out to lanes'
    );
    assert.ok(
        regenerateBlock.indexOf('await this.runMemoryAugmentFlow(lastUserMessage.content ||') <
            regenerateBlock.indexOf('await this.councilController.runRegenerateTurn'),
        'regenerate should rerun Memory once before the Parallel/Council controller fans out to lanes'
    );
    assert.ok(
        regenerateBlock.includes('preserveLocalOnlyMessages: shouldAttemptMemoryAugment || options.skipMemoryAugment === true'),
        'council regenerate should preserve the current Memory Agent status row after approval/auto-include'
    );
    assert.ok(
        regenerateBlock.includes('} finally {\n            this._lastApiContent = null;'),
        'regenerate should clear the one-shot memory API override in a finally block'
    );
    assert.ok(
        sendBlock.includes('} finally {\n            this.clearMemoryApiOverrideContent();'),
        'send should clear the one-shot memory API override in a finally block'
    );
});

test('council model shortcut follows enabled review setting', () => {
    const source = read('chat/app.js');
    assert.equal(source.includes('const isCouncilReviewEnabled'), true);
    assert.match(
        source,
        /this\.isCouncilModeActive\(session\) && session\?\.councilConfig\?\.outputMode === COUNCIL_OUTPUT_SYNTHESIS/,
        'Active-session Council model shortcut should require both Parallel and Council review to be enabled'
    );
    assert.match(
        source,
        /this\.pendingCouncilConfig\?\.enabled === true && this\.pendingCouncilConfig\?\.outputMode === COUNCIL_OUTPUT_SYNTHESIS/,
        'Pending Council model shortcut should require both pending Parallel and Council review to be enabled'
    );
    const shortcutBlock = source.slice(source.indexOf('// Cmd/Ctrl + L for the Council synthesis model picker'));
    assert.equal(shortcutBlock.includes('isCouncilModeActive(session)'), true);
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
    const quickAskAccessMatch = appSource.match(/async ensureQuickAskAccess\([\s\S]*?\n    getQuickAskConversationMessages/);
    assert.ok(quickAskAccessMatch, 'ensureQuickAskAccess method should be present');
    assert.ok(
        /onStatus\?\.\('requesting-key'\)[\s\S]*?acquireAndSetAccess[\s\S]*?abortController\.signal\.aborted/.test(quickAskAccessMatch[0]) &&
        /inferenceService\.streamCompletion\([\s\S]*?quickAskAccessSession/.test(inlineQuickAskMatch[0]),
        'inline quick ask should acquire access for expired past sessions and re-check cancellation before inference'
    );
    assert.ok(
        quickAskAccessMatch[0].includes('signal: abortController.signal'),
        'quick ask access acquisition should receive the panel abort signal'
    );
    assert.ok(
        inlineQuickAskMatch[0].includes('const quickAskModel = await this.resolveModelForQuickAsk(session);') &&
        quickAskAccessMatch[0].includes('modelIdOverride: quickAskModel.modelId') &&
        quickAskAccessMatch[0].includes('modelNameOverride: quickAskModel.modelName'),
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
        quickAskModelResolverMatch[0].includes('this.isCouncilModeActive(session)') &&
        quickAskModelResolverMatch[0].includes('primaryEntry?.id === selectedModelEntry.id') &&
        quickAskModelResolverMatch[0].includes("quickAskModel.laneId = primaryEntry.laneId || 'primary';") &&
        quickAskAccessMatch[0].includes('this.councilController.seedPrimaryLaneAccessFromSession(session, entry);') &&
        quickAskAccessMatch[0].includes('abortController.signal') &&
        appSource.includes('this.councilController.buildLaneSession(session, quickAskModel.laneId)') &&
        appSource.includes('this.councilController.buildLaneConversationMessages('),
        'parallel quick ask should reuse primary lane access only when the pinned quick-ask model matches the primary lane'
    );
    assert.ok(
        inlineQuickAskMatch[0].includes('this.isAccessCreditExhaustedError(error)') &&
        inlineQuickAskMatch[0].includes('this.councilController.clearLaneAccess(session, quickAskModel.laneId);') &&
        inlineQuickAskMatch[0].includes('this.councilController.requestLaneAccess(') &&
        inlineQuickAskMatch[0].includes('abortController.signal') &&
        inlineQuickAskMatch[0].includes('quickAskAccessSession = this.getQuickAskAccessSession(session, quickAskModel);'),
        'parallel quick ask should directly refresh an exhausted reused primary lane key before retrying once'
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
