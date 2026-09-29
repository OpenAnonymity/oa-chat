import QRCode from 'qrcode';
import { getAddress } from 'ethers';

// EIP-681 includes the intended chain and the exact native transfer in wei.
// The caller supplies the remaining transfer, including fees and less any
// funds already at the address, rather than just the private-note principal.
export function fundingPaymentUri({ address, chainId, amountWei }) {
    if (!Number.isSafeInteger(chainId) || chainId <= 0
        || typeof amountWei !== 'string' || !/^[1-9]\d{0,77}$/.test(amountWei)
        || BigInt(amountWei) >= 2n ** 256n) return null;
    try {
        if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) return null;
        return `ethereum:${getAddress(address)}@${chainId}?value=${amountWei}`;
    } catch {
        return null;
    }
}

let lastQr = null;

function qrSvg(uri) {
    if (lastQr?.uri === uri) return lastQr.svg;
    const { modules } = QRCode.create(uri, { errorCorrectionLevel: 'M' });
    const quietZone = 4;
    const size = modules.size + quietZone * 2;
    const rectangles = [];
    for (let row = 0; row < modules.size; row += 1) {
        for (let column = 0; column < modules.size; column += 1) {
            if (modules.get(row, column)) rectangles.push(`M${column + quietZone} ${row + quietZone}h1v1h-1z`);
        }
    }
    // Only encoder-produced integer coordinates enter SVG markup. A white
    // quiet zone keeps this locally generated code scannable in either theme.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="192" height="192" role="img" aria-label="Payment QR code" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${rectangles.join('')}" fill="#000"/></svg>`;
    lastQr = { uri, svg };
    return svg;
}

export function renderFundingPaymentQr({ address, chainId, amountWei }) {
    const uri = fundingPaymentUri({ address, chainId, amountWei });
    if (!uri) return '';
    return `<figure class="zkapi-funding-qr" data-funding-payment-qr>
        ${qrSvg(uri)}
        <figcaption>Scan to pay</figcaption>
    </figure>`;
}
