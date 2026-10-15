// Token amount text conversion owned by the host.
//
// This is a copy of parseTokenAmount from the legacy SDK's wallet.js
// (sdk/wallet.js, "function parseTokenAmount"). The revision 3 SDK removed it,
// so the host no longer imports it from the SDK package: the amount field
// parses the same way no matter which protocol version's SDK is loaded.
//
// Six decimals, matching the legacy token units. test/zkapi/token-amount.test.mjs
// pins parity with the installed SDK's export, including invalid input.

/** Parse a decimal string with at most six fraction digits into base units. */
export function parseTokenAmount(value) {
    const match = String(value).trim().match(/^(\d+)(?:\.(\d{0,6}))?$/);
    if (!match) throw new Error('Enter a positive amount with no more than six decimal places.');
    return BigInt(match[1]) * 1_000_000n + BigInt((match[2] || '').padEnd(6, '0') || '0');
}
