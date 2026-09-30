const MAX_WEI = (1n << 256n) - 1n;
const PERCENT_SCALE = 1_000_000n;

function unsignedWei(value) {
    if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,77})$/.test(value)) return null;
    const parsed = BigInt(value);
    return parsed <= MAX_WEI ? parsed : null;
}

// Percentages are display-only. Keep both money and ratios in integer space so
// a sub-gwei difference cannot change whether the required amount is covered.
function ratio(amount, total) {
    if (total === 0n) return 0n;
    return (amount < total ? amount : total) * PERCENT_SCALE / total;
}

function percent(value) {
    const whole = value / 10_000n;
    const fraction = (value % 10_000n).toString().padStart(4, '0').replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''}`;
}

function ethText(wei) {
    const whole = wei / 1_000_000_000_000_000_000n;
    const fraction = (wei % 1_000_000_000_000_000_000n).toString().padStart(18, '0').replace(/0+$/, '');
    return `${whole}${fraction ? `.${fraction}` : ''} ETH`;
}

/** Pure view: renderAmount receives canonical wei and returns trusted markup
 *  (a short value — the caller shows the exact amount to send). One thin bar
 *  for what has arrived, then the few numbers that make up the total. An
 *  unknown balance (availableWei null) leaves out the bar and the credit row
 *  rather than drawing it as empty. */
export function renderFundingProgress({ availableWei, depositWei, requiredFeeWei, feeBufferWei = '0', expectedFeeWei = null, renderAmount } = {}) {
    const balanceKnown = availableWei !== null;
    const amounts = [balanceKnown ? availableWei : '0', depositWei, requiredFeeWei, feeBufferWei].map(unsignedWei);
    if (amounts.some(value => value === null) || typeof renderAmount !== 'function') return '';
    const [available, deposit, fee, buffer] = amounts;
    const expected = expectedFeeWei == null ? null : unsignedWei(expectedFeeWei);
    const required = deposit + fee;
    const recommended = required + buffer;
    if (recommended > MAX_WEI || required === 0n) return '';

    const requiredPosition = ratio(required, recommended);
    const fundedRatio = ratio(available, recommended);
    const receivedPercent = percent(fundedRatio);
    const requiredCovered = balanceKnown && available >= required;
    // The exact story stays available to assistive technology.
    const progressText = `${ethText(available)} already at this address, including any ETH left from earlier deposits. ${ethText(required)} required for the deposit and network fee. ${ethText(buffer)} optional buffer. ${ethText(recommended)} total including buffer. ${requiredCovered ? 'Required amount covered.' : `${ethText(required - available)} still required.`}`;
    const optionalRange = buffer > 0n
        ? `<span class="zkapi-funding-progress-optional" style="left:${percent(requiredPosition)}%;width:${percent(PERCENT_SCALE - requiredPosition)}%" aria-hidden="true"></span>`
        : '';
    const chart = balanceKnown ? `<div class="zkapi-funding-progress-chart" style="--funding-required-position:${percent(requiredPosition)}%">
            <div class="zkapi-funding-progress-track" role="progressbar" aria-label="ETH at this address toward the deposit" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${receivedPercent}" aria-valuetext="${progressText}">
                <span class="zkapi-funding-progress-received" style="width:${receivedPercent}%" aria-hidden="true"></span>
                ${optionalRange}
            </div>
            <span class="zkapi-funding-progress-required" aria-hidden="true"></span>
        </div>` : '';
    const row = (label, value, note = '') => `<div><dt>${label}${note ? `<small>${note}</small>` : ''}</dt><dd>${value}</dd></div>`;
    return `<section class="zkapi-funding-progress" data-funding-progress data-required-covered="${requiredCovered}" aria-label="Address funding">
        ${chart}
        <dl class="zkapi-funding-costs">
            ${row('Deposit', renderAmount(deposit.toString()))}
            ${row('Network fee', renderAmount(fee.toString()), expected != null ? `about ${renderAmount(expected.toString())} expected` : '')}
            ${buffer > 0n ? row('Optional buffer', renderAmount(buffer.toString())) : ''}
            ${available > 0n ? row('Already at this address', `−${renderAmount(available.toString())}`) : ''}
        </dl>
    </section>`;
}
