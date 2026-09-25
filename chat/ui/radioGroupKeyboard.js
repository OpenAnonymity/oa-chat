/** Arrow-key selection reuses each segment's existing click handler. */
export function setupRadioGroupKeyboard(group) {
    if (!group) return;
    group.addEventListener('keydown', event => {
        if (event.altKey || event.ctrlKey || event.metaKey ||
            group.getAttribute('aria-disabled') === 'true') return;
        const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
        if (!keys.includes(event.key)) return;
        const buttons = [...group.querySelectorAll('[role="radio"]')]
            .filter(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true');
        const current = buttons.indexOf(event.target.closest('[role="radio"]'));
        if (current < 0) return;
        const direction = ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1;
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
            : (current + direction + buttons.length) % buttons.length;
        event.preventDefault();
        event.stopPropagation();
        buttons[index].focus();
        buttons[index].click();
    });
}
