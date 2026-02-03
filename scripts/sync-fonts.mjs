#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const fontsDir = path.join(repoRoot, 'chat', 'fonts');
const cssPath = path.join(fontsDir, 'fonts.css');

const DEFAULT_GOOGLE_FONTS_URL =
  'https://fonts.googleapis.com/css2?family=Cormorant:ital,wght@0,300..700;1,300..700&family=Fira+Code:wght@300..700&family=Libre+Caslon+Text:ital,wght@0,400;0,700;1,400&family=Source+Serif+4:ital,opsz,wght@0,8..60,200..900;1,8..60,200..900&family=PT+Serif:ital,wght@0,400;0,700;1,400;1,700&display=swap';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const args = process.argv.slice(2);
const urlArg = args.find(arg => !arg.startsWith('--')) || DEFAULT_GOOGLE_FONTS_URL;
const force = args.includes('--force');
const concurrency = Math.max(
  1,
  Number(args.find(arg => arg.startsWith('--concurrency='))?.split('=')[1] || 6)
);

async function fetchText(url) {
  if (typeof fetch === 'function') {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Failed to fetch CSS (${res.status})`);
    return await res.text();
  }
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': UA } }, res => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to fetch CSS (${res.statusCode})`));
          res.resume();
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (data += chunk));
        res.on('end', () => resolve(data));
      })
      .on('error', reject);
  });
}

async function fetchBuffer(url) {
  if (typeof fetch === 'function') {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`Failed to fetch font (${res.status})`);
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { 'User-Agent': UA } }, res => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to fetch font (${res.statusCode})`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      })
      .on('error', reject);
  });
}

function extractUrls(cssText) {
  const matches = cssText.matchAll(/url\((https:[^)]+)\)/g);
  const urls = new Set();
  for (const match of matches) {
    urls.add(match[1]);
  }
  return [...urls].filter(url => url.endsWith('.woff2'));
}

function rewriteCss(cssText) {
  return cssText.replace(/url\((https:[^)]+)\)/g, (full, url) => {
    const basename = path.basename(new URL(url).pathname);
    return `url("${basename}")`;
  });
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function downloadFont(url) {
  const filename = path.basename(new URL(url).pathname);
  const destPath = path.join(fontsDir, filename);
  if (!force) {
    try {
      await fs.access(destPath);
      return { filename, skipped: true };
    } catch {
      // continue
    }
  }
  const buffer = await fetchBuffer(url);
  const tmpPath = `${destPath}.tmp`;
  await fs.writeFile(tmpPath, buffer);
  await fs.rename(tmpPath, destPath);
  return { filename, skipped: false };
}

async function runQueue(items, worker, limit) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const current = items[index++];
      results.push(await worker(current));
    }
  });
  await Promise.all(workers);
  return results;
}

async function pruneUnusedFiles(keep) {
  const entries = await fs.readdir(fontsDir, { withFileTypes: true });
  const deletions = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name === 'fonts.css') continue;
    if (!keep.has(entry.name)) {
      deletions.push(fs.unlink(path.join(fontsDir, entry.name)));
    }
  }
  await Promise.all(deletions);
  return deletions.length;
}

async function main() {
  await ensureDir(fontsDir);
  const cssText = await fetchText(urlArg);
  const fontUrls = extractUrls(cssText);
  if (fontUrls.length === 0) {
    throw new Error('No woff2 URLs found in CSS. Check the URL or user agent.');
  }

  const rewrittenCss = rewriteCss(cssText);
  await fs.writeFile(cssPath, rewrittenCss, 'utf8');

  const results = await runQueue(fontUrls, downloadFont, concurrency);
  const keptFiles = new Set(fontUrls.map(url => path.basename(new URL(url).pathname)));
  const removed = await pruneUnusedFiles(keptFiles);

  const downloaded = results.filter(r => !r.skipped).length;
  const skipped = results.filter(r => r.skipped).length;

  console.log(`Fonts synced.`);
  console.log(`- CSS: ${path.relative(repoRoot, cssPath)}`);
  console.log(`- Downloaded: ${downloaded}`);
  console.log(`- Skipped (already present): ${skipped}`);
  console.log(`- Removed stale files: ${removed}`);
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
