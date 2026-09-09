import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    deriveZkapiUxState,
    normalizeZkapiUxProposal
} from '../../chat/zkapi/services/zkapiUxState.mjs';

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
    assert.match(state.primary.detail, /keep typing/i);
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
    assert.match(pendingIndicator, /pending-response-dots/);
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
