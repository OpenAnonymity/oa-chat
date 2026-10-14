import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import concessionV1 from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { versionCopyText } from '../../chat/zkapi/versioning/copy.mjs';
import { readExitRefusal } from '../../chat/zkapi/versioning/exitRefusal.mjs';
import { deriveVersionState } from '../../chat/zkapi/versioning/versionState.mjs';
import { NOW_MS, resolvedTable, threeVersionRegistry } from './_registryFixtures.mjs';
import { createDocument } from './_miniDom.mjs';

const { BALANCE_EXTRAS_WORDS, renderBalanceExtras } = await import('../../chat/zkapi/components/BalanceExtras.js');
const { CONCEDE_FIELD, EXIT_CHOICE_WORDS, readExitChoice, renderExitChoice } = await import('../../chat/zkapi/components/ExitChoice.js');
const { handleVersionAction } = await import('../../chat/zkapi/components/VersionNotices.js');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// The two renderers under a balance dialog: what sits beside the balance (the exit
// kit's status and the way to give an empty or very small balance up), and what a
// withdrawal can cost while a chat is still settling. Both are driven by the REAL
// snapshots the SDK emitted (test/fixtures/zkapi-v2-real-shapes) through the real
// adapter and the real VersionState derivation.

const FIXTURE = JSON.parse(fs.readFileSync(
    new URL('../fixtures/zkapi-v2-real-shapes/snapshots.json', import.meta.url), 'utf8'
));
const GENERATED = FIXTURE.generatedAtMs;
assert.equal(GENERATED, NOW_MS);

// v1 and v2 exit-only, v3 active; v2 is the closed concession version with a deposit target.
const TABLE = resolvedTable(threeVersionRegistry(), 'mainnet');
const [, CLOSED, LIVE] = TABLE;
const FORMAT = date => date.toISOString().replace(/:\d\d\.\d{3}Z$/, 'Z');
// 1 gwei per micro-unit: "$0.10" for 1000000, so the money words are exact.
const MONEY = units => `$${(Number(units) / 1e7).toFixed(2)}`;

const scenario = name => {
    const { clientSnapshot, runtime } = FIXTURE.scenarios[name];
    return { ...clientSnapshot, runtime };
};
const normalized = name => concessionV1.normalizeSnapshot(scenario(name), { nowMs: GENERATED });

function derive({ active = LIVE, snapshot, now = GENERATED, ...rest }) {
    return deriveVersionState({
        table: TABLE,
        active,
        target: TABLE.find(row => row.status === 'active') || null,
        selection: {
            version: active, reason: 'runtime_holds_note', slotOwner: active.id, open: {}, credits: {}, foreignDeploymentId: null,
            depositBlock: null, draftDiscarded: false, slotKind: 'note'
        },
        snapshot,
        intent: null,
        previewSelection: null,
        now,
        busy: false,
        admissionClosed: false,
        buildClosed: false,
        configBlock: false,
        unreachable: false,
        adapter: getAdapter(active.adapter),
        ...rest
    });
}

const refusal = (name, now = GENERATED) => {
    const shape = FIXTURE.errors[name];
    return readExitRefusal(Object.assign(new Error(shape.message || name), {
        code: shape.code, status: shape.status, data: shape.data
    }), now);
};

const ZERO = { available: true, kind: 'zero', blockedBy: null };
const DUST = { available: true, kind: 'dust', blockedBy: null };

const mount = html => {
    const doc = createDocument();
    const root = doc.createElement('div');
    root.innerHTML = html;
    doc.body.append(root);
    return root;
};

// ---------------------------------------------------------------------------
// The balance card's extras
// ---------------------------------------------------------------------------

function rowOf(html) {
    const root = mount(html);
    return root.querySelector('[data-zkapi-kit-row]');
}

test('a balance with no exit kit says so in one quiet row with the one way to make it', () => {
    const state = derive({ snapshot: normalized('kit_never_exported') });
    const html = renderBalanceExtras(state);
    const root = mount(html);
    assert.ok(root.querySelector('[data-zkapi-balance-extras]'));
    const row = root.querySelector('[data-zkapi-kit-row]');
    assert.equal(row.getAttribute('data-kit-state'), 'never');
    assert.equal(row.querySelector('.zkapi-extras-text').textContent, `${BALANCE_EXTRAS_WORDS.kitLabel}${BALANCE_EXTRAS_WORDS.never}`);
    const buttons = root.querySelectorAll('button');
    assert.deepEqual(buttons.map(button => button.getAttribute('data-zkapi-version-action')), ['export-exit-kit']);
    assert.equal(buttons[0].textContent, 'Create exit kit');
    assert.equal(buttons[0].getAttribute('type'), 'button', 'a button that is not inside a form submits nothing');
    assert.equal(buttons[0].disabled, false);
    // It is a row, not a banner: no live region, no alert, nothing that takes focus.
    assert.doesNotMatch(html, /aria-live|role="(?:status|alert)"|\bautofocus\b|tabindex/);
    // And not inside a notice banner, so the dialog's own wiring of version buttons is the only one.
    assert.equal(root.querySelector('[data-zkapi-version-banner]'), null);
    assert.equal(root.querySelector('[data-zkapi-exit-rpc]'), null);
});

test('a kit that was made and not saved says so in the sentence the notice uses', () => {
    const state = derive({ snapshot: normalized('kit_out_of_date'), kitUnsaved: true });
    const row = rowOf(renderBalanceExtras(state));
    assert.equal(row.getAttribute('data-kit-state'), 'unsaved');
    assert.equal(row.querySelector('[data-zkapi-kit-state-text]').textContent, versionCopyText('kit.unsaved'));
    assert.equal(row.querySelector('button').textContent, 'Create exit kit');
});

test('a kit older than the latest chats is one line and one click, never a banner', () => {
    const state = derive({ snapshot: normalized('kit_out_of_date') });
    assert.equal(state.exit.kit.outOfDate, true);
    const row = rowOf(renderBalanceExtras(state));
    assert.equal(row.getAttribute('data-kit-state'), 'stale');
    assert.equal(row.querySelector('[data-zkapi-kit-state-text]').textContent, versionCopyText('kit.stale'));
    assert.equal(row.querySelector('button').textContent, 'Create a new exit kit');
    assert.equal(row.querySelector('button').getAttribute('data-zkapi-version-action'), 'export-exit-kit');
});

test('a kit made at the latest state is a status that claims only that it was created, and still has the way to make another', () => {
    const base = derive({ snapshot: normalized('kit_out_of_date') });
    const state = { ...base, exit: { ...base.exit, kit: { ...base.exit.kit, outOfDate: false } } };
    const row = rowOf(renderBalanceExtras(state));
    assert.equal(row.getAttribute('data-kit-state'), 'current');
    assert.equal(row.querySelector('.zkapi-extras-text').textContent, 'Exit kitCreated for this balance');
    assert.equal(row.querySelector('button').textContent, 'Create a new exit kit');
    // The SDK counts a kit as created before it is delivered, and a reload forgets that the file was
    // never saved: the row can not say a file exists, or that anything is "up to date".
    assert.doesNotMatch(BALANCE_EXTRAS_WORDS.current, /up to date|saved|safe|backed/i);
});

test('nothing is said where a kit could not help or must not be offered', () => {
    const kitless = derive({ snapshot: normalized('kit_never_exported') });
    assert.notEqual(renderBalanceExtras(kitless), '');

    // No balance, a v1 page, a state that is not one.
    assert.equal(renderBalanceExtras({ ...kitless, exit: null }), '');
    for (const value of [null, undefined, 'state', 5, []]) assert.equal(renderBalanceExtras(value), '');
    assert.equal(renderBalanceExtras({}), '');
    assert.equal(renderBalanceExtras({ exit: { kit: null } }), '');

    // Another device used the balance since: a kit made here would be an older state.
    const device = derive({ snapshot: normalized('device_not_newest_evidence') });
    assert.equal(device.exit.deviceNotNewest, true);
    assert.equal(renderBalanceExtras(device), '');

    // The page must reload first, whichever way the state says it.
    const moved = derive({ snapshot: normalized('kit_never_exported'),
        previewSelection: { version: CLOSED, reason: 'runtime_holds_note', slotOwner: CLOSED.id, open: {}, credits: {},
            foreignDeploymentId: null, depositBlock: null, draftDiscarded: false, slotKind: 'note' } });
    assert.equal(moved.phase, 'reload-required');
    assert.equal(renderBalanceExtras(moved), '');
    assert.equal(renderBalanceExtras({ ...kitless, reload: { ...kitless.reload, required: true } }), '');

    // A client that can not make a kit leaves the row out.
    assert.equal(renderBalanceExtras(kitless, { canExport: false }), '');
    assert.notEqual(renderBalanceExtras(kitless, { canExport: true }), '');
    assert.notEqual(renderBalanceExtras(kitless, {}), '');
});

test('while the dialog works its buttons are off, and they are the same buttons', () => {
    const state = derive({ active: CLOSED, snapshot: normalized('kit_never_exported'), abandon: DUST });
    const idle = mount(renderBalanceExtras(derive({ snapshot: normalized('kit_never_exported') }), { busy: false }));
    assert.equal(idle.querySelector('button').disabled, false);
    const busy = mount(renderBalanceExtras(derive({ snapshot: normalized('kit_never_exported') }), { busy: true }));
    assert.equal(busy.querySelector('button').disabled, true);
    assert.equal(busy.querySelector('button').getAttribute('data-zkapi-version-action'), 'export-exit-kit');
    // The give-up link too.
    const link = mount(renderBalanceExtras(state, { busy: true }));
    assert.equal(link.querySelector('[data-zkapi-version-action="abandon-open"]').disabled, true);
});

test('an empty or very small balance on a closed version has a quiet link to give it up, in place of a kit row', () => {
    const snapshot = normalized('kit_never_exported');
    const zero = mount(renderBalanceExtras(derive({ active: CLOSED, snapshot, abandon: ZERO })));
    assert.equal(zero.querySelector('[data-zkapi-kit-row]'), null, 'a balance about to be cleared is not asked for a kit');
    const clear = zero.querySelectorAll('button');
    assert.deepEqual(clear.map(button => button.getAttribute('data-zkapi-version-action')), ['abandon-open']);
    assert.equal(clear[0].textContent, 'Clear this balance');
    assert.ok(zero.querySelector('[data-zkapi-abandon-row]'));

    const dust = mount(renderBalanceExtras(derive({ active: CLOSED, snapshot, abandon: DUST })));
    assert.equal(dust.querySelector('button').textContent, 'Give up this balance');
    assert.equal(dust.querySelector('button').getAttribute('data-zkapi-version-action'), 'abandon-open');

    // No verdict, or one that says no: no link, and the kit row is back.
    const none = renderBalanceExtras(derive({ active: CLOSED, snapshot }));
    assert.doesNotMatch(none, /abandon-open/);
    assert.match(none, /data-zkapi-kit-row/);
    const refused = renderBalanceExtras(derive({ active: CLOSED, snapshot,
        abandon: { available: false, kind: null, blockedBy: 'not_dust' } }));
    assert.doesNotMatch(refused, /abandon-open/);
    // A verdict with a kind this page does not know is not a link.
    const odd = { ...derive({ active: CLOSED, snapshot, abandon: ZERO }) };
    assert.doesNotMatch(renderBalanceExtras({ ...odd, abandon: { available: true, kind: 'huge', blockedBy: null } }), /abandon-open/);
});

test('the line about keeping a current kit shows with the kit row and only then', () => {
    const base = derive({ snapshot: normalized('kit_never_exported') });
    const withRpc = (rpc, extra = {}) => ({ ...base, exit: { ...base.exit, rpc }, ...extra });
    const shown = mount(renderBalanceExtras(withRpc({ recommended: true, wrongChain: false })));
    assert.equal(shown.querySelector('[data-zkapi-exit-rpc]').textContent, versionCopyText('exit.rpc'));
    assert.ok(mount(renderBalanceExtras(withRpc({ recommended: false, wrongChain: true }))).querySelector('[data-zkapi-exit-rpc]'));
    assert.equal(mount(renderBalanceExtras(withRpc({ recommended: false, wrongChain: false }))).querySelector('[data-zkapi-exit-rpc]'), null);
    // The line is advice about the kit: without the kit row there is nothing for it to refer to.
    assert.equal(renderBalanceExtras(withRpc({ recommended: true, wrongChain: false }), { canExport: false }), '');
    // It says nothing about an address, a provider or a setting: there is none to change.
    assert.doesNotMatch(versionCopyText('exit.rpc'), /rpc|endpoint|provider|setting|url/i);
});

test('every button of the extras is an action the notices’ own handler knows', async () => {
    const snapshot = normalized('kit_never_exported');
    const names = new Set();
    for (const state of [derive({ snapshot }), derive({ active: CLOSED, snapshot, abandon: DUST })]) {
        for (const match of renderBalanceExtras(state).matchAll(/data-zkapi-version-action="([^"]+)"/g)) names.add(match[1]);
    }
    assert.deepEqual([...names].sort(), ['abandon-open', 'export-exit-kit']);
    for (const name of names) {
        const answer = await handleVersionAction(name, { facade: null, notify() {}, refresh() {} });
        assert.notEqual(answer.why, 'unknown_action', name);
    }
});

// ---------------------------------------------------------------------------
// The exit choice
// ---------------------------------------------------------------------------

const settling = () => derive({
    snapshot: normalized('unresolved_request_settlement_wait'),
    exitRefusal: refusal('request_settlement_pending_withdraw')
});
const OPTIONS = { table: TABLE, formatter: FORMAT, formatAmount: MONEY, now: GENERATED };
const radios = root => root.querySelectorAll(`input[name="${CONCEDE_FIELD}"]`);
const radio = (root, value) => radios(root).find(input => input.value === value);

test('no settling chat can cost anything: no fine print and no choice', () => {
    const fresh = derive({ snapshot: normalized('kit_never_exported') });
    assert.equal(fresh.exit.boundAtState, '0');
    assert.equal(renderExitChoice(fresh, OPTIONS), '');
    assert.equal(renderExitChoice({ ...fresh, exit: null }, OPTIONS), '');
    for (const value of [null, undefined, 'x', 5, []]) assert.equal(renderExitChoice(value, OPTIONS), '');
    assert.equal(renderExitChoice({ exit: { boundAtState: null } }, OPTIONS), '');
    assert.equal(renderExitChoice({ exit: { boundAtState: '0', wait: { kind: 'settlement', boundAtState: '0' } } }, OPTIONS), '');
    // Not an amount: nothing is said rather than a number that was never one.
    for (const bound of ['abc', '-5', '1e3', '0x10', '1.5', 12.5, -1, {}]) {
        assert.equal(renderExitChoice({ exit: { boundAtState: bound, stateFresh: false } }, OPTIONS), '', String(bound));
    }
});

test('a bound that could be taken is said once, quietly, in the money of the page, with its ether beside it', () => {
    const base = derive({ snapshot: normalized('unresolved_request_settlement_wait') });
    const known = { ...base, exit: { ...base.exit, stateFresh: true, wait: null } };
    const html = renderExitChoice(known, OPTIONS);
    const root = mount(html);
    const fine = root.querySelector('[data-zkapi-exit-bound]');
    assert.equal(fine.getAttribute('data-bound'), '1000000', 'the number shown is the number carried');
    assert.equal(fine.textContent, 'If a recent chat is still settling, a withdrawal can give up as much as $0.10 (0.001 ETH).');
    assert.equal(radios(root).length, 0, 'a chat that is not known to be settling is no choice');
    assert.equal(root.querySelector('fieldset'), null);
    assert.doesNotMatch(html, /aria-live|role="(?:status|alert)"|\bautofocus\b/);
});

test('while a chat is settling there are three choices, and the quiet one is the one that is chosen', () => {
    const state = settling();
    assert.equal(state.exit.wait.kind, 'settlement');
    const html = renderExitChoice(state, OPTIONS);
    const root = mount(html);
    assert.ok(root.querySelector('[data-zkapi-exit-choice]'));
    assert.equal(root.querySelector('[data-zkapi-exit-bound]').getAttribute('data-bound'), '1000000');
    const fieldset = root.querySelector('fieldset');
    assert.ok(fieldset);
    assert.equal(fieldset.querySelector('legend').textContent, EXIT_CHOICE_WORDS.legend);
    assert.deepEqual(radios(root).map(input => input.value), ['wait', 'zero', 'bound']);
    assert.deepEqual(radios(root).map(input => input.checked), [true, false, false], 'never preselect a concession');
    // Which row reads as chosen is the stylesheet's (`:has(:checked)`), so no class is left on the row
    // that was chosen when the markup was written.
    assert.doesNotMatch(html, /\bselected\b/);
    assert.equal(radios(root).every(input => input.type === 'radio'), true);

    // The settlement sentence names when a normal withdrawal can go ahead.
    const settlement = root.querySelector('[data-zkapi-exit-settlement]').textContent;
    assert.equal(settlement, 'A recent chat may still be settling, so a normal withdrawal waits for it until '
        + `${FORMAT(new Date(state.exit.wait.escapeAtMs))}. You can wait, or leave now with an emergency exit, which takes longer to finish.`);

    const labels = radios(root).map(input => input.closest('label'));
    assert.match(labels[0].textContent, /^Wait for it to settleUse the normal withdrawal\. It goes through once the chat has settled, from /);
    assert.equal(labels[1].querySelector('strong').textContent, 'Leave now and give up nothing now');
    assert.equal(labels[2].querySelector('strong').textContent, 'Leave now and give up $0.10 (0.001 ETH)');
    // The sentence the protocol requires beside the concession: it was never recorded on Ethereum.
    assert.match(labels[2].querySelector('small').textContent, /isn’t recorded on Ethereum, so you may give up more than it actually cost\.$/);
    assert.match(labels[1].querySelector('small').textContent, /may still be taken from your payout\.$/);
    for (const label of labels) assert.ok(label.querySelector('strong') && label.querySelector('small'));
});

test('a choice made earlier is restored only for the bound it was made against', () => {
    const state = settling();
    const checked = options => radios(mount(renderExitChoice(state, { ...OPTIONS, ...options })))
        .filter(input => input.checked).map(input => input.value);
    assert.deepEqual(checked({}), ['wait']);
    assert.deepEqual(checked({ choice: 'bound', choiceBound: '1000000' }), ['bound']);
    assert.deepEqual(checked({ choice: 'zero', choiceBound: '1000000' }), ['zero']);
    assert.deepEqual(checked({ choice: 'zero', choiceBound: 1000000 }), ['zero'], 'the bound as a number is the same bound');
    // The bound moved since: the person did not agree to this one.
    assert.deepEqual(checked({ choice: 'bound', choiceBound: '500000' }), ['wait']);
    assert.deepEqual(checked({ choice: 'bound' }), ['wait']);
    // Waiting is the default and is never anything else on its own.
    assert.deepEqual(checked({ choice: 'wait', choiceBound: '1000000' }), ['wait']);
    assert.deepEqual(checked({ choice: 'something', choiceBound: '1000000' }), ['wait']);
    assert.deepEqual(checked({ choice: { value: 'bound' }, choiceBound: '1000000' }), ['wait']);
});

test('when the way out is already fixed only the fine print is shown, and a working dialog turns the choices off', () => {
    const state = settling();
    const fixed = mount(renderExitChoice(state, { ...OPTIONS, offerChoice: false }));
    assert.ok(fixed.querySelector('[data-zkapi-exit-bound]'));
    assert.equal(radios(fixed).length, 0);
    const working = mount(renderExitChoice(state, { ...OPTIONS, disabled: true }));
    assert.equal(working.querySelector('fieldset').hasAttribute('disabled'), true);
    const idle = mount(renderExitChoice(state, OPTIONS));
    assert.equal(idle.querySelector('fieldset').hasAttribute('disabled'), false);
});

test('the figure is the larger of the standing bound and the refused withdrawal’s, and it is never understated', () => {
    const base = settling();
    const bound = state => mount(renderExitChoice(state, OPTIONS)).querySelector('[data-zkapi-exit-bound]').getAttribute('data-bound');
    assert.equal(bound(base), '1000000');
    const grown = { ...base, exit: { ...base.exit, wait: { ...base.exit.wait, boundAtState: '2500000' } } };
    assert.equal(bound(grown), '2500000');
    const standing = { ...base, exit: { ...base.exit, boundAtState: '9000000', wait: { ...base.exit.wait, boundAtState: '4000000' } } };
    assert.equal(bound(standing), '9000000');
    // Compared as amounts, not as text: "9" is smaller than "10".
    const text = { ...base, exit: { ...base.exit, boundAtState: '9', wait: { ...base.exit.wait, boundAtState: '10' } } };
    assert.equal(bound(text), '10');
    // Amounts beyond a safe integer stay exact.
    const huge = { ...base, exit: { ...base.exit, boundAtState: '123456789012345678901', wait: null } };
    assert.equal(bound(huge), '123456789012345678901');
});

test('money words never throw, never double the unit and are never markup', () => {
    const state = settling();
    const text = formatAmount => mount(renderExitChoice(state, { ...OPTIONS, formatAmount }))
        .querySelector('[data-zkapi-exit-bound]').textContent;
    assert.match(text(MONEY), /as much as \$0\.10 \(0\.001 ETH\)\.$/);
    // No price: the ether amount is the figure.
    assert.match(text(() => ''), /as much as 0\.001 ETH\.$/);
    assert.match(text(undefined), /as much as 0\.001 ETH\.$/);
    assert.match(text(() => { throw new Error('no quote'); }), /as much as 0\.001 ETH\.$/);
    assert.match(text(() => 42), /as much as 0\.001 ETH\.$/);
    // A formatter that already says ether is not followed by it again.
    assert.match(text(() => '0.001 ETH'), /as much as 0\.001 ETH\.$/);
    // Whatever it returns is text.
    const hostile = renderExitChoice(state, { ...OPTIONS, formatAmount: () => '<img src=x onerror=alert(1)>' });
    assert.doesNotMatch(hostile, /<img/);
    assert.equal(mount(hostile).querySelector('img'), null);
    assert.ok(mount(hostile).querySelector('[data-zkapi-exit-bound]').textContent.includes('<img src=x onerror=alert(1)>'));
    // The attribute is digits and nothing else, whatever the money words are.
    assert.match(/data-bound="([^"]*)"/.exec(hostile)[1], /^\d+$/);
});

test('the smallest amount still reads as a whole, with and without a price', () => {
    const base = settling();
    const smallest = { ...base, exit: { ...base.exit, boundAtState: '1', wait: null, stateFresh: false } };
    for (const formatAmount of [() => '', MONEY, undefined]) {
        const root = mount(renderExitChoice(smallest, { ...OPTIONS, formatAmount }));
        const labels = radios(root).map(input => input.closest('label').textContent);
        assert.equal(labels.length, 3);
        for (const label of labels) assert.doesNotMatch(label, /undefined|NaN|\{|\}|\bnull\b/);
        assert.match(labels[2], /Leave now and give up (?:\$0\.00 \()?0\.000000001 ETH\)?/);
        assert.equal(root.querySelector('[data-zkapi-exit-bound]').getAttribute('data-bound'), '1');
    }
});

// -- The time a settling chat has to settle -------------------------------------

// From that time the SDK no longer waits for the chat and no longer honors
// "give up nothing now": a withdrawal of any kind leaves at once and gives up the
// whole figure. A page that still offers to wait, or to give nothing up, would say
// the opposite of what happens, so no radio and no "a normal withdrawal waits for it".
const settlementAt = () => settling().exit.escapeAtMs;
const asOf = now => ({ ...OPTIONS, now });
const PASSED_WORDS = /waits for it|Wait for it to settle|Give up nothing now|Leave now and give up|normal withdrawal|You can wait/;

test('the settlement time is the fixture’s own, in the future of its clock', () => {
    const at = settlementAt();
    assert.equal(Number.isFinite(at), true);
    assert.ok(at > GENERATED);
});

test('from the settlement time there is no waiting and no giving up nothing, and the figure is still carried', () => {
    const state = settling();
    const at = settlementAt();
    // The last moment before it: the choice, as always.
    assert.deepEqual(radios(mount(renderExitChoice(state, asOf(at - 1)))).map(input => input.value), ['wait', 'zero', 'bound']);
    for (const now of [at, at + 1, at + 3_600_000]) {
        for (const mode of ['mutual', 'escape']) {
            const html = renderExitChoice(state, { ...asOf(now), mode });
            const root = mount(html);
            assert.equal(root.querySelector('fieldset'), null, `${mode} at ${now}: no choice`);
            assert.equal(radios(root).length, 0, `${mode} at ${now}: no radio at all`);
            // The number the signer is later held to is still the number shown.
            assert.equal(root.querySelector('[data-zkapi-exit-bound]').getAttribute('data-bound'), '1000000');
            const said = root.querySelector('[data-zkapi-exit-settlement-passed]');
            assert.ok(said, 'one sentence says what a withdrawal does now');
            assert.equal(said.textContent, EXIT_CHOICE_WORDS.passed);
            assert.match(said.textContent, /^The time that chat had to settle has passed\. A withdrawal now leaves at once, as an emergency exit, and gives up the most that chat could cost, even if it cost less\.$/);
            assert.doesNotMatch(root.textContent.replace(EXIT_CHOICE_WORDS.passed, ''), PASSED_WORDS);
            assert.doesNotMatch(said.textContent, PASSED_WORDS);
            // The sentence follows the fine print, in one container.
            assert.ok(html.indexOf('data-zkapi-exit-bound') < html.indexOf('data-zkapi-exit-settlement-passed'));
            assert.ok(root.querySelector('[data-zkapi-exit-settled]'));
            assert.doesNotMatch(html, /aria-live|role="(?:status|alert)"|\bautofocus\b/);
            // Read back: nothing was chosen, nothing is forced, and the shown figure is the cap.
            assert.deepEqual(readExitChoice(root, state), {
                choice: null, mode, bound: '1000000', conceded: null, concededMax: '1000000', changed: false
            });
        }
    }
});

test('what is drawn after the settlement time is what the dialog’s own compensation would write, so the two agree and the dialog’s branch never fires', () => {
    const state = settling();
    const after = asOf(settlementAt() + 1);
    // The dialog (AccountModal.renderExitChoice) wraps the fine print it drew with
    // `offerChoice: false` and one sentence, when the helpers still drew the choice
    // past the time. The helpers no longer draw it, and write exactly that.
    for (const mode of ['mutual', 'escape']) {
        const fine = renderExitChoice(state, { ...after, mode, offerChoice: false });
        assert.equal(renderExitChoice(state, { ...after, mode }),
            `<div class="zkapi-exit-choice" data-zkapi-exit-settled>${fine}`
            + `<p class="zkapi-note" data-zkapi-exit-settlement-passed>${EXIT_CHOICE_WORDS.passed}</p></div>`);
        // No fieldset hook: the dialog looks for it, and finds nothing to correct.
        assert.doesNotMatch(renderExitChoice(state, { ...after, mode }), /data-zkapi-exit-fieldset/);
    }
});

test('a settled chat has no settlement time: the choice drawn for it stays, whatever the clock says', () => {
    const base = settling();
    const settled = { ...base, exit: { ...base.exit, stateFresh: true } };
    // The held wait is still a settlement wait (a refusal not yet aged out); the state says it settled.
    assert.equal(settled.exit.wait.kind, 'settlement');
    assert.deepEqual(radios(mount(renderExitChoice(settled, asOf(settlementAt() + 1)))).map(input => input.value),
        ['wait', 'zero', 'bound']);
});

test('only a settlement wait carries a settlement time, and the later of the times held is the one', () => {
    const base = settling();
    const at = settlementAt();
    const values = state => radios(mount(renderExitChoice(state, asOf(at + 1)))).map(input => input.value);
    const withTimes = (exitAt, wait) => ({ ...base, exit: { ...base.exit, escapeAtMs: exitAt, wait } });
    const wait = (kind, escapeAtMs) => ({ ...base.exit.wait, kind, escapeAtMs });
    // No time anywhere: nothing is known to have passed.
    assert.deepEqual(values(withTimes(null, wait('settlement', null))), ['wait', 'zero', 'bound']);
    // Another kind of wait with a time behind the clock does not end the choice.
    assert.deepEqual(values(withTimes(null, wait('release', at - 1000))), ['wait', 'zero', 'bound']);
    assert.deepEqual(values(withTimes(null, wait('proof', at - 1000))), ['wait', 'zero', 'bound']);
    // The standing time is behind the clock, a held refusal names a later one: still waiting.
    assert.deepEqual(values(withTimes(at - 60_000, wait('settlement', at + 3_600_000))), ['wait', 'zero', 'bound']);
    // Both behind it: over, whichever of them is the held one.
    assert.deepEqual(values(withTimes(at - 60_000, wait('settlement', at - 1000))), []);
    assert.deepEqual(values(withTimes(at - 60_000, null)), [], 'the standing time alone ends it');
    assert.deepEqual(values(withTimes(null, wait('settlement', at - 1000))), [], 'a held wait alone ends it');
    // A standing time that is not an instant is no time.
    for (const bad of [0, -5, NaN, Infinity, '1794766205000', {}]) {
        assert.deepEqual(values(withTimes(bad, null)), ['wait', 'zero', 'bound'], String(bad));
    }
});

test('a page with no clock draws what it always drew: nothing is known to have passed', () => {
    const state = settling();
    for (const now of [undefined, null, NaN, Infinity, '1794766205000', {}]) {
        const root = mount(renderExitChoice(state, { ...OPTIONS, now }));
        assert.deepEqual(radios(root).map(input => input.value), ['wait', 'zero', 'bound'], String(now));
        assert.equal(root.querySelector('[data-zkapi-exit-settlement-passed]'), null);
    }
});

test('a withdrawal whose way is already fixed shows the fine print alone, before and after the settlement time', () => {
    const state = settling();
    const at = settlementAt();
    for (const now of [at - 1, at, at + 1000]) {
        const html = renderExitChoice(state, { ...asOf(now), offerChoice: false });
        const root = mount(html);
        assert.equal(radios(root).length, 0);
        assert.equal(root.querySelector('[data-zkapi-exit-settlement-passed]'), null, 'nothing is offered, so nothing is withdrawn from the offer');
        assert.equal(root.querySelector('[data-zkapi-exit-bound]').getAttribute('data-bound'), '1000000');
    }
});

test('a chat that cannot cost anything has nothing to say after the settlement time either', () => {
    const base = settling();
    const at = settlementAt();
    const nothing = { ...base, exit: { ...base.exit, boundAtState: '0', wait: { ...base.exit.wait, boundAtState: '0' } } };
    assert.equal(renderExitChoice(nothing, asOf(at + 1)), '');
    // And a balance that is not known to be waiting on a chat is the fine print alone.
    const known = { ...base, exit: { ...base.exit, stateFresh: null, wait: null } };
    const root = mount(renderExitChoice(known, asOf(at + 1)));
    assert.equal(root.querySelector('[data-zkapi-exit-settlement-passed]'), null);
    assert.equal(radios(root).length, 0);
    assert.ok(root.querySelector('[data-zkapi-exit-bound]'));
});

// -- Reading the choice back ----------------------------------------------------

const read = (state, check, options = {}) => {
    const root = mount(renderExitChoice(state, { ...OPTIONS, ...options }));
    if (check) radio(root, check).click();
    return readExitChoice(root, state);
};

test('waiting gives up nothing now, and carries the bound that was shown as the most a conversion may take', () => {
    const state = settling();
    assert.deepEqual(read(state), {
        choice: 'wait', mode: 'mutual', bound: '1000000', conceded: null, concededMax: '1000000', changed: false
    });
    assert.deepEqual(read(state, 'wait'), {
        choice: 'wait', mode: 'mutual', bound: '1000000', conceded: null, concededMax: '1000000', changed: false
    });
});

test('leaving now with nothing given up asks for exactly nothing, and with the bound for exactly the bound', () => {
    const state = settling();
    assert.deepEqual(read(state, 'zero'), {
        choice: 'zero', mode: 'mutual', bound: '1000000', conceded: '0', concededMax: null, changed: false
    });
    assert.deepEqual(read(state, 'bound'), {
        choice: 'bound', mode: 'mutual', bound: '1000000', conceded: '1000000', concededMax: null, changed: false
    });
});

test('what is read is what was shown, not what the state says since', () => {
    const state = settling();
    const root = mount(renderExitChoice(state, OPTIONS));
    radio(root, 'bound').click();
    const grown = { ...state, exit: { ...state.exit, boundAtState: '3000000' } };
    const answer = readExitChoice(root, grown);
    assert.equal(answer.bound, '1000000', 'the figure the person saw');
    assert.equal(answer.conceded, '1000000');
    assert.equal(answer.changed, true, 'and the caller is told the figure has grown');
    // A bound that did not grow, or shrank, is not a change.
    assert.equal(readExitChoice(root, { ...state, exit: { ...state.exit, boundAtState: '10', wait: null } }).changed, false);
    assert.equal(readExitChoice(root, null).changed, false);
    assert.equal(readExitChoice(root).changed, false);
});

test('the fine print alone still carries the bound, and no markup carries nothing', () => {
    const state = settling();
    const fixed = mount(renderExitChoice(state, { ...OPTIONS, offerChoice: false }));
    assert.deepEqual(readExitChoice(fixed, state), {
        choice: null, mode: 'mutual', bound: '1000000', conceded: null, concededMax: '1000000', changed: false
    });
    const nothing = mount('<div></div>');
    assert.deepEqual(readExitChoice(nothing, state), {
        choice: null, mode: null, bound: null, conceded: null, concededMax: null, changed: false
    });
    for (const root of [null, undefined, {}, 'x', 5]) {
        assert.deepEqual(readExitChoice(root, state), {
            choice: null, mode: null, bound: null, conceded: null, concededMax: null, changed: false
        }, String(root));
    }
});

test('a choice that needs a bound the markup does not carry falls back to waiting', () => {
    const state = settling();
    const hostile = [
        '<p data-zkapi-exit-bound data-bound="1e3"></p>',
        '<p data-zkapi-exit-bound data-bound="-5"></p>',
        '<p data-zkapi-exit-bound data-bound="0x10"></p>',
        '<p data-zkapi-exit-bound data-bound="1.5"></p>',
        '<p data-zkapi-exit-bound data-bound=""></p>',
        '<p data-zkapi-exit-bound></p>',
        ''
    ];
    for (const fine of hostile) {
        for (const value of ['zero', 'bound']) {
            const root = mount(`${fine}<fieldset><input type="radio" name="${CONCEDE_FIELD}" value="${value}" checked></fieldset>`);
            const answer = readExitChoice(root, state);
            assert.equal(answer.choice, 'wait', `${fine} / ${value}`);
            assert.equal(answer.conceded, null);
            assert.equal(answer.bound, null);
            assert.equal(answer.concededMax, null);
        }
    }
    // A value the page never rendered is waiting; so is no radio checked at all.
    const bound = '<p data-zkapi-exit-bound data-bound="40"></p>';
    const odd = mount(`${bound}<input type="radio" name="${CONCEDE_FIELD}" value="everything" checked>`);
    assert.deepEqual(readExitChoice(odd, null), {
        choice: 'wait', mode: null, bound: '40', conceded: null, concededMax: '40', changed: false
    });
    const none = mount(`${bound}<input type="radio" name="${CONCEDE_FIELD}" value="zero">`);
    assert.equal(readExitChoice(none, null).choice, 'wait');
    // Another radio group on the page is not this choice.
    const other = mount(`${bound}<input type="radio" name="zkapi-withdraw-mode" value="zero" checked>`);
    assert.equal(readExitChoice(other, null).choice, null);
});

// -- A prepared emergency exit, continued once the bound has fallen to nothing ----

// The SDK's saved escape plan survives a reload, and the state's bound can have
// fallen to nothing since it was prepared. The fine print is then not drawn, so
// the dialog has no figure to name: it passes no cap, and the Send Ethereum signer
// (address-funding-escape-concession: "continued after a reload with no bound to
// name") refuses a plan that concedes anything, in words that say to cancel and
// start again. Pinned here: the real state draws nothing and carries nothing.
test('a prepared emergency exit continued once the bound is nothing draws no figure and names no cap', () => {
    const state = derive({ snapshot: normalized('escape_lock_released_proof') });
    assert.equal(state.exit.boundAtState, '0');
    assert.notEqual(state.exit.frozen, null);
    for (const options of [{ ...OPTIONS, mode: 'escape', offerChoice: false }, { ...OPTIONS, mode: 'escape' }, { ...OPTIONS }]) {
        const html = renderExitChoice(state, options);
        assert.equal(html, '');
        assert.deepEqual(readExitChoice(mount(html), state), {
            choice: null, mode: null, bound: null, conceded: null, concededMax: null, changed: false
        });
    }
    // While a bound is still there, the same plan names it, and that is the cap.
    const bounded = { ...state, exit: { ...state.exit, boundAtState: '300000' } };
    const root = mount(renderExitChoice(bounded, { ...OPTIONS, mode: 'escape', offerChoice: false }));
    assert.deepEqual(readExitChoice(root, bounded), {
        choice: null, mode: 'escape', bound: '300000', conceded: null, concededMax: '300000', changed: false
    });
});

// -- An emergency exit never waits ------------------------------------------------

// With "Emergency exit" selected the SDK leaves at once before the settlement time, conceding
// nothing unless asked for the bound. A "Wait for it to settle" button there, checked, would say
// the opposite of what happens.
const ESCAPE = { ...OPTIONS, mode: 'escape' };

test('an emergency exit has no waiting: the choices are what to give up, and giving up nothing now is the one chosen', () => {
    const state = settling();
    const html = renderExitChoice(state, ESCAPE);
    const root = mount(html);
    assert.equal(root.querySelector('[data-zkapi-exit-choice]').getAttribute('data-zkapi-exit-mode'), 'escape');
    assert.deepEqual(radios(root).map(input => input.value), ['zero', 'bound']);
    assert.deepEqual(radios(root).map(input => input.checked), [true, false], 'the default gives up nothing now');
    assert.equal(radio(root, 'wait'), undefined);
    assert.equal(root.querySelector('legend').textContent, EXIT_CHOICE_WORDS.legendExit);
    assert.equal(root.querySelector('[data-zkapi-exit-settlement]').textContent, EXIT_CHOICE_WORDS.exitIntro);
    // Nothing says a normal withdrawal waits or that an emergency exit is "the other way": it was chosen.
    assert.doesNotMatch(root.textContent, /Wait for it to settle|normal withdrawal|You can wait/);
    // The two that remain are the same two as in a normal withdrawal, with the required sentence.
    const labels = radios(root).map(input => input.closest('label'));
    assert.equal(labels[0].querySelector('strong').textContent, 'Leave now and give up nothing now');
    assert.equal(labels[1].querySelector('strong').textContent, 'Leave now and give up $0.10 (0.001 ETH)');
    assert.match(labels[1].querySelector('small').textContent, /isn’t recorded on Ethereum, so you may give up more than it actually cost\.$/);
    // The fine print is the same, and carries the same bound.
    assert.equal(root.querySelector('[data-zkapi-exit-bound]').getAttribute('data-bound'), '1000000');
    // A normal withdrawal is the default kind and says so.
    for (const options of [OPTIONS, { ...OPTIONS, mode: 'mutual' }, { ...OPTIONS, mode: 'bogus' }, { ...OPTIONS, mode: undefined }]) {
        const normal = mount(renderExitChoice(state, options));
        assert.equal(normal.querySelector('[data-zkapi-exit-choice]').getAttribute('data-zkapi-exit-mode'), 'mutual');
        assert.deepEqual(radios(normal).map(input => input.value), ['wait', 'zero', 'bound']);
    }
});

test('in an emergency exit a choice made earlier is restored for the same bound, and anything else starts on nothing given up', () => {
    const state = settling();
    const checked = options => radios(mount(renderExitChoice(state, { ...ESCAPE, ...options })))
        .filter(input => input.checked).map(input => input.value);
    assert.deepEqual(checked({}), ['zero']);
    assert.deepEqual(checked({ choice: 'bound', choiceBound: '1000000' }), ['bound']);
    assert.deepEqual(checked({ choice: 'zero', choiceBound: '1000000' }), ['zero']);
    // The bound moved since, or the earlier choice was to wait: there is no waiting to restore.
    assert.deepEqual(checked({ choice: 'bound', choiceBound: '500000' }), ['zero']);
    assert.deepEqual(checked({ choice: 'bound' }), ['zero']);
    assert.deepEqual(checked({ choice: 'wait', choiceBound: '1000000' }), ['zero']);
    // Exactly one is ever checked.
    for (const options of [{}, { choice: 'bound', choiceBound: '1000000' }, { choice: 'wait' }]) {
        assert.equal(checked(options).length, 1);
    }
});

test('an emergency exit is read back as what was shown, and says which kind of withdrawal the markup was for', () => {
    const state = settling();
    assert.deepEqual(read(state, null, { mode: 'escape' }), {
        choice: 'zero', mode: 'escape', bound: '1000000', conceded: '0', concededMax: null, changed: false
    });
    assert.deepEqual(read(state, 'bound', { mode: 'escape' }), {
        choice: 'bound', mode: 'escape', bound: '1000000', conceded: '1000000', concededMax: null, changed: false
    });
    // Only the fine print (the way out is already fixed): no choice, still the mode and the bound.
    assert.deepEqual(read(state, null, { mode: 'escape', offerChoice: false }), {
        choice: null, mode: 'escape', bound: '1000000', conceded: null, concededMax: '1000000', changed: false
    });
    // The container itself may be the root that is read.
    const container = mount(renderExitChoice(state, ESCAPE)).querySelector('[data-zkapi-exit-choice]');
    assert.equal(readExitChoice(container, state).mode, 'escape');
    assert.equal(readExitChoice(container, state).choice, 'zero');
    // Markup that carries a kind this page does not know is no kind at all.
    const odd = mount('<div data-zkapi-exit-choice data-zkapi-exit-mode="both"><p data-zkapi-exit-bound data-bound="7"></p></div>');
    assert.equal(readExitChoice(odd, null).mode, null);
});

// ---------------------------------------------------------------------------
// Words and styling
// ---------------------------------------------------------------------------

const FORBIDDEN = /nullifier|vault|circuit|deployment|manifest|\bnotes?\b|note\s*#|#\s*\d|unlinkable|untraceable|anonymous|zero.knowledge|proof\b|escape hatch|mutual close|nothing is lost|\bsafe(ly)?\b|backup|restore/i;

function assertPlainWords(text, where) {
    assert.equal(FORBIDDEN.test(text), false, `${where}: ${text}`);
    assert.equal(/!/.test(text), false, `${where}: exclamation`);
    assert.equal(/'/.test(text), false, `${where}: straight apostrophe`);
    assert.equal(/\p{Extended_Pictographic}/u.test(text), false, `${where}: emoji`);
    assert.equal(/\s{2,}|\s[.,;:?]/.test(text), false, `${where}: spacing`);
    assert.equal(/[{}]|undefined|NaN|\bnull\b/.test(text), false, `${where}: a token was left`);
}

test('vocabulary: calm plain words, curly apostrophes, no jargon, and the unit words arrive as tokens', () => {
    for (const [key, text] of Object.entries({ ...BALANCE_EXTRAS_WORDS, ...EXIT_CHOICE_WORDS })) {
        assert.equal(typeof text, 'string', key);
        const filled = text.replace(/\{\?(\w+)\}([\s\S]*?)\{\/\1\}/g, '$2').replace(/\{(\w+)\}/g, 'then');
        assertPlainWords(filled, key);
        assert.equal(/\b[A-Z]{3,}\b/.test(text), false, `${key}: shouting or a unit word`);
    }
    const snapshot = normalized('kit_never_exported');
    const seen = [];
    const states = [
        derive({ snapshot }),
        derive({ snapshot: normalized('kit_out_of_date') }),
        derive({ snapshot: normalized('kit_out_of_date'), kitUnsaved: true }),
        derive({ active: CLOSED, snapshot, abandon: ZERO }),
        derive({ active: CLOSED, snapshot, abandon: DUST })
    ];
    for (const state of states) seen.push(mount(renderBalanceExtras(state)).textContent);
    for (const state of [settling(), derive({ snapshot: normalized('unresolved_request_settlement_wait') })]) {
        seen.push(mount(renderExitChoice(state, OPTIONS)).textContent);
        seen.push(mount(renderExitChoice(state, ESCAPE)).textContent);
    }
    // And the page after the time that chat had to settle.
    seen.push(mount(renderExitChoice(settling(), asOf(settlementAt() + 1))).textContent);
    seen.push(mount(renderExitChoice(settling(), { ...asOf(settlementAt() + 1), mode: 'escape' })).textContent);
    assert.equal(seen.filter(Boolean).length, seen.length);
    for (const text of seen) {
        // Units arrive as tokens built by the component ("0.001 ETH").
        const words = text.replace(/\b[\d.]+ ETH\b/g, '').replace(/\s+/g, ' ').trim();
        assertPlainWords(words, 'rendered');
        assert.equal(/\b[A-Z]{3,}\b/.test(words), false, `shouting: ${words}`);
    }
});

test('styling: every class the extras and the choice use is one the app ships', () => {
    const css = ['chat/tailwind.generated.css', 'chat/zkapi/zkapi.css', 'chat/styles.css']
        .map(file => fs.readFileSync(path.join(repoRoot, file), 'utf8')).join('\n');
    const escape = name => name.replace(/([^a-zA-Z0-9_-])/g, '\\$1');
    const snapshot = normalized('kit_never_exported');
    const base = derive({ snapshot: normalized('kit_out_of_date') });
    const html = [
        renderBalanceExtras(derive({ snapshot })),
        renderBalanceExtras(derive({ snapshot: normalized('kit_out_of_date') })),
        renderBalanceExtras({ ...base, exit: { ...base.exit, rpc: { recommended: true, wrongChain: false } } }),
        renderBalanceExtras(derive({ active: CLOSED, snapshot, abandon: DUST })),
        renderExitChoice(settling(), OPTIONS),
        renderExitChoice(settling(), ESCAPE),
        renderExitChoice(settling(), { ...OPTIONS, offerChoice: false }),
        renderExitChoice(settling(), asOf(settlementAt() + 1))
    ].join('');
    const classes = new Set();
    for (const match of html.matchAll(/class="([^"]*)"/g)) match[1].split(/\s+/).filter(Boolean).forEach(name => classes.add(name));
    assert.ok(classes.size >= 10, [...classes].join());
    for (const name of classes) {
        assert.ok(css.includes(`.${name}`) || css.includes(`.${escape(name)}`), `class ${name} is not in the shipped stylesheets`);
    }
});
