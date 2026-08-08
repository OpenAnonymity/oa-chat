export function getLocalCreditLimitedMaxOutputTokens(session) {
    const info = session?.apiKeyInfo;
    const isVerified = info?.verifierSubmitKeyProof?.status === 'verified';
    const creditLimit = Number(info?.creditLimit ?? info?.credit_limit);
    if (!isVerified || !Number.isFinite(creditLimit) || creditLimit > 0.05) {
        return undefined;
    }
    // OpenRouter may price the model's full possible output against a tiny
    // child-key limit and reject the request before generation begins.
    return 512;
}
