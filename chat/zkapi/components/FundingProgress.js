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
    const receivedPercent = percent(ratio(available, recommended));
    const markerAlignment = requiredPosition > 800_000n ? 'end' : requiredPosition < 200_000n ? 'start' : 'middle';
    const requiredCovered = available >= required;
    const labels = ['Deposit', 'Network fee', 'Optional buffer'];
    const kinds = ['deposit', 'fee', 'buffer'];
    const portions = [deposit, fee, buffer];
    let allocated = 0n;
    const segments = portions.map((amount, index) => {
        if (amount === 0n) return '';
        const width = ratio(allocated + amount, recommended) - ratio(allocated, recommended);
        const received = available > allocated ? available - allocated : 0n;
        allocated += amount;
        // At narrow dialog widths, an 8% segment still fits a small numbered
        // key. Smaller portions retain their exact width and the visible legend.
        const key = width >= 80_000n ? `<span class="zkapi-funding-progress-segment-label">${index + 1}</span>` : '';
        return `<span class="zkapi-funding-progress-segment zkapi-funding-progress-${kinds[index]}" data-funding-part="${kinds[index]}" title="${labels[index]}" style="width:${percent(width)}%"><span class="zkapi-funding-progress-received" style="width:${percent(ratio(received, amount))}%"></span>${key}</span>`;
    }).join('');
    const legend = portions.map((amount, index) => `<div class="zkapi-funding-progress-item">
        <dt><span class="zkapi-funding-progress-key zkapi-funding-progress-${kinds[index]}" aria-hidden="true">${index + 1}</span><span>${labels[index]}${index === 1 ? '<small>Required allowance</small>' : ''}</span></dt>
        <dd>${renderAmount(amount.toString())}</dd>
    </div>`).join('');
    const progressText = `${ethText(available)} available. ${ethText(required)} required for the deposit and network fee. ${ethText(buffer)} optional buffer. ${requiredCovered ? 'Required amount covered.' : `${ethText(required - available)} still required.`}`;

    return `<section class="zkapi-funding-progress" data-funding-progress data-required-covered="${requiredCovered}" aria-label="Address funding">
        <div class="zkapi-funding-progress-available"><span>Available at this address</span><strong>${renderAmount(available.toString())}</strong></div>
        <div class="zkapi-funding-progress-chart" style="--funding-required-position:${percent(requiredPosition)}%">
            <div class="zkapi-funding-progress-track" role="progressbar" aria-label="Address funding received" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${receivedPercent}" aria-valuetext="${progressText}">
                <span class="zkapi-funding-progress-segments" aria-hidden="true">${segments}</span>
            </div>
            <span class="zkapi-funding-progress-required zkapi-funding-progress-required-${markerAlignment}" aria-hidden="true"><span>Required</span></span>
        </div>
        <p class="zkapi-funding-progress-caption">Filled areas show funds received.</p>
        <dl class="zkapi-funding-progress-legend">${legend}</dl>
        <dl class="zkapi-funding-progress-totals">
            <div><dt>Required total</dt><dd>${renderAmount(required.toString())}</dd></div>
            <div><dt>With optional buffer</dt><dd>${renderAmount(recommended.toString())}</dd></div>
        </dl>
        <p class="zkapi-funding-progress-note">The network fee is an allowance; the actual fee can be lower. The extra buffer is optional. Unused ETH stays here.</p>
    </section>`;
}
