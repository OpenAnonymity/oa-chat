// Generic preparation presentation. Product-specific phase names, copy and
// progress calculations belong to the composition, not the chat renderer.
const expandedTraces = new Set();

function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[character]));
}

if (typeof window !== 'undefined') {
    window.rememberPendingSecurityTrace = details => {
        const id = details?.dataset?.pendingSecurityTraceId;
        if (!id) return;
        if (details.open) expandedTraces.add(id);
        else expandedTraces.delete(id);
    };
}

export function buildDetailedPendingIndicator(presentation, { phase, traceId = '' } = {}) {
    const showDetails = presentation.mode === 'security';
    const steps = Array.isArray(presentation.steps) ? presentation.steps : [];
    const stepHtml = steps.map((step, index) => {
        const state = ['active', 'waiting', 'complete', 'error', 'canceled', 'upcoming'].includes(step.state)
            ? step.state : 'upcoming';
        const stateLabel = state === 'active' ? 'current step' : state;
        return `<li class="pending-security-step" data-step-id="${escape(step.id)}" data-state="${state}" aria-label="${escape(step.label)}, ${stateLabel}" ${['active', 'waiting'].includes(state) ? 'aria-current="step"' : ''}>
            <span class="pending-security-step-marker" aria-hidden="true">${state === 'complete' ? '✓' : index + 1}</span>
            <span class="pending-security-step-label">${escape(step.label)}</span>
        </li>`;
    }).join('');
    return `<div class="pending-response-line" data-phase="${escape(phase)}" data-progress-phase="${escape(presentation.progressPhase)}">
        <span class="pending-response-announcement sr-only" role="status" aria-live="polite" aria-atomic="true">${escape(presentation.description)}</span>
        <details class="pending-security-trace${showDetails ? '' : ' hidden'}" ${traceId ? `data-pending-security-trace-id="${escape(traceId)}" ontoggle="window.rememberPendingSecurityTrace?.(this)"` : ''}${expandedTraces.has(traceId) ? ' open' : ''}>
            <summary class="pending-security-summary" aria-label="${escape(presentation.description)}">
                <svg class="pending-security-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m9 5 .8 2.9a4.5 4.5 0 0 0 3.1 3.1L16 12l-3.1.8a4.5 4.5 0 0 0-3.1 3.1L9 19l-.8-3.1a4.5 4.5 0 0 0-3.1-3.1L2 12l3.1-.8a4.5 4.5 0 0 0 3.1-3.1L9 5Zm9-3 .5 2L21 5l-2.5 1-.5 2-.5-2L15 5l2.5-1 .5-2Z"/></svg>
                <span class="pending-response-label pending-response-streaming">${escape(presentation.current)}</span>
                <svg class="pending-security-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m5.5 6.5 2.5 2.5 2.5-2.5" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5"/></svg>
            </summary>
            <div class="pending-security-content">
                <strong class="pending-security-category">${escape(presentation.category || 'Preparing access')}</strong>
                <ol class="pending-security-steps" aria-label="Preparation progress">${stepHtml}</ol>
                <p class="pending-security-note">${escape(presentation.note)}</p>
            </div>
        </details>
        <div class="pending-response-simple${showDetails ? ' hidden' : ''}">
            <span class="pending-response-dots" aria-hidden="true"><i></i><i></i><i></i></span>
            <span class="pending-response-label pending-response-streaming">${escape(presentation.current)}</span>
        </div>
    </div>`;
}

export function updateDetailedPendingIndicator(indicator, presentation, phase) {
    if (!indicator || !presentation) return false;
    const steps = Array.isArray(presentation.steps) ? presentation.steps : [];
    const signature = JSON.stringify([phase, presentation.current, presentation.description,
        presentation.mode, presentation.kind, presentation.progressPhase, presentation.category,
        presentation.note, steps.map(step => [step.id, step.label, step.state])]);
    if (indicator.dataset.pendingPresentationSignature === signature) return true;
    indicator.dataset.pendingPresentationSignature = signature;
    indicator.dataset.phase = phase;

    const setText = (parent, selector, value) => {
        const element = parent?.querySelector(selector);
        if (element && element.textContent !== String(value || '')) element.textContent = value || '';
    };
    const line = indicator.querySelector('.pending-response-line');
    line?.setAttribute('data-phase', phase);
    line?.setAttribute('data-progress-phase', presentation.progressPhase || phase);
    setText(line, '.pending-response-announcement', presentation.description);
    const trace = indicator.querySelector('.pending-security-trace');
    const simple = indicator.querySelector('.pending-response-simple');
    const showDetails = presentation.mode === 'security';
    trace?.classList.toggle('hidden', !showDetails);
    simple?.classList.toggle('hidden', showDetails);
    setText(trace, '.pending-response-label', presentation.current);
    setText(simple, '.pending-response-label', presentation.current);
    trace?.querySelector('.pending-security-summary')?.setAttribute('aria-label', presentation.description || '');
    setText(trace, '.pending-security-category', presentation.category);
    setText(trace, '.pending-security-note', presentation.note);

    const list = trace?.querySelector('.pending-security-steps');
    if (list) {
        // Keyed steps keep disclosure focus and the active shimmer alive while
        // progress changes; clock-only updates are complete no-ops above.
        const oldRows = new Map([...list.children].map(row => [row.dataset.stepId, row]));
        const retained = new Set();
        steps.forEach((step, index) => {
            const key = String(step.id ?? index);
            let row = oldRows.get(key);
            if (!row) {
                row = document.createElement('li');
                row.className = 'pending-security-step';
                row.dataset.stepId = key;
                const marker = document.createElement('span');
                marker.className = 'pending-security-step-marker';
                marker.setAttribute('aria-hidden', 'true');
                const label = document.createElement('span');
                label.className = 'pending-security-step-label';
                row.append(marker, label);
            }
            retained.add(row);
            if (list.children[index] !== row) list.insertBefore(row, list.children[index] || null);
            row.dataset.state = step.state;
            const stateLabel = step.state === 'active' ? 'current step' : step.state;
            row.setAttribute('aria-label', `${step.label}, ${stateLabel}`);
            if (['active', 'waiting'].includes(step.state)) row.setAttribute('aria-current', 'step');
            else row.removeAttribute('aria-current');
            setText(row, '.pending-security-step-marker', step.state === 'complete' ? '✓' : index + 1);
            setText(row, '.pending-security-step-label', step.label);
        });
        [...list.children].forEach(row => { if (!retained.has(row)) row.remove(); });
    }
    return true;
}
