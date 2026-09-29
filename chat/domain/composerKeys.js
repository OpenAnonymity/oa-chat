/**
 * What a plain Enter should do given the composer state. While a response is
 * streaming, Enter stops it only when the person has typed something new.
 * An empty composer, or one still holding the text of the send in flight
 * (the composer is cleared only once the message is accepted), means the
 * Enter is a repeat of the one that just sent -- a double tap, key repeat,
 * or a habit -- and cancelling the request they just made is never what they
 * meant. Stop stays on the button and Escape.
 * @param {{streaming: boolean, draft: string|null|undefined, sendDisabled: boolean, pendingText?: string|null}} state
 * @returns {'send'|'stop'|'ignore'}
 */
export function enterKeyAction({ streaming, draft, sendDisabled, pendingText = null }) {
    if (sendDisabled) return 'ignore';
    const typed = String(draft || '').trim();
    const busy = streaming || pendingText !== null;
    if (!busy) return 'send';
    if (!typed) return 'ignore';
    if (pendingText !== null && typed === String(pendingText).trim()) return 'ignore';
    return 'stop';
}
