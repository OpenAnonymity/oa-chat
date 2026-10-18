// The "Network fee" choice of the withdrawal form: who pays the fee of the
// withdrawal, and what the person receives when it is paid from the
// withdrawal itself.
//
// Pure string renderer: no DOM, no storage, no clock, no facade, no SDK. The
// dialog hands it the state it holds (the choice, the quote and whether one is
// being fetched) and the money words, and writes the markup where the form
// has its place for it. The dialog reads the radio itself:
//
//   input[name="zkapi-sponsored-fee"]       value `wallet` or `payout`
//   [data-zkapi-sponsored-fieldset]         the fieldset
//   [data-zkapi-sponsored-detail]           the line under the choices
//   [data-zkapi-sponsored-retry]            "Check again" after a failed quote
//
// The words are calm and plain: "network fee", "relay service", "receiving
// address". The protocol's own names (paymaster, bundler, user operation,
// transit account) never appear. Units are tokens to the caller: amounts
// arrive already in the dialog's money words.
import { escapeHtml } from '../versioning/copy.mjs';
import { weiToEthText, weiToUnits } from '../versioning/sponsoredFees.mjs';

export const SPONSORED_FEE_WORDS = Object.freeze({
    legend: 'Network fee',
    walletTitle: 'Paid by your wallet',
    walletMetamask: 'Your wallet pays the network fee separately, in ETH.',
    walletAddress: 'The address this app holds for you pays the network fee, in ETH.',
    payoutTitle: 'Paid from this withdrawal',
    payoutHelp: 'No ETH is needed to pay the fee. It comes out of the withdrawal.',
    checking: 'Checking the network fee…',
    retry: 'Check again',
    closeEstimate: 'You’ll receive about {amount}, after an estimated network fee of {fee}. Estimates may change before signing.',
    closeEstimateFee: 'You’ll receive about {amount}, after an estimated network fee of {fee} and the service’s fee of {flat}. Estimates may change before signing.',
    escapeEstimate: 'The exit starts now and finishes after the safety wait, and its network fee comes out of the withdrawal then. At today’s fees you’d receive about {amount}.',
    escapeNoEstimate: 'The exit starts now and finishes after the safety wait, and its network fee comes out of the withdrawal then.',
    relay: 'To pay this way, the withdrawal goes through this app to the service’s relay, which sees it and the receiving address before it reaches the network. The account that signs it shows on the network as its owner.',
    contract: 'The receiving address is a contract. If it won’t accept a plain ETH payment, the payout is held for you to claim from Payment history.',
    pick: 'Choose how the network fee is paid.'
});

function fill(template, values) {
    return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? escapeHtml(values[key]) : ''));
}

// An amount of wei in the dialog's money words, with the ETH figure beside it.
function money(wei, format) {
    const eth = weiToEthText(wei);
    if (!eth) return '';
    const units = weiToUnits(wei);
    let text = '';
    try { text = typeof format === 'function' && units !== null ? String(format(units) ?? '').trim() : ''; } catch { text = ''; }
    const priced = text && !/^[—–-]+$/.test(text) && !/\bETH\b/.test(text);
    return priced ? `${text} (${eth} ETH)` : `${eth} ETH`;
}

/**
 * The markup of the fee choice. `state`:
 *   choice     'wallet' | 'payout'
 *   status     'idle' | 'loading' | 'ready' | 'unavailable'
 *   quote      the facade's normalized quote (ready or unavailable)
 *   method     'metamask' | 'address' (whose wallet pays otherwise)
 *   busy       work is running: the choices are disabled
 *   format     (units) => the dialog's money text for an amount in ledger units
 *   mode       'mutual' | 'escape' (what the withdrawal is)
 * Returns '' when there is nothing to choose (the caller decides that).
 */
export function renderSponsoredFee(state = {}) {
    const choice = state.choice === 'payout' ? 'payout' : 'wallet';
    const status = ['idle', 'loading', 'ready', 'unavailable'].includes(state.status) ? state.status : 'idle';
    const quote = state.quote && typeof state.quote === 'object' ? state.quote : null;
    const disabled = state.busy === true ? ' disabled' : '';
    const walletHelp = state.method === 'address' ? SPONSORED_FEE_WORDS.walletAddress : SPONSORED_FEE_WORDS.walletMetamask;
    // "Paid from this withdrawal" cannot be chosen while the quote says it is
    // not available: the person is told why and keeps the wallet.
    const payoutDisabled = state.busy === true || (choice === 'payout' && status === 'unavailable') ? ' disabled' : '';
    let detail = '';
    if (choice === 'payout') {
        if (status === 'idle' && state.locked) {
            detail = `<p class="zkapi-note">The network fee is paid from this withdrawal.</p>
                <button class="zkapi-quiet-button" type="button" data-zkapi-sponsored-retry${disabled}>Check fee again</button>`;
        } else if (status === 'loading' || status === 'idle') {
            detail = `<p class="zkapi-note" data-zkapi-sponsored-detail role="status">${escapeHtml(SPONSORED_FEE_WORDS.checking)}</p>`;
        } else if (status === 'unavailable') {
            detail = `<p class="zkapi-note zkapi-note--attention" data-zkapi-sponsored-detail>${escapeHtml(quote?.text || '')}</p>
                <button class="zkapi-quiet-button" type="button" data-zkapi-sponsored-retry${disabled}>${escapeHtml(SPONSORED_FEE_WORDS.retry)}</button>`;
        } else if (quote?.available === true) {
            const fee = money(quote.maxCostWei, state.format);
            const flat = BigInt(quote.flatFeeWei || '0') > 0n ? money(quote.flatFeeWei, state.format) : '';
            const credit = BigInt(quote.creditSurchargeWei || '0') > 0n ? money(quote.creditSurchargeWei, state.format) : '';
            let line;
            if (quote.mode === 'escape') {
                const estimate = quote.estimatedReceivedWei ? money(quote.estimatedReceivedWei, state.format) : '';
                line = estimate ? fill(SPONSORED_FEE_WORDS.escapeEstimate, { amount: estimate })
                    : SPONSORED_FEE_WORDS.escapeNoEstimate;
            } else {
                const estimate = money(quote.minimumReceivedWei, state.format);
                line = estimate
                    ? fill(flat ? SPONSORED_FEE_WORDS.closeEstimateFee : SPONSORED_FEE_WORDS.closeEstimate, { amount: estimate, fee, flat })
                    : '';
            }
            detail = `<div data-zkapi-sponsored-detail>
                ${line ? `<p class="zkapi-note">${line}</p>` : ''}
                ${credit ? `<p class="zkapi-helper">The estimate includes an additional fee of about ${escapeHtml(credit)} if the receiving contract requires the payout to be held.</p>` : ''}
                <p class="zkapi-helper">${escapeHtml(SPONSORED_FEE_WORDS.relay)}</p>
                ${quote.payoutHasCode ? `<p class="zkapi-helper">${escapeHtml(SPONSORED_FEE_WORDS.contract)}</p>` : ''}
            </div>`;
        }
    }
    return `<fieldset class="zkapi-section zkapi-choices" data-zkapi-sponsored-fieldset ${state.busy === true ? 'disabled' : ''}>
        <legend class="zkapi-section-title">${escapeHtml(SPONSORED_FEE_WORDS.legend)}</legend>
        ${state.locked ? '' : `<label class="zkapi-choice ${choice === 'wallet' ? 'selected' : ''}">
            <input type="radio" name="zkapi-sponsored-fee" value="wallet" ${choice === 'wallet' ? 'checked' : ''}${disabled} />
            <span><strong>${escapeHtml(SPONSORED_FEE_WORDS.walletTitle)}</strong><small>${escapeHtml(walletHelp)}</small></span>
        </label>`}
        <label class="zkapi-choice ${choice === 'payout' ? 'selected' : ''}">
            <input type="radio" name="zkapi-sponsored-fee" value="payout" ${choice === 'payout' ? 'checked' : ''}${state.locked ? ' disabled' : payoutDisabled} />
            <span><strong>${escapeHtml(SPONSORED_FEE_WORDS.payoutTitle)}</strong><small>${escapeHtml(SPONSORED_FEE_WORDS.payoutHelp)}</small></span>
        </label>
        ${detail}
    </fieldset>`;
}
