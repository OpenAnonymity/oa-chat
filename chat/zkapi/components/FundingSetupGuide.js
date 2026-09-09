const LINK_CLASSES = 'underline underline-offset-2 hover:text-foreground';

export function fundingSetupGuide({ mainnet, demoMintEnabled, open = false }) {
    const prerequisites = mainnet
        ? '<strong>MetaMask</strong> installed, <strong>USDC</strong> to fund chats, and <strong>ETH</strong> to pay network fees (gas). Keep both tokens on <strong>Ethereum Mainnet</strong> in the same MetaMask account.'
        : demoMintEnabled
            ? '<strong>MetaMask</strong> installed and <strong>Sepolia ETH</strong> for testnet fees. Demo billing tokens are provided automatically when needed. No real ETH or USDC purchase is needed.'
            : 'Install MetaMask to get started. The payment network and token requirements will appear when the payment service connects.';
    const installStep = `<li><strong class="text-foreground">Install MetaMask.</strong> Get the browser extension from <a data-funding-setup-focus="install" class="${LINK_CLASSES}" href="https://metamask.io/download/" target="_blank" rel="noopener noreferrer">metamask.io</a>. Open it, create a wallet, and follow its backup instructions.</li>`;
    const steps = mainnet ? `
        ${installStep}
        <li><strong class="text-foreground">Buy ETH for fees.</strong> In MetaMask, choose <strong>Buy/Sell → Buy</strong> (this may open MetaMask Portfolio). Select your country, currency, <strong>ETH</strong>, and the <strong>Ethereum</strong> network. Enter an amount, choose an available card or bank payment method, review the quote, and complete any identity check. Keep ETH available for deposit and withdrawal fees; MetaMask shows the fee before you confirm.</li>
        <li><strong class="text-foreground">Buy USDC for chats.</strong> Repeat Buy with <strong>USDC</strong> on <strong>Ethereum</strong>. Buy enough to cover the balance you want to add here. Available tokens, payment methods, fees, and minimum purchases depend on your region and provider.</li>
        <li><strong class="text-foreground">Return here to fund.</strong> Once ETH and USDC appear in your wallet, enter your deposit amount below. Choose <strong>Continue with MetaMask</strong>, connect that same account, and follow the prompts to approve USDC and confirm the deposit.</li>` : demoMintEnabled ? `
        ${installStep}
        <li><strong class="text-foreground">Get free Sepolia ETH.</strong> Choose a faucet from <a data-funding-setup-focus="faucets" class="${LINK_CLASSES}" href="https://ethereum.org/en/developers/docs/networks/#sepolia" target="_blank" rel="noopener noreferrer">Ethereum’s Sepolia faucet list</a>. Copy your public MetaMask account address into the faucet and request test ETH.</li>
        <li><strong class="text-foreground">Return here to fund.</strong> Choose <strong>Continue with MetaMask</strong>, select Sepolia if prompted, and confirm the test-token and deposit steps. The app creates demo billing tokens if your wallet needs them.</li>` : installStep;
    return `<section data-funding-setup class="rounded-lg border border-border p-4 text-xs leading-relaxed text-muted-foreground">
        <p class="font-medium text-foreground">Before you fund</p>
        <p class="mt-1">${prerequisites}</p>
        <details data-funding-setup-details class="mt-3" ${open ? 'open' : ''}>
            <summary data-funding-setup-focus="summary" class="cursor-pointer rounded-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">${mainnet ? 'New to crypto? Set up your wallet' : 'Set up MetaMask for this app'}</summary>
            <ol class="mt-3 list-decimal space-y-3 pl-4">${steps}</ol>
            ${mainnet ? `<p class="mt-3"><a data-funding-setup-focus="buy-help" class="${LINK_CLASSES}" href="https://support.metamask.io/manage-crypto/move-crypto/buy/how-to-buy-crypto-in-metamask" target="_blank" rel="noopener noreferrer">MetaMask’s step-by-step buying guide ↗</a></p>` : ''}
        </details>
    </section>`;
}

// Background wallet refreshes rebuild the modal. Keep an open guide readable
// without losing the user's place or keyboard focus inside it.
export function captureFundingSetupView(root) {
    const details = root?.querySelector('[data-funding-setup-details]');
    if (!details) return null;
    const active = document.activeElement;
    return {
        open: details.open,
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
