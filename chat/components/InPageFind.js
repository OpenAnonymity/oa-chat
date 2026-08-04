export const IN_PAGE_FIND_IDLE_TIMEOUT_MS = 10_000;

const MATCH_HIGHLIGHT_NAME = 'oa-find-match';
const CURRENT_HIGHLIGHT_NAME = 'oa-find-current';
const MAX_MATCHES = 500;
const INLINE_TEXT_TAGS = new Set([
    'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DATA', 'DEL', 'DFN',
    'EM', 'I', 'INS', 'KBD', 'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN',
    'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR'
]);

export function findCaseInsensitiveMatchOffsets(text, query) {
    if (!text || !query) return [];
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const expression = new RegExp(escapedQuery, 'giu');
    return Array.from(text.matchAll(expression), (match) => ({
        start: match.index,
        end: match.index + match[0].length
    }));
}

export function getNextFindMatchIndex(currentIndex, matchCount, direction = 1) {
    if (matchCount <= 0) return -1;
    const normalizedCurrent = currentIndex >= 0 ? currentIndex : (direction < 0 ? 0 : -1);
    return (normalizedCurrent + direction + matchCount) % matchCount;
}

export function chooseActiveDialog(visibleDialogs) {
    if (!visibleDialogs.length) return null;
    const modalDialogs = visibleDialogs.filter((dialog) =>
        dialog.matches?.('[aria-modal="true"], dialog[open]')
    );
    return modalDialogs.pop() || visibleDialogs[visibleDialogs.length - 1];
}

export class FindIdleTimer {
    constructor(options = {}) {
        this.timeoutMs = options.timeoutMs ?? IN_PAGE_FIND_IDLE_TIMEOUT_MS;
        this.now = options.now || (() => Date.now());
        this.setTimeoutFn = options.setTimeoutFn || ((callback, delay) => setTimeout(callback, delay));
        this.clearTimeoutFn = options.clearTimeoutFn || ((timerId) => clearTimeout(timerId));
        this.onExpire = options.onExpire || (() => {});
        this.deadline = 0;
        this.timerId = null;
    }

    touch() {
        this.deadline = this.now() + this.timeoutMs;
        this.schedule(this.timeoutMs);
    }

    check() {
        if (!this.deadline) return;
        const remaining = this.deadline - this.now();
        if (remaining <= 0) {
            this.cancel();
            this.onExpire();
            return;
        }
        this.schedule(remaining);
    }

    schedule(delay) {
        if (this.timerId !== null) {
            this.clearTimeoutFn(this.timerId);
        }
        this.timerId = this.setTimeoutFn(() => {
            this.timerId = null;
            this.check();
        }, delay);
    }

    cancel() {
        if (this.timerId !== null) {
            this.clearTimeoutFn(this.timerId);
        }
        this.timerId = null;
        this.deadline = 0;
    }
}

export default class InPageFind {
    constructor(options = {}) {
        this.document = options.documentRef || document;
        this.window = options.windowRef || window;
        this.isOpen = false;
        this.currentIndex = -1;
        this.matches = [];
        this.returnFocusEl = null;
        this.fallbackSelectionActive = false;

        this.idleTimer = new FindIdleTimer({
            timeoutMs: options.idleTimeoutMs,
            now: options.now,
            setTimeoutFn: options.setTimeoutFn,
            clearTimeoutFn: options.clearTimeoutFn,
            onExpire: () => this.close({ restoreFocus: true })
        });

        this.handleGlobalKeydown = this.handleGlobalKeydown.bind(this);
        this.handleDocumentPointerDown = this.handleDocumentPointerDown.bind(this);
        this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
        this.handleWindowFocus = this.handleWindowFocus.bind(this);

        this.createToolbar();
        this.attachEventListeners();
    }

    createToolbar() {
        const toolbar = this.document.createElement('div');
        toolbar.id = 'in-page-find';
        toolbar.className = 'in-page-find hidden';
        toolbar.setAttribute('role', 'search');
        toolbar.setAttribute('aria-label', 'Find on page');
        toolbar.setAttribute('aria-hidden', 'true');
        toolbar.innerHTML = `
            <svg class="in-page-find__search-icon" viewBox="0 0 20 20" aria-hidden="true">
                <circle cx="8.5" cy="8.5" r="5.25"></circle>
                <path d="m12.4 12.4 4.1 4.1"></path>
            </svg>
            <input id="in-page-find-input" class="in-page-find__input" type="search"
                autocomplete="off" spellcheck="false" placeholder="Find on page"
                aria-label="Find on page" />
            <span class="in-page-find__count" aria-live="polite">0 / 0</span>
            <button class="in-page-find__button" type="button" data-find-action="previous"
                aria-label="Previous match" disabled>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 12.5 4.5-4.5 4.5 4.5"></path></svg>
            </button>
            <button class="in-page-find__button" type="button" data-find-action="next"
                aria-label="Next match" disabled>
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 7.5 4.5 4.5 4.5-4.5"></path></svg>
            </button>
            <span class="in-page-find__divider" aria-hidden="true"></span>
            <button class="in-page-find__button" type="button" data-find-action="close"
                aria-label="Close find">
                <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5.5 5.5 9 9m0-9-9 9"></path></svg>
            </button>
        `;

        this.document.body.appendChild(toolbar);
        this.toolbar = toolbar;
        this.input = toolbar.querySelector('#in-page-find-input');
        this.count = toolbar.querySelector('.in-page-find__count');
        this.previousButton = toolbar.querySelector('[data-find-action="previous"]');
        this.nextButton = toolbar.querySelector('[data-find-action="next"]');
        this.closeButton = toolbar.querySelector('[data-find-action="close"]');

        this.input.addEventListener('input', () => {
            this.updateMatches();
            this.idleTimer.touch();
        });
        this.input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                this.move(event.shiftKey ? -1 : 1);
            }
        });
        this.previousButton.addEventListener('click', () => this.move(-1));
        this.nextButton.addEventListener('click', () => this.move(1));
        this.closeButton.addEventListener('click', () => this.close({ restoreFocus: true }));
        toolbar.addEventListener('pointerdown', () => this.idleTimer.touch());
        toolbar.addEventListener('focusout', (event) => {
            if (this.isOpen && event.relatedTarget && !toolbar.contains(event.relatedTarget)) {
                this.close({ restoreFocus: false });
            }
        });
    }

    attachEventListeners() {
        this.document.addEventListener('keydown', this.handleGlobalKeydown, true);
        this.document.addEventListener('pointerdown', this.handleDocumentPointerDown, true);
        this.document.addEventListener('visibilitychange', this.handleVisibilityChange);
        this.window.addEventListener('focus', this.handleWindowFocus);
    }

    handleGlobalKeydown(event) {
        const isFindShortcut = (event.metaKey || event.ctrlKey) &&
            !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f';
        if (isFindShortcut) {
            event.preventDefault();
            event.stopPropagation();
            this.open();
            return;
        }

        if (!this.isOpen) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            this.close({ restoreFocus: true });
            return;
        }

        const isFindAgain = (event.metaKey || event.ctrlKey) &&
            !event.altKey && event.key.toLowerCase() === 'g';
        if (isFindAgain) {
            event.preventDefault();
            event.stopPropagation();
            this.move(event.shiftKey ? -1 : 1);
        }
    }

    handleDocumentPointerDown(event) {
        if (!this.isOpen || this.toolbar.contains(event.target)) return;
        this.close({ restoreFocus: false });
    }

    handleVisibilityChange() {
        if (this.isOpen && this.document.visibilityState === 'visible') {
            this.idleTimer.check();
        }
    }

    handleWindowFocus() {
        if (this.isOpen) {
            this.idleTimer.check();
        }
    }

    open() {
        if (!this.isOpen) {
            const activeElement = this.document.activeElement;
            if (activeElement && activeElement !== this.document.body && !this.toolbar.contains(activeElement)) {
                this.returnFocusEl = activeElement;
            }
            this.toolbar.classList.remove('hidden');
            this.toolbar.setAttribute('aria-hidden', 'false');
            this.isOpen = true;
            this.updateMatches();
        }

        this.input.focus({ preventScroll: true });
        this.input.select();
        this.idleTimer.touch();
    }

    close({ restoreFocus = false } = {}) {
        if (!this.isOpen) return;
        this.isOpen = false;
        this.idleTimer.cancel();
        this.clearHighlights();
        const focusTarget = restoreFocus ? this.getFocusReturnTarget() : null;
        this.toolbar.classList.add('hidden');
        this.toolbar.setAttribute('aria-hidden', 'true');

        this.returnFocusEl = null;
        if (restoreFocus && focusTarget) {
            focusTarget.focus({ preventScroll: true });
        }
        if (this.toolbar.contains(this.document.activeElement)) {
            this.document.activeElement.blur?.();
        }
    }

    getFocusReturnTarget() {
        const activeDialog = this.getTopmostActiveDialog();
        if (this.isEligibleFocusTarget(this.returnFocusEl, activeDialog)) {
            return this.returnFocusEl;
        }

        if (activeDialog) {
            const dialogControlGroups = [
                '[autofocus], input:not([type="hidden"]), textarea, select, [contenteditable="true"]',
                'button, a[href], [tabindex]:not([tabindex="-1"])'
            ];
            for (const selector of dialogControlGroups) {
                for (const control of activeDialog.querySelectorAll(selector)) {
                    if (this.isEligibleFocusTarget(control, activeDialog)) return control;
                }
            }
        }

        const messageInput = this.document.getElementById('message-input');
        return this.isEligibleFocusTarget(messageInput, activeDialog) ? messageInput : null;
    }

    getTopmostActiveDialog() {
        const dialogs = Array.from(this.document.querySelectorAll('[role="dialog"], dialog[open]'));
        return chooseActiveDialog(dialogs.filter((dialog) => this.isElementVisible(dialog)));
    }

    isEligibleFocusTarget(element, activeDialog = null) {
        if (!element?.isConnected || element.disabled || element.getAttribute?.('aria-disabled') === 'true') {
            return false;
        }
        if (activeDialog && !activeDialog.contains(element)) return false;
        if (element.closest?.('[hidden], [inert], [aria-hidden="true"], .hidden')) return false;
        return this.isElementVisible(element);
    }

    isElementVisible(element) {
        return typeof element?.getClientRects === 'function' && element.getClientRects().length > 0;
    }

    updateMatches() {
        this.clearHighlights();
        this.matches = this.collectMatches(this.input.value.trim());
        this.currentIndex = this.matches.length > 0 ? 0 : -1;
        this.renderMatchState({ scroll: this.matches.length > 0 });
    }

    collectMatches(query) {
        if (!query) return [];
        const matches = [];
        const nodeFilter = this.window.NodeFilter;
        const walker = this.document.createTreeWalker(
            this.document.body,
            nodeFilter.SHOW_TEXT,
            {
                acceptNode: (node) => this.acceptTextNode(node, nodeFilter)
            }
        );

        const groups = new Map();
        let node = walker.nextNode();
        while (node) {
            const block = this.getTextBlock(node);
            if (!groups.has(block)) groups.set(block, []);
            groups.get(block).push(node);
            node = walker.nextNode();
        }

        for (const nodes of groups.values()) {
            const segments = [];
            let text = '';
            for (const textNode of nodes) {
                const value = textNode.nodeValue || '';
                const start = text.length;
                text += value;
                segments.push({ node: textNode, start, end: text.length });
            }

            for (const offsets of findCaseInsensitiveMatchOffsets(text, query)) {
                const range = this.createRangeFromSegments(segments, offsets);
                if (range) matches.push(range);
                if (matches.length >= MAX_MATCHES) return matches;
            }
        }
        return matches;
    }

    getTextBlock(node) {
        let element = node.parentElement;
        while (element?.parentElement && INLINE_TEXT_TAGS.has(element.tagName)) {
            element = element.parentElement;
        }
        return element || this.document.body;
    }

    createRangeFromSegments(segments, offsets) {
        const startSegment = segments.find((segment) =>
            offsets.start >= segment.start && offsets.start < segment.end
        );
        const endSegment = segments.find((segment) =>
            offsets.end > segment.start && offsets.end <= segment.end
        );
        if (!startSegment || !endSegment) return null;

        const range = this.document.createRange();
        range.setStart(startSegment.node, offsets.start - startSegment.start);
        range.setEnd(endSegment.node, offsets.end - endSegment.start);
        return range;
    }

    acceptTextNode(node, nodeFilter) {
        if (!node.nodeValue?.length) return nodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || this.toolbar.contains(parent)) return nodeFilter.FILTER_REJECT;
        if (parent.closest('script, style, noscript, template, textarea, input, select, option')) {
            return nodeFilter.FILTER_REJECT;
        }
        if (parent.closest('[hidden], [inert], [aria-hidden="true"], .hidden')) {
            return nodeFilter.FILTER_REJECT;
        }
        return nodeFilter.FILTER_ACCEPT;
    }

    move(direction) {
        if (!this.isOpen) return;
        this.currentIndex = getNextFindMatchIndex(this.currentIndex, this.matches.length, direction);
        this.renderMatchState({ scroll: this.currentIndex >= 0 });
        this.idleTimer.touch();
    }

    renderMatchState({ scroll = false } = {}) {
        const matchCount = this.matches.length;
        this.count.textContent = matchCount > 0 ? `${this.currentIndex + 1} / ${matchCount}` : '0 / 0';
        this.previousButton.disabled = matchCount === 0;
        this.nextButton.disabled = matchCount === 0;
        this.applyHighlights();
        if (scroll && this.currentIndex >= 0) {
            this.scrollRangeIntoView(this.matches[this.currentIndex]);
        }
    }

    applyHighlights() {
        const registry = this.window.CSS?.highlights;
        const HighlightCtor = this.window.Highlight;
        if (registry && HighlightCtor) {
            const currentRange = this.currentIndex >= 0 ? this.matches[this.currentIndex] : null;
            const otherRanges = currentRange
                ? this.matches.filter((_range, index) => index !== this.currentIndex)
                : this.matches;
            registry.set(MATCH_HIGHLIGHT_NAME, new HighlightCtor(...otherRanges));
            registry.set(CURRENT_HIGHLIGHT_NAME, new HighlightCtor(...(currentRange ? [currentRange] : [])));
            return;
        }

        const currentRange = this.currentIndex >= 0 ? this.matches[this.currentIndex] : null;
        const selection = this.window.getSelection?.();
        if (selection && currentRange) {
            selection.removeAllRanges();
            selection.addRange(currentRange.cloneRange());
            this.fallbackSelectionActive = true;
        }
    }

    clearHighlights() {
        const registry = this.window.CSS?.highlights;
        registry?.delete(MATCH_HIGHLIGHT_NAME);
        registry?.delete(CURRENT_HIGHLIGHT_NAME);
        if (this.fallbackSelectionActive) {
            this.window.getSelection?.()?.removeAllRanges();
            this.fallbackSelectionActive = false;
        }
    }

    scrollRangeIntoView(range) {
        const element = range?.startContainer?.parentElement;
        if (!element?.scrollIntoView) return;
        element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
    }
}
