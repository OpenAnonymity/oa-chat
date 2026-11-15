// On phones the keyboard belongs to the user: async completion and startup
// must not reopen it. Explicit taps/keyboard shortcuts keep their own focus.
export function isPhoneComposer(input) {
    return (input?.ownerDocument?.defaultView?.innerWidth ?? Infinity) < 768;
}

export function dismissSubmittedPhoneKeyboard(input) {
    if (isPhoneComposer(input) && input.ownerDocument.activeElement === input && !input.value) input.blur();
}

// Reserve a readable start of the reply below a photo or multi-line prompt.
// Desktop retains its existing quarter-viewport anchor.
export function promptReadingOffset({ phone, areaHeight, visibleHeight, promptHeight }) {
    if (!phone) return Math.round(areaHeight * 0.25);
    // A tall photo may need to scroll partly above the viewport. Clamping to
    // a positive offset would hide the entire reply behind the composer.
    return Math.min(Math.round(visibleHeight * 0.25), visibleHeight - promptHeight - 128);
}
