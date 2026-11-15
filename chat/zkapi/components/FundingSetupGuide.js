import { fundingDisclosure } from './FundingDisclosures.js';

const LINK_CLASSES = 'underline underline-offset-2 hover:text-foreground';
const BUY_GUIDE = 'https://support.metamask.io/manage-crypto/move-crypto/buy/how-to-buy-crypto-in-metamask';
const buyLink = name => `<a data-funding-setup-focus="${name}" class="${LINK_CLASSES}" href="${BUY_GUIDE}" target="_blank" rel="noopener noreferrer">How to buy in MetaMask ↗</a>`;

export function fundingSetupGuide({ mainnet, open = false, scope = 'account' }) {
    const installStep = `<li><strong class="zkapi-guide-step-title">Create your MetaMask wallet</strong><p>Install the browser extension, create a wallet, and follow its backup instructions. <a data-funding-setup-focus="install" class="${LINK_CLASSES}" href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">Install MetaMask ↗</a></p></li>`;
    const steps = `
        ${installStep}
        ${mainnet ? `<li><strong class="zkapi-guide-step-title">Add ETH to MetaMask</strong><p>Buy ETH on Ethereum for the amount you want to deposit, plus network fees. ${buyLink('buy-eth')}</p></li>` : `<li><strong class="zkapi-guide-step-title">Get Sepolia ETH</strong><p>Use a faucet from <a data-funding-setup-focus="faucets" class="${LINK_CLASSES}" href="https://ethereum.org/en/developers/docs/networks/#sepolia" target="_blank" rel="noopener noreferrer">Ethereum’s Sepolia faucet list</a> with your MetaMask address.</p></li>`}
        <li><strong class="zkapi-guide-step-title">Return here to add funds</strong><p>Enter the amount in USD and choose <strong>Continue with MetaMask</strong>. Confirm the ETH deposit and network fee in your wallet.</p></li>`;
    const intro = '<p class="zkapi-guide-lead">Your wallet holds ETH. The displayed USD value changes with its price.</p>';
    return fundingDisclosure({ key: 'setup', id: `zkapi-${scope}-setup`, open,
        label: mainnet ? 'Set up your wallet' : 'Set up MetaMask for this app',
        attributes: 'data-funding-setup data-funding-setup-details',
        triggerAttributes: 'data-funding-setup-focus="summary"',
        body: `${intro}<ol class="zkapi-guide-steps">${steps}</ol>`
    });
}

// Background wallet refreshes rebuild the modal. Keep an open guide readable
// without losing the user's place or keyboard focus inside it.
export function captureFundingSetupView(root) {
    const details = root?.querySelector('[data-funding-setup-details]');
    if (!details) return null;
    const active = document.activeElement;
    return {
        open: details.dataset.open === 'true',
        focus: details.contains(active) ? active?.dataset?.fundingSetupFocus : null,
        scrollTop: root.querySelector('[data-funding-scroll]')?.scrollTop || 0
    };
}

export function restoreFundingSetupView(root, view) {
    if (!view || !root.querySelector('[data-funding-setup-details]')) return;
    if (view.focus) root.querySelector(`[data-funding-setup-focus="${view.focus}"]`)?.focus({ preventScroll: true });
    const scroller = root.querySelector('[data-funding-scroll]');
    if (scroller) scroller.scrollTop = view.scrollTop;
}
