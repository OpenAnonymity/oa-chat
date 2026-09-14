import { motionDuration } from '../ui/uiMotion.js';
let initialized = false;

export function infoTooltipPosition(rect, width, height, viewport, alignRight = false) {
    const clampX = left => Math.max(12, Math.min(left, viewport.width - width - 12));
    return {
        left: clampX(alignRight ? rect.right - width : rect.left),
        top: rect.bottom + height + 8 <= viewport.height - 12
            ? rect.bottom + 8 : Math.max(12, rect.top - height - 8)
    };
}


/** Shared, portaled explanations for Settings info buttons and payment marks. */
export function setupInfoTooltips(settingsMenu) {
    if (initialized) return;
    initialized = true;
    const tooltip = document.createElement('div');
    tooltip.id = 'oa-info-tooltip';
    tooltip.className = 'info-tooltip t-tt';
    tooltip.setAttribute('role', 'tooltip');
    tooltip.hidden = true;
    document.body.appendChild(tooltip);
    let active = null;
    let pinned = false;
    let showTimer;
    let hideTimer;
    let previousDescription;
    let exitTimer;
    const trigger = target => target?.closest?.('[data-info-tooltip]');

    function hide() {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        if (active) {
            if (previousDescription) active.setAttribute('aria-describedby', previousDescription);
            else active.removeAttribute('aria-describedby');
            if (active.hasAttribute('data-info-toggle')) active.setAttribute('aria-expanded', 'false');
        }
        tooltip.dataset.show = 'false';
        clearTimeout(exitTimer);
        exitTimer = setTimeout(() => { tooltip.hidden = true; }, motionDuration(tooltip, '--tt-out-dur', 50));
        active = null;
        pinned = false;
    }

    function show(button) {
        clearTimeout(showTimer);
        clearTimeout(hideTimer);
        if (!button.isConnected || !button.getClientRects().length) return;
        if (active !== button) {
            hide();
            active = button;
            previousDescription = button.getAttribute('aria-describedby');
        }
        tooltip.textContent = button.dataset.infoTooltip;
        button.setAttribute('aria-describedby', [previousDescription, tooltip.id].filter(Boolean).join(' '));
        if (button.hasAttribute('data-info-toggle')) button.setAttribute('aria-expanded', 'true');
        clearTimeout(exitTimer);
        tooltip.hidden = false;
        void tooltip.offsetWidth;
        tooltip.dataset.show = 'true';
        // Payment labels open below the switch and extend left from its
        // right edge, keeping Share and the System Panel clear.
        const paymentControl = button.closest('.payment-mode-control');
        const rect = (paymentControl || button).getBoundingClientRect();
        const position = infoTooltipPosition(rect, tooltip.offsetWidth, tooltip.offsetHeight,
            { width: window.innerWidth, height: window.innerHeight }, Boolean(paymentControl));
        tooltip.style.left = `${position.left}px`;
        tooltip.style.top = `${position.top}px`;
    }

    document.addEventListener('mouseover', event => {
        const button = trigger(event.target);
        if (!button || button.contains(event.relatedTarget) || pinned) return;
        clearTimeout(hideTimer);
        clearTimeout(showTimer);
        showTimer = setTimeout(() => show(button), 160);
    });
    document.addEventListener('mouseout', event => {
        const button = trigger(event.target);
        if (!button || button.contains(event.relatedTarget)) return;
        clearTimeout(showTimer);
        if (!pinned && document.activeElement !== button) hideTimer = setTimeout(hide, 160);
    });
    document.addEventListener('focusin', event => {
        const button = trigger(event.target);
        if (button) show(button);
    });
    document.addEventListener('focusout', event => {
        if (trigger(event.target) && !pinned) hideTimer = setTimeout(hide, 100);
    });
    document.addEventListener('pointerdown', event => {
        if (!trigger(event.target) && !tooltip.contains(event.target)) hide();
    }, true);
    document.addEventListener('click', event => {
        const button = trigger(event.target);
        if (!button?.hasAttribute('data-info-toggle')) {
            // Payment buttons retain their normal action without pinning a tooltip.
            if (!tooltip.contains(event.target)) hide();
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        if (active === button && pinned) hide();
        else {
            show(button);
            pinned = true;
        }
    }, true);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && active) {
            hide();
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
    tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
    tooltip.addEventListener('mouseleave', () => {
        if (!pinned && document.activeElement !== active) hideTimer = setTimeout(hide, 160);
    });
    tooltip.addEventListener('click', event => event.stopPropagation());
    window.addEventListener('resize', hide);
    window.addEventListener('scroll', hide, true);
    if (settingsMenu) {
        new MutationObserver(() => {
            if (settingsMenu.classList.contains('hidden') && settingsMenu.contains(active)) hide();
        }).observe(settingsMenu, { attributes: true, attributeFilter: ['class'] });
    }
}
