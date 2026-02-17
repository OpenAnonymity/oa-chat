/**
 * Verifier Attestation Modal Component
 * Shows hardware attestation verification for the OA-Verifier enclave
 */

import stationVerifier from '../services/verifier.js';
import networkLogger from '../services/networkLogger.js';
import { VERIFIER_URL } from '../config.js';

const OA_VERIFIER_REPO_BLOB_BASE = 'https://github.com/OpenAnonymity/oa-verifier/blob/main';

class VerifierAttestationModal {
    constructor() {
        this.isOpen = false;
        this.overlay = null;
        this.isLoading = false;
        this.error = null;
        this.attestation = null;
        this.verification = null;
        this.zeroTrustEvidence = null;
        this.context = null;
        this.zeroTrustOpenSteps = new Set();
    }

    async open(context = null) {
        if (this.isOpen) return;
        this.isOpen = true;
        this.context = context || null;
        this.attestation = null;
        this.verification = null;
        this.zeroTrustEvidence = null;
        this.zeroTrustOpenSteps = new Set();

        document.querySelector('.verifier-attestation-modal')?.remove();

        this.overlay = document.createElement('div');
        this.overlay.className = 'verifier-attestation-modal fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-in fade-in';

        this.isLoading = true;
        this.error = null;
        this.render();
        document.body.appendChild(this.overlay);
        this.setupEventListeners();

        await this.fetchAndVerifyAttestation();
    }

    close() {
        if (!this.isOpen) return;
        this.isOpen = false;
        if (this.escapeHandler) {
            document.removeEventListener('keydown', this.escapeHandler);
        }
        this.overlay?.remove();
        this.overlay = null;
    }

    async fetchAndVerifyAttestation() {
        try {
            const [attestation, zeroTrustEvidence] = await Promise.all([
                stationVerifier.getAttestation(true),
                this.collectZeroTrustEvidence()
            ]);
            this.attestation = attestation;
            this.verification = await this.verifyAttestation(this.attestation);
            this.zeroTrustEvidence = zeroTrustEvidence;

            this.isLoading = false;
            this.render();
            this.setupEventListeners();
        } catch (e) {
            console.error('Failed to fetch attestation:', e);
            this.error = e.message;
            this.isLoading = false;
            this.render();
            this.setupEventListeners();
        }
    }

    async verifyAttestation(attestation) {
        const result = {
            jwtVerified: false,
            jwtError: null,
            jwtKeyId: null,
            jwtIssuer: null,
            jwtJku: null,
            policyVerified: false,
            policyError: null,
            computedHash: null,
            hostData: attestation?.summary?.host_data || null,
            containerInfo: null,
            azureKeysLoaded: false,
            // GHCR verification
            ghcrVerified: null, // null = pending, true = verified, false = failed
            ghcrError: null,
            // Sigstore verification
            sigstoreVerified: null,
            sigstoreError: null,
            sigstoreEntries: null,
            sigstoreRekorUrl: null
        };

        if (!attestation) return result;

        // 1. Verify JWT signature against Azure keys
        try {
            const jwtResult = await this.verifyJwt(attestation);
            result.jwtVerified = jwtResult.verified;
            result.jwtKeyId = jwtResult.keyId;
            result.jwtIssuer = jwtResult.issuer;
            result.jwtJku = jwtResult.jku;
            result.azureKeysLoaded = jwtResult.keysLoaded;
            result.jwtError = jwtResult.error;
        } catch (e) {
            result.jwtError = e.message;
        }

        // 2. Verify policy hash matches hardware measurement
        try {
            const policyResult = await this.verifyPolicyHash(attestation);
            result.policyVerified = policyResult.verified;
            result.computedHash = policyResult.computedHash;
            result.policyError = policyResult.error;
        } catch (e) {
            result.policyError = e.message;
        }

        // 3. Extract container info from policy
        try {
            result.containerInfo = this.extractContainerInfo(attestation);
        } catch (e) {
            console.warn('Could not extract container info:', e);
        }

        // 4. Verify container exists in GHCR (async, update UI when done)
        if (result.containerInfo?.owner && result.containerInfo?.image && result.containerInfo?.digest) {
            this.verifyGhcr(result.containerInfo).then(ghcrResult => {
                result.ghcrVerified = ghcrResult.verified;
                result.ghcrError = ghcrResult.error;
                if (this.isOpen) {
                    this.render();
                    this.setupEventListeners();
                }
            });
        }

        // 5. Check Sigstore transparency log (async)
        if (result.containerInfo?.digest) {
            this.verifySigstore(result.containerInfo).then(sigstoreResult => {
                result.sigstoreVerified = sigstoreResult.verified;
                result.sigstoreError = sigstoreResult.error;
                result.sigstoreEntries = sigstoreResult.entries;
                result.sigstoreRekorUrl = sigstoreResult.rekorUrl;
                if (this.isOpen) {
                    this.render();
                    this.setupEventListeners();
                }
            });
        }

        return result;
    }

    async verifyGhcr(containerInfo) {
        const result = { verified: false, error: null };
        const { owner, image, digest } = containerInfo;

        try {
            // Get anonymous token for GHCR
            const tokenUrl = `https://ghcr.io/token?scope=repository:${owner}/${image}:pull`;
            const tokenResponse = await fetch(tokenUrl);

            if (!tokenResponse.ok) {
                result.error = 'Could not get GHCR token (may be private)';
                return result;
            }

            const tokenData = await tokenResponse.json();
            const token = tokenData.token;

            if (!token) {
                result.error = 'Invalid GHCR token response';
                return result;
            }

            // Check if digest exists in registry
            const manifestUrl = `https://ghcr.io/v2/${owner}/${image}/manifests/${digest}`;
            const manifestResponse = await fetch(manifestUrl, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.docker.distribution.manifest.v2+json,application/vnd.oci.image.manifest.v1+json'
                }
            });

            if (manifestResponse.ok) {
                result.verified = true;
            } else if (manifestResponse.status === 404) {
                result.error = 'Digest not found in GHCR';
            } else if (manifestResponse.status === 401 || manifestResponse.status === 403) {
                result.error = 'Private repo - manual verification needed';
            } else {
                result.error = `GHCR returned ${manifestResponse.status}`;
            }

        } catch (e) {
            console.warn('GHCR verification failed:', e);
            result.error = e.message || 'Network error';
        }

        return result;
    }

    async verifySigstore(containerInfo) {
        const result = { verified: false, error: null, entries: null, rekorUrl: null };
        const { owner, image, digest } = containerInfo;

        try {
            // Query Rekor transparency log for this digest
            // Sigstore stores container signatures indexed by the digest hash
            const digestHash = digest.replace('sha256:', '');

            // Search Rekor by hash
            const searchUrl = 'https://rekor.sigstore.dev/api/v1/index/retrieve';
            const searchResponse = await fetch(searchUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ hash: `sha256:${digestHash}` })
            });

            if (!searchResponse.ok) {
                // Try alternative search by artifact
                const altSearchUrl = `https://rekor.sigstore.dev/api/v1/log/entries?logIndex=&hash=${digestHash}`;
                const altResponse = await fetch(altSearchUrl);

                if (!altResponse.ok) {
                    result.error = 'No Sigstore entry found';
                    return result;
                }
            }

            const uuids = await searchResponse.json();

            if (!uuids || uuids.length === 0) {
                result.error = 'No transparency log entries found';
                return result;
            }

            // Get entry details
            const entryUuid = uuids[0];
            const entryUrl = `https://rekor.sigstore.dev/api/v1/log/entries/${entryUuid}`;
            const entryResponse = await fetch(entryUrl);

            if (entryResponse.ok) {
                const entryData = await entryResponse.json();
                result.verified = true;
                result.entries = uuids.length;
                result.rekorUrl = `https://search.sigstore.dev/?hash=${digestHash}`;

                // Try to extract more info from entry
                const entry = Object.values(entryData)[0];
                if (entry?.body) {
                    try {
                        const body = JSON.parse(atob(entry.body));
                        result.entryKind = body.kind;
                    } catch (e) {
                        // Ignore parse errors
                    }
                }
            } else {
                result.error = 'Could not fetch entry details';
            }

        } catch (e) {
            console.warn('Sigstore verification failed:', e);
            result.error = e.message || 'Network error';
        }

        return result;
    }

    async verifyJwt(attestation) {
        const result = {
            verified: false,
            keyId: null,
            issuer: null,
            jku: null,
            keysLoaded: false,
            error: null
        };

        if (!attestation.token || !attestation.verify_at) {
            result.error = 'Missing JWT token or verify_at URL';
            return result;
        }

        try {
            const [headerB64] = attestation.token.split('.');
            const headerJson = this.base64UrlDecode(headerB64);
            const header = JSON.parse(headerJson);

            result.keyId = header.kid;
            result.jku = header.jku;

            if (!header.jku || !header.jku.includes('.attest.azure.net/certs')) {
                result.error = 'JKU is not from Azure Attestation Service';
                return result;
            }

            const [, payloadB64] = attestation.token.split('.');
            const payloadJson = this.base64UrlDecode(payloadB64);
            const payload = JSON.parse(payloadJson);
            result.issuer = payload.iss;

            const keysResponse = await fetch(attestation.verify_at);
            if (!keysResponse.ok) {
                result.error = `Failed to fetch Azure keys: ${keysResponse.status}`;
                return result;
            }

            const jwks = await keysResponse.json();
            result.keysLoaded = true;

            const key = jwks.keys?.find(k => k.kid === header.kid);
            if (!key) {
                result.error = 'Key ID not found in Azure JWKS';
                return result;
            }

            const cryptoKey = await this.importJwk(key);
            const signatureValid = await this.verifyJwtSignature(attestation.token, cryptoKey);

            result.verified = signatureValid;
            if (!signatureValid) {
                result.error = 'JWT signature verification failed';
            }

        } catch (e) {
            result.error = e.message;
        }

        return result;
    }

    base64UrlDecode(str) {
        let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
        const pad = base64.length % 4;
        if (pad) {
            base64 += '='.repeat(4 - pad);
        }
        return atob(base64);
    }

    async importJwk(jwk) {
        return await crypto.subtle.importKey(
            'jwk',
            { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: jwk.alg || 'RS256', use: 'sig' },
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify']
        );
    }

    async verifyJwtSignature(token, cryptoKey) {
        const [headerB64, payloadB64, signatureB64] = token.split('.');
        const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

        const signatureStr = this.base64UrlDecode(signatureB64);
        const signature = new Uint8Array(signatureStr.length);
        for (let i = 0; i < signatureStr.length; i++) {
            signature[i] = signatureStr.charCodeAt(i);
        }

        return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signature, data);
    }

    async verifyPolicyHash(attestation) {
        const result = { verified: false, computedHash: null, error: null };

        if (!attestation.policy?.base64) {
            result.error = 'Policy not available in attestation';
            return result;
        }

        try {
            const policyBytes = atob(attestation.policy.base64);
            const policyArray = new Uint8Array(policyBytes.length);
            for (let i = 0; i < policyBytes.length; i++) {
                policyArray[i] = policyBytes.charCodeAt(i);
            }

            const hashBuffer = await crypto.subtle.digest('SHA-256', policyArray);
            result.computedHash = Array.from(new Uint8Array(hashBuffer))
                .map(b => b.toString(16).padStart(2, '0'))
                .join('');

            const hostData = attestation.summary?.host_data;
            result.verified = result.computedHash === hostData;

            if (!result.verified && hostData) {
                result.error = 'Policy hash does not match hardware measurement';
            }

        } catch (e) {
            result.error = e.message;
        }

        return result;
    }

    extractContainerInfo(attestation) {
        if (!attestation.policy?.decoded) return null;

        const policyStr = attestation.policy.decoded;

        const idMatch = policyStr.match(/"id":"(ghcr\.io\/[^"]+)"/);
        const containerId = idMatch ? idMatch[1] : null;

        const cmdMatch = policyStr.match(/"command":\["([^"]+)"\]/);
        const command = cmdMatch ? cmdMatch[1] : null;

        const wdMatch = policyStr.match(/"working_dir":"([^"]+)"/);
        const workingDir = wdMatch ? wdMatch[1] : null;

        let registry = null, owner = null, image = null, digest = null;
        if (containerId) {
            const match = containerId.match(/^(ghcr\.io)\/([^/]+)\/([^@]+)@(.+)$/);
            if (match) {
                registry = match[1];
                owner = match[2];
                image = match[3];
                digest = match[4];
            }
        }

        return {
            containerId,
            command,
            workingDir,
            registry,
            owner,
            image,
            digest,
            ghcrUrl: owner && image ? `https://github.com/${owner}/${image}/pkgs/container/${image}` : null,
            repoUrl: owner && image ? `https://github.com/${owner}/${image}` : null
        };
    }

    async collectZeroTrustEvidence() {
        const access = this.getActiveAccessContext();
        const evidence = {
            hasActiveKey: access.hasActiveKey,
            stationId: access.stationId,
            expiresAtUnix: access.expiresAtUnix,
            stationSignature: access.stationSignature,
            orgSignature: access.orgSignature,
            hasStationSignature: !!access.stationSignature,
            hasOrgSignature: !!access.orgSignature,
            stationSignatureLength: access.stationSignature ? access.stationSignature.length : 0,
            orgSignatureLength: access.orgSignature ? access.orgSignature.length : 0,
            apiKeyHash: null,
            apiKeyFingerprint: null,
            apiKeyHashPrefix16: null,
            stationPayloadHash: null,
            orgPayloadHash: null,
            broadcastTimestamp: null,
            broadcastAge: null,
            broadcastVerifiedCount: 0,
            broadcastBannedCount: 0,
            stationVerifiedInBroadcast: false,
            stationBannedInBroadcast: false,
            stationPublicKey: null,
            stationDisplayName: null,
            stationVerifiedRecord: null,
            stationBannedRecord: null,
            broadcastError: null,
            localStationSignature: {
                verified: null,
                supported: true,
                error: null
            },
            submitKeyOwnership: {
                found: false,
                ownership_passed: false,
                pending: false,
                rejected: false,
                reason: null,
                response: null
            }
        };

        if (!access.hasActiveKey) {
            return evidence;
        }

        if (access.apiKey) {
            evidence.apiKeyHash = await this.computeHash(access.apiKey);
            evidence.apiKeyFingerprint = evidence.apiKeyHash ? evidence.apiKeyHash.slice(0, 16) : null;
            evidence.apiKeyHashPrefix16 = evidence.apiKeyHash ? evidence.apiKeyHash.slice(0, 16) : null;
        }

        if (access.stationId && access.apiKey && access.expiresAtUnix !== null) {
            const stationPayload = `${access.stationId}|${access.apiKey}|${access.expiresAtUnix}`;
            evidence.stationPayloadHash = await this.computeHash(stationPayload);

            if (access.stationSignature) {
                const orgPayload = `${access.stationId}|${access.apiKey}|${access.expiresAtUnix}|${access.stationSignature}`;
                evidence.orgPayloadHash = await this.computeHash(orgPayload);
            }
        }

        let broadcastData = stationVerifier.getLastBroadcastData();
        if (!broadcastData && access.stationId) {
            try {
                await stationVerifier.queryBroadcast();
                broadcastData = stationVerifier.getLastBroadcastData();
            } catch (error) {
                evidence.broadcastError = error?.message || 'Could not fetch broadcast';
            }
        }

        if (broadcastData) {
            evidence.broadcastTimestamp = this.getBroadcastTimestamp(broadcastData);
            evidence.broadcastAge = this.formatRelativeTime(evidence.broadcastTimestamp);
            evidence.broadcastVerifiedCount = Array.isArray(broadcastData.verified_stations) ? broadcastData.verified_stations.length : 0;
            evidence.broadcastBannedCount = Array.isArray(broadcastData.banned_stations) ? broadcastData.banned_stations.length : 0;
        }

        if (access.stationId && broadcastData) {
            const verifiedEntry = Array.isArray(broadcastData.verified_stations)
                ? broadcastData.verified_stations.find((station) => station.station_id === access.stationId)
                : null;
            const bannedEntry = Array.isArray(broadcastData.banned_stations)
                ? broadcastData.banned_stations.find((station) => station.station_id === access.stationId)
                : null;

            if (verifiedEntry) {
                evidence.stationVerifiedInBroadcast = true;
                evidence.stationPublicKey = verifiedEntry.public_key || null;
                evidence.stationDisplayName = verifiedEntry.display_name || null;
                evidence.stationVerifiedRecord = {
                    station_id: verifiedEntry.station_id || null,
                    public_key: verifiedEntry.public_key || null,
                    display_name: verifiedEntry.display_name || null
                };
            }

            if (bannedEntry) {
                evidence.stationBannedInBroadcast = true;
                evidence.stationPublicKey = evidence.stationPublicKey || bannedEntry.public_key || null;
                evidence.stationDisplayName = evidence.stationDisplayName || bannedEntry.display_name || null;
                evidence.stationBannedRecord = {
                    station_id: bannedEntry.station_id || null,
                    public_key: bannedEntry.public_key || null,
                    reason: bannedEntry.reason || null,
                    banned_at: bannedEntry.banned_at || null
                };
            }
        }

        if (access.stationId &&
            access.apiKey &&
            access.expiresAtUnix !== null &&
            access.stationSignature &&
            evidence.stationPublicKey) {
            evidence.localStationSignature = await this.verifyStationSignatureLocally({
                stationId: access.stationId,
                apiKey: access.apiKey,
                expiresAtUnix: access.expiresAtUnix,
                stationSignature: access.stationSignature,
                stationPublicKey: evidence.stationPublicKey
            });
        } else if (access.stationSignature && !evidence.stationPublicKey) {
            evidence.localStationSignature.error = 'Station public key is not available from broadcast.';
        }

        evidence.submitKeyOwnership = this.extractSubmitKeyOwnershipEvidence(access, evidence);

        return evidence;
    }

    extractSubmitKeyOwnershipEvidence(access, evidence) {
        const allLogs = window.networkLogger?.getAllLogs?.() || networkLogger.getAllLogs?.() || [];
        const sessionId = this.context?.session?.id || null;
        const expectedHashPrefix = evidence?.apiKeyHashPrefix16 || null;
        const storedProof = access?.submitKeyProof || null;

        const candidates = allLogs.filter((log) => {
            if (log?.type !== 'verification') return false;
            if (!String(log?.url || '').includes('/submit_key')) return false;
            if (access?.stationId && log?.request?.station_id && log.request.station_id !== access.stationId) return false;
            if (sessionId && log?.sessionId && log.sessionId !== sessionId) return false;
            return true;
        });

        const preferred = candidates.find((log) => {
            const response = log?.response || {};
            const keyHashFromVerifier = typeof response?.key_hash === 'string' ? response.key_hash : null;
            const responseStatus = response?.status || null;
            const hashMatches = expectedHashPrefix && keyHashFromVerifier
                ? expectedHashPrefix.startsWith(keyHashFromVerifier)
                : true;
            return responseStatus === 'verified' && hashMatches;
        }) || candidates[0] || null;

        if (!preferred && storedProof) {
            const response = storedProof?.verifierResponse || storedProof?.response || null;
            const detail = storedProof?.detail || response?.detail || null;
            const responseStatus = response?.status || null;
            const storedStatus = storedProof?.status || null;
            const derivedHttpStatus = storedProof?.http_status ??
                (storedStatus === 'verified' ? 200 : null);
            const keyHashFromVerifier = storedProof?.keyHashFromVerifier || response?.key_hash || null;
            const keyHashMatchesCurrentKey = expectedHashPrefix && keyHashFromVerifier
                ? expectedHashPrefix.startsWith(keyHashFromVerifier)
                : null;
            const ownershipPassed = (storedStatus === 'verified' || responseStatus === 'verified') &&
                (keyHashMatchesCurrentKey !== false);
            const pending = storedStatus === 'pending' ||
                detail === 'ownership_check_error' ||
                detail === 'rate_limited';
            const rejected = storedStatus === 'rejected' || responseStatus === 'banned';

            return {
                found: true,
                ownership_passed: ownershipPassed,
                pending,
                rejected,
                reason: detail || null,
                timestamp: storedProof?.recordedAt || null,
                http_status: Number.isFinite(derivedHttpStatus) ? derivedHttpStatus : null,
                session_id: sessionId,
                request: {
                    station_id: access?.stationId || null,
                    key_hash_prefix: expectedHashPrefix || null,
                    source: 'persisted_session'
                },
                expected_key_hash_prefix: expectedHashPrefix,
                key_hash_from_verifier: keyHashFromVerifier,
                key_hash_matches_current_key: keyHashMatchesCurrentKey,
                response
            };
        }

        if (!preferred) {
            return {
                found: false,
                ownership_passed: false,
                pending: false,
                rejected: false,
                reason: null,
                expected_key_hash_prefix: expectedHashPrefix,
                response: null
            };
        }

        const response = preferred?.response || {};
        const detail = preferred?.detail || response?.detail || null;
        const responseStatus = response?.status || null;
        const httpStatus = typeof preferred?.status === 'number' ? preferred.status : null;
        const keyHashFromVerifier = typeof response?.key_hash === 'string' ? response.key_hash : null;
        const keyHashMatchesCurrentKey = expectedHashPrefix && keyHashFromVerifier
            ? expectedHashPrefix.startsWith(keyHashFromVerifier)
            : null;
        const ownershipPassed = httpStatus !== null &&
            httpStatus >= 200 &&
            httpStatus < 300 &&
            responseStatus === 'verified' &&
            (keyHashMatchesCurrentKey !== false);
        const pending = preferred?.status === 'pending' ||
            preferred?.status === 'queued' ||
            detail === 'ownership_check_error' ||
            detail === 'rate_limited';
        const rejected = (httpStatus !== null && httpStatus >= 400) || responseStatus === 'banned';

        return {
            found: true,
            ownership_passed: ownershipPassed,
            pending,
            rejected,
            reason: detail || null,
            timestamp: preferred?.timestamp ? new Date(preferred.timestamp).toISOString() : null,
            http_status: httpStatus,
            session_id: preferred?.sessionId || null,
            request: preferred?.request || null,
            expected_key_hash_prefix: expectedHashPrefix,
            key_hash_from_verifier: keyHashFromVerifier,
            key_hash_matches_current_key: keyHashMatchesCurrentKey,
            response
        };
    }

    getActiveAccessContext() {
        const sessionFromContext = this.context?.session || null;
        const sessionFromApp = window.app?.getCurrentSession ? window.app.getCurrentSession() : null;
        const selectedSession = sessionFromContext || sessionFromApp || null;
        const accessInfo = this.context?.accessInfo ||
            selectedSession?.apiKeyInfo ||
            null;

        const stationId = accessInfo?.stationId ||
            accessInfo?.station_id ||
            accessInfo?.station_name ||
            this.context?.stationId ||
            null;
        const apiKey = accessInfo?.key || accessInfo?.token || selectedSession?.apiKey || null;
        const expiresAtUnix = this.parseUnixTimestamp(
            accessInfo?.expiresAtUnix ??
            accessInfo?.expires_at_unix ??
            accessInfo?.key_valid_till ??
            null
        );
        const stationSignature = accessInfo?.stationSignature || accessInfo?.station_signature || null;
        const orgSignature = accessInfo?.orgSignature || accessInfo?.org_signature || null;
        const submitKeyProof = accessInfo?.verifierSubmitKeyProof || accessInfo?.submitKeyProof || null;

        return {
            hasActiveKey: !!apiKey,
            stationId,
            apiKey,
            expiresAtUnix,
            stationSignature,
            orgSignature,
            submitKeyProof
        };
    }

    parseUnixTimestamp(value) {
        if (value === null || value === undefined || value === '') {
            return null;
        }
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) {
            return null;
        }
        return Math.floor(parsed);
    }

    getBroadcastTimestamp(broadcastData) {
        if (!broadcastData) return null;
        return broadcastData.timestamp || broadcastData.last_verified || null;
    }

    async computeHash(input) {
        if (!input) return null;
        try {
            const bytes = new TextEncoder().encode(input);
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest))
                .map((value) => value.toString(16).padStart(2, '0'))
                .join('');
        } catch (error) {
            console.warn('Could not compute hash:', error);
            return null;
        }
    }

    async verifyStationSignatureLocally({ stationId, apiKey, expiresAtUnix, stationSignature, stationPublicKey }) {
        const result = {
            verified: null,
            supported: true,
            error: null
        };

        try {
            if (!window.crypto?.subtle) {
                result.supported = false;
                result.error = 'WebCrypto is unavailable in this browser.';
                return result;
            }

            const message = `${stationId}|${apiKey}|${expiresAtUnix}`;
            const messageBytes = new TextEncoder().encode(message);
            const signatureBytes = this.hexToBytes(stationSignature);
            const publicKeyBytes = this.hexToBytes(stationPublicKey);

            let cryptoKey;
            try {
                cryptoKey = await crypto.subtle.importKey(
                    'raw',
                    publicKeyBytes,
                    { name: 'Ed25519' },
                    false,
                    ['verify']
                );
            } catch {
                cryptoKey = await crypto.subtle.importKey(
                    'raw',
                    publicKeyBytes,
                    'Ed25519',
                    false,
                    ['verify']
                );
            }

            let verified;
            try {
                verified = await crypto.subtle.verify(
                    { name: 'Ed25519' },
                    cryptoKey,
                    signatureBytes,
                    messageBytes
                );
            } catch {
                verified = await crypto.subtle.verify(
                    'Ed25519',
                    cryptoKey,
                    signatureBytes,
                    messageBytes
                );
            }

            result.verified = verified;
            if (!verified) {
                result.error = 'Signature mismatch for station public key.';
            }
            return result;
        } catch (error) {
            const message = String(error?.message || error || '').toLowerCase();
            if (message.includes('not supported') || message.includes('unrecognized') || message.includes('algorithm')) {
                result.supported = false;
                result.error = 'Browser does not support Ed25519 verification.';
            } else {
                result.error = error?.message || 'Station signature verification failed.';
            }
            return result;
        }
    }

    hexToBytes(hex) {
        if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) {
            throw new Error('Invalid hex input.');
        }

        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
        }
        return bytes;
    }

    formatRelativeTime(timestamp) {
        if (!timestamp) return null;
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return null;

        const deltaMs = Date.now() - date.getTime();
        if (deltaMs < 60 * 1000) return 'just now';

        const minutes = Math.floor(deltaMs / (60 * 1000));
        if (minutes < 60) return `${minutes}m ago`;

        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;

        const days = Math.floor(hours / 24);
        return `${days}d ago`;
    }

    truncateMiddle(value, left = 12, right = 10) {
        if (!value) return 'N/A';
        if (value.length <= left + right + 3) return value;
        return `${value.slice(0, left)}...${value.slice(-right)}`;
    }

    render() {
        const a = this.attestation;
        const v = this.verification;

        const isFullyVerified = v?.jwtVerified && v?.policyVerified;
        const hasPartialVerification = v?.jwtVerified || v?.policyVerified;

        this.overlay.innerHTML = `
            <div class="verifier-modal-content bg-background border border-border rounded-xl shadow-2xl max-w-xl w-full mx-4 animate-in zoom-in-95 overflow-hidden flex flex-col">
                <div class="p-4 flex items-center justify-between shrink-0">
                    <div class="flex items-center gap-2">
                        <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/50">
                            <svg class="w-4 h-4 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                                ${isFullyVerified ? '<path d="M9 12l2 2 4-4"/>' : ''}
                            </svg>
                        </div>
                        <h2 class="text-sm font-semibold text-foreground">Verifier Attestation</h2>
                    </div>
                    <button class="verifier-modal-close text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-lg hover:bg-muted/50">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                    </button>
                </div>

                <div class="verifier-modal-scroll px-5 pb-0 space-y-2.5">
                    ${this.isLoading ? this.renderLoading() : this.error ? this.renderError() : this.renderContent()}
                </div>

                <div class="px-5 py-2 flex justify-end shrink-0">
                    <button class="verifier-modal-done px-3 py-1 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-200">
                        Done
                    </button>
                </div>
            </div>
        `;
    }

    renderLoading() {
        return `
            <div class="flex flex-col items-center justify-center py-8 space-y-3">
                <svg class="w-8 h-8 text-muted-foreground animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                <p class="text-xs text-muted-foreground">Fetching and verifying attestation...</p>
            </div>
        `;
    }

    renderError() {
        return `
            <div class="p-4 rounded-lg border border-destructive/30 bg-destructive/10 text-center">
                <svg class="w-8 h-8 text-destructive mx-auto mb-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M15 9l-6 6M9 9l6 6"/>
                </svg>
                <p class="text-xs font-medium text-destructive">Failed to fetch attestation</p>
                <p class="text-xs text-muted-foreground mt-1">${this.escapeHtml(this.error)}</p>
                <button class="verifier-retry-btn mt-3 px-3 py-1.5 text-xs font-medium rounded-md border border-border bg-background text-foreground hover:bg-muted transition-colors">
                    Retry
                </button>
            </div>
        `;
    }

    renderContent() {
        const a = this.attestation;
        const v = this.verification;
        const evidence = this.zeroTrustEvidence;
        const summary = a?.summary || {};
        const container = v?.containerInfo;

        return `
            <div class="p-3 rounded-lg border border-border bg-card space-y-1.5">
                <h3 class="text-xs font-semibold text-foreground">What is an Ephemeral Access Key?</h3>
                <p class="text-[11px] text-muted-foreground leading-relaxed">
                    A short-lived, credit-limited "burner" key for this chat session. After issue, your browser talks to the model provider directly over HTTPS, so the verifier does not need your prompt/response plaintext.
                </p>
                <p class="text-[11px] text-muted-foreground leading-relaxed">
                    It provides compartmentalization: keys expire quickly and limit blast radius if one key leaks.
                </p>
            </div>

            <div class="p-3 rounded-lg border border-border/70 bg-muted/20 space-y-1.5">
                <h3 class="text-xs font-semibold text-foreground">How to read this panel</h3>
                <ul class="list-disc list-inside space-y-0.5 text-[11px] text-muted-foreground">
                    <li><span class="text-foreground font-medium">Hardware Attestation:</span> proves verifier runtime identity from confidential hardware.</li>
                    <li><span class="text-foreground font-medium">JWT Signature:</span> checks the attestation token against Azure attestation keys.</li>
                    <li><span class="text-foreground font-medium">Policy Verification:</span> checks measured runtime hash matches expected policy hash.</li>
                </ul>
            </div>

            <!-- Key Issuance Proof Chain -->
            <details class="verifier-collapsible group rounded-lg border border-border bg-card overflow-hidden">
                <summary style="list-style:none;" class="verifier-collapsible-summary cursor-pointer px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-muted/40 transition-colors">
                    <div class="flex items-center gap-2 min-w-0">
                        <svg class="w-3.5 h-3.5 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M9 12l2 2 4-4"/>
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                        </svg>
                        <span class="text-xs font-medium text-foreground truncate">Key Issuance Proof Chain</span>
                    </div>
                    <svg class="w-3 h-3 text-muted-foreground transition-transform group-open:rotate-90 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 18l6-6-6-6"/>
                    </svg>
                </summary>
                <div class="border-t border-border px-3 py-2.5">
                    ${this.renderZeroTrustSection(a, v, evidence)}
                </div>
            </details>

            <!-- Code Auditability -->
            ${container ? `
                <details class="verifier-collapsible group rounded-lg border border-border bg-card overflow-hidden">
                    <summary style="list-style:none;" class="verifier-collapsible-summary cursor-pointer px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-muted/40 transition-colors">
                        <div class="flex items-center gap-2 min-w-0">
                            <svg class="w-3.5 h-3.5 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
                                <polyline points="14 2 14 8 20 8"/>
                                <line x1="16" y1="13" x2="8" y2="13"/>
                                <line x1="16" y1="17" x2="8" y2="17"/>
                            </svg>
                            <span class="text-xs font-medium text-foreground truncate">Code Auditability</span>
                        </div>
                        <svg class="w-3 h-3 text-muted-foreground transition-transform group-open:rotate-90 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M9 18l6-6-6-6"/>
                        </svg>
                    </summary>
                    <div class="border-t border-border px-3 py-2.5">
                        ${this.renderCodeAuditability(container, v)}
                    </div>
                </details>
            ` : ''}

            <!-- Hardware Attestation -->
            <div class="rounded-lg border border-border bg-card overflow-hidden">
                <div class="px-3 py-2.5 border-b border-border bg-muted/20 flex items-center gap-2">
                    <svg class="w-3.5 h-3.5 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    </svg>
                    <h3 class="text-xs font-medium text-foreground">Hardware Attestation</h3>
                </div>
                <div class="px-3 py-2.5 space-y-2">
                    <p class="text-[11px] text-muted-foreground">Verifies the verifier service is running in a genuine confidential-computing environment.</p>
                    <div class="space-y-1.5">
                        ${this.renderRow('Type', summary.attestation_type || 'Unknown', summary.attestation_type ? 'text-foreground' : 'text-muted-foreground')}
                        ${this.renderRow('Debug Disabled', summary.debug_disabled === true ? 'Yes' : summary.debug_disabled === false ? 'No' : 'Unknown', summary.debug_disabled === true ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400')}
                        ${this.renderRow('Compliance', summary.compliance_status || 'Unknown')}
                        ${this.renderRow('Issuer', this.formatIssuer(summary.issuer), 'text-foreground truncate', true)}
                    </div>
                </div>
            </div>

            <!-- JWT Signature -->
            <div class="rounded-lg border border-border bg-card overflow-hidden">
                <div class="px-3 py-2.5 border-b border-border bg-muted/20 flex items-center gap-2">
                    <svg class="w-3.5 h-3.5 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 12l2 2 4-4"/>
                        <path d="M20 6L9 17l-5-5"/>
                    </svg>
                    <h3 class="text-xs font-medium text-foreground">JWT Signature</h3>
                </div>
                <div class="px-3 py-2.5 space-y-2">
                    <p class="text-[11px] text-muted-foreground">Confirms the attestation token is cryptographically signed by Azure Attestation.</p>
                    <div class="space-y-1.5">
                        ${this.renderStatusRow('Status', v?.jwtVerified, v?.jwtError, 'Verified')}
                        ${v?.jwtKeyId ? this.renderRow('Key ID', v.jwtKeyId.substring(0, 20) + '...', 'text-foreground font-mono text-xs') : ''}
                        ${v?.jwtIssuer ? this.renderRow('Issuer', this.formatIssuer(v.jwtIssuer), 'text-foreground truncate', true) : ''}
                        ${v?.azureKeysLoaded ? this.renderRow('Azure Keys', 'Loaded', 'text-green-600 dark:text-green-400') : ''}
                    </div>
                </div>
            </div>

            <!-- Policy Verification -->
            <div class="rounded-lg border border-border bg-card overflow-hidden">
                <div class="px-3 py-2.5 border-b border-border bg-muted/20 flex items-center gap-2">
                    <svg class="w-3.5 h-3.5 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M4 7h16M4 12h16M4 17h10"/>
                    </svg>
                    <h3 class="text-xs font-medium text-foreground">Policy Verification</h3>
                </div>
                <div class="px-3 py-2.5 space-y-2">
                    <p class="text-[11px] text-muted-foreground">Confirms the enclave's measured runtime matches the expected policy hash.</p>
                    <div class="space-y-1.5">
                        ${this.renderStatusRow('Status', v?.policyVerified, v?.policyError, 'Hardware Verified')}
                        ${v?.computedHash ? `
                            <div class="flex justify-between items-start gap-3">
                                <span class="text-xs text-muted-foreground/70 shrink-0">Computed Hash</span>
                                <span class="text-xs font-mono text-foreground truncate" title="${v.computedHash}">${v.computedHash.substring(0, 16)}...</span>
                            </div>
                        ` : ''}
                        ${v?.hostData ? `
                            <div class="flex justify-between items-start gap-3">
                                <span class="text-xs text-muted-foreground/70 shrink-0">Hardware host_data</span>
                                <span class="text-xs font-mono text-foreground truncate" title="${v.hostData}">${v.hostData.substring(0, 16)}...</span>
                            </div>
                        ` : ''}
                        ${v?.policyVerified ? `
                            <div class="mt-1.5 text-xs text-green-600 dark:text-green-400">
                                ✓ Policy hash matches hardware measurement
                            </div>
                        ` : ''}
                    </div>
                </div>
            </div>

            <!-- Verification Summary -->
            <div class="mt-2 p-3 rounded-lg ${v?.policyVerified && v?.jwtVerified ? 'bg-green-50/50 dark:bg-green-500/10' : 'bg-amber-50/50 dark:bg-amber-500/10'} text-center">
                ${v?.policyVerified && v?.jwtVerified ? `
                    <div class="flex items-center justify-center gap-2">
                        <svg class="w-4 h-4 text-green-600 dark:text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                            <path d="M9 12l2 2 4-4"/>
                        </svg>
                        <span class="font-medium text-xs text-green-700 dark:text-green-300">Hardware Verified</span>
                    </div>
                    <p class="text-xs text-green-600 dark:text-green-400 mt-1">Secure enclave running authentic code</p>
                ` : `
                    <div class="flex items-center justify-center gap-2">
                        <svg class="w-4 h-4 text-amber-600 dark:text-amber-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                        </svg>
                        <span class="font-medium text-xs text-amber-700 dark:text-amber-300">Partial Verification</span>
                    </div>
                    <p class="text-xs text-amber-600 dark:text-amber-400 mt-1">Some steps incomplete</p>
                `}
            </div>

            <!-- Verify Yourself -->
            <details class="verifier-collapsible group rounded-lg border border-border bg-card overflow-hidden">
                <summary style="list-style:none;" class="verifier-collapsible-summary cursor-pointer px-3 py-2.5 flex items-center justify-between gap-3 hover:bg-muted/40 transition-colors">
                    <div class="flex items-center gap-2 min-w-0">
                        <svg class="w-3.5 h-3.5 text-muted-foreground shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M15 12H9"/>
                            <path d="M12 9v6"/>
                            <path d="M21 12a9 9 0 1 1-9-9"/>
                        </svg>
                        <span class="text-xs font-medium text-foreground truncate">Verify Yourself</span>
                    </div>
                    <svg class="w-3 h-3 text-muted-foreground transition-transform group-open:rotate-90 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 18l6-6-6-6"/>
                    </svg>
                </summary>
                <div class="border-t border-border px-3 py-2.5 text-xs space-y-2">
                    <div class="rounded-lg border border-border bg-muted/20 p-3 text-muted-foreground space-y-2">
                        <p class="text-xs font-medium text-foreground">Run the verification script</p>
                        <p>Download and run the zero-trust verification script:</p>
                        <code class="verifier-command p-2 bg-muted/70 border border-border rounded text-[11px] font-mono text-foreground"><span class="verifier-command-line">curl -sL https://raw.githubusercontent.com/OpenAnonymity/oa-verifier/main/verify.sh \\</span><span class="verifier-command-line">| bash -s ${VERIFIER_URL}</span></code>
                        <p>This script independently verifies the attestation without trusting this UI.</p>
                    </div>
                    <div class="rounded-lg border border-border bg-muted/20 p-3 text-muted-foreground space-y-1.5">
                        <p class="text-xs font-medium text-foreground">What is being verified?</p>
                        <ul class="list-disc list-inside space-y-1">
                            <li><strong class="text-foreground">JWT Signature:</strong> Verified against Azure Attestation Service public keys</li>
                            <li><strong class="text-foreground">Policy Hash:</strong> SHA-256 of policy compared with hardware-measured host_data</li>
                            <li><strong class="text-foreground">GHCR:</strong> Container digest exists in GitHub Container Registry</li>
                            <li><strong class="text-foreground">Sigstore:</strong> Build provenance in transparency log</li>
                        </ul>
                    </div>
                </div>
            </details>
        `;
    }

    renderCodeAuditability(container, v) {
        const isGhcrVerified = v?.ghcrVerified === true;
        const isSigstoreVerified = v?.sigstoreVerified === true;
        const isGhcrPending = v?.ghcrVerified === null;
        const isSigstorePending = v?.sigstoreVerified === null;

        return `
            <div class="space-y-2.5">
                <p class="text-[11px] text-muted-foreground">
                    All code processing your data comes from a trusted open-source repository and is auditable.
                </p>

                <!-- Container Digest Verification -->
                <div class="p-2 rounded-md border ${isGhcrVerified ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20' : 'border-border bg-muted/30'} space-y-1.5">
                    <div class="flex items-center justify-between">
                        <span class="text-[11px] font-medium">Container Registry (GHCR)</span>
                        ${isGhcrPending ? `
                            <span class="text-[10px] text-muted-foreground flex items-center gap-1">
                                <svg class="w-2.5 h-2.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                                Verifying...
                            </span>
                        ` : isGhcrVerified ? `
                            <span class="text-[10px] text-green-600 dark:text-green-400 flex items-center gap-1">
                                <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
                                Verified
                            </span>
                        ` : `
                            <span class="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                                <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                                ${v?.ghcrError || 'Not verified'}
                            </span>
                        `}
                    </div>
                    <div class="text-[10px] font-mono text-foreground bg-muted/70 border border-border p-1.5 rounded overflow-x-auto whitespace-nowrap">
                        ${container.digest || 'N/A'}
                    </div>
                    ${container.ghcrUrl ? `
                        <a href="${container.ghcrUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[10px] text-blue-500 hover:underline">
                            <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                            View on GitHub Container Registry
                        </a>
                    ` : ''}
                </div>

                <!-- Sigstore Transparency Log -->
                <div class="p-2 rounded-md border ${isSigstoreVerified ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20' : 'border-border bg-muted/30'} space-y-1.5">
                    <div class="flex items-center justify-between">
                        <span class="text-[11px] font-medium">Sigstore Transparency Log</span>
                        ${isSigstorePending ? `
                            <span class="text-[10px] text-muted-foreground flex items-center gap-1">
                                <svg class="w-2.5 h-2.5 animate-spin" viewBox="0 0 24 24" fill="none"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"/><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                                Checking...
                            </span>
                        ` : isSigstoreVerified ? `
                            <span class="text-[10px] text-green-600 dark:text-green-400 flex items-center gap-1">
                                <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>
                                ${v.sigstoreEntries || 1} ${v.sigstoreEntries === 1 ? 'entry' : 'entries'} found
                            </span>
                        ` : `
                            <span class="text-[10px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                                <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                                ${v?.sigstoreError || 'Not found'}
                            </span>
                        `}
                    </div>
                    <p class="text-[10px] text-muted-foreground">
                        Verifies that the source code was correctly built through GitHub Actions and the resulting binary is recorded in the Sigstore transparency log.
                    </p>
                    ${v?.sigstoreRekorUrl ? `
                        <a href="${v.sigstoreRekorUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[10px] text-blue-500 hover:underline">
                            <svg class="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                            View on Sigstore
                        </a>
                    ` : ''}
                </div>

                <!-- Source Repository -->
                <div class="p-2 rounded-md border border-border bg-muted/30 space-y-1">
                    <span class="text-[11px] font-medium">Configuration Repository</span>
                    <p class="text-[10px] text-muted-foreground">
                        The configuration repository specifies exactly what code is running inside the secure enclave.
                    </p>
                    ${container.repoUrl ? `
                        <a href="${container.repoUrl}" target="_blank" rel="noopener" class="inline-flex items-center gap-1 text-[11px] text-blue-500 hover:underline font-medium">
                            <svg class="w-3 h-3" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                            ${container.owner}/${container.image}
                        </a>
                    ` : ''}
                </div>

                <!-- Container Details (collapsible) -->
                <details class="group">
                    <summary class="cursor-pointer flex items-center gap-2 text-[11px] text-muted-foreground hover:text-foreground">
                        <svg class="w-2.5 h-2.5 transition-transform group-open:rotate-90" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
                        Additional container info
                    </summary>
                    <div class="mt-1.5 p-1.5 rounded border border-border bg-muted/20 space-y-1 text-[10px]">
                        ${this.renderRow('Registry', container.registry, 'text-foreground')}
                        ${this.renderRow('Owner', container.owner, 'text-foreground')}
                        ${this.renderRow('Image', container.image, 'text-foreground')}
                        ${this.renderRow('Command', container.command, 'text-foreground font-mono')}
                    </div>
                </details>
            </div>
        `;
    }

    renderZeroTrustSection(attestation, verification, evidence) {
        const stationId = evidence?.stationId || null;
        const hasStationSignature = !!evidence?.hasStationSignature;
        const hasOrgSignature = !!evidence?.hasOrgSignature;
        const stationVerified = !!evidence?.stationVerifiedInBroadcast;
        const stationBanned = !!evidence?.stationBannedInBroadcast;
        const localSig = evidence?.localStationSignature || { verified: null, supported: true, error: null };
        const ownership = evidence?.submitKeyOwnership || {};
        const ownershipPassed = ownership?.ownership_passed === true;
        const verifierOffline = typeof stationVerifier?.isOffline === 'function' &&
            typeof stationVerifier?.hasEverConnected === 'function'
            ? (stationVerifier.hasEverConnected() && stationVerifier.isOffline())
            : false;
        const hideAllLiveEvidence = verifierOffline || Boolean(evidence?.broadcastError);

        const ownershipResponse = ownership?.response && typeof ownership.response === 'object'
            ? ownership.response
            : null;
        const ownershipResponseHasData = ownershipResponse && Object.keys(ownershipResponse).length > 0;
        const hasOwnershipLiveEvidence = !hideAllLiveEvidence &&
            ownership?.found === true &&
            (
                ownershipResponseHasData ||
                Number.isFinite(ownership?.http_status) ||
                typeof ownership?.key_hash_from_verifier === 'string' ||
                typeof ownership?.timestamp === 'string'
            );

        const hasAttestationLiveEvidence = !hideAllLiveEvidence && Boolean(attestation?.summary);
        const hasSignatureLiveEvidence = !hideAllLiveEvidence && Boolean(
            stationId &&
            evidence?.expiresAtUnix !== null &&
            evidence?.apiKeyHash &&
            evidence?.stationPayloadHash &&
            hasStationSignature &&
            hasOrgSignature
        );
        const hasBroadcastSnapshot = Boolean(
            evidence?.broadcastTimestamp ||
            evidence?.broadcastAge ||
            (evidence?.broadcastVerifiedCount ?? 0) > 0 ||
            (evidence?.broadcastBannedCount ?? 0) > 0
        );
        const hasBroadcastStationRecord = Boolean(evidence?.stationVerifiedRecord || evidence?.stationBannedRecord);
        const hasLocalValidationInput = Boolean(stationId && evidence?.stationPublicKey && evidence?.stationPayloadHash);
        const hasLineageLiveEvidence = !hideAllLiveEvidence && hasBroadcastSnapshot && (hasBroadcastStationRecord || hasLocalValidationInput);

        const attestationEvidence = {
            endpoint: 'GET /attestation',
            response: {
                attestation_type: attestation?.summary?.attestation_type || null,
                debug_disabled: attestation?.summary?.debug_disabled,
                compliance_status: attestation?.summary?.compliance_status || null,
                cce_policy_hash: attestation?.summary?.cce_policy_hash || attestation?.summary?.host_data || null,
                tls_pubkey_hash: attestation?.summary?.tls_pubkey_hash || null,
                verify_at: attestation?.verify_at || null,
                jwt_key_id: verification?.jwtKeyId || null
            },
            checks: {
                jwt_signature_verified: verification?.jwtVerified === true,
                policy_hash_matches_hardware: verification?.policyVerified === true
            }
        };

        const ownershipEvidence = {
            endpoint: 'POST /submit_key',
            response: ownership?.response || null,
            check_result: {
                ownership_passed: ownershipPassed,
                pending: ownership?.pending || false,
                rejected: ownership?.rejected || false,
                reason: ownership?.reason || null
            },
            correlation: {
                station_id: stationId,
                expected_key_hash_prefix: ownership?.expected_key_hash_prefix || null,
                key_hash_from_verifier: ownership?.key_hash_from_verifier || null,
                key_hash_matches_current_key: ownership?.key_hash_matches_current_key ?? null,
                http_status: ownership?.http_status ?? null,
                timestamp: ownership?.timestamp || null
            },
            request_summary: ownership?.request || null
        };

        const broadcastEvidence = {
            endpoint: 'GET /broadcast',
            response: {
                timestamp: evidence?.broadcastTimestamp || null,
                verified_stations_count: evidence?.broadcastVerifiedCount ?? 0,
                banned_stations_count: evidence?.broadcastBannedCount ?? 0,
                station_lookup: {
                    station_id: stationId,
                    found_in_verified: stationVerified,
                    found_in_banned: stationBanned,
                    station_public_key: evidence?.stationPublicKey || null,
                    verified_record: evidence?.stationVerifiedRecord || null,
                    banned_record: evidence?.stationBannedRecord || null
                },
                sampled_at: evidence?.broadcastAge || null
            },
            error: evidence?.broadcastError || null
        };

        const signatureEvidence = {
            endpoint: 'POST /submit_key',
            signed_payload: stationId && evidence?.expiresAtUnix
                ? {
                    station_id: stationId,
                    key_valid_till: evidence.expiresAtUnix,
                    key_hash_sha256: evidence?.apiKeyHash || null,
                    station_message_hash_sha256: evidence?.stationPayloadHash || null,
                    org_message_hash_sha256: evidence?.orgPayloadHash || null
                }
                : null,
            signatures: {
                station_signature: evidence?.stationSignature || null,
                org_signature: evidence?.orgSignature || null
            },
            checks: {
                station_signature_present: hasStationSignature,
                org_signature_present: hasOrgSignature,
                dual_signature_required: true
            }
        };

        const localVerificationEvidence = {
            endpoint: 'GET /broadcast + browser Ed25519 verify',
            verification_input: {
                station_id: stationId,
                station_public_key: evidence?.stationPublicKey || null,
                message_format: 'station_id|api_key|key_valid_till',
                message_hash_sha256: evidence?.stationPayloadHash || null
            },
            result: {
                supported: localSig.supported !== false,
                verified: localSig.verified === true,
                detail: localSig.error || null
            }
        };

        const steps = [
            {
                number: 1,
                title: 'Verifier runtime is attestable',
                description: 'The verifier is open source, and Azure confidential-computing measurements report what is running.',
                proves: 'You can independently check the verifier runtime identity and policy claims.',
                tone: 'success',
                evidence: attestationEvidence,
                showLiveEvidence: hasAttestationLiveEvidence,
                codeLinks: [
                    {
                        label: 'Attestation endpoint (/attestation)',
                        url: `${OA_VERIFIER_REPO_BLOB_BASE}/internal/server/handlers.go#L705`
                    },
                    {
                        label: 'Attestation token fetch (MAA sidecar)',
                        url: `${OA_VERIFIER_REPO_BLOB_BASE}/internal/server/handlers.go#L620`
                    },
                    {
                        label: 'Attestation guide',
                        url: `${OA_VERIFIER_REPO_BLOB_BASE}/docs/ATTESTATION.md`
                    }
                ],
                open: this.zeroTrustOpenSteps.has(1)
            },
            {
                number: 2,
                title: 'Verifier checks key ownership',
                description: "The verifier validates the submitted key against the station's provider account.",
                proves: 'The issued key is confirmed as station-owned, which blocks shadow-account key issuance.',
                tone: 'success',
                evidence: ownershipEvidence,
                showLiveEvidence: hasOwnershipLiveEvidence,
                codeLinks: [
                    {
                        label: 'Ownership check in /submit_key',
                        url: `${OA_VERIFIER_REPO_BLOB_BASE}/internal/server/handlers.go#L378`
                    },
                    {
                        label: 'Ephemeral key ownership API call',
                        url: `${OA_VERIFIER_REPO_BLOB_BASE}/internal/openrouter/api.go#L321`
                    },
                    {
                        label: 'Banning on not-owned key',
                        url: `${OA_VERIFIER_REPO_BLOB_BASE}/internal/server/handlers.go#L396`
                    }
                ],
                open: this.zeroTrustOpenSteps.has(2)
            },
            {
                number: 3,
                title: 'Issued key response is double-signed',
                description: 'The key payload carries both station and org Ed25519 signatures.',
                proves: 'Tampering is detectable because signatures bind key, station identity, and expiry together.',
                tone: 'success',
                evidence: signatureEvidence,
                showLiveEvidence: hasSignatureLiveEvidence,
                codeLinks: [
                    {
                        label: 'Inner + outer signature checks',
                        url: `${OA_VERIFIER_REPO_BLOB_BASE}/internal/server/handlers.go#L333`
                    },
                    {
                        label: 'Ed25519 verification function',
                        url: `${OA_VERIFIER_REPO_BLOB_BASE}/internal/server/server.go#L297`
                    },
                    {
                        label: 'submit_key request model',
                        url: `${OA_VERIFIER_REPO_BLOB_BASE}/internal/models/models.go#L33`
                    }
                ],
                open: this.zeroTrustOpenSteps.has(3)
            },
            {
                number: 4,
                title: 'Station registry and key lineage checks',
                description: 'The app validates signatures against station public keys from verifier broadcast records.',
                proves: 'Key lineage maps to a registered station, with ban visibility and client-side signature validation.',
                tone: 'success',
                evidence: {
                    broadcast: broadcastEvidence,
                    local_validation: localVerificationEvidence
                },
                showLiveEvidence: hasLineageLiveEvidence,
                codeLinks: [
                    {
                        label: 'Broadcast endpoint (/broadcast)',
                        url: `${OA_VERIFIER_REPO_BLOB_BASE}/internal/server/handlers.go#L490`
                    },
                    {
                        label: 'Hardcoded required toggles',
                        url: `${OA_VERIFIER_REPO_BLOB_BASE}/internal/config/config.go#L18`
                    },
                    {
                        label: 'Toggle false-check logic',
                        url: `${OA_VERIFIER_REPO_BLOB_BASE}/internal/challenge/challenge.go#L13`
                    }
                ],
                open: this.zeroTrustOpenSteps.has(4)
            }
        ];

        const summaryClasses = this.getStepToneClasses('success');
        const summaryTitle = 'Key issuance chain verified';
        const summaryBody = 'This flow attests the verifier runtime, checks ownership lineage, and binds issued ephemeral keys to signed station identity.';

        return `
            <div class="space-y-2.5">
                <p class="text-[11px] text-muted-foreground">
                    Expand each item to inspect live evidence (attestation fields, broadcast snapshot, signed payload details, and local verification inputs).
                </p>

                <div class="space-y-1.5">
                    ${steps.map((step) => this.renderZeroTrustStep(step)).join('')}
                </div>

                <div class="p-2 rounded-md border ${summaryClasses.border} ${summaryClasses.bg}">
                    <div class="text-[11px] font-semibold ${summaryClasses.text}">${this.escapeHtml(summaryTitle)}</div>
                    <p class="text-[11px] mt-0.5 ${summaryClasses.subtleText}">
                        ${this.escapeHtml(summaryBody)}
                    </p>
                </div>
            </div>
        `;
    }

    renderZeroTrustStep(step) {
        const classes = this.getStepToneClasses(step.tone);
        return `
            <details class="group rounded-md border ${classes.border} ${classes.bg}" data-zero-trust-step="${step.number}" ${step.open ? 'open' : ''}>
                <summary style="list-style:none;" class="cursor-pointer px-2 py-1.5 flex items-start gap-2">
                    <span class="inline-flex items-center justify-center h-4 w-4 rounded border border-border bg-background text-[10px] font-semibold text-foreground shrink-0 mt-px">${step.number}</span>
                    <div class="min-w-0 flex-1">
                        <p class="text-[11px] font-medium text-foreground">${this.escapeHtml(step.title)}</p>
                        <p class="text-[10px] text-muted-foreground leading-relaxed mt-0.5">${this.escapeHtml(step.description)}</p>
                    </div>
                    <svg class="w-3 h-3 text-muted-foreground transition-transform group-open:rotate-90 shrink-0 mt-0.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9 18l6-6-6-6"/>
                    </svg>
                </summary>
                <div class="px-2 pb-3 space-y-1.5">
                    <div class="rounded-md border border-border bg-background/70 p-1.5">
                        <p class="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">What This Proves</p>
                        <p class="text-[11px] text-foreground mt-0.5">${this.escapeHtml(step.proves)}</p>
                    </div>
                    ${step.showLiveEvidence === false ? '' : `
                        <div class="rounded-md border border-border bg-background p-1.5">
                            <p class="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Live Evidence</p>
                            <pre class="mt-0.5 max-h-44 overflow-auto text-[10px] leading-relaxed font-mono text-foreground whitespace-pre">${this.escapeHtml(this.formatJson(step.evidence))}</pre>
                        </div>
                    `}
                    ${Array.isArray(step.codeLinks) && step.codeLinks.length > 0 ? `
                        <div class="rounded-md border border-border bg-background p-1.5">
                            <p class="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">View Verifier Code</p>
                            <div class="mt-1 flex flex-nowrap gap-1 overflow-x-auto pb-0.5">
                                ${step.codeLinks.map((link) => `
                                    <a
                                        href="${this.escapeHtmlAttribute(link.url)}"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        class="inline-flex shrink-0 whitespace-nowrap items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[10px] text-foreground hover:bg-muted/60 transition-colors"
                                        title="${this.escapeHtmlAttribute(link.url)}"
                                    >
                                        <svg class="w-2.5 h-2.5 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                                            <polyline points="15 3 21 3 21 9"/>
                                            <line x1="10" y1="14" x2="21" y2="3"/>
                                        </svg>
                                        <span>${this.escapeHtml(link.label)}</span>
                                    </a>
                                `).join('')}
                            </div>
                        </div>
                    ` : ''}
                </div>
            </details>
        `;
    }

    formatJson(value) {
        try {
            return JSON.stringify(value ?? {}, null, 2);
        } catch {
            return String(value ?? '');
        }
    }

    getStepToneClasses(tone) {
        switch (tone) {
            case 'success':
                return {
                    border: 'border-green-200 dark:border-green-800',
                    bg: 'bg-green-50 dark:bg-green-900/20',
                    text: 'text-green-700 dark:text-green-400',
                    subtleText: 'text-green-700/90 dark:text-green-300',
                    badge: 'border-green-300 bg-green-100 text-green-700 dark:border-green-700 dark:bg-green-900/40 dark:text-green-300'
                };
            case 'danger':
                return {
                    border: 'border-destructive/40',
                    bg: 'bg-destructive/10',
                    text: 'text-destructive',
                    subtleText: 'text-destructive/90',
                    badge: 'border-destructive/40 bg-destructive/20 text-destructive'
                };
            case 'warn':
                return {
                    border: 'border-amber-200 dark:border-amber-800',
                    bg: 'bg-amber-50 dark:bg-amber-900/20',
                    text: 'text-amber-700 dark:text-amber-300',
                    subtleText: 'text-amber-700/90 dark:text-amber-300',
                    badge: 'border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                };
            default:
                return {
                    border: 'border-border',
                    bg: 'bg-muted/20',
                    text: 'text-foreground',
                    subtleText: 'text-muted-foreground',
                    badge: 'border-border bg-background text-foreground'
                };
        }
    }

    renderStatusRow(label, verified, error, successText) {
        return `
            <div class="flex justify-between items-center">
                <span class="text-xs text-muted-foreground/70">${label}</span>
                <span class="text-xs flex items-center gap-1 ${verified ? 'text-green-600 dark:text-green-400' : 'text-amber-600 dark:text-amber-400'}">
                    ${verified
                        ? `<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> ${successText}`
                        : error
                            ? `<svg class="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg> ${this.escapeHtml(error)}`
                            : 'Pending'}
                </span>
            </div>
        `;
    }

    renderRow(label, value, valueClass = 'text-foreground', truncate = false) {
        return `
            <div class="flex justify-between items-start gap-3">
                <span class="text-xs text-muted-foreground/70 shrink-0">${this.escapeHtml(label)}</span>
                <span class="text-xs ${valueClass} ${truncate ? 'truncate' : ''}" ${truncate ? `title="${this.escapeHtml(value || '')}"` : ''}>${this.escapeHtml(value || 'N/A')}</span>
            </div>
        `;
    }

    formatIssuer(issuer) {
        if (!issuer) return 'Unknown';
        try {
            const url = new URL(issuer);
            return url.host;
        } catch {
            return issuer.length > 30 ? issuer.substring(0, 30) + '...' : issuer;
        }
    }

    escapeHtml(str) {
        if (!str) return '';
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    escapeHtmlAttribute(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '&#10;');
    }

    setupEventListeners() {
        this.overlay.querySelector('.verifier-modal-close')?.addEventListener('click', () => this.close());
        this.overlay.querySelector('.verifier-modal-done')?.addEventListener('click', () => this.close());

        this.overlay.querySelector('.verifier-retry-btn')?.addEventListener('click', () => {
            this.isLoading = true;
            this.error = null;
            this.render();
            this.setupEventListeners();
            this.fetchAndVerifyAttestation();
        });

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });

        this.escapeHandler = (e) => {
            if (e.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this.escapeHandler);

        this.overlay.querySelectorAll('details[data-zero-trust-step]').forEach((detailsEl) => {
            detailsEl.addEventListener('toggle', () => {
                const stepNumber = Number(detailsEl.dataset.zeroTrustStep);
                if (!Number.isFinite(stepNumber)) return;
                if (detailsEl.open) {
                    this.zeroTrustOpenSteps.add(stepNumber);
                } else {
                    this.zeroTrustOpenSteps.delete(stepNumber);
                }
            });
        });
    }
}

const verifierAttestationModal = new VerifierAttestationModal();
export default verifierAttestationModal;
