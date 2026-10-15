// Exact-source compatibility patch; applied and recorded by patch-zkapi-sdk.mjs.
export default {
    "name": "desktop-assets-v1",
    "revision": "3342c95871e8422bb878ad40072687c241a68a5b",
    "files": [
        {
            "file": "sdk/configure.js",
            "beforeSha256": "2859ecab058ece8fb28673ca6485225581cf14d2f289e0abb264d65a3ab89073",
            "afterSha256": "1f0285eb404dba9c240c8a85126efb89df17f3211cde99c967a7ca791dc995cb",
            "replacements": [
                {
                    "before": "function absoluteUrl(value, label) {",
                    "after": "// Electron's standard app scheme reports an opaque origin in URL parsers.\n// Match the actual host and page explicitly; never allow arbitrary app URLs.\nexport function isDesktopAssetUrl(url) {\n    const page = globalThis.location?.href;\n    if (!page) return false;\n    const current = new URL(page);\n    return [current, url].every(value => value.protocol === 'app:'\n        && value.hostname === 'openanonymity.ai' && !value.port\n        && !value.username && !value.password);\n}\n\nfunction absoluteUrl(value, label) {"
                },
                {
                    "before": "if (!['https:', 'http:', 'file:'].includes(url.protocol)) {",
                    "after": "if (!['https:', 'http:', 'file:'].includes(url.protocol) && !isDesktopAssetUrl(url)) {"
                }
            ]
        },
        {
            "file": "sdk/services/browserWalletRuntime.js",
            "beforeSha256": "09cf761c7071cf1fe2e4f9724cb038878c7fa9bb4a5cbdd6f06afbdcad56dc08",
            "afterSha256": "617733063d853a9f7b2b80514d20f5128a16fbd505305e5d6bddd96b2e3b9b7e",
            "replacements": [
                {
                    "before": "import { browserSdkOptions, beginBrowserSdkInitialization, browserSdkTransport } from '../configure.js';",
                    "after": "import { browserSdkOptions, beginBrowserSdkInitialization, browserSdkTransport, isDesktopAssetUrl } from '../configure.js';"
                },
                {
                    "before": "    deploymentProxyUrl(url) {\n        const proxyPath",
                    "after": "    deploymentProxyUrl(url) {\n        // The packaged desktop serves bundled files, not Vercel API rewrites.\n        // Keep remote requests on the existing cookie-free host transport.\n        if (isDesktopAssetUrl(new URL(location.href))) return null;\n        const proxyPath"
                }
            ]
        }
    ]
};
