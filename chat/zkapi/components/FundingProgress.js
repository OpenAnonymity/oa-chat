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

/** Pure view: renderAmount receives canonical wei and returns trusted markup. */
export function renderFundingProgress({ availableWei, depositWei, requiredFeeWei, feeBufferWei = '0', renderAmount } = {}) {
    const amounts = [availableWei, depositWei, requiredFeeWei, feeBufferWei].map(unsignedWei);
    if (amounts.some(value => value === null) || typeof renderAmount !== 'function') return '';
    const [available, deposit, fee, buffer] = amounts;
    const required = deposit + fee;
    const recommended = required + buffer;
    if (recommended > MAX_WEI || required === 0n) return '';

    const requiredPosition = ratio(required, recommended);
    const fundedRatio = ratio(available, recommended);
    const receivedPercent = percent(fundedRatio);
    const displayedPercent = available > 0n && fundedRatio < 1_000n
        ? '&lt;0.1'
        : percent(fundedRatio / 1_000n * 1_000n);
    const requiredCovered = available >= required;
    const labels = ['Deposit', 'Network fee', 'Optional buffer'];
    const portions = [deposit, fee, buffer];
    const breakdown = portions.map((amount, index) => `<div class="zkapi-funding-progress-item">
        <dt>${labels[index]}${index === 1 ? '<small>Required allowance</small>' : ''}</dt>
        <dd>${renderAmount(amount.toString())}</dd>
    </div>`).join('');
    const progressText = `${ethText(available)} already at this address, including any ETH left from earlier deposits. ${ethText(required)} required for the deposit and network fee. ${ethText(buffer)} optional buffer. ${ethText(recommended)} total including buffer. ${requiredCovered ? 'Required amount covered.' : `${ethText(required - available)} still required.`}`;
    const optionalRange = buffer > 0n
        ? `<span class="zkapi-funding-progress-optional" style="left:${percent(requiredPosition)}%;width:${percent(PERCENT_SCALE - requiredPosition)}%" aria-hidden="true"></span>`
        : '';
    const optionalKey = buffer > 0n
        ? '<span><i class="zkapi-funding-progress-optional-key" aria-hidden="true"></i>Optional buffer</span>'
        : '';

    return `<section class="zkapi-funding-progress" data-funding-progress data-required-covered="${requiredCovered}" aria-label="Address funding">
        <div class="zkapi-funding-progress-available"><span>Already at this address</span><strong>${renderAmount(available.toString())}</strong></div>
        <p class="zkapi-funding-progress-percentage">${displayedPercent}% of total including buffer</p>
        <div class="zkapi-funding-progress-chart" style="--funding-required-position:${percent(requiredPosition)}%">
            <div class="zkapi-funding-progress-track" role="progressbar" aria-label="Address balance toward deposit funding" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${receivedPercent}" aria-valuetext="${progressText}">
                <span class="zkapi-funding-progress-received" style="width:${receivedPercent}%" aria-hidden="true"></span>
                ${optionalRange}
            </div>
            <span class="zkapi-funding-progress-required" aria-hidden="true"></span>
        </div>
        <div class="zkapi-funding-progress-chart-key" aria-hidden="true"><span><i class="zkapi-funding-progress-required-key"></i>Required total</span>${optionalKey}</div>
        <p class="zkapi-funding-progress-caption">Blue shows the current balance, including any ETH left from earlier deposits.</p>
        <dl class="zkapi-funding-progress-legend">${breakdown}</dl>
        <dl class="zkapi-funding-progress-totals">
            <div><dt>Required total</dt><dd>${renderAmount(required.toString())}</dd></div>
            <div><dt>Total including buffer</dt><dd>${renderAmount(recommended.toString())}</dd></div>
        </dl>
        <p class="zkapi-funding-progress-note">The network fee is an allowance; the actual fee can be lower. The extra buffer is optional. Unused ETH stays here.</p>
    </section>`;
}
