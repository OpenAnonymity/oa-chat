/**
 * Custom share expiry: what the person typed, validated rather than repaired.
 * A share that expires sooner or later than asked is a silent surprise, so an
 * empty, zero, fractional or out-of-range value is an error to show, never a
 * default to substitute.
 */
export const SHARE_TTL_MIN_SECONDS = 60;            // 1 minute
export const SHARE_TTL_MAX_SECONDS = 30 * 86400;    // 30 days, the server-side ceiling
const UNIT_LABELS = { 60: 'minute', 3600: 'hour', 86400: 'day' };

function describe(seconds) {
    const days = seconds / 86400;
    if (days >= 1 && Number.isInteger(days)) return `${days} day${days === 1 ? '' : 's'}`;
    const hours = seconds / 3600;
    if (hours >= 1 && Number.isInteger(hours)) return `${hours} hour${hours === 1 ? '' : 's'}`;
    return `${Math.round(seconds / 60)} minute${seconds === 60 ? '' : 's'}`;
}

/**
 * @param {string|number} valueText - the number typed in the custom field
 * @param {string|number} unitSeconds - 60, 3600 or 86400
 * @returns {{ok: true, ttlSeconds: number}|{ok: false, message: string}}
 */
export function resolveCustomShareExpiry(valueText, unitSeconds) {
    const unit = Number(unitSeconds);
    const unitLabel = UNIT_LABELS[unit];
    if (!unitLabel) return { ok: false, message: 'Choose minutes, hours or days.' };
    const text = String(valueText ?? '').trim();
    if (!text) return { ok: false, message: `Enter how many ${unitLabel}s the share should last.` };
    const value = Number(text);
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
        return { ok: false, message: `Enter a whole number of ${unitLabel}s.` };
    }
    if (value < 1) return { ok: false, message: `The share must last at least 1 ${unitLabel}.` };
    const ttlSeconds = value * unit;
    if (ttlSeconds < SHARE_TTL_MIN_SECONDS) {
        return { ok: false, message: `The share must last at least ${describe(SHARE_TTL_MIN_SECONDS)}.` };
    }
    if (ttlSeconds > SHARE_TTL_MAX_SECONDS) {
        return { ok: false, message: `The share can last at most ${describe(SHARE_TTL_MAX_SECONDS)}. Choose Indefinite for no expiry.` };
    }
    return { ok: true, ttlSeconds };
}
