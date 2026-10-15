import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    deriveZkapiUxState,
    normalizeZkapiUxProposal,
    ZKAPI_UX_PROPOSALS
} from '../../chat/zkapi/services/zkapiUxState.mjs';
import { renderVersionBanner } from '../../chat/zkapi/components/VersionNotices.js';
import concessionV1 from '../../chat/zkapi/versioning/adapters/concessionV1.mjs';
import { getAdapter } from '../../chat/zkapi/versioning/adapters/index.mjs';
import { copyTokens, versionCopyText } from '../../chat/zkapi/versioning/copy.mjs';
import { deriveVersionState } from '../../chat/zkapi/versioning/versionState.mjs';
import { resolvedTable, threeVersionRegistry } from './_registryFixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function fundedSnapshot(overrides = {}) {
    return {
        config: { ux_proposal: 'quiet', active_lease: null, prepared_withdrawal: null },
        wallet: {
            has_note: true,
            note: { note_id: 7, current_balance: 4_000_000, deposit_amount: 5_000_000 }
        },
        withdrawal: null,
        activities: [],
        ...overrides
    };
}

test('UX proposal names are pinned and unknown builds fail closed to Quiet Layer', () => {
    assert.equal(normalizeZkapiUxProposal('quiet'), 'quiet');
    assert.equal(normalizeZkapiUxProposal('guided'), 'guided');
    assert.equal(normalizeZkapiUxProposal('activity'), 'activity');
    assert.equal(normalizeZkapiUxProposal('receipt'), 'receipt');
    assert.equal(normalizeZkapiUxProposal('relay'), 'relay');
    assert.equal(normalizeZkapiUxProposal('ambient'), 'ambient');
    assert.equal(normalizeZkapiUxProposal('capsule'), 'capsule');
    assert.equal(normalizeZkapiUxProposal('surprise'), 'quiet');
});

test('New Chat is immediately typeable while the previous chat closes', () => {
    const state = deriveZkapiUxState({
        snapshot: fundedSnapshot(),
        transition: { phase: 'settling', message: 'internal protocol copy' }
    });
    assert.equal(state.primary.phase, 'closing');
    assert.equal(state.primary.blocksSend, false);
    assert.match(state.primary.detail, /New messages can send when this finishes/);
    assert.equal(state.showComposer, true);
});

test('a fast send becomes an explicit queue instead of a frozen composer', () => {
    const state = deriveZkapiUxState({
        snapshot: fundedSnapshot(),
        transition: { phase: 'waiting' }
    });
    assert.equal(state.primary.phase, 'queued');
    assert.equal(state.primary.blocksSend, true);
    assert.match(state.primary.detail, /send automatically/i);
});

test('a stopped or failed settlement keeps recovery visible over residual SDK work', () => {
    const state = deriveZkapiUxState({
        snapshot: fundedSnapshot({ activities: [
            { kind: 'settlement', phase: 'usage', status: 'running', title: 'Closing previous chat' },
            { kind: 'access', phase: 'waiting', status: 'waiting', title: 'Requesting a key' }
        ] }),
        transition: { phase: 'error', message: 'Stopped waiting for private access. Your recovery record is saved.' }
    });
    for (const primary of [state.primary, state.composerPrimary, state.balancePrimary, state.closingPrimary]) {
        assert.equal(primary.phase, 'error');
        assert.equal(primary.busy, false);
        assert.equal(primary.tone, 'error');
        assert.match(primary.detail, /recovery record is saved/);
    }
    assert.equal(state.settlementAction, 'retry');
    assert.equal(state.journey[0].state, 'error');
    assert.equal(state.showComposer, true);
});

test('settlement controls are scoped to an actionable runtime transition', () => {
    for (const phase of ['settling', 'waiting', 'error', 'ready', null]) {
        const state = deriveZkapiUxState({ snapshot: fundedSnapshot(), transition: phase ? { phase } : null });
        assert.equal(state.settlementAction, phase === 'error' ? 'retry'
            : ['settling', 'waiting'].includes(phase) ? 'stop' : null);
    }
});

test('private-key creation exposes real proof, server, and verification phases', () => {
    const phases = [
        ['proving', 0],
        ['requesting', 1],
        ['waiting', 1],
        ['verifying', 1],
        ['ready', 2]
    ];
    for (const [phase, expectedStep] of phases) {
        const status = phase === 'ready' ? 'success' : 'running';
        const state = deriveZkapiUxState({
            snapshot: fundedSnapshot({
                config: { ux_proposal: 'guided', active_lease: null, prepared_withdrawal: null },
                activities: [{
                    id: `access-${phase}`,
                    kind: 'access',
                    phase,
                    status,
                    title: 'Starting private chat',
                    message: `phase ${phase}`,
                    blocksSend: status === 'running',
                    startedAt: 1,
                    updatedAt: 2,
                    finishedAt: status === 'success' ? 3 : null
                }]
            })
        });
        assert.equal(state.journey.findIndex(step => ['active', 'error'].includes(step.state)) === -1
            ? state.journey.findLastIndex(step => step.state === 'complete')
            : state.journey.findIndex(step => ['active', 'error'].includes(step.state)), expectedStep);
    }
});

test('new access work replaces a completed handoff instead of looking stuck on ready', () => {
    const state = deriveZkapiUxState({
        snapshot: fundedSnapshot({
            config: { ux_proposal: 'guided', active_lease: null, prepared_withdrawal: null },
            activities: [{
                id: 'access-after-handoff',
                kind: 'access',
                phase: 'proving',
                status: 'running',
                title: 'Starting private chat',
                message: 'Proving this chat is funded…',
                blocksSend: true,
                startedAt: 1,
                updatedAt: 2
            }]
        }),
        transition: { phase: 'ready' }
    });

    assert.equal(state.primary.phase, 'proving');
    assert.equal(state.primary.detail, 'Proving this chat is funded…');
    assert.equal(state.journey[2].state, 'active');
});

test('wallet work also replaces a completed handoff so withdrawal progress is never masked', () => {
    const state = deriveZkapiUxState({
        snapshot: fundedSnapshot({
            activities: [{
                id: 'withdraw-after-handoff',
                kind: 'withdraw',
                phase: 'settling',
                status: 'running',
                title: 'Returning your balance',
                message: 'Generating the withdrawal proof…',
                blocksSend: true,
                startedAt: 1,
                updatedAt: 2
            }]
        }),
        transition: { phase: 'ready' }
    });

    assert.equal(state.primary.title, 'Returning your balance');
    assert.equal(state.journey[1].label, 'Create close proof');
});

test('concurrent settlement and MetaMask work route to the surface where each is actionable', () => {
    const state = deriveZkapiUxState({
        snapshot: fundedSnapshot({
            activities: [{
                id: 'deposit-wallet',
                kind: 'deposit',
                phase: 'wallet',
                status: 'waiting',
                title: 'Adding funds',
                message: 'Confirm in MetaMask.',
                startedAt: 2,
                updatedAt: 3
            }]
        }),
        transition: { phase: 'waiting' }
    });

    assert.equal(state.composerPrimary.phase, 'queued');
    assert.equal(state.balancePrimary.activity.kind, 'deposit');
    assert.equal(state.panelPrimary.activity.kind, 'deposit');
});

// Accepted-prompt snapshot and later-draft/file preservation are verified
// against the actual shared ChatApp in chatRuntimeOwnership.test.js.

test('withdrawal and escape-hatch states stay visible outside their modal', () => {
    const prepared = deriveZkapiUxState({
        snapshot: fundedSnapshot({
            config: { ux_proposal: 'activity', active_lease: null, prepared_withdrawal: { mode: 'mutual' } }
        })
    });
    assert.equal(prepared.primary.phase, 'withdrawal');
    assert.equal(prepared.primary.blocksSend, true);
    assert.deepEqual(prepared.journey.map(step => step.label), [
        'Withdrawal prepared', 'Finish in MetaMask', 'Update balance'
    ]);
    assert.equal(prepared.journey[1].state, 'active');

    const escape = deriveZkapiUxState({
        snapshot: fundedSnapshot({ withdrawal: { phase: 'pending', challengeDeadline: 42 } })
    });
    assert.equal(escape.primary.phase, 'escape-wait');
    assert.match(escape.primary.detail, /paused/i);
    assert.deepEqual(escape.journey.map(step => step.label), [
        'Recovery started', 'Safety window', 'Finalize withdrawal'
    ]);
});

test('guided wallet operations use truthful operation-specific steps', () => {
    const deposit = deriveZkapiUxState({
        snapshot: fundedSnapshot({
            activities: [{
                id: 'deposit-1',
                kind: 'deposit',
                phase: 'wallet',
                status: 'running',
                title: 'Adding funds',
                message: 'Approving ZKAPI… confirm in MetaMask.',
                startedAt: 1,
                updatedAt: 2
            }]
        })
    });
    assert.deepEqual(deposit.journey.map(step => step.label), [
        'Connect wallet', 'Confirm deposit', 'Save private note'
    ]);
    assert.equal(deposit.journey[1].state, 'active');

    const withdraw = deriveZkapiUxState({
        snapshot: fundedSnapshot({
            activities: [{
                id: 'withdraw-1',
                kind: 'withdraw',
                phase: 'settling',
                status: 'running',
                title: 'Returning your balance',
                message: 'Requesting server clearance and generating the withdrawal proof…',
                blocksSend: true,
                startedAt: 1,
                updatedAt: 2
            }]
        })
    });
    assert.equal(withdraw.journey[1].label, 'Create close proof');
    assert.equal(withdraw.journey[1].state, 'active');
});

test('a failed first deposit stays visible instead of falling back to an unexplained empty balance', () => {
    const now = Date.now();
    const failed = deriveZkapiUxState({
        now,
        snapshot: fundedSnapshot({
            wallet: { has_note: false, note: null },
            activities: [{
                id: 'deposit-failed',
                kind: 'deposit',
                phase: 'wallet',
                status: 'error',
                title: 'Adding funds',
                message: 'Confirm the deposit in MetaMask.',
                error: 'The transaction reverted. Review the wallet details and try again.',
                startedAt: now - 1_000,
                updatedAt: now,
                finishedAt: now
            }]
        })
    });

    assert.equal(failed.primary.phase, 'error');
    assert.match(failed.primary.detail, /try again/i);
    assert.equal(failed.journey[1].state, 'error');
});

test('runtime initialization failures are actionable state rather than a frozen loading shell', () => {
    const state = deriveZkapiUxState({
        snapshot: fundedSnapshot({
            wallet: null,
            lastError: new Error('Could not reach the configured zkAPI deployment.')
        })
    });

    assert.equal(state.primary.phase, 'error');
    assert.equal(state.primary.blocksSend, true);
    assert.match(state.primary.detail, /configured zkAPI deployment/);
});

test('low-text proposals keep protocol detail behind disclosure and preserve the visible balance', () => {
    const experience = fs.readFileSync(path.join(root, 'chat/zkapi/components/ZkapiStateExperience.js'), 'utf8');
    const templates = fs.readFileSync(path.join(root, 'chat/components/MessageTemplates.js'), 'utf8');
    const pendingIndicator = fs.readFileSync(path.join(root, 'chat/components/PendingIndicator.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'chat/zkapi/zkapi.css'), 'utf8');
    assert.match(experience, /renderLowTextPanel/);
    assert.match(experience, /proposal === 'receipt'/);
    assert.match(experience, /zkapi-composer-relay/);
    assert.match(experience, /zkapi-composer-ambient-button/);
    assert.match(experience, /zkapi-composer-capsule/);
    assert.doesNotMatch(experience, /text = primary\.compact/);
    assert.doesNotMatch(templates, /buildUserDeliveryReceipt|user-delivery|data-delivery-state/);
    assert.match(templates, /resend-prompt-btn/);
    assert.match(templates, /edit-prompt-btn/);
    assert.match(templates, /pending-response-line/);
    assert.match(templates, /buildDetailedPendingIndicator\(presentation/);
    assert.doesNotMatch(pendingIndicator, /pending-response-dots/);
    assert.match(css, /prefers-reduced-motion: reduce/);
    assert.match(css, /zkapi-composer-state--ambient/);
});

test('runtime progress comes from real zkAPI work rather than a fabricated percentage', () => {
    const runtime = fs.readFileSync(new URL(import.meta.resolve('@openanonymity/zkapi-browser-sdk/runtime')), 'utf8');
    assert.match(runtime, /onProgress\('proving', 'Proving this chat is funded…'\)/);
    assert.match(runtime, /attempt === 1[\s\S]*'Creating a temporary key for this chat…'/);
    assert.match(runtime, /'Retrying temporary key creation…'/);
    assert.match(runtime, /onProgress\('verifying', 'Verifying the new private key with OA…'\)/);
    assert.match(runtime, /onProgress\('applying', 'Updating your private balance…'\)/);
    assert.doesNotMatch(runtime, /onProgress\([^\n]*percent/i);
});


// ---------------------------------------------------------------------------
// A balance held by an exit lock, with no withdrawal of its own
// ---------------------------------------------------------------------------
//
// The SDK freezes new chats while an exit lock is held (a released ownership or
// escape proof can still land). With a plan prepared, the plan is the thing to
// finish and has its own words. With none (a mutual close that only sent its
// ownership proof, or a plan that was canceled while its escape proof stays
// live) nothing is prepared and nothing is moving, and the panel used to say
// "Ready to chat" or "Withdrawal ready to finish". The version facade's state
// knows the balance is frozen; the words are the ones the balance dialog's
// notice uses (versioning/copy.mjs, 'exit.frozen'). Driven by the REAL snapshots
// the revision 3 SDK emitted (test/fixtures/zkapi-v2-real-shapes).

const SHAPES = JSON.parse(fs.readFileSync(new URL('../fixtures/zkapi-v2-real-shapes/snapshots.json', import.meta.url), 'utf8'));
const SHAPES_NOW = SHAPES.generatedAtMs;
const SHAPES_TABLE = resolvedTable(threeVersionRegistry(), 'mainnet');
const SHAPES_LIVE = SHAPES_TABLE[2];

function shapesVersion(name, { changes = null } = {}) {
    const scenario = SHAPES.scenarios[name];
    const client = changes ? changes(structuredClone(scenario.clientSnapshot)) : scenario.clientSnapshot;
    const snapshot = concessionV1.normalizeSnapshot({ ...client, runtime: scenario.runtime }, { nowMs: SHAPES_NOW });
    const state = deriveVersionState({
        table: SHAPES_TABLE, active: SHAPES_LIVE, target: SHAPES_LIVE,
        selection: { version: SHAPES_LIVE, reason: 'runtime_holds_note', slotOwner: SHAPES_LIVE.id, open: {}, credits: {},
            foreignDeploymentId: null, depositBlock: null, draftDiscarded: false, slotKind: 'note' },
        snapshot, intent: null, previewSelection: null, now: SHAPES_NOW, busy: false, admissionClosed: false,
        buildClosed: false, configBlock: false, unreachable: false, adapter: getAdapter(SHAPES_LIVE.adapter)
    });
    return { client, state };
}

// What the SDK keeps after a prepared escape is canceled while its proof is live.
const withoutPlan = client => {
    client.config.prepared_withdrawal = null;
    return client;
};
const FROZEN_TITLE = 'Balance frozen';

test('a balance held by an exit lock with no prepared plan says frozen, in the dialog’s words, not ready', () => {
    const { client, state: version } = shapesVersion('mutual_lock_with_ownership_proof');
    assert.equal(client.config.prepared_withdrawal, null);
    assert.equal(client.withdrawal, null);
    assert.equal(version.exit.frozen !== null, true, 'the facade knows it is frozen');
    // A page without the version helpers (or a build that has none): as it always was.
    const before = deriveZkapiUxState({ snapshot: client, now: SHAPES_NOW });
    assert.equal(before.primary.phase, 'ready');
    assert.equal(before.composerPrimary.blocksSend, false);

    const state = deriveZkapiUxState({ snapshot: client, now: SHAPES_NOW, version });
    const detail = versionCopyText('exit.frozen', copyTokens(version, { now: SHAPES_NOW }));
    assert.match(detail, /frozen/);
    for (const key of ['primary', 'composerPrimary', 'balancePrimary', 'panelPrimary']) {
        const primary = state[key];
        assert.equal(primary.phase, 'withdrawal', key);
        assert.equal(primary.frozen, true, key);
        assert.equal(primary.tone, 'waiting', key);
        assert.equal(primary.busy, false, key);
        assert.equal(primary.blocksSend, true, key);
        assert.equal(primary.title, FROZEN_TITLE, key);
        assert.equal(primary.compact, FROZEN_TITLE, key);
        assert.equal(primary.detail, detail, key);
        assert.doesNotMatch(`${primary.title} ${primary.detail}`,
            /Withdrawal ready|No transaction is moving|Finish withdrawing|Ready to chat|private key will be created/);
    }
    assert.equal(state.showComposer, true, 'a chat that cannot start must be said where it is typed');
    assert.equal(state.settlementAction, null);
});

test('a frozen balance says until when, once the lock reports it, and says nothing about a time that has passed', () => {
    const { client, state: version } = shapesVersion('escape_lock_released_proof', { changes: withoutPlan });
    const until = version.exit.frozen.untilMs;
    assert.equal(Number.isFinite(until) && until > SHAPES_NOW, true);
    const early = deriveZkapiUxState({ snapshot: client, now: SHAPES_NOW, version });
    assert.match(early.primary.detail, /New chats resume after /);
    assert.equal(early.primary.detail, versionCopyText('exit.frozen', copyTokens(version, { now: SHAPES_NOW })));
    // After that instant the date is left out (the facade re-derives; a stale
    // state read late must not promise a time that is behind the reader).
    const late = deriveZkapiUxState({ snapshot: client, now: until + 1, version });
    assert.doesNotMatch(late.primary.detail, /New chats resume after \d/);
    assert.match(late.primary.detail, /frozen/);
});

test('a prepared plan keeps its own words: finishing it is what comes next', () => {
    const { client, state: version } = shapesVersion('escape_lock_released_proof');
    assert.equal(client.config.prepared_withdrawal.phase, 'prepared');
    assert.equal(version.exit.frozen !== null, true);
    const withVersion = deriveZkapiUxState({ snapshot: client, now: SHAPES_NOW, version });
    const without = deriveZkapiUxState({ snapshot: client, now: SHAPES_NOW });
    assert.deepEqual(withVersion, without);
    assert.equal(withVersion.primary.title, 'Withdrawal paused');
    assert.equal(withVersion.primary.frozen, undefined);
    // The same for every other withdrawal in motion, with the lock held, on
    // a balance another device has used as well.
    const frozen = { exit: { frozen: { untilMs: null, mode: 'escape' } } };
    const frozenElsewhere = { exit: { frozen: { untilMs: null, mode: 'escape' }, deviceNotNewest: true } };
    const cases = {
        submitted: fundedSnapshot({ config: { prepared_withdrawal: { phase: 'submitted', transaction_hash: '0xab' } } }),
        ambiguous: fundedSnapshot({ config: { prepared_withdrawal: { phase: 'ambiguous' } } }),
        pending: fundedSnapshot({ withdrawal: { phase: 'pending', challengeDeadline: 42 } }),
        late: fundedSnapshot({ config: { late_withdrawal_attempts: [{ note_id: 7, status: 'submitted' }] } }),
        recorded: fundedSnapshot({ withdrawal: { phase: 'dropped_or_pending' } })
    };
    for (const [name, snapshot] of Object.entries(cases)) {
        assert.deepEqual(deriveZkapiUxState({ snapshot, version: frozen }), deriveZkapiUxState({ snapshot }), name);
        assert.deepEqual(deriveZkapiUxState({ snapshot, version: frozenElsewhere }), deriveZkapiUxState({ snapshot }),
            `${name}, used on another device`);
    }
});

test('running work, a failed attempt and a handoff keep their place over a frozen balance', () => {
    const { client, state: version } = shapesVersion('mutual_lock_with_ownership_proof');
    const accessing = { ...client, activities: [{ id: 'a', kind: 'access', phase: 'requesting', status: 'running',
        title: 'Starting private chat', message: 'Asking OA for a temporary key…', startedAt: 1, updatedAt: 2 }] };
    const withActivity = deriveZkapiUxState({ snapshot: accessing, now: SHAPES_NOW, version });
    const bare = deriveZkapiUxState({ snapshot: accessing, now: SHAPES_NOW });
    assert.deepEqual(withActivity.composerPrimary, bare.composerPrimary);
    assert.deepEqual(withActivity.primary, bare.primary);
    // The balance control still says what holds the balance.
    assert.equal(withActivity.balancePrimary.title, FROZEN_TITLE);

    // A handoff in progress is what the panel narrates; the composer, where a
    // withdrawal in motion outranks a quiet handoff, says why sending is blocked.
    const settling = deriveZkapiUxState({ snapshot: client, now: SHAPES_NOW, version, transition: { phase: 'settling' } });
    const preparedLike = deriveZkapiUxState({ snapshot: fundedSnapshot({ config: { prepared_withdrawal: { mode: 'escape' } } }),
        now: SHAPES_NOW, transition: { phase: 'settling' } });
    assert.equal(settling.primary.phase, 'closing');
    assert.equal(settling.panelPrimary.phase, 'closing');
    assert.equal(settling.composerPrimary.title, FROZEN_TITLE);
    assert.equal(preparedLike.composerPrimary.phase, 'withdrawal', 'the same rule a prepared withdrawal follows');
    // A handoff that failed owns the composer, as it does for any withdrawal.
    const error = deriveZkapiUxState({ snapshot: client, now: SHAPES_NOW, version, transition: { phase: 'error', message: 'Try again.' } });
    assert.equal(error.composerPrimary.phase, 'error');
    assert.equal(error.settlementAction, 'retry');
});

test('a frozen balance needs a balance: with none in the wallet the funding words stay', () => {
    const { client, state: version } = shapesVersion('mutual_lock_with_ownership_proof');
    const noBalance = { ...client, wallet: { has_note: false, note: null } };
    const loading = deriveZkapiUxState({ snapshot: { ...noBalance, loading: true }, now: SHAPES_NOW, version });
    assert.equal(loading.primary.phase, 'loading');
    assert.equal(loading.primary.title, 'Loading private balance');
    const unfunded = deriveZkapiUxState({ snapshot: noBalance, now: SHAPES_NOW, version });
    assert.equal(unfunded.primary.phase, 'unfunded');
    assert.equal(unfunded.primary.frozen, undefined);
    // Nor does a balance used on another device speak for one that is not there.
    const elsewhere = { ...version, exit: { ...version.exit, deviceNotNewest: true } };
    assert.equal(deriveZkapiUxState({ snapshot: noBalance, now: SHAPES_NOW, version: elsewhere }).primary.phase, 'unfunded');
    assert.equal(deriveZkapiUxState({ snapshot: { ...noBalance, loading: true }, now: SHAPES_NOW, version: elsewhere })
        .primary.phase, 'loading');
});

test('guided progress for a frozen balance names the three things that are true of it', () => {
    const { client, state: version } = shapesVersion('mutual_lock_with_ownership_proof');
    const state = deriveZkapiUxState({
        snapshot: { ...client, config: { ...client.config, ux_proposal: 'guided' } }, now: SHAPES_NOW, version
    });
    assert.deepEqual(state.journey.map(step => [step.id, step.label, step.state]), [
        ['started', 'Withdrawal started', 'complete'],
        ['frozen', 'Balance frozen', 'active'],
        ['resume', 'Chats resume', 'upcoming']
    ]);
    // Never the steps of a prepared withdrawal, which would say something to finish in MetaMask.
    assert.doesNotMatch(state.journey.map(step => step.label).join(' '), /MetaMask|prepared|proof/i);
});

test('every proposal says the same thing about a frozen balance and keeps its own name', () => {
    const { client, state: version } = shapesVersion('mutual_lock_with_ownership_proof');
    let reference = null;
    for (const proposal of ZKAPI_UX_PROPOSALS) {
        const snapshot = { ...client, config: { ...client.config, ux_proposal: proposal } };
        const state = deriveZkapiUxState({ snapshot, now: SHAPES_NOW, version });
        assert.equal(state.proposal, proposal);
        const copy = { title: state.primary.title, detail: state.primary.detail, compact: state.primary.compact };
        reference ??= copy;
        assert.deepEqual(copy, reference, proposal);
        assert.equal(state.composerPrimary.blocksSend, true, proposal);
        assert.equal(state.showComposer, true, proposal);
    }
});

test('a page whose helpers say nothing about a freeze is byte for byte what it was', () => {
    const scenarios = Object.values(SHAPES.scenarios).map(entry => entry.clientSnapshot);
    const snapshots = [
        ...scenarios,
        fundedSnapshot(),
        fundedSnapshot({ withdrawal: { phase: 'pending', challengeDeadline: 42 } }),
        fundedSnapshot({ config: { prepared_withdrawal: { mode: 'mutual' } } }),
        fundedSnapshot({ wallet: { has_note: false, note: null } })
    ];
    const absent = [undefined, null, 'frozen', 7, [], {}, { exit: null }, { exit: {} }, { exit: { frozen: null } },
        { exit: { frozen: false } }, { exit: { frozen: 'yes' } }, { exit: { frozen: [] } },
        // Used on another device is the dialog banner's to say; with no freeze
        // the panel, the composer and the balance control keep their words.
        { exit: { deviceNotNewest: true } }, { exit: { frozen: null, deviceNotNewest: true } }];
    for (const snapshot of snapshots) {
        const expected = JSON.stringify(deriveZkapiUxState({ snapshot, now: SHAPES_NOW }));
        for (const version of absent) {
            assert.equal(JSON.stringify(deriveZkapiUxState({ snapshot, now: SHAPES_NOW, version })), expected,
                JSON.stringify(version));
        }
    }
});

// ---------------------------------------------------------------------------
// A frozen balance another device or copy has since used
// ---------------------------------------------------------------------------
//
// The dialog's banner leaves its frozen notice out for such a balance (the
// sentence ends "You can still withdraw", and a withdrawal from this browser is
// rejected) and tells it the device sentence. The panel, the composer and the
// balance control follow it: the lock still holds chats, so sending stays
// blocked, and the words are the device words.

const usedElsewhere = client => {
    client.config.exit.device_not_newest = true;
    return client;
};
const DEVICE_LABEL = 'Used on another device';
const noticeIds = html => [...html.matchAll(/data-zkapi-version-notice="([^"]+)"/g)].map(match => match[1]);
const plainText = html => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

test('a frozen balance another device has used says that, never that it can still be withdrawn here', () => {
    const { client, state: version } = shapesVersion('mutual_lock_with_ownership_proof', { changes: usedElsewhere });
    assert.notEqual(version.exit.frozen, null, 'the lock still holds the balance');
    assert.equal(version.exit.deviceNotNewest, true);
    const detail = versionCopyText('exit.device', copyTokens(version, { now: SHAPES_NOW }));
    assert.equal(versionCopyText('exit.device.label'), DEVICE_LABEL);
    assert.match(detail, /can’t safely withdraw/);

    const state = deriveZkapiUxState({ snapshot: client, now: SHAPES_NOW, version });
    for (const key of ['primary', 'composerPrimary', 'balancePrimary', 'panelPrimary']) {
        const primary = state[key];
        // The phase stays a withdrawal's, so the status badge, the balance
        // control and the composer's hold glyph treat it as one.
        assert.equal(primary.phase, 'withdrawal', key);
        assert.equal(primary.tone, 'waiting', key);
        assert.equal(primary.frozen, true, key);
        assert.equal(primary.deviceNotNewest, true, key);
        assert.equal(primary.busy, false, key);
        assert.equal(primary.blocksSend, true, `${key}: the lock still holds chats`);
        assert.equal(primary.title, DEVICE_LABEL, key);
        assert.equal(primary.compact, DEVICE_LABEL, key);
        assert.equal(primary.detail, detail, key);
        assert.doesNotMatch(`${primary.title} ${primary.detail}`,
            /can still withdraw|New chats resume|Balance frozen|Withdrawal ready|Finish withdrawing|Ready to chat/, key);
    }
    assert.equal(state.showComposer, true, 'a chat that cannot start must be said where it is typed');
});

test('the panel and the dialog banner say the same thing of a frozen balance, used on another device or not', () => {
    const CAN_WITHDRAW = /can still withdraw/i;
    for (const [name, changes, device] of [['frozen', null, false], ['frozen, used on another device', usedElsewhere, true]]) {
        const { client, state: version } = shapesVersion('mutual_lock_with_ownership_proof', { changes });
        assert.equal(version.exit.deviceNotNewest, device, name);
        const banner = renderVersionBanner(version, { surface: 'dialog', now: SHAPES_NOW });
        const ids = noticeIds(banner);
        const ux = deriveZkapiUxState({ snapshot: client, now: SHAPES_NOW, version });
        const said = `${ux.primary.title} ${ux.primary.detail}`;
        // The banner tells the frozen notice, or the device notice, never both
        // and never the frozen notice for a balance that cannot be withdrawn here.
        assert.deepEqual(ids.filter(id => id === 'frozen' || id === 'device'), [device ? 'device' : 'frozen'], name);
        assert.equal(CAN_WITHDRAW.test(plainText(banner)), CAN_WITHDRAW.test(said), name);
        assert.equal(CAN_WITHDRAW.test(said), !device, name);
        // And the panel quotes the banner's own sentence.
        const sentence = versionCopyText(device ? 'exit.device' : 'exit.frozen', copyTokens(version, { now: SHAPES_NOW }));
        assert.equal(ux.primary.detail, sentence, name);
        assert.ok(plainText(banner).includes(sentence.slice(0, 40)), name);
    }
});

test('guided progress for a balance used on another device promises no resume and names no wallet step', () => {
    const { client, state: version } = shapesVersion('mutual_lock_with_ownership_proof', { changes: usedElsewhere });
    const state = deriveZkapiUxState({
        snapshot: { ...client, config: { ...client.config, ux_proposal: 'guided' } }, now: SHAPES_NOW, version
    });
    assert.deepEqual(state.journey.map(step => [step.id, step.label, step.state]), [
        ['used', DEVICE_LABEL, 'complete'],
        ['newest', 'Use the newest copy', 'active']
    ]);
    assert.doesNotMatch(state.journey.map(step => step.label).join(' '), /resume|MetaMask|prepared|proof|frozen/i);
    // The same balance that no other device has used keeps its three steps.
    const frozen = shapesVersion('mutual_lock_with_ownership_proof');
    const kept = deriveZkapiUxState({
        snapshot: { ...frozen.client, config: { ...frozen.client.config, ux_proposal: 'guided' } }, now: SHAPES_NOW, version: frozen.state
    });
    assert.deepEqual(kept.journey.map(step => step.label), ['Withdrawal started', 'Balance frozen', 'Chats resume']);
});

test('only a device flag that is exactly true changes the words of a frozen balance', () => {
    const { client, state: version } = shapesVersion('mutual_lock_with_ownership_proof');
    const frozenWords = deriveZkapiUxState({ snapshot: client, now: SHAPES_NOW, version });
    assert.equal(frozenWords.primary.title, FROZEN_TITLE);
    for (const flag of [false, null, undefined, 'true', 'yes', 1, {}, []]) {
        const given = { ...version, exit: { ...version.exit, deviceNotNewest: flag } };
        assert.deepEqual(deriveZkapiUxState({ snapshot: client, now: SHAPES_NOW, version: given }), frozenWords,
            JSON.stringify(flag) ?? 'undefined');
    }
});
