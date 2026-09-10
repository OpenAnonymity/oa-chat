import test from 'node:test';
import assert from 'node:assert/strict';
import { applyZkapiDefaultTheme, ZKAPI_THEME_APPLIED_KEY, THEME_PREFERENCE_KEY } from '../../chat/zkapi/services/zkapiDefaultTheme.js';

function storage(initial = {}) {
    const map = new Map(Object.entries(initial));
    return { getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), map };
}
function manager() { const calls = []; return { calls, setPreference: value => calls.push(value) }; }

test('first zkAPI use in a browser with no chosen theme switches to EF purple, once', () => {
    const store = storage();
    const theme = manager();
    assert.equal(applyZkapiDefaultTheme(store, theme), true);
    assert.deepEqual(theme.calls, ['purple']);
    assert.equal(store.map.get(ZKAPI_THEME_APPLIED_KEY), '1');
    assert.equal(applyZkapiDefaultTheme(store, theme), false, 'later switches leave the shared theme alone');
    assert.deepEqual(theme.calls, ['purple']);
});

test('a theme the person already chose is respected', () => {
    const store = storage({ [THEME_PREFERENCE_KEY]: 'dark' });
    const theme = manager();
    assert.equal(applyZkapiDefaultTheme(store, theme), false);
    assert.deepEqual(theme.calls, []);
    assert.equal(store.map.get(ZKAPI_THEME_APPLIED_KEY), '1', 'still marked so a later reset of the preference does not re-apply it');
});

test('no storage or a throwing storage is a no-op', () => {
    const theme = manager();
    assert.equal(applyZkapiDefaultTheme(null, theme), false);
    assert.equal(applyZkapiDefaultTheme({ getItem() { throw new Error('blocked'); }, setItem() {} }, theme), false);
    assert.deepEqual(theme.calls, []);
});
