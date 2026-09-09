import zkapiClient from '@openanonymity/zkapi-browser-sdk/client';
import { deriveZkapiUxState } from '../services/zkapiUxState.mjs';

function escapeFallback(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

export function getZkapiExperience(app, sessionId = app?.state?.currentSessionId) {
    const state = deriveZkapiUxState({
        snapshot: zkapiClient.snapshot(),
        transition: app?.integration?.getTransition?.() || app?.newChatSettlementState || null,
        sessionId
    });
    if (typeof document !== 'undefined') {
        document.documentElement.dataset.zkapiUxProposal = state.proposal;
    }
    return state;
}

function stateGlyph(primary) {
    if (primary.tone === 'working') {
        return '<span class="zkapi-state-spinner" aria-hidden="true"></span>';
    }
    if (primary.tone === 'waiting') {
        return '<span class="zkapi-state-glyph zkapi-state-glyph--waiting" aria-hidden="true"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.75v3.5l2.25 1.35" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.4"/></svg></span>';
    }
    if (primary.tone === 'error') {
        return '<span class="zkapi-state-glyph zkapi-state-glyph--error" aria-hidden="true">!</span>';
    }
    if (primary.tone === 'success') {
        return '<span class="zkapi-state-glyph zkapi-state-glyph--success" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m3.25 8.25 3 3 6.5-6.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.6"/></svg></span>';
    }
    return '<span class="zkapi-state-glyph" aria-hidden="true"></span>';
}

function renderJourney(state, escapeHtml = escapeFallback, compact = false) {
    return `
        <ol class="zkapi-journey ${compact ? 'zkapi-journey--compact' : ''}" aria-label="Private chat progress">
            ${state.journey.map((step, index) => `
                <li class="zkapi-journey-step" data-state="${step.state}" ${step.state === 'active' ? 'aria-current="step"' : ''}>
                    <span class="zkapi-journey-marker" aria-hidden="true">${step.state === 'complete' ? '✓' : index + 1}</span>
                    <span class="zkapi-journey-label">${escapeHtml(step.label)}</span>
                </li>`).join('')}
        </ol>`;
}

function activityStatus(activity) {
    if (activity.status === 'success') return 'Done';
    if (activity.status === 'error') return 'Needs attention';
    if (activity.status === 'canceled') return 'Canceled';
    return 'In progress';
}

function renderActivityRows(state, escapeHtml = escapeFallback, limit = 4) {
    const rows = state.activities.slice(-limit).reverse();
    if (!rows.length) {
        return '<p class="zkapi-activity-empty">Private balance activity will appear here.</p>';
    }
    return `<ul class="zkapi-activity-list">${rows.map(activity => `
        <li class="zkapi-activity-row" data-status="${activity.status}">
            <span class="zkapi-activity-indicator" aria-hidden="true"></span>
            <span class="zkapi-activity-copy">
                <strong>${escapeHtml(activity.title || 'Private balance')}</strong>
                <small>${escapeHtml(activity.error || activity.message || activityStatus(activity))}</small>
            </span>
            <span class="zkapi-activity-state">${activityStatus(activity)}</span>
        </li>`).join('')}</ul>`;
}

function visualStateLabel(primary) {
    if (primary.tone === 'error') return 'Needs attention';
    if (primary.phase === 'queued') return 'Queued';
    if (primary.phase === 'closing') return 'Finishing';
    if (primary.activity?.kind === 'access'
        && (primary.phase === 'waiting'
            || /\b(?:retry|limiting|unavailable|busy)\b/i.test(primary.detail || ''))) return 'Retrying';
    if (primary.activity?.kind === 'access') return 'Securing';
    if (primary.busy) return 'Working';
    if (primary.tone === 'success') return 'Ready';
    return primary.compact;
}

function renderLowTextLiveStatus(primary) {
    return `<span class="sr-only zkapi-composer-live-status" role="status" aria-live="polite" aria-atomic="true">${escapeFallback(primary.title)}. ${escapeFallback(primary.detail)}</span>`;
}

function disclosureChevron() {
    return '<svg class="zkapi-disclosure-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m5.5 6.5 2.5 2.5 2.5-2.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/></svg>';
}

function isPassiveLowTextState(primary) {
    return ['unfunded', 'loading', 'ready', 'chat-ready'].includes(primary?.phase)
        && primary?.tone !== 'error';
}

function capsuleEndpoints(primary) {
    const phase = primary?.phase || '';
    if (primary?.tone === 'error' || phase === 'error' || phase === 'canceled') {
        return {
            origin: '<span class="zkapi-capsule-origin zkapi-capsule-origin--neutral" aria-hidden="true"><i></i></span>',
            end: '<span class="zkapi-capsule-end zkapi-capsule-end--error" aria-hidden="true">×</span>'
        };
    }
    if (primary?.tone === 'waiting' || ['waiting', 'withdrawal', 'escape-wait'].includes(phase)) {
        return {
            origin: '<span class="zkapi-capsule-origin zkapi-capsule-origin--neutral" aria-hidden="true"><i></i></span>',
            end: '<span class="zkapi-capsule-end zkapi-capsule-end--hold" aria-hidden="true">Ⅱ</span>'
        };
    }
    if (phase === 'closing') {
        return {
            origin: '<span class="zkapi-capsule-origin zkapi-capsule-origin--neutral" aria-hidden="true"><i></i></span>',
            end: '<span class="zkapi-capsule-end zkapi-capsule-end--closing" aria-hidden="true">…</span>'
        };
    }
    return {
        origin: '<span class="zkapi-capsule-check" aria-hidden="true">✓</span>',
        end: '<span class="zkapi-capsule-arrow" aria-hidden="true">→</span>'
    };
}

function renderLowTextPanel(state, escapeHtml = escapeFallback) {
    const primary = state.panelPrimary || state.primary;
    if (isPassiveLowTextState(primary) || (!state.showComposer && primary.tone !== 'error')) return '';
    return `
        <details class="zkapi-panel-experience zkapi-panel-experience--disclosure" data-tone="${escapeHtml(primary.tone)}">
            <summary>
                ${stateGlyph(primary)}
                <span>${escapeHtml(visualStateLabel(primary))}</span>
                ${disclosureChevron()}
            </summary>
            <div class="zkapi-panel-disclosure-body">
                <strong>${escapeHtml(primary.title)}</strong>
                <p>${escapeHtml(primary.detail)}</p>
                ${renderActivityRows(state, escapeHtml, 3)}
            </div>
        </details>`;
}

export function renderZkapiPanelExperience(state, escapeHtml = escapeFallback) {
    const primary = state.panelPrimary || state.primary;
    const { proposal } = state;
    if (['receipt', 'relay', 'ambient', 'capsule'].includes(proposal)) {
        return renderLowTextPanel(state, escapeHtml);
    }
    if (proposal === 'guided') {
        return `
            <section class="zkapi-panel-experience zkapi-panel-experience--guided" aria-label="Private chat status">
                <div class="zkapi-panel-state-heading">
                    ${stateGlyph(primary)}
                    <div><strong>${escapeHtml(primary.title)}</strong><p>${escapeHtml(primary.detail)}</p></div>
                </div>
                ${renderJourney(state, escapeHtml)}
            </section>`;
    }
    if (proposal === 'activity') {
        return `
            <section class="zkapi-panel-experience zkapi-panel-experience--activity" aria-label="Private balance activity">
                <div class="zkapi-panel-state-heading">
                    ${stateGlyph(primary)}
                    <div><strong>Private activity</strong><p>${escapeHtml(primary.compact)}</p></div>
                    ${state.runningActivities.length ? `<span class="zkapi-running-count">${state.runningActivities.length} active</span>` : ''}
                </div>
                ${renderActivityRows(state, escapeHtml)}
            </section>`;
    }
    if (!state.showComposer && primary.tone !== 'error') return '';
    return `
        <section class="zkapi-panel-experience zkapi-panel-experience--quiet" aria-label="Private chat status">
            <div class="zkapi-panel-state-heading">
                ${stateGlyph(primary)}
                <div><strong>${escapeHtml(primary.title)}</strong><p>${escapeHtml(primary.detail)}</p></div>
            </div>
        </section>`;
}

function showActivityPanel(app) {
    const panel = app?.rightPanel;
    if (!panel) return;
    panel.zkapiDisclosureOpen = true;
    panel.show?.();
    panel.loadSessionData?.();
    requestAnimationFrame(() => {
        const disclosure = document.querySelector('#right-panel .zkapi-panel-experience--disclosure');
        if (!disclosure) return;
        disclosure.open = true;
        const summary = disclosure.querySelector('summary');
        summary?.focus?.({ preventScroll: true });
        summary?.scrollIntoView?.({ block: 'nearest' });
    });
}

// Private-access work narrates itself in words over the chat bar: the app
// toast, held while the step runs and replaced by the next step, the way
// wallet steps in the balance dialog do. The composer keeps its quiet glyph.
const PHASE_TOAST_MS = 120000;
let phaseToastText = null;
function mirrorPhaseToast(app, ...candidates) {
    // Whichever surface is busy speaks: the composer's private-access step,
    // or wallet work (a deposit, a withdrawal) that only the balance knows.
    const primary = candidates.find(entry => entry?.busy === true && entry?.tone !== 'error') || null;
    // With the balance dialog open its own status row narrates; the toast
    // would say the same thing twice.
    const dialog = typeof document !== 'undefined' ? document.getElementById?.('payment-balance-modal') : null;
    const dialogOpen = Boolean(dialog && !dialog.classList?.contains?.('hidden'));
    const text = primary && !dialogOpen ? String(primary.compact || '').trim() : '';
    if (text) {
        if (text === phaseToastText) return;
        phaseToastText = text;
        app?.showToast?.(text, 'info', PHASE_TOAST_MS);
        return;
    }
    if (!phaseToastText) return;
    const current = typeof document !== 'undefined' ? document.getElementById?.('app-toast') : null;
    // Only our own toast is taken down; a result toast that replaced it stays.
    if (current && current.textContent === phaseToastText) app?.clearToast?.();
    phaseToastText = null;
}

export function renderZkapiComposerStatus(element, app, stateOverride = null) {
    if (!element) return;
    const state = stateOverride || getZkapiExperience(app);
    const primary = state.composerPrimary || state.primary;
    const { proposal } = state;
    mirrorPhaseToast(app, primary, state.balancePrimary || state.primary);
    if (['receipt', 'relay', 'ambient', 'capsule'].includes(proposal)
        && isPassiveLowTextState(primary)) {
        element.className = 'hidden';
        element.innerHTML = '';
        delete element.dataset.zkapiStateSignature;
        element.removeAttribute('aria-busy');
        return;
    }
    if (!state.showComposer) {
        element.className = 'hidden';
        element.innerHTML = '';
        delete element.dataset.zkapiStateSignature;
        element.removeAttribute('aria-busy');
        return;
    }

    const visualSignature = JSON.stringify([
        proposal,
        primary.phase,
        primary.tone,
        primary.busy,
        primary.title,
        primary.detail,
        primary.compact,
        visualStateLabel(primary),
        proposal === 'guided'
            ? state.journey.map(step => [step.id, step.label, step.state])
            : null
    ]);
    // Assigning identical innerHTML still destroys and recreates descendants,
    // restarting spinners, orbits, and entrance animations. Every proposal can
    // safely retain its DOM while its complete rendered state is unchanged.
    if (element.dataset.zkapiStateSignature === visualSignature) {
        return;
    }
    element.dataset.zkapiStateSignature = visualSignature;

    element.className = `zkapi-composer-state zkapi-composer-state--${proposal}`;
    element.dataset.tone = primary.tone;
    element.dataset.phase = primary.phase;
    element.setAttribute('aria-busy', primary.busy ? 'true' : 'false');
    if (proposal === 'receipt') {
        element.innerHTML = `
            <button type="button" class="zkapi-composer-relay zkapi-composer-receipt" data-zkapi-open-activity aria-label="${escapeFallback(visualStateLabel(primary))}. Open details">
                ${stateGlyph(primary)}
                <span>${escapeFallback(visualStateLabel(primary))}</span>
            </button>
            ${renderLowTextLiveStatus(primary)}`;
        element.querySelector('[data-zkapi-open-activity]')?.addEventListener('click', () => showActivityPanel(app));
    } else if (proposal === 'relay') {
        element.innerHTML = `
            <button type="button" class="zkapi-composer-relay" data-zkapi-open-activity aria-label="${escapeFallback(visualStateLabel(primary))}. Open details">
                ${stateGlyph(primary)}
                <span>${escapeFallback(visualStateLabel(primary))}</span>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9m-3-3 3 3-3 3" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.4"/></svg>
            </button>
            ${renderLowTextLiveStatus(primary)}`;
        element.querySelector('[data-zkapi-open-activity]')?.addEventListener('click', () => showActivityPanel(app));
    } else if (proposal === 'ambient') {
        element.innerHTML = `
            <button type="button" class="zkapi-composer-ambient-button" data-zkapi-open-activity aria-label="${escapeFallback(visualStateLabel(primary))}. Open details">
                ${stateGlyph(primary)}
            </button>
            ${renderLowTextLiveStatus(primary)}`;
        element.querySelector('[data-zkapi-open-activity]')?.addEventListener('click', () => showActivityPanel(app));
    } else if (proposal === 'capsule') {
        const endpoints = capsuleEndpoints(primary);
        element.innerHTML = `
            <button type="button" class="zkapi-composer-capsule" data-zkapi-open-activity aria-label="${escapeFallback(visualStateLabel(primary))}. Open details">
                ${endpoints.origin}
                ${stateGlyph(primary)}
                ${endpoints.end}
            </button>
            ${renderLowTextLiveStatus(primary)}`;
        element.querySelector('[data-zkapi-open-activity]')?.addEventListener('click', () => showActivityPanel(app));
    } else if (proposal === 'guided') {
        element.innerHTML = `
            <div class="zkapi-composer-guided-heading">
                ${stateGlyph(primary)}
                <span><strong>${escapeFallback(primary.title)}</strong><small>${escapeFallback(primary.detail)}</small></span>
            </div>
            ${renderJourney(state, escapeFallback, true)}`;
    } else if (proposal === 'activity') {
        element.innerHTML = `
            <div class="zkapi-composer-inline">
                ${stateGlyph(primary)}
                <span class="zkapi-composer-copy"><strong>${escapeFallback(primary.compact)}</strong><small>${escapeFallback(primary.detail)}</small></span>
                <button type="button" data-zkapi-open-activity>View activity</button>
            </div>`;
        element.querySelector('[data-zkapi-open-activity]')?.addEventListener('click', () => showActivityPanel(app));
    } else {
        element.innerHTML = `
            <div class="zkapi-composer-inline">
                ${stateGlyph(primary)}
                <span class="zkapi-composer-copy"><strong>${escapeFallback(primary.compact)}</strong><small>${escapeFallback(primary.detail)}</small></span>
            </div>`;
    }
}

export function updateZkapiBalanceControl(button, app) {
    if (!button) return;
    const state = getZkapiExperience(app);
    const primary = state.balancePrimary || state.primary;
    const { note } = state;
    const label = button.querySelector('[data-private-balance-label]');
    let status = note ? 'logged-in' : 'none';
    let text = note ? zkapiClient.formatMoney(note.current_balance) : 'Private balance';
    if (primary.tone === 'working') {
        status = 'busy';
    } else if (primary.tone === 'error') {
        status = 'attention';
    } else if (primary.phase === 'escape-wait' || primary.phase === 'withdrawal') {
        status = 'waiting';
    }
    button.dataset.status = status;
    button.dataset.phase = primary.phase;
    button.dataset.zkapiUxProposal = state.proposal;
    button.title = `${primary.title}. ${primary.detail}`;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-busy', primary.busy ? 'true' : 'false');
    if (label) label.textContent = text;
}
