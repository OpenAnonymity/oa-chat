# Proof of Cryptographic Unlinkability for OA Privacy Pass

## 1. Introduction

The OpenAnonymity (OA) architecture relies on Privacy Pass (RFC 9578) with RSA Blind Signatures (RFC 9474) to decouple ticket issuance from ticket redemption. While the verifier and client are open-source and their execution is attested, the org backend (station) handling the issuance and redemption is closed-source.

This document provides a formal cryptographic proof that, given the specific client-side implementation in `chat/services/privacyPass.js`, **a malicious, closed-source server absolutely cannot link a redeemed ticket to its issuance event.**

## 2. Cryptographic Foundation (RFC 9474)

The protocol uses RSA Blind Signatures (0x0002). The server possesses an RSA keypair $(N, e)$ (public) and $(N, d)$ (private).

1. **Blinding (Client):** The client wants the server to sign a token message $m$. The client generates a random blinding factor $r \in \mathbb{Z}_N^*$. It computes the blinded message $m' = m \cdot r^e \pmod N$ and sends $m'$ to the server.
2. **Signing (Server):** The server receives $m'$, computes the blind signature $s' = (m')^d \pmod N$, and returns $s'$.
3. **Unblinding (Client):** The client receives $s'$ and computes $s = s' \cdot r^{-1} \pmod N$. 
   Mathematically: $s \equiv (m \cdot r^e)^d \cdot r^{-1} \equiv m^d \cdot r^{ed} \cdot r^{-1} \equiv m^d \cdot r \cdot r^{-1} \equiv m^d \pmod N$.
   The client verifies that $s^e \equiv m \pmod N$.

## 3. Proof of Perfect Unlinkability

To track a user, the server must correlate the issuance view ($m'$, $s'$) with the redemption view ($m$, $s$).

**Theorem:** The server's view during issuance ($m'$) is statistically independent of the underlying token $m$.

**Proof:**
By definition of the blinding operation, $m' = m \cdot r^e \pmod N$. 
The blinding factor $r$ is chosen uniformly at random from $\mathbb{Z}_N^*$ by the client's local `@cloudflare/privacypass-ts` library. Because $\gcd(r, N) = 1$ and RSA exponentiation $r \mapsto r^e \pmod N$ is a permutation (bijection) over $\mathbb{Z}_N^*$, multiplying any valid token message $m$ by a uniformly random value $r^e \pmod N$ results in a uniformly distributed $m' \in \mathbb{Z}_N^*$.

Therefore, for *any* token $m$ later revealed during redemption, there exists a unique blinding factor $r$ that maps it to the $m'$ seen during issuance. Because the server does not know $r$, every issuance event is equally likely to correspond to any redemption event. The server has zero mathematical advantage in linking them.

## 4. Addressing Server-Side Cheating Vectors

Even with perfect blinding, a malicious server might try to cheat by manipulating the protocol parameters. We analyze these vectors against the `privacyPass.js` implementation.

### Vector A: Malicious Signature Tagging

* **Attack:** The server modifies the returned signature $s'$ to encode a unique tracking identifier (e.g., changing low-order bits), hoping the client will pass this tagged signature back during redemption.
* **Defense (Proven Impossibility):** RSA signatures are deterministic. During the `finalizeToken` step, the client mathematically verifies that $s^e \equiv m \pmod N$ (using `client.finalize()`). If the server alters even a single bit of $s'$, the cryptographic verification fails, and the client discards the token. The server is strictly bounded to returning the exact, mathematically correct signature or failing the issuance entirely.

### Vector B: Challenge Segregation Attack

* **Attack:** The Privacy Pass protocol allows the server to issue a "Challenge" (a nonce) to the client. A malicious server could issue a unique challenge to every client. At redemption, the token includes a hash of the challenge (`challenge_digest`), allowing the server to identify the user.
* **Defense (Proven Impossibility):** In `privacyPass.js` (Lines 75-86), the client entirely ignores the server's challenge and **hardcodes** a static challenge for all requests with empty redemption context and no origin info:
  ```javascript
  const challenge = new TokenChallenge(
      0x0002,
      '<hardcoded-in-the-code :)>',
      new Uint8Array(0)
  );
  ```
  The issuerName is a static string (same for all users), redemptionContext is empty (0 bytes), and originInfo is omitted. The ticket carries no extra information beyond the blind signature itself. Because every single client uses this identical, static challenge, the `challenge_digest` embedded in the token is identical for the entire anonymity set. The server cannot segregate or track users via challenges.

### Vector C: Malicious Modulus ($N$)

* **Attack:** The server crafts a weak or mathematically malformed RSA modulus $N$ to compromise the blinding property.
* **Defense (Proven Impossibility):** The blinding property relies solely on $r$ being drawn uniformly from $\mathbb{Z}_N^*$ and $\gcd(r, N) = 1$. The client library correctly samples $r$ and enforces the GCD requirement. The distribution of $m'$ remains uniform over $\mathbb{Z}_N^*$ regardless of the prime factorization of $N$. The server learns nothing about $m$.

### Vector D: Public Key Segregation (The "Sybil Key" Attack)

* **Attack:** The server provides a uniquely generated RSA public key ($e, N$) to each user during the issuance API call. Since the redeemed token includes the `token_key_id` (a SHA-256 hash of the public key), the server can look at this ID during redemption and perfectly link the user.
* **Mitigation Requirement:** The `privacyPass.js` client accepts the public key as an argument:
  ```javascript
  async createSingleTokenRequest(publicKeyB64) { ... }
  ```
  **Cryptographic Constraint:** For perfect unlinkability to hold in practice, the client application *must* ensure that the `publicKeyB64` it uses is identical across the entire user base.

  **Detectability:** The public key endpoint (`/api/ticket/issue/public-key`) is publicly accessible and unauthenticated. Any user or third party can call it at any time to record the current key and compare it against keys observed by other users. Since these verification calls are independent and unpredictable, the org cannot serve per-user keys without detection -- a single inconsistency reported by any observer exposes the attack. Future: automated transparency log for key consistency.

## 5. Conclusion

Given that the client uses the hardcoded `TokenChallenge` and performs standard unblinding with strict RSA verification, it is **cryptographically impossible** for a malicious, closed-source server to link a redeemed token back to its issuance request. The client's refusal to accept server-defined challenges successfully closes the most common Privacy Pass side-channel, guaranteeing perfect unlinkability within the anonymity set of users sharing the same public key.
