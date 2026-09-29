// Activate and invoke in one synchronous turn: the SDK captures the provider
// when its async method starts. Never await between these two operations.
// A stopped/replaced view must not activate a signer after a stalled read.
export async function withWalletProviderRead(client, provider, read, {
    isCurrent = () => true, now = Date.now,
    wait = () => new Promise(resolve => setTimeout(resolve, 50))
} = {}) {
    const deadline = now() + 30_000;
    while (true) {
        if (!isCurrent()) throw Object.assign(new Error('This payment estimate is no longer needed.'), { code: 'address_quote_stopped' });
        try {
            client.setWalletProvider(provider);
        } catch (error) {
            if (error?.code !== 'wallet_provider_busy') throw error;
            if (now() >= deadline) throw new Error('The previous wallet check is still running. Try this estimate again shortly.');
            await wait();
            continue;
        }
        return read();
    }
}
