import http from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const port = Number.parseInt(process.env.OA_CHAT_DEV_PORT || '8080', 10);
const chatRoot = resolve('chat');
const orgTarget = new URL(
    process.env.OA_ORG_DEV_URL || 'http://127.0.0.1:8005'
);
const contentTypes = new Map([
    ['.css', 'text/css; charset=utf-8'],
    ['.html', 'text/html; charset=utf-8'],
    ['.ico', 'image/x-icon'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.json', 'application/json; charset=utf-8'],
    ['.mjs', 'text/javascript; charset=utf-8'],
    ['.png', 'image/png'],
    ['.svg', 'image/svg+xml'],
    ['.wasm', 'application/wasm'],
    ['.woff', 'font/woff'],
    ['.woff2', 'font/woff2']
]);

function safeStaticPath(pathname) {
    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        return null;
    }
    const candidate = resolve(chatRoot, `.${decoded}`);
    if (candidate !== chatRoot && !candidate.startsWith(`${chatRoot}${sep}`)) {
        return null;
    }
    return candidate;
}

async function findStaticFile(pathname) {
    const candidate = safeStaticPath(pathname);
    if (!candidate) return null;
    try {
        const metadata = await stat(candidate);
        if (metadata.isFile()) return { path: candidate, metadata };
        if (metadata.isDirectory()) {
            const indexPath = resolve(candidate, 'index.html');
            const indexMetadata = await stat(indexPath);
            if (indexMetadata.isFile()) {
                return { path: indexPath, metadata: indexMetadata };
            }
        }
    } catch {
        return null;
    }
    return null;
}

async function serveStatic(
    request,
    response,
    file,
    { clearCache = false } = {}
) {
    const isIndex = file.path === resolve(chatRoot, 'index.html');
    const body = isIndex
        ? (await readFile(file.path, 'utf8')).replace(
            '</head>',
            '<script>globalThis.__OA_LOCAL_ORG_PROXY__ = true;</script></head>'
        )
        : null;
    response.statusCode = 200;
    response.setHeader(
        'Content-Type',
        contentTypes.get(extname(file.path).toLowerCase()) ||
            'application/octet-stream'
    );
    response.setHeader(
        'Content-Length',
        body === null ? file.metadata.size : Buffer.byteLength(body)
    );
    response.setHeader('Cache-Control', 'no-store');
    if (clearCache) {
        response.setHeader('Clear-Site-Data', '"cache"');
    }
    if (request.method === 'HEAD') {
        response.end();
        return;
    }
    if (body !== null) {
        response.end(body);
        return;
    }
    createReadStream(file.path).pipe(response);
}

function proxyToOrg(request, response) {
    const headers = { ...request.headers, host: orgTarget.host };
    const proxyRequest = http.request({
        protocol: orgTarget.protocol,
        hostname: orgTarget.hostname,
        port: orgTarget.port,
        method: request.method,
        path: request.url,
        headers
    }, proxyResponse => {
        response.writeHead(
            proxyResponse.statusCode || 502,
            proxyResponse.statusMessage,
            proxyResponse.headers
        );
        proxyResponse.pipe(response);
    });
    proxyRequest.on('error', error => {
        if (response.headersSent) {
            response.destroy(error);
            return;
        }
        response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(`Local org proxy unavailable: ${error.message}`);
    });
    request.pipe(proxyRequest);
}

const server = http.createServer(async (request, response) => {
    const host = request.headers.host || '';
    if (host === '127.0.0.1' || host === `127.0.0.1:${port}`) {
        response.writeHead(307, {
            Location: `http://localhost:${port}${request.url || '/'}`
        });
        response.end();
        return;
    }
    const requestUrl = new URL(request.url || '/', 'http://localhost');
    const canServeStatic = request.method === 'GET' || request.method === 'HEAD';
    const file = canServeStatic
        ? await findStaticFile(requestUrl.pathname)
        : null;
    if (file) {
        await serveStatic(request, response, file, {
            clearCache: requestUrl.searchParams.get('oa-clear-cache') === '1'
        });
        return;
    }
    proxyToOrg(request, response);
});

server.listen(port, '127.0.0.1', () => {
    console.log(`oa-chat: http://localhost:${port}`);
    console.log(`local org proxy: ${orgTarget.origin}`);
});
