import test from 'node:test';
import assert from 'node:assert/strict';
import jsQR from 'jsqr';
import { fundingPaymentUri, renderFundingPaymentQr } from '../../chat/zkapi/components/FundingPaymentQr.js';

const address = '0x2222222222222222222222222222222222222222';

// Rasterize the actual returned SVG modules for an independent decoder. This
// catches encoding, quiet-zone, SVG-coordinate and payload mistakes together.
function decodeSvg(html) {
    const size = Number(html.match(/viewBox="0 0 (\d+) \d+"/)[1]);
    const scale = 6;
    const width = size * scale;
    const pixels = new Uint8ClampedArray(width * width * 4).fill(255);
    const path = html.match(/<path d="([^"]+)"/)[1];
    for (const match of path.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
        const left = Number(match[1]) * scale;
        const top = Number(match[2]) * scale;
        for (let y = top; y < top + scale; y += 1) {
            for (let x = left; x < left + scale; x += 1) {
                const offset = (y * width + x) * 4;
                pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0;
            }
        }
    }
    return jsQR(pixels, width, width)?.data;
}

for (const [chainId, network] of [[1, 'Ethereum Mainnet'], [11155111, 'Ethereum Sepolia']]) {
    test(`payment QR decodes exact remaining wei and chain ${chainId}`, () => {
        const amountWei = '1500000000000001';
        const html = renderFundingPaymentQr({ address, chainId, amountWei, network });
        assert.equal(decodeSvg(html), `ethereum:${address}@${chainId}?value=${amountWei}`);
        assert.match(html, /Includes the ETH amount shown above/);
        assert.doesNotMatch(html, /<img|<script|href=|src=|data:/);
    });
}

test('invalid or fully funded payment instructions never produce a QR', () => {
    for (const values of [
        { amountWei: '0' }, { amountWei: '-1' }, { amountWei: '0.01' },
        { amountWei: '1e18' }, { amountWei: 123 }, { amountWei: String(2n ** 256n) },
        { chainId: 0 }, { chainId: '1' }, { chainId: 1.1 },
        { address: '0x0000000000000000000000000000000000000000' },
        { address: `${address}?value=1` }, { address: '<script>alert(1)</script>' }
    ]) {
        const props = { address, chainId: 1, amountWei: '1500000000000000', network: 'Ethereum Mainnet', ...values };
        assert.equal(fundingPaymentUri(props), null);
        assert.equal(renderFundingPaymentQr(props), '');
    }
});

test('updated transfer instructions replace the QR without a repetitive network caption', () => {
    const props = { address, chainId: 1, amountWei: '5500000000000000', network: '<svg onload="alert(1)">' };
    const initial = renderFundingPaymentQr(props);
    const updated = renderFundingPaymentQr({ ...props, amountWei: '1500000000000000' });
    assert.notEqual(decodeSvg(initial), decodeSvg(updated));
    assert.equal(decodeSvg(updated), `ethereum:${address}@1?value=1500000000000000`);
    assert.match(updated, /<figcaption>Scan to pay<span>/);
    assert.doesNotMatch(updated, /onload|Ethereum|Sepolia/);
    assert.doesNotMatch(updated, /<svg onload/);
});
