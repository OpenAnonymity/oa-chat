import { fundingDisclosure } from './FundingDisclosures.js';

const LINK_CLASSES = 'underline underline-offset-2 hover:text-foreground';
const BUY_GUIDE = 'https://support.metamask.io/manage-crypto/move-crypto/buy/how-to-buy-crypto-in-metamask';
const buyLink = name => `<a data-funding-setup-focus="${name}" class="${LINK_CLASSES}" href="${BUY_GUIDE}" target="_blank" rel="noopener noreferrer">How to buy in MetaMask ↗</a>`;

export function fundingSetupGuide({ mainnet, demoMintEnabled, open = false, scope = 'account' }) {
    const installStep = `<li><strong class="zkapi-guide-step-title">Create your MetaMask wallet</strong><p>Install the browser extension, create a wallet, and follow its backup instructions.</p><a data-funding-setup-focus="install" class="${LINK_CLASSES}" href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">Install MetaMask ↗</a></li>`;
    const steps = mainnet ? `
        ${installStep}
        <li><strong class="zkapi-guide-step-title">Add USDC for your chats</strong><p>In MetaMask, choose <strong>Buy</strong>. Select <strong>USDC on Ethereum</strong> and add the amount you want to deposit.</p>${buyLink('buy-usdc')}</li>
        <li><strong class="zkapi-guide-step-title">Add ETH for network fees</strong><p>Buy ETH on the Ethereum network through the same MetaMask account you used to buy USDC. You will use this ETH to pay the network fees for deposits and withdrawals.</p>${buyLink('buy-eth')}</li>
        <li><strong class="zkapi-guide-step-title">Return here to add funds</strong><p>Once both tokens arrive, choose <strong>Continue with MetaMask</strong> here. Approve USDC and confirm the deposit in your wallet.</p></li>` : demoMintEnabled ? `
        ${installStep}
        <li><strong class="zkapi-guide-step-title">Get free Sepolia ETH</strong>Choose a faucet from <a data-funding-setup-focus="faucets" class="${LINK_CLASSES}" href="https://ethereum.org/en/developers/docs/networks/#sepolia" target="_blank" rel="noopener noreferrer">Ethereum’s Sepolia faucet list</a>. Copy your public MetaMask account address into the faucet and request test ETH.</li>
        <li><strong class="zkapi-guide-step-title">Return here to fund</strong>Choose <strong>Continue with MetaMask</strong>, select Sepolia if prompted, and confirm the test-token and deposit steps. The app creates demo billing tokens if your wallet needs them.</li>` : installStep;
    const intro = mainnet ? '' : demoMintEnabled
        ? '<p class="zkapi-guide-lead">Use Sepolia ETH for testnet fees. Demo billing tokens are provided automatically when needed. No real ETH or USDC purchase is needed.</p>'
        : '<p class="zkapi-guide-lead">The payment network and token requirements will appear when the payment service connects.</p>';
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
