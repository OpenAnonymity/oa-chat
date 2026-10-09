import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { isPhoneAppLayout } from '../../chat/ui/phoneAppLayout.js';

const read = file => fs.readFileSync(file, 'utf8');
const phoneView = (extra = {}) => ({ innerWidth: 393, innerHeight: 852,
    navigator: { standalone: true, maxTouchPoints: 5 }, screen: { width: 393, height: 852 },
    matchMedia: query => ({ matches: query === '(pointer: coarse)' }), ...extra });

// Run the actual production positioning block. No copied geometry algorithm.
function position(view) {
    const source = read('chat/components/ChatInput.js');
    const start = source.indexOf('                const viewportMargin = 12;');
    const end = source.indexOf("                menu.style.overflowY = 'auto';", start);
    assert.ok(start > -1 && end > start);
    const menu = { style: {} };
    const inputCard = { getBoundingClientRect: () => ({ left: 16, top: 650, width: 361 }) };
    const context = { window: view, menu, btnRect: { left: 270, top: 730, width: 32 },
        SETTINGS_MENU_WIDTH_PX: 340, isPhoneAppLayout: () => isPhoneAppLayout(view),
        app: { elements: { inputCard } } };
    vm.runInNewContext(source.slice(start, end), context);
    return menu.style;
}

test('phone Safari and Home Screen settings sit above the composer, match its edges and cap at 70%', () => {
    const style = position(phoneView({ navigator: { maxTouchPoints: 5 } }));
    assert.equal(style.left, '16px'); assert.equal(style.width, '361px');
    assert.equal(style.bottom, '210px'); assert.equal(style.top, 'auto');
    assert.equal(style.maxHeight, '596px');
});

test('laptop browser and Electron settings retain their released button anchoring', () => {
    for (const view of [phoneView({ screen: { width: 1280, height: 852 } }), phoneView({ electronAPI: { isElectron: true } }),
        phoneView({ innerWidth: 1280 })]) {
        const style = position(view);
        assert.equal(style.width, '340px'); assert.equal(style.bottom, '130px');
        assert.equal(style.maxHeight, '710px');
    }
});

test('short keyboard viewport keeps the phone settings height bounded and nonnegative', () => {
    const style = position(phoneView({ visualViewport: { offsetTop: 480, height: 240 } }));
    assert.equal(style.top, '492px'); assert.equal(style.bottom, 'auto');
    assert.equal(style.maxHeight, '168px');
});

test('automatic panel hand-off is phone-only and does not change synced preferences', () => {
    const app = read('chat/app.js'); const panel = read('chat/components/RightPanel.js');
    assert.match(app, /if \(isPhoneAppLayout\(\) && this\.rightPanel\) \{\s*this\.rightPanel\.closeRightPanel\(\{ persist: false \}\);/);
    assert.match(panel, /if \(this\.isVisible && isPhoneAppLayout\(\)[\s\S]*?this\.app\.hideSidebar\(\{ persist: false \}\);/);
    assert.match(panel, /closeRightPanel\(\{ persist = true \} = \{\}\) \{[\s\S]*?if \(persist\) preferencesStore\.savePreference/);
});

test('new core CSS selectors are phone-only, with the original browser picker retained', () => {
    const css = read('chat/styles.css');
    const marker = '/* Phone touch-layout follow-up; laptop and Electron layouts are unchanged. */';
    const [original, changes] = css.split(marker);
    assert.ok(changes);
    assert.match(original, /#model-list-scroll-area \{ height: min\(55dvh, 420px\); \}/);
    for (const match of changes.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)) {
        const prelude = match[1].trim();
        if (prelude.startsWith('@media')) continue;
        for (const selector of prelude.split(',')) assert.ok(selector.trim().startsWith('html[data-phone-app-panels]'), selector);
    }
    assert.match(changes, /height: auto;\s*max-height: min\(55dvh, 420px\)/);
    assert.match(changes, /prefers-reduced-motion: reduce[\s\S]*transition: none;/);
});

function panelFixture(phone = true) {
    const source = read('chat/components/RightPanel.js');
    const between = (start, end) => { const from = source.indexOf(start); return source.slice(from, source.indexOf(end, from)); };
    const methods = [
        between('    loadPreferences() {', '    /** The count shown:'),
        between('    toggle() {', '    /**\n     * Updates right panel'),
        between('    updatePanelVisibility() {', '    playContentFadeIn() {')
    ].join('\n');
    let listener, finishSave, finishRead;
    const sidebar = { visible: false, classList: { contains: () => sidebar.visible } };
    const panel = { style: {}, contains: () => false };
    let saves = 0;
    const context = { preferencesStore: {
        getPreference: key => new Promise(resolve => { if (key === 'right') finishRead = resolve; }),
        onChange: fn => { listener = fn; },
        savePreference: (key, value) => { saves++; return new Promise(resolve => { finishSave = () => { listener(key, value); resolve(); }; }); }
    }, PREF_KEYS: { rightPanelVisible: 'right' }, RIGHT_PANEL_WIDTH: 288,
    isPhoneAppLayout: () => phone,
    document: { getElementById: id => id === 'right-panel' ? panel : null,
        documentElement: { removeAttribute() {}, setAttribute() {} } } };
    vm.createContext(context); vm.runInContext(`this.Subject = class { ${methods} }`, context);
    const subject = new context.Subject(); subject.isVisible = false;
    subject.app = { elements: { sidebar }, hideSidebar: () => { sidebar.visible = false; }, updateToolbarDivider() {} };
    subject.loadPreferences();
    return { subject, sidebar, saves: () => saves, finishSave: () => finishSave(), finishRead: async () => { finishRead(true); await Promise.resolve(); },
        setPhone: value => { phone = value; } };
}

test('a delayed preference save or initial read cannot undo a phone rail hand-off', async () => {
    for (const pending of ['save', 'read']) {
        const f = panelFixture();
        f.subject.toggle(); f.subject.closeRightPanel({ persist: false }); f.sidebar.visible = true;
        if (pending === 'save') f.finishSave(); else await f.finishRead();
        assert.equal(f.subject.isVisible, false); assert.equal(f.sidebar.visible, true);
        assert.equal(f.saves(), 1, 'automatic hand-off did not save a second preference');
        f.subject.toggle();
        assert.equal(f.subject.isVisible, true); assert.equal(f.sidebar.visible, false, 'explicit reopen wins');
    }
});

test('returning to phone portrait reconciles two open rails without saving preferences', () => {
    const f = panelFixture(false); f.subject.isVisible = true; f.sidebar.visible = true;
    f.subject.reconcilePhonePanels(); assert.equal(f.subject.isVisible, true, 'browser/wide layout untouched');
    f.setPhone(true); f.subject.reconcilePhonePanels();
    assert.equal(f.subject.isVisible, false); assert.equal(f.sidebar.visible, true); assert.equal(f.saves(), 0);
    assert.match(read('chat/components/RightPanel.js'), /window\.addEventListener\(PHONE_APP_LAYOUT_CHANGE, \(\) => this\.reconcilePhonePanels\(\)\)/);
});

test('ordinary browser preference hydration still applies after a local close', async () => {
    const f = panelFixture(false); f.subject.closeRightPanel({ persist: false });
    await f.finishRead(); assert.equal(f.subject.isVisible, true);
});


test('opening history before the initial panel preference arrives keeps history open', async () => {
    const f = panelFixture();
    const appSource = read('chat/app.js');
    const start = appSource.indexOf('        if (isPhoneAppLayout() && this.rightPanel) {');
    const end = appSource.indexOf('\n        }', start) + 10;
    assert.ok(start > -1 && end > start);
    vm.runInNewContext(`(function () { ${appSource.slice(start, end)} }).call(app)`, {
        isPhoneAppLayout: () => true, app: { rightPanel: f.subject }
    });
    f.sidebar.visible = true;
    await f.finishRead();
    assert.equal(f.subject.isVisible, false);
    assert.equal(f.sidebar.visible, true);
    assert.equal(f.saves(), 0);
});
