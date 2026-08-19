#!/usr/bin/env node
// Live verification against a running worker (default http://localhost:8787 — start `npm run dev` first).
// For every provider the worker reports as configured, exercises the real APIs with tiny, cheap requests:
// chat streaming, tool round-trip, JSON-schema output, vision, native web search, /api/search, images, TTS→STT,
// embeddings and realtime tokens. Prints a pass/fail table and exits non-zero on failures.
//   node scripts/verify-live.mjs [--only xai,anthropic] [--skip image,speech] [--url http://localhost:8787]

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const BASE = (opt('url', process.env.WORKER_URL || 'http://localhost:8787')).replace(/\/$/, '');
const ONLY = opt('only', '').split(',').filter(Boolean);
const SKIP = new Set(opt('skip', '').split(',').filter(Boolean));
const TIMEOUT = Number(opt('timeout', 120000));

import { deflateSync } from 'node:zlib';
const results = [];
// A valid 32x32 solid red PNG generated at runtime (hand-typed base64 fixtures are easy to get wrong).
const PNG_RED = `data:image/png;base64,${makePng(32, 32, [220, 30, 30]).toString('base64')}`;
function makePng(w, h, [r, g, b]) {
    const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
    const crc32 = (buf) => { let c = 0xffffffff; for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td)); return Buffer.concat([len, td, crc]); };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
    const raw = Buffer.concat(Array.from({ length: h }, () => row));
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function api(path, body, { raw = false, timeout = TIMEOUT } = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
        const isForm = body instanceof FormData;
        const res = await fetch(`${BASE}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: isForm || body === undefined ? {} : { 'Content-Type': 'application/json' }, body: isForm ? body : body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal });
        if (!res.ok) { let msg = `${res.status}`; try { msg = (await res.json()).error?.message || msg; } catch { } throw new Error(msg); }
        return raw ? res : res.json();
    } finally { clearTimeout(t); }
}

async function chatStream(params) {
    const res = await api('/chat', { ...params, stream: true }, { raw: true });
    const out = { text: '', reasoning: '', tool_calls: [], citations: [], images: [], usage: null, finish: null, events: 0 };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (; ;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
            const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                const ev = JSON.parse(data);
                out.events++;
                if (ev.type === 'text') out.text += ev.delta;
                else if (ev.type === 'reasoning') out.reasoning += ev.delta;
                else if (ev.type === 'tool_call') out.tool_calls.push(ev);
                else if (ev.type === 'citation') out.citations.push(ev);
                else if (ev.type === 'image') out.images.push(ev);
                else if (ev.type === 'usage') out.usage = ev;
                else if (ev.type === 'done') out.finish = ev.finish;
                else if (ev.type === 'error') throw new Error(ev.message);
            }
        }
    }
    return out;
}

async function check(provider, name, fn) {
    const started = Date.now();
    try {
        const detail = await fn();
        results.push({ provider, name, ok: true, ms: Date.now() - started, detail: String(detail ?? '').slice(0, 90) });
        console.log(`  ✓ ${provider} ${name} (${Date.now() - started}ms) ${String(detail ?? '').slice(0, 90)}`);
    } catch (e) {
        results.push({ provider, name, ok: false, ms: Date.now() - started, detail: (e.message || String(e)).slice(0, 200) });
        console.log(`  ✗ ${provider} ${name} (${Date.now() - started}ms) ${(e.message || String(e)).slice(0, 200)}`);
    }
}

const TIME_TOOL = { type: 'function', name: 'get_time', description: 'Returns the current time as a string.', parameters: { type: 'object', properties: {}, additionalProperties: false } };

async function verifyProvider(p, cat) {
    const models = cat.models || [];
    const def = models.find((m) => m.default)?.id || models[0]?.id;
    const fast = models.find((m) => m.fast)?.id || def;
    if (!models.length) { // embeddings-only provider (Cloudflare Workers AI)
        console.log(`\n${p} — embeddings only`);
        await check(p, 'embeddings', async () => {
            const r = await api('/embeddings', { provider: p, input: ['hello world', 'goodbye world'] });
            if (!Array.isArray(r.embeddings) || r.embeddings.length !== 2 || !r.dims) throw new Error(JSON.stringify(r).slice(0, 120));
            return `${r.model} dims=${r.dims}`;
        });
        return;
    }
    console.log(`\n${p} — default ${def}, fast ${fast}`);

    await check(p, `chat stream (${def})`, async () => {
        const r = await chatStream({ provider: p, model: def, system: 'You are terse.', messages: [{ role: 'user', content: 'Reply with exactly the word OK and nothing else.' }], max_tokens: 200 });
        if (!/ok/i.test(r.text)) throw new Error(`unexpected text: ${JSON.stringify(r.text).slice(0, 100)}`);
        if (r.finish !== 'stop') throw new Error(`finish=${r.finish}`);
        return `"${r.text.trim()}" usage=${JSON.stringify(r.usage)} reasoning=${r.reasoning.length}ch`;
    });
    if (fast !== def) await check(p, `chat stream (${fast}) + reasoning_effort=low`, async () => {
        const r = await chatStream({ provider: p, model: fast, messages: [{ role: 'user', content: 'Reply with exactly the word OK.' }], reasoning_effort: 'low', max_tokens: 200 });
        if (!/ok/i.test(r.text)) throw new Error(`unexpected text: ${JSON.stringify(r.text).slice(0, 100)}`);
        return `"${r.text.trim()}"`;
    });
    await check(p, 'tool round-trip', async () => {
        const first = await chatStream({ provider: p, model: fast, messages: [{ role: 'user', content: 'Call the get_time tool, then tell me the time it returned.' }], tools: [TIME_TOOL], max_tokens: 400 });
        if (!first.tool_calls.length) throw new Error(`no tool_call (text=${JSON.stringify(first.text).slice(0, 80)})`);
        const call = first.tool_calls[0];
        if (call.name !== 'get_time') throw new Error(`called ${call.name}`);
        const second = await chatStream({
            provider: p, model: fast, tools: [TIME_TOOL], max_tokens: 400, messages: [
                { role: 'user', content: 'Call the get_time tool, then tell me the time it returned.' },
                { role: 'assistant', content: first.text, tool_calls: first.tool_calls },
                { role: 'tool', tool_call_id: call.id, name: call.name, content: '{"time":"12:34"}' }
            ]
        });
        if (!second.text.includes('12:34')) throw new Error(`result not used: ${JSON.stringify(second.text).slice(0, 100)}`);
        return `${call.name}(${call.arguments}) → "${second.text.trim().slice(0, 50)}"`;
    });
    await check(p, 'json_schema output', async () => {
        const r = await api('/chat', { provider: p, model: fast, stream: false, max_tokens: 200, messages: [{ role: 'user', content: 'Which of these bots should answer a question about the weather: Researcher, Analyst? Return JSON.' }], response_format: { type: 'json_schema', name: 'route', schema: { type: 'object', properties: { owners: { type: 'array', items: { type: 'string' } } }, required: ['owners'], additionalProperties: false } } });
        const parsed = JSON.parse(r.text);
        if (!Array.isArray(parsed.owners)) throw new Error(`bad json: ${r.text.slice(0, 100)}`);
        return JSON.stringify(parsed);
    });
    await check(p, 'vision (data URL image)', async () => {
        const r = await chatStream({ provider: p, model: fast, messages: [{ role: 'user', content: [{ type: 'text', text: 'What colour is this image? One word.' }, { type: 'image', url: PNG_RED }] }], max_tokens: 100 });
        if (!/red|orange|pink|crimson/i.test(r.text)) throw new Error(`answer: ${r.text.slice(0, 80)}`);
        return `"${r.text.trim()}"`;
    });
    if (cat.capabilities?.web_search && !SKIP.has('search')) await check(p, 'native web_search + citations', async () => {
        const r = await chatStream({ provider: p, model: fast, messages: [{ role: 'user', content: 'Search the web: what is the current version of Node.js LTS? Answer in one sentence with a source link.' }], tools: [{ type: 'web_search' }], max_tokens: 800 });
        if (!r.text.trim()) throw new Error('empty text');
        return `citations=${r.citations.length} "${r.text.trim().slice(0, 60)}"`;
    });
    if (cat.capabilities?.search && !SKIP.has('search')) await check(p, '/api/search (web)', async () => {
        const r = await api('/search', { provider: p, query: 'latest stable Python version', mode: 'web', max_results: 3 });
        if (!r.answer) throw new Error('empty answer');
        return `citations=${r.citations.length} "${r.answer.slice(0, 60)}"`;
    });
    if (cat.capabilities?.x_search && !SKIP.has('search')) await check(p, '/api/search (x)', async () => {
        const r = await api('/search', { provider: p, query: 'what are people saying about SpaceX today', mode: 'x', max_results: 3 });
        if (!r.answer) throw new Error('empty answer');
        return `citations=${r.citations.length} "${r.answer.slice(0, 60)}"`;
    });
    if (cat.image?.length && !SKIP.has('image')) await check(p, `image generation (${cat.image.find((m) => m.default)?.id})`, async () => {
        const r = await api('/image', { provider: p, prompt: 'A small red circle on a white background, flat vector style', n: 1 });
        const im = r.images?.[0];
        if (!im || !(im.url || im.b64)) throw new Error(`no image: ${JSON.stringify(r).slice(0, 120)}`);
        return im.url ? im.url.slice(0, 60) : `b64 ${im.b64.length} chars ${im.mime}`;
    });
    let audioBlob = null;
    if (cat.tts && !SKIP.has('speech')) await check(p, `tts (${cat.tts.voices?.[0]?.id})`, async () => {
        const res = await api('/speech', { provider: p, voice: cat.tts.voices?.[0]?.id, input: 'The quick brown fox jumps over the lazy dog.' }, { raw: true });
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length < 1000) throw new Error(`audio too small (${buf.length} bytes)`);
        audioBlob = new Blob([buf], { type: res.headers.get('content-type') || 'audio/mpeg' });
        return `${buf.length} bytes ${res.headers.get('content-type')}`;
    });
    if (cat.stt && audioBlob && !SKIP.has('speech')) await check(p, 'stt (transcribe the tts output)', async () => {
        const form = new FormData();
        form.append('file', audioBlob, 'speech.mp3');
        form.append('provider', p);
        const r = await api('/transcribe', form);
        if (!/fox|dog|quick/i.test(r.text || '')) throw new Error(`transcript: ${JSON.stringify(r).slice(0, 120)}`);
        return `"${r.text}"`;
    });
    if (cat.embeddings?.length && !SKIP.has('embeddings')) await check(p, 'embeddings', async () => {
        const r = await api('/embeddings', { provider: p, input: ['hello world', 'goodbye world'] });
        if (!Array.isArray(r.embeddings) || r.embeddings.length !== 2 || !r.dims) throw new Error(JSON.stringify(r).slice(0, 120));
        return `${r.model} dims=${r.dims}`;
    });
    if (cat.capabilities?.realtime && !SKIP.has('realtime')) await check(p, 'realtime token', async () => {
        const r = await api('/realtime/token', { provider: p, expires: 120 });
        if (!r.client_secret) throw new Error(JSON.stringify(r).slice(0, 120));
        return `${r.url}?model=${r.model} secret=${String(r.client_secret).slice(0, 6)}… expires_at=${r.expires_at}`;
    });
}

(async () => {
    console.log(`Verifying worker at ${BASE}`);
    const health = await api('/health');
    const catalog = await api('/models');
    console.log('providers:', health.providers, 'version', health.version);
    await check('worker', 'MCP tools/list (docs.mcp.cloudflare.com)', async () => {
        const r = await api('/mcp/tools', { server_url: 'https://docs.mcp.cloudflare.com/mcp' });
        if (!r.tools?.length) throw new Error('no tools');
        return `${r.tools.length} tools, protocol ${r.protocolVersion}`;
    });
    for (const [id, p] of Object.entries(catalog.providers)) {
        if (!p.enabled || id === 'mock') continue;
        if (ONLY.length && !ONLY.includes(id)) continue;
        await verifyProvider(id, p);
    }
    const failed = results.filter((r) => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((f) => `${f.provider}:${f.name}`).join(', ')}` : ''}`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('fatal:', e.message || e); process.exit(2); });
