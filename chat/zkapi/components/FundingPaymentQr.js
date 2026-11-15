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

// The ETH mark sits in the middle of the code, so the code uses the
// highest error-correction level (H, ~30% recoverable); M (~15%) is not
// enough headroom for a centre mark. The mark covers about 5% of the area.
const ETH_MARK = 'M6 .6 2.5 6.3 6 8.4l3.5-2.1L6 .6Zm0 8.5L2.5 7 6 11.4 9.5 7 6 9.1Z';

function qrSvg(uri) {
    if (lastQr?.uri === uri) return lastQr.svg;
    const { modules } = QRCode.create(uri, { errorCorrectionLevel: 'H' });
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
    const logo = Math.round(modules.size * 0.22) | 1;
    const start = (size - logo) / 2;
    const mark = logo * 0.62;
    const markAt = (size - mark) / 2;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="192" height="192" role="img" aria-label="Payment QR code" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${rectangles.join('')}" fill="#000"/><rect data-qr-logo x="${start}" y="${start}" width="${logo}" height="${logo}" rx="${logo * 0.24}" fill="#fff"/><path d="${ETH_MARK}" transform="translate(${markAt} ${markAt}) scale(${mark / 12})" fill="#1c1c28" shape-rendering="geometricPrecision"/></svg>`;
    lastQr = { uri, svg };
    return svg;
}

export function renderFundingPaymentQr({ address, chainId, amountWei, caption = true }) {
    const uri = fundingPaymentUri({ address, chainId, amountWei });
    if (!uri) return '';
    return `<figure class="zkapi-funding-qr" data-funding-payment-qr>
        ${qrSvg(uri)}
        ${caption ? '<figcaption>Scan with your phone’s wallet</figcaption>' : ''}
    </figure>`;
}
