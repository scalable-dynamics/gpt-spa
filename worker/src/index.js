// biz-bot worker: a lightweight router that fronts OpenAI, xAI (Grok) and Anthropic (Claude) with one API,
// normalises streaming into a single event format, and proxies MCP servers. It also serves the SPA (static assets),
// so the browser only ever talks to its own origin.
//
// Routes (all JSON unless noted):
//   GET  /api/health                → {ok, providers:{openai,xai,anthropic}}
//   GET  /api/models                → model catalog for the UI
//   POST /api/chat                  → unified chat (stream: SSE of unified events | JSON)
//   POST /api/image                 → {images:[{url|b64,mime,revised_prompt}]}
//   POST /api/image/edit            → xAI image edit
//   POST /api/speech                → audio bytes
//   POST /api/transcribe            → multipart file → {text}
//   POST /api/embeddings            → {embeddings:[[...]], model, dims}
//   POST /api/search                → {answer, citations:[{url,title}]}
//   POST /api/realtime/token        → ephemeral client secret for xAI realtime voice
//   POST /api/mcp/tools, /api/mcp/call
//
// Secrets: OPENAI_API_KEY, XAI_API_KEY, ANTHROPIC_API_KEY (any subset). Vars:
//   ALLOWED_ORIGIN – comma-separated extra origins allowed to call /api/* (same-origin is always allowed)
//   ENABLE_MOCK    – "true" adds a keyless demo provider (local development)
// Bindings: AI (Workers AI) – keyless document embeddings (bge-base-en-v1.5) so vector search works with any key set.

import * as openai from './providers/openai.js';
import * as xai from './providers/xai.js';
import * as anthropic from './providers/anthropic.js';
import * as mock from './providers/mock.js';
import * as cloudflare from './providers/cloudflare.js';
import { buildCatalog } from './catalog.js';
import * as mcp from './mcp.js';
import { HttpError, collectEvents, error, json, sseResponse } from './util.js';
import { VERSION } from './version.js';

const PROVIDERS = { openai, xai, anthropic, mock, cloudflare };

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (!url.pathname.startsWith('/api/')) return serveAsset(request, env);

        const origin = originPolicy(request, env);
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: origin.allowed ? 204 : 403, headers: origin.headers });
        }
        if (!origin.allowed) return error('Forbidden: cross-origin requests are not allowed', 403);
        try {
            const res = await route(url, request, env, ctx);
            return withHeaders(res, origin.headers);
        } catch (e) {
            const status = e instanceof HttpError ? e.status : 500;
            console.error('worker error', e);
            return withHeaders(error(e.message || 'Internal error', status, e.details), origin.headers);
        }
    }
};

// ---------- static assets (SPA) ----------
// With run_worker_first: ["/api/*"], static requests are served by Cloudflare's asset layer directly and never reach
// this code; cache/security headers for the SPA live in public/_headers. This branch only runs when ASSETS is unbound.
async function serveAsset(request, env) {
    if (!env.ASSETS) return json({ ok: true, message: 'biz-bot worker. API lives under /api/.' });
    return env.ASSETS.fetch(request);
}

// ---------- origin policy ----------
// The SPA is same-origin, so browsers send an Origin equal to the request origin (or none for GETs).
// Extra origins can be allowed with ALLOWED_ORIGIN; everything else is refused (no wildcard CORS).
function originPolicy(request, env) {
    const self = new URL(request.url).origin;
    const origin = request.headers.get('Origin');
    const allowList = String(env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
    const site = request.headers.get('Sec-Fetch-Site'); // same-origin | same-site | cross-site | none
    let allowed;
    if (!origin) allowed = site !== 'cross-site';               // curl / same-origin GET / navigations
    else allowed = origin === self || allowList.includes(origin);
    const headers = {};
    if (origin && allowed && origin !== self) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Vary'] = 'Origin';
        headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Content-Type';
        headers['Access-Control-Max-Age'] = '86400';
    }
    return { allowed, headers };
}

function withHeaders(res, extra) {
    if (!extra || !Object.keys(extra).length) return res;
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(extra)) headers.set(k, v);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// ---------- API routes ----------
async function route(url, request, env, ctx) {
    const path = url.pathname.replace(/\/+$/, '');
    const method = request.method;
    const keys = resolveKeys(env);

    if (path === '/api/health' && method === 'GET') {
        return json({ ok: true, version: VERSION, providers: { openai: !!keys.openai, xai: !!keys.xai, anthropic: !!keys.anthropic, ...(keys.mock ? { mock: true } : {}) }, embeddings: !!(keys.openai || keys.mock || keys.cloudflare) });
    }
    if (path === '/api/models' && method === 'GET') {
        return json(buildCatalog(env, keys));
    }
    if (method !== 'POST') throw new HttpError(405, 'Method not allowed');

    if (path === '/api/mcp/tools') {
        const body = await readJson(request);
        assertUrl(body.server_url);
        return json(await mcp.listTools(body.server_url, sanitizeHeaders(body.headers)));
    }
    if (path === '/api/mcp/call') {
        const body = await readJson(request);
        assertUrl(body.server_url);
        if (!body.name) throw new HttpError(400, 'name is required');
        return json(await mcp.callTool(body.server_url, sanitizeHeaders(body.headers), body.name, body.arguments || {}));
    }
    if (path === '/api/transcribe') {
        const form = await request.formData();
        const file = form.get('file');
        if (!(file instanceof File) && !(file instanceof Blob)) throw new HttpError(400, 'file is required');
        if (file.size > 25 * 1024 * 1024) throw new HttpError(413, 'audio file too large (max 25 MB)');
        const providerId = form.get('provider') || defaultProvider(keys, ['openai', 'xai', 'mock']);
        const provider = getProvider(providerId, keys, 'transcribe');
        return json(await provider.transcribe({ key: keys[providerId], env }, { file, model: form.get('model') || undefined, language: form.get('language') || undefined }));
    }

    const body = await readJson(request);
    if (path === '/api/chat') {
        const providerId = body.provider || defaultProvider(keys, ['openai', 'xai', 'anthropic', 'mock']);
        const provider = getProvider(providerId, keys, 'chat');
        if (!body.model) throw new HttpError(400, 'model is required');
        if (!Array.isArray(body.messages)) throw new HttpError(400, 'messages must be an array');
        const params = normalizeChatParams(body);
        const opts = { key: keys[providerId], env, signal: request.signal };
        if (body.stream !== false) {
            return sseResponse(async (emit) => {
                for await (const ev of provider.chat(opts, params)) await emit(ev);
            });
        }
        return json(await collectEvents(provider.chat(opts, params)));
    }
    if (path === '/api/image') {
        const providerId = body.provider || defaultProvider(keys, ['xai', 'openai', 'mock']);
        const provider = getProvider(providerId, keys, 'image');
        if (!body.prompt) throw new HttpError(400, 'prompt is required');
        return json(await provider.image({ key: keys[providerId], env }, body));
    }
    if (path === '/api/image/edit') {
        const providerId = body.provider || 'xai';
        const provider = getProvider(providerId, keys, 'imageEdit');
        if (!body.prompt || !body.image) throw new HttpError(400, 'prompt and image are required');
        return json(await provider.imageEdit({ key: keys[providerId], env }, body));
    }
    if (path === '/api/speech') {
        const providerId = body.provider || defaultProvider(keys, ['openai', 'xai', 'mock']);
        const provider = getProvider(providerId, keys, 'speech');
        if (!body.input) throw new HttpError(400, 'input is required');
        const audio = await provider.speech({ key: keys[providerId], env }, body);
        return new Response(audio.body, { status: 200, headers: { 'Content-Type': audio.contentType || 'audio/mpeg', 'Cache-Control': 'no-store' } });
    }
    if (path === '/api/embeddings') {
        const providerId = body.provider || defaultProvider(keys, ['openai', 'mock', 'cloudflare']);
        const provider = getProvider(providerId, keys, 'embeddings');
        const input = Array.isArray(body.input) ? body.input : [body.input];
        if (!input.length || input.some((t) => typeof t !== 'string')) throw new HttpError(400, 'input must be a string or array of strings');
        if (input.length > 256) throw new HttpError(413, 'too many inputs (max 256 per request)');
        return json(await provider.embeddings({ key: keys[providerId], env }, { input, model: body.model }));
    }
    if (path === '/api/realtime/token') {
        const providerId = body.provider || 'xai';
        const provider = getProvider(providerId, keys, 'realtimeToken');
        return json(await provider.realtimeToken({ key: keys[providerId], env }, body));
    }
    if (path === '/api/search') {
        const providerId = body.provider || defaultProvider(keys, ['xai', 'openai', 'anthropic', 'mock']);
        const provider = getProvider(providerId, keys, 'search');
        if (!body.query) throw new HttpError(400, 'query is required');
        return json(await provider.search({ key: keys[providerId], env, signal: request.signal }, body));
    }
    throw new HttpError(404, `No route for ${method} ${path}`);
}

async function readJson(request) {
    const len = Number(request.headers.get('content-length') || 0);
    if (len > 20 * 1024 * 1024) throw new HttpError(413, 'request body too large');
    try { return await request.json(); } catch { throw new HttpError(400, 'invalid JSON body'); }
}

function resolveKeys(env) {
    return {
        openai: env.OPENAI_API_KEY || '',
        xai: env.XAI_API_KEY || '',
        anthropic: env.ANTHROPIC_API_KEY || '',
        mock: env.ENABLE_MOCK === 'true' ? 'mock' : '',
        cloudflare: env.AI ? 'ai' : ''            // Workers AI binding (embeddings), no key needed
    };
}

function getProvider(id, keys, capability) {
    const provider = PROVIDERS[id];
    if (!provider) throw new HttpError(400, `Unknown provider "${id}"`);
    if (!keys[id]) throw new HttpError(400, `${provider.label} is not configured on this worker (set the ${provider.secretName} secret)`);
    if (typeof provider[capability] !== 'function') throw new HttpError(400, `${provider.label} does not support ${capability}`);
    return provider;
}

function defaultProvider(keys, order) {
    const found = order.find((p) => keys[p]);
    if (!found) throw new HttpError(400, `No provider configured for this request (need one of: ${order.join(', ')})`);
    return found;
}

function normalizeChatParams(body) {
    return {
        model: body.model,
        system: body.system || '',
        messages: body.messages,
        tools: Array.isArray(body.tools) ? body.tools : [],
        tool_choice: body.tool_choice,
        max_tokens: body.max_tokens ? Number(body.max_tokens) : undefined,
        reasoning_effort: body.reasoning_effort,
        response_format: body.response_format,
        temperature: body.temperature
    };
}

function assertUrl(u) {
    let parsed;
    try { parsed = new URL(u); } catch { throw new HttpError(400, 'server_url must be a valid URL'); }
    if (!/^https?:$/.test(parsed.protocol)) throw new HttpError(400, 'server_url must be http(s)');
    const host = parsed.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.)/.test(host) || host.endsWith('.internal') || host.endsWith('.local')) {
        throw new HttpError(400, 'server_url must not point at a private address');
    }
}

function sanitizeHeaders(headers) {
    const out = {};
    for (const [k, v] of Object.entries(headers || {})) {
        if (!/^[A-Za-z0-9-]+$/.test(k) || typeof v !== 'string') continue;
        if (['host', 'origin', 'content-length', 'content-type', 'accept', 'cookie'].includes(k.toLowerCase())) continue;
        out[k] = v;
    }
    return out;
}
