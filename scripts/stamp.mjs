#!/usr/bin/env node
// Writes a build version (package version + git short sha) into worker/src/version.js and public/index.html.
// The SPA compares its own stamp with /api/health and reloads once if they differ (cache-busting after deploys).
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
let sha = '';
try { sha = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { }
const version = `${pkg.version}+${sha || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;

const files = [
    [new URL('../worker/src/version.js', import.meta.url), /export const VERSION = '[^']*';/, `export const VERSION = '${version}';`],
    [new URL('../public/index.html', import.meta.url), /<meta name="app-version" content="[^"]*">/, `<meta name="app-version" content="${version}">`]
];
for (const [url, re, replacement] of files) {
    const src = readFileSync(url, 'utf8');
    if (!re.test(src)) { console.error(`stamp: pattern not found in ${url.pathname}`); process.exit(1); }
    writeFileSync(url, src.replace(re, replacement));
}
console.log(`stamped version ${version}`);
