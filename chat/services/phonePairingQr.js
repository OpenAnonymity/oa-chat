// The pairing QR as inline SVG. Error-correction level M: the code is only
// ever shown on a screen and scanned by a phone a foot away, and the line it
// carries (docs/PHONE_PAIRING.md: prefix, version, environment, tunnel id,
// secret, ephemeral key) must stay as small as possible so it scans fast.
// Select the browser entry explicitly: Node-bundled UI tests must not load
// the package's server renderer (fs/pngjs) for this client-only SVG helper.
import QRCode from 'qrcode/lib/browser.js';

export function pairingQrSvg(text, { size = 220 } = {}) {
    const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
    const quietZone = 4;
    const side = modules.size + quietZone * 2;
    const rectangles = [];
    for (let row = 0; row < modules.size; row += 1) {
        for (let column = 0; column < modules.size; column += 1) {
            if (modules.get(row, column)) rectangles.push(`M${column + quietZone} ${row + quietZone}h1v1h-1z`);
        }
    }
    // Only encoder-produced integer coordinates enter the markup; the text
    // itself never does, so nothing here needs escaping.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${size}" height="${size}" role="img" aria-label="OA pairing code" shape-rendering="crispEdges"><rect width="${side}" height="${side}" fill="#fff"/><path d="${rectangles.join('')}" fill="#000"/></svg>`;
    return svg;
}
