/**
 * Proxy Info Modal Component
 * Explains what the network proxy is and how it works
 */

class ProxyInfoModal {
    constructor() {
        this.isOpen = false;
        this.overlay = null;
    }

    open() {
        if (this.isOpen) return;
        this.isOpen = true;

        document.querySelector('.proxy-info-modal')?.remove();

        this.overlay = document.createElement('div');
        this.overlay.className = 'proxy-info-modal fixed inset-0 z-50 flex items-center justify-center bg-black/50 animate-in fade-in';

        this.render();
        document.body.appendChild(this.overlay);
        this.setupEventListeners();
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

    render() {
        this.overlay.innerHTML = `
            <div class="bg-background rounded-xl shadow-2xl max-w-lg w-full mx-4 animate-in zoom-in-95 overflow-hidden max-h-[85vh] flex flex-col">
                <!-- Header -->
                <div class="p-4 flex items-center justify-between shrink-0">
                    <div class="flex items-center gap-2">
                        <div class="flex h-8 w-8 items-center justify-center rounded-lg bg-muted/50">
                            <svg class="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
                                <circle cx="12" cy="9" r="8"/>
                                <path d="M4 9h16"/>
                                <path d="M12 1a12 12 0 0 1 3.5 8 12 12 0 0 1-3.5 8 12 12 0 0 1-3.5-8A12 12 0 0 1 12 1z"/>
                                <path d="M12 17v4"/>
                                <circle cx="12" cy="22" r="1.5" fill="currentColor"/>
                                <path d="M4 22h6m4 0h6"/>
                            </svg>
                        </div>
                        <h2 class="text-sm font-semibold text-foreground">Network Proxy</h2>
                        <span class="px-1 py-0.5 rounded text-[8px] font-medium bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400 uppercase tracking-wide">Beta</span>
                    </div>
                    <button class="proxy-info-close text-muted-foreground hover:text-foreground transition-colors p-1.5 rounded-lg hover:bg-muted/50">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                        </svg>
                    </button>
                </div>

                <!-- Content -->
                <div class="px-5 pt-1 pb-0 space-y-3 overflow-y-auto flex-1">
                    <div class="space-y-3">
                        <p class="text-xs text-muted-foreground/80">
                            OA provides an in-browser, VPN-like encrypted tunnel when accessing models with OA-issued ephemeral access keys. This hides your IP/metadata side-channels from the model provider, preventing network-level fingerprinting.
                        </p>

                        <!-- How it works -->
                        <div class="space-y-2">
                            <h3 class="text-xs font-medium text-foreground">How it works</h3>
                            <ul class="pl-3 space-y-1 text-xs">
                                <li class="flex items-start gap-2">
                                    <span class="text-muted-foreground/60 mt-0.5">→</span>
                                    <span class="text-muted-foreground/70">Your browser connects to our relay server via WebSocket</span>
                                </li>
                                <li class="flex items-start gap-2">
                                    <span class="text-muted-foreground/60 mt-0.5">→</span>
                                    <span class="text-muted-foreground/70">Inside that WebSocket, your browser establishes a separate TLS connection (using mbedTLS/WASM) directly to model provider</span>
                                </li>
                                <li class="flex items-start gap-2">
                                    <span class="text-muted-foreground/60 mt-0.5">→</span>
                                    <span class="text-muted-foreground/70">Encrypted prompts and responses travel through this tunnel directly to and from the model provider</span>
                                </li>
                            </ul>
                        </div>

                        <!-- Security Properties -->
                        <div class="space-y-2">
                            <h3 class="text-xs font-medium text-foreground">Security Properties</h3>
                            <ul class="pl-3 space-y-1 text-xs">
                                <li class="text-muted-foreground/70">• Same encryption guarantees as traditional VPN</li>
                                <li class="text-muted-foreground/70">• Relay servers only see encrypted blobs (no plaintext prompts or responses)</li>
                                <li class="text-muted-foreground/70">• Your IP/metadata is hidden from the model provider</li>
                            </ul>
                        </div>

                        <p class="text-xs text-muted-foreground/60 pt-1">
                            Click Security Details below to verify the TLS implementation and inspect connection info.
                        </p>
                    </div>
                </div>

                <!-- Footer -->
                <div class="px-5 py-2 flex justify-end shrink-0">
                    <button class="proxy-info-done px-3 py-1 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-all duration-200">
                        Done
                    </button>
                </div>
            </div>
        `;
    }

    setupEventListeners() {
        this.overlay.querySelector('.proxy-info-close')?.addEventListener('click', () => this.close());
        this.overlay.querySelector('.proxy-info-done')?.addEventListener('click', () => this.close());

        this.overlay.addEventListener('click', (e) => {
            if (e.target === this.overlay) this.close();
        });

        this.escapeHandler = (e) => {
            if (e.key === 'Escape') this.close();
        };
        document.addEventListener('keydown', this.escapeHandler);
    }
}

const proxyInfoModal = new ProxyInfoModal();
export default proxyInfoModal;

