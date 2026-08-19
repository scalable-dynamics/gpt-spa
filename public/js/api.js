// Client for the biz-bot worker (see worker/src/index.js). The SPA is served by the same worker, so every
// request is same-origin (/api/*). Provider keys live only in the worker's secrets — nothing is configured client-side.

function apiUrl(path) {
    return `/api${path}`;
}

async function request(path, { method = 'POST', body, headers = {}, raw = false, signal } = {}) {
    const isForm = body instanceof FormData;
    const res = await fetch(apiUrl(path), {
        method,
        credentials: 'same-origin',
        headers: { ...(isForm || body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: isForm ? body : body === undefined ? undefined : JSON.stringify(body),
        signal
    });
    if (!res.ok) {
        let message = `${res.status} ${res.statusText}`;
        try {
            const data = await res.json();
            message = data?.error?.message || message;
        } catch { }
        const err = new Error(message);
        err.status = res.status;
        throw err;
    }
    return raw ? res : res.json();
}

/** Health check: {ok, providers:{openai,xai,anthropic[,mock]}} or null when the API is unreachable. */
export async function probeWorker() {
    try {
        const res = await fetch(apiUrl('/health'), { credentials: 'same-origin' });
        if (!res.ok) return null;
        const data = await res.json();
        return data && data.ok ? data : null;
    } catch {
        return null;
    }
}

let catalogPromise;
export function getCatalog(force = false) {
    if (!catalogPromise || force) catalogPromise = request('/models', { method: 'GET' }).catch((e) => { catalogPromise = undefined; throw e; });
    return catalogPromise;
}

/**
 * Stream a chat completion. `onEvent` receives unified events:
 *   {type:'text',delta} {type:'reasoning',delta} {type:'tool_call',id,name,arguments}
 *   {type:'citation',url,title} {type:'image',url|b64,mime} {type:'usage'} {type:'done',finish} {type:'error',message}
 * Resolves with the collected result {text, reasoning, tool_calls, citations, images, usage, finish}.
 * Uses reader.read() (not async iteration of ReadableStream) so it works in Safari.
 */
export async function chatStream(params, onEvent, signal) {
    const res = await request('/chat', { body: { ...params, stream: true }, raw: true, signal });
    const result = { text: '', reasoning: '', tool_calls: [], citations: [], images: [], usage: null, finish: 'stop' };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const handle = (ev) => {
        switch (ev.type) {
            case 'text': result.text += ev.delta; break;
            case 'reasoning': result.reasoning += ev.delta; break;
            case 'tool_call': result.tool_calls.push({ id: ev.id, name: ev.name, arguments: ev.arguments }); break;
            case 'citation': if (!result.citations.some((c) => c.url === ev.url)) result.citations.push({ url: ev.url, title: ev.title }); break;
            case 'image': result.images.push({ url: ev.url, b64: ev.b64, mime: ev.mime }); break;
            case 'usage': result.usage = { input: ev.input, output: ev.output }; break;
            case 'done': result.finish = ev.finish; break;
            case 'error': throw new Error(ev.message);
        }
        onEvent && onEvent(ev);
    };
    // Idle guard: if no bytes arrive for a while (phone went to sleep, connection silently dropped) the turn would
    // otherwise spin forever with the stop button showing. Streams normally deliver at least reasoning/keepalive
    // events well within this window.
    const IDLE_MS = 120000;
    const readWithTimeout = () => new Promise((resolve, reject) => {
        const t = setTimeout(() => { reader.cancel().catch(() => { }); reject(new Error('The model stopped responding (no data for 2 minutes) — please try again')); }, IDLE_MS);
        reader.read().then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
    });
    while (true) {
        const { value, done } = await readWithTimeout();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const chunk = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of chunk.split('\n')) {
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                let ev;
                try { ev = JSON.parse(data); } catch { continue; }
                handle(ev);
            }
        }
    }
    return result;
}

export function chat(params) {
    return request('/chat', { body: { ...params, stream: false } });
}

export function generateImage(params) {
    return request('/image', { body: params });
}

export async function speech(params) {
    const res = await request('/speech', { body: params, raw: true });
    return res.blob();
}

/** Transcribe an audio blob. Filename/extension follows the blob type (Safari records audio/mp4, Chrome audio/webm). */
export function transcribe(blob, { provider, model, language } = {}) {
    const form = new FormData();
    form.append('file', blob, audioFilename(blob.type));
    if (provider) form.append('provider', provider);
    if (model) form.append('model', model);
    if (language) form.append('language', language);
    return request('/transcribe', { body: form });
}

export function audioFilename(mime = '') {
    const m = mime.toLowerCase();
    if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'recording.m4a';
    if (m.includes('mpeg') || m.includes('mp3')) return 'recording.mp3';
    if (m.includes('wav')) return 'recording.wav';
    if (m.includes('ogg')) return 'recording.ogg';
    return 'recording.webm';
}

export function embeddings(input, { provider, model } = {}) {
    return request('/embeddings', { body: { input, provider, model } });
}

export function search(params) {
    return request('/search', { body: params });
}

export function mcpTools(server_url, headers) {
    return request('/mcp/tools', { body: { server_url, headers } });
}

export function mcpCall(server_url, headers, name, args) {
    return request('/mcp/call', { body: { server_url, headers, name, arguments: args } });
}

export function realtimeToken(provider = 'xai') {
    return request('/realtime/token', { body: { provider, expires: 300 } });
}
