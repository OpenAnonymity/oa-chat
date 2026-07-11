import { getProviderAsset, resolveProvider } from './providerRegistry.js';

const DEFAULT_CLASSES = 'w-3.5 h-3.5';
const FALLBACK_CLASSES = 'text-[10px] font-semibold';
let listenerDocument = null;

function escapeHtmlAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function getProviderInitial(provider) {
    const match = typeof provider === 'string' ? provider.match(/[a-z0-9]/i) : null;
    return match ? match[0].toUpperCase() : 'A';
}

function buildFallback(provider, hidden = false, classes = '') {
    const className = [classes, FALLBACK_CLASSES].filter(Boolean).join(' ');
    return `<span${hidden ? ' hidden' : ''} data-provider-icon-fallback class="${escapeHtmlAttribute(className)}">${escapeHtmlAttribute(getProviderInitial(provider))}</span>`;
}

function installProviderIconErrorFallback() {
    if (typeof document === 'undefined'
        || typeof document.addEventListener !== 'function'
        || document === listenerDocument) {
        return;
    }

    document.addEventListener('error', (event) => {
        const image = event.target;
        if (!image?.matches?.('img[data-provider-icon]')) {
            return;
        }

        image.hidden = true;
        const fallback = image.nextElementSibling;
        if (fallback?.matches?.('[data-provider-icon-fallback]')) {
            fallback.hidden = false;
        }
    }, true);
    listenerDocument = document;
}

/**
 * Gets an icon for a provider.
 * @param {string} provider - Provider name or registered author slug.
 * @param {string} classes - Optional CSS classes for the icon.
 * @returns {{ html: string, hasIcon: boolean }}
 */
export function getProviderIcon(provider, classes = DEFAULT_CLASSES) {
    installProviderIconErrorFallback();

    const metadata = resolveProvider(provider);
    const asset = getProviderAsset(metadata.displayName);
    if (!asset || !asset.startsWith('img/')) {
        return {
            html: buildFallback(provider),
            hasIcon: false
        };
    }

    const escapedClasses = escapeHtmlAttribute(classes);
    const escapedAsset = escapeHtmlAttribute(asset);
    const escapedAlt = escapeHtmlAttribute(metadata.displayName);
    return {
        html: `<img data-provider-icon src="${escapedAsset}" class="${escapedClasses}" alt="${escapedAlt}" />${buildFallback(provider, true, classes)}`,
        hasIcon: true
    };
}

installProviderIconErrorFallback();
