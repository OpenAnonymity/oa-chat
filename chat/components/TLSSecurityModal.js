/**
 * TLS Security Modal Component
 * Shows VERIFIABLE security information - not just parsed strings
 */

import networkProxy from '../services/networkProxy.js';
import inferenceService from '../services/inference/inferenceService.js';
import { ORG_API_BASE } from '../config.js';
const LIBCURL_ASSET_URL = 'vendor/libcurl/libcurl_full.js';
const LIBCURL_VERSION = '0.7.1';

class TLSSecurityModal {
    constructor() {
        this.isOpen = false;
        this.overlay = null;
        this.wasmIntegrity = null; // { localHash, expectedHash, verified, source, error }
        this.isVerifying = false;
    }

    async open() {
        if (this.isOpen) return;
        this.isOpen = true;

        document.querySelector('.tls-security-modal')?.remove();

        this.overlay = document.createElement('div');
        this.overlay.className = 'tls-security-modal fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-in fade-in';

        this.render();
        document.body.appendChild(this.overlay);
        this.setupEventListeners();

        // Verify WASM integrity on first open
        if (!this.wasmIntegrity) {
            this.verifyWasmIntegrity();
        }
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

    async verifyWasmIntegrity() {
        this.isVerifying = true;
        this.render();
        this.setupEventListeners();

        try {
            // libcurl.js bundles WASM inside libcurl_full.js (no separate .wasm file)
            // Verify the locally hosted JS asset that the app loads

            let localHash = null;
            let source = 'local';

            // Fetch the local libcurl_full.js and compute hash
            try {
                const response = await fetch(LIBCURL_ASSET_URL, {
                    signal: AbortSignal.timeout(10000),
                    cache: 'force-cache', // Use cached version (same as what browser loaded)
                    credentials: 'omit'
                });
                if (response.ok) {
                    const jsBuffer = await response.arrayBuffer();
                    const hashBuffer = await crypto.subtle.digest('SHA-256', jsBuffer);
                    localHash = Array.from(new Uint8Array(hashBuffer))
                        .map(b => b.toString(16).padStart(2, '0'))
                        .join('');
                }
            } catch (e) {
                console.debug('Could not fetch local libcurl_full.js:', e);
            }

            // For now, just show the hash and local source for transparency
            this.wasmIntegrity = {
                localHash,
                source,
                version: LIBCURL_VERSION,
                assetUrl: LIBCURL_ASSET_URL,
                verified: !!localHash,
                error: !localHash ? 'Could not fetch local asset' : null
            };
        } catch (e) {
            console.error('WASM integrity verification failed:', e);
            this.wasmIntegrity = { error: e.message };
        }

        this.isVerifying = false;
        this.render();
        this.setupEventListeners();
    }

    render() {
        const status = networkProxy.getStatus();
        const tlsInfo = networkProxy.getTlsInfo();
        const isEncrypted = status.enabled && status.usingProxy;
        const libcurl = window.libcurl;

        const tlsTargetName = inferenceService.getTlsDisplayName();
        this.overlay.innerHTML = `
            <div class="tls-modal-content bg-background border border-border rounded-xl shadow-2xl max-w-xl w-full mx-4 animate-in zoom-in-95 overflow-hidden max-h-[90vh] flex flex-col">
                <!-- Header -->
                <div class="p-4 flex items-center justify-between shrink-0">
                    <div class="flex items-center gap-2">
                        <div class="flex h-8 w-8 items-center justify-center rounded-lg ${isEncrypted ? 'bg-status-success/15' : 'bg-muted/50'}">
                            <svg class="w-4 h-4 ${isEncrypted ? 'text-status-success' : 'text-muted-foreground'}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                ${isEncrypted
                                    ? '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
                                    : '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>'
                                }
                            </svg>
                        </div>
                        <h2 class="text-sm font-semibold text-foreground">Network Proxy Security Details</h2>
                        <span class="px-1 py-0.5 rounded text-[8px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400 uppercase tracking-wide">Beta</span>
                    </div>
                    <button class="tls-modal-close text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-lg hover:bg-muted/50">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                    </button>
                </div>

                <!-- Content -->
                <div class="px-5 pb-0 space-y-4 overflow-y-auto flex-1 min-h-0">

                    <!-- TLS Implementation -->
                    <div class="space-y-2">
                        <h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                            TLS Implementation
                        </h3>
                        <div class="p-4 rounded-lg border border-border bg-card space-y-2">
                            <div class="flex justify-between items-start">
                                <span class="text-xs text-muted-foreground">Library</span>
                                <span class="text-xs font-mono text-foreground">mbedTLS (WASM)</span>
                            </div>
                            <div class="flex justify-between items-start">
                                <span class="text-xs text-muted-foreground">Source</span>
                                <a href="https://github.com/ading2210/libcurl.js" target="_blank" rel="noopener" class="text-xs font-mono text-blue-500 hover:underline">libcurl.js</a>
                            </div>
                            <div class="flex justify-between items-start">
                                <span class="text-xs text-muted-foreground">Version</span>
                                <span class="text-xs font-mono text-foreground">${libcurl?.version?.lib || 'Unknown'}</span>
                            </div>
                            ${this.renderWasmIntegrity()}
                        </div>
                    </div>

                    <!-- Current Connection Info (if available) -->
                    ${tlsInfo.version ? this.renderConnectionInfo(tlsInfo) : this.renderNoConnection(status)}

                    <!-- How to Verify Yourself -->
                    <details class="rounded-lg border border-border bg-card">
                        <summary class="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground transition-colors px-4 py-3">
                            How to Verify Yourself (click to expand)
                        </summary>
                        <div class="px-4 pb-4 space-y-2 text-[11px]">
                            <details class="group border border-border/60 rounded-md bg-background">
                                <summary class="px-2 py-1.5 cursor-pointer flex items-center gap-2 hover:bg-muted/50 rounded-md">
                                    <svg class="w-3 h-3 transition-transform group-open:rotate-90 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
                                    <span class="font-medium">1. Check WebSocket frames in DevTools</span>
                                </summary>
                                <div class="px-2.5 pb-1.5 text-muted-foreground space-y-1.5">
                                    <p>Open DevTools → Network → WS → Click the WebSocket connection</p>
                                    <p>Look at "Messages" tab. You should see:</p>
                                    <ul class="list-disc list-inside pl-2 space-y-0.5">
                                        <li><strong class="text-foreground">Binary frames</strong> (not readable text)</li>
                                        <li>TLS record headers start with <code class="bg-slate-200 dark:bg-slate-700 px-1 rounded">0x16</code> (handshake) or <code class="bg-slate-200 dark:bg-slate-700 px-1 rounded">0x17</code> (app data)</li>
                                    </ul>
                                    <p class="text-amber-600 dark:text-amber-400">If you see readable JSON/text, it's NOT encrypted!</p>
                                </div>
                            </details>

                            <details class="group border border-border/60 rounded-md bg-background">
                                <summary class="px-2 py-1.5 cursor-pointer flex items-center gap-2 hover:bg-muted/50 rounded-md">
                                    <svg class="w-3 h-3 transition-transform group-open:rotate-90 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
                                    <span class="font-medium">2. Verify the WASM source</span>
                                </summary>
                                <div class="px-2.5 pb-1.5 text-muted-foreground space-y-1.5">
                                    <p>The TLS is handled by <code class="bg-slate-200 dark:bg-slate-700 px-1 rounded">libcurl_full.js</code></p>
                                    <p>This is compiled from:</p>
                                    <ul class="list-disc list-inside pl-2">
                                        <li><a href="https://github.com/ading2210/libcurl.js" class="text-blue-500 hover:underline" target="_blank">libcurl.js</a> - WASM port of libcurl</li>
                                        <li>Uses <a href="https://github.com/Mbed-TLS/mbedtls" class="text-blue-500 hover:underline" target="_blank">mbedTLS</a> for cryptography</li>
                                    </ul>
                                    <p>You can rebuild from source and compare hashes.</p>
                                </div>
                            </details>

                            <details class="group border border-border/60 rounded-md bg-background">
                                <summary class="px-2 py-1.5 cursor-pointer flex items-center gap-2 hover:bg-muted/50 rounded-md">
                                    <svg class="w-3 h-3 transition-transform group-open:rotate-90 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
                                    <span class="font-medium">3. Use Wireshark for deep inspection</span>
                                </summary>
                                <div class="px-2.5 pb-1.5 text-muted-foreground space-y-1.5">
                                    <p>Capture traffic on your network interface:</p>
                                    <ul class="list-disc list-inside pl-2">
                                        <li>WebSocket frames to proxy should contain TLS records</li>
                                        <li>You should NOT see plaintext HTTP to ${tlsTargetName}</li>
                                        <li>The proxy only sees encrypted blobs</li>
                                    </ul>
                                </div>
                            </details>
                        </div>
                    </details>

                    <!-- Trust Model -->
                    <div class="space-y-2">
                        <h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                            <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>
                            What You're Trusting
                        </h3>
                        <div class="p-4 rounded-lg border border-border bg-card text-xs space-y-2">
                            <div class="flex items-start gap-2">
                                <span class="text-status-success">✓</span>
                                <div>
                                    <strong class="text-foreground">mbedTLS crypto</strong>
                                    <span class="text-muted-foreground"> — widely audited, used by millions of devices</span>
                                </div>
                            </div>
                            <div class="flex items-start gap-2">
                                <span class="text-status-success">✓</span>
                                <div>
                                    <strong class="text-foreground">libcurl.js WASM</strong>
                                    <span class="text-muted-foreground"> — open source, you can audit/rebuild</span>
                                </div>
                            </div>
                            <div class="flex items-start gap-2">
                                <span class="text-status-success">✓</span>
                                <div>
                                    <strong class="text-foreground">Local static assets</strong>
                                    <span class="text-muted-foreground"> — bundled locally for consistent integrity</span>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>

                <!-- Footer -->
                <div class="px-5 py-2 flex justify-end shrink-0">
                    <button class="tls-modal-done px-3 py-1 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-200">
                        Done
                    </button>
                </div>
            </div>
        `;
    }

    renderWasmIntegrity() {
        if (this.isVerifying) {
            return `
                <div class="flex justify-between items-start gap-2">
                    <span class="text-xs text-muted-foreground shrink-0">Asset Source</span>
                    <span class="text-xs font-mono text-muted-foreground">⏳ Verifying...</span>
                </div>
            `;
        }

        const integrity = this.wasmIntegrity;
        if (!integrity) {
            return `
                <div class="flex justify-between items-start gap-2">
                    <span class="text-xs text-muted-foreground shrink-0">Asset Source</span>
                    <span class="text-xs font-mono text-muted-foreground">Not checked</span>
                </div>
            `;
        }

        if (integrity.verified && integrity.localHash) {
            return `
                <div class="flex justify-between items-start gap-2">
                    <span class="text-xs text-muted-foreground shrink-0">Asset Source</span>
                    <a href="${integrity.assetUrl}" target="_blank" rel="noopener" class="text-xs font-mono text-blue-500 hover:underline">Local asset</a>
                </div>
                <div class="flex justify-between items-start gap-2">
                    <span class="text-xs text-muted-foreground shrink-0">SHA-256</span>
                    <span class="text-xs font-mono text-foreground truncate" title="${integrity.localHash}">${integrity.localHash?.substring(0, 16)}...</span>
                </div>
            `;
        }

        if (integrity.error) {
            return `
                <div class="flex justify-between items-start gap-2">
                    <span class="text-xs text-muted-foreground shrink-0">Asset Source</span>
                    <span class="text-xs font-mono text-amber-600 dark:text-amber-400">Local asset</span>
                </div>
                <div class="text-xs text-muted-foreground">
                    Hash check unavailable
                </div>
            `;
        }

        return '';
    }

    renderConnectionInfo(tlsInfo) {
        const settings = networkProxy.getSettings();
        const proxyUrl = settings.url;

        return `
            <div class="space-y-2">
                <h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                    Current Connection
                </h3>
                <div class="p-4 rounded-lg border border-border bg-card text-xs">
                    <div class="space-y-1.5 font-mono text-muted-foreground">
                        ${proxyUrl ? `<div class="flex justify-between"><span>Relay Server</span><span class="text-foreground truncate ml-2" title="${proxyUrl}">${this.formatProxyHostname(proxyUrl)}</span></div>` : ''}
                        ${tlsInfo.version ? `<div class="flex justify-between"><span>TLS Version</span><span class="text-foreground">${tlsInfo.version}</span></div>` : ''}
                        ${tlsInfo.cipher ? `<div class="flex justify-between"><span>Cipher</span><span class="text-foreground">${tlsInfo.cipher}</span></div>` : ''}
                        ${tlsInfo.certSubject ? `<div class="flex justify-between"><span>Certificate</span><span class="text-foreground">${this.formatCertName(tlsInfo.certSubject)}</span></div>` : ''}
                        ${tlsInfo.certIssuer ? `<div class="flex justify-between"><span>Issuer</span><span class="text-foreground">${this.formatCertName(tlsInfo.certIssuer)}</span></div>` : ''}
                        ${tlsInfo.alpn ? `<div class="flex justify-between"><span>Protocol</span><span class="text-foreground">${tlsInfo.alpn}</span></div>` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    renderNoConnection(status) {
        if (!status.enabled) {
            return `
                <div class="p-4 rounded-lg border border-border bg-card text-center text-xs text-muted-foreground">
                    Proxy disabled — using browser's native TLS (verifiable in DevTools Security tab)
                </div>
            `;
        }

        const settings = networkProxy.getSettings();
        const proxyUrl = settings.url;

        return `
            <div class="space-y-2">
                <h3 class="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                    <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                    Current Connection
                </h3>
                <div class="p-4 rounded-lg border border-border bg-card text-xs">
                    ${proxyUrl ? `
                        <div class="flex justify-between font-mono text-muted-foreground mb-2">
                            <span>Relay Server</span>
                            <span class="text-foreground truncate ml-2" title="${proxyUrl}">${this.formatProxyHostname(proxyUrl)}</span>
                        </div>
                    ` : ''}
                    <p class="text-center text-muted-foreground truncate" title="No TLS captured yet. Make a proxied request to see details.">No TLS captured yet. Make a proxied request to see details.</p>
                </div>
            </div>
        `;
    }

    formatCertName(certString) {
        const cnMatch = certString.match(/CN=([^,]+)/i);
        if (cnMatch) return cnMatch[1];
        const parts = certString.split(',');
        return parts[0]?.replace(/^[A-Z]+=/, '') || certString;
    }

    formatProxyHostname(url) {
        if (!url) return '';
        try {
            const parsed = new URL(url);
            return parsed.host;
        } catch {
            return url;
        }
    }

    setupEventListeners() {
        this.overlay.querySelector('.tls-modal-close')?.addEventListener('click', () => this.close());
        this.overlay.querySelector('.tls-modal-done')?.addEventListener('click', () => this.close());

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });

        this.escapeHandler = (e) => {
            if (e.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this.escapeHandler);
    }
}

const tlsSecurityModal = new TLSSecurityModal();
export default tlsSecurityModal;
