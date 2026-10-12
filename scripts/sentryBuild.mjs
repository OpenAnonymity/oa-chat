import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

export function resolveSentryConfig(env = process.env) {
    const dsn = env.SENTRY_DSN?.trim();
    if (!dsn) return null;
    let url;
    try { url = new URL(dsn); } catch { throw new Error('SENTRY_DSN must be a valid Sentry HTTPS DSN.'); }
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.sentry.io') ||
        !/^[a-f0-9]+$/i.test(url.username) || url.password || url.port ||
        !/^\/\d+$/.test(url.pathname) || url.search || url.hash) {
        throw new Error('SENTRY_DSN must be a Sentry HTTPS DSN with a public key and numeric project ID.');
    }
    const environment = env.SENTRY_ENVIRONMENT || env.VERCEL_ENV || 'development';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(environment) || environment === 'None') {
        throw new Error('SENTRY_ENVIRONMENT must be a short environment label.');
    }
    const release = env.SENTRY_RELEASE || env.VERCEL_GIT_COMMIT_SHA || '';
    if (release && !/^[a-zA-Z0-9_.@+-]{1,200}$/.test(release)) {
        throw new Error('SENTRY_RELEASE must be a version or commit identifier.');
    }
    return { dsn, environment, release };
}

export async function injectSentry(html, { outDir, outputs, config }) {
    if (!config) return html;
    const scriptPaths = Object.keys(outputs).filter(file => file.endsWith('.js'))
        .map(file => `/${path.relative(outDir, path.resolve(file)).split(path.sep).join('/')}`);
    const result = await esbuild.build({
        entryPoints: [fileURLToPath(new URL('./sentry/browser.mjs', import.meta.url))],
        bundle: true, format: 'iife', platform: 'browser', target: ['es2020'],
        outdir: path.join(outDir, 'assets'), entryNames: 'sentry-[hash]',
        minify: true, metafile: true, logLevel: 'silent',
        define: { __OA_SENTRY_CONFIG__: JSON.stringify({ ...config, scriptPaths }) }
    });
    const script = Object.keys(result.metafile.outputs).find(file => file.endsWith('.js'));
    const src = path.relative(outDir, path.resolve(script)).split(path.sep).join('/');
    return html.replace('</head>', `    <script src="${src}"></script>\n</head>`);
}
