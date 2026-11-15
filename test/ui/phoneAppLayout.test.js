import test from 'node:test';
import assert from 'node:assert/strict';
import { isPhoneAppLayout, watchPhoneAppLayout } from '../../chat/ui/phoneAppLayout.js';

function fixture({ width = 393, screenWidth = 393, standalone = true, ios = false, touch = true, electron = false } = {}) {
    const media = new Map();
    for (const [query, matches] of [
        ['(max-width: 767px)', width < 768],
        ['(display-mode: standalone)', standalone],
        ['(pointer: coarse)', touch]
    ]) media.set(query, Object.assign(new EventTarget(), { matches }));
    const view = { innerWidth: width, screen: { width: screenWidth, height: 852 }, navigator: { standalone: ios, maxTouchPoints: touch ? 5 : 0 },
        electronAPI: { isElectron: electron }, location: { protocol: 'https:' }, matchMedia: query => media.get(query) };
    const attrs = new Set();
    let writes = 0;
    const root = { hasAttribute: key => attrs.has(key),
        toggleAttribute(key, value) { writes++; value ? attrs.add(key) : attrs.delete(key); },
        removeAttribute: key => attrs.delete(key) };
    return { view, root, attrs, media, writes: () => writes };
}

test('phone app layout supports Safari and Home Screen on touch phones; excludes laptops and Electron', () => {
    assert.equal(isPhoneAppLayout(fixture().view), true);
    assert.equal(isPhoneAppLayout(fixture({ standalone: false, ios: true }).view), true);
    assert.equal(isPhoneAppLayout(fixture({ standalone: false }).view), true);
    for (const options of [
        { screenWidth: 1280 }, { width: 768 }, { width: 1024 }, { width: 1440 },
        { touch: false }, { electron: true }, { standalone: false, width: 600, screenWidth: 1280 }
    ]) assert.equal(isPhoneAppLayout(fixture(options).view), false, JSON.stringify(options));
    const f = fixture(); f.view.location.protocol = 'app:';
    assert.equal(isPhoneAppLayout(f.view), false);
    assert.equal(isPhoneAppLayout(undefined), false);
});

test('scope marker follows viewport/pointer changes and is removed on cleanup', () => {
    const f = fixture();
    const stop = watchPhoneAppLayout(f);
    assert.equal(f.attrs.has('data-phone-app-panels'), true);
    f.view.innerWidth = 844;
    f.media.get('(max-width: 767px)').dispatchEvent(new Event('change'));
    assert.equal(f.attrs.size, 0, 'landscape/wide layouts revert to the released layout');
    f.view.innerWidth = 393;
    f.media.get('(max-width: 767px)').dispatchEvent(new Event('change'));
    assert.equal(f.attrs.size, 1);
    f.media.get('(pointer: coarse)').matches = false;
    f.media.get('(pointer: coarse)').dispatchEvent(new Event('change'));
    assert.equal(f.attrs.size, 0, 'non-touch layout stays unchanged');
    stop();
    f.media.get('(pointer: coarse)').matches = true;
    f.media.get('(pointer: coarse)').dispatchEvent(new Event('change'));
    assert.equal(f.attrs.size, 0, 'cleanup removed listeners');
});

test('unchanged media events do not mutate the DOM or run a polling loop', () => {
    const f = fixture(); const stop = watchPhoneAppLayout(f);
    for (let i = 0; i < 60; i++) f.media.get('(max-width: 767px)').dispatchEvent(new Event('change'));
    assert.equal(f.writes(), 1);
    stop();
    const browser = fixture({ screenWidth: 1280 });
    watchPhoneAppLayout(browser)();
    assert.equal(browser.writes(), 0);
});
