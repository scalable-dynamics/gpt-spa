// Shared helpers for the biz-bot worker: JSON responses, SSE parsing/writing, upstream errors.
// (Origin/CORS policy lives in index.js — responses here carry no CORS headers of their own.)

export function json(data, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders }
    });
}

export function error(message, status = 400, details = undefined) {
    return json({ error: { message, status, details } }, status);
}

export class HttpError extends Error {
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

/**
 * Read an upstream error body (JSON or text) and throw an HttpError with a useful message.
 */
export async function throwUpstream(response, provider) {
    let details;
    const text = await response.text().catch(() => '');
    try { details = JSON.parse(text); } catch { details = text; }
    const message =
        details?.error?.message || (typeof details?.error === 'string' && details.error) || details?.message ||
        (typeof details === 'string' && details.slice(0, 500)) ||
        `${provider} request failed with status ${response.status}`;
    throw new HttpError(response.status, `${provider}: ${message}`, details);
}

/**
 * Async generator that parses a text/event-stream body into {event, data} records.
 * `data` is the raw string (may be JSON). Handles multi-line data and CRLF.
 */
export async function* parseSSE(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let event = undefined;
    let dataLines = [];
    let finished = false;
    const flush = function* () {
        if (dataLines.length) {
            yield { event, data: dataLines.join('\n') };
        }
        event = undefined;
        dataLines = [];
    };
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) { finished = true; break; }
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf('\n')) !== -1) {
                let line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (line.endsWith('\r')) line = line.slice(0, -1);
                if (line === '') { yield* flush(); continue; }
                if (line.startsWith(':')) continue; // comment / keepalive
                const colon = line.indexOf(':');
                const field = colon === -1 ? line : line.slice(0, colon);
                let value2 = colon === -1 ? '' : line.slice(colon + 1);
                if (value2.startsWith(' ')) value2 = value2.slice(1);
                if (field === 'event') event = value2;
                else if (field === 'data') dataLines.push(value2);
            }
        }
        if (buffer.trim()) {
            const line = buffer.trim();
            if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        yield* flush();
    } finally {
        // If the consumer stopped early (e.g. found the JSON-RPC reply it wanted), release the connection.
        if (!finished) reader.cancel().catch(() => { });
    }
}

/**
 * Create a unified SSE response. `producer(emit)` is an async function that calls emit(obj)
 * for each unified event; errors are forwarded as {type:'error'} events.
 */
export function sseResponse(producer) {
    const encoder = new TextEncoder();
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const emit = (obj) => writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)).catch(() => { });
    (async () => {
        try {
            await producer(emit);
        } catch (e) {
            await emit({ type: 'error', message: e?.message || String(e), status: e?.status, details: e?.details });
        } finally {
            try { await writer.write(encoder.encode('data: [DONE]\n\n')); } catch { }
            try { await writer.close(); } catch { }
        }
    })();
    return new Response(readable, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        }
    });
}

/**
 * Collect a unified event stream (as produced by a provider adapter generator) into a single JSON result.
 */
export async function collectEvents(iterable) {
    const result = { text: '', reasoning: '', tool_calls: [], citations: [], images: [], usage: null, finish: 'stop' };
    for await (const ev of iterable) {
        switch (ev.type) {
            case 'text': result.text += ev.delta; break;
            case 'reasoning': result.reasoning += ev.delta; break;
            case 'tool_call': result.tool_calls.push({ id: ev.id, name: ev.name, arguments: ev.arguments }); break;
            case 'citation': result.citations.push({ url: ev.url, title: ev.title }); break;
            case 'image': result.images.push({ url: ev.url, b64: ev.b64, mime: ev.mime }); break;
            case 'usage': result.usage = { input: ev.input, output: ev.output }; break;
            case 'done': result.finish = ev.finish; break;
            case 'error': throw new HttpError(ev.status || 502, ev.message, ev.details);
        }
    }
    return result;
}

export function safeJsonParse(text, fallback = undefined) {
    try { return JSON.parse(text); } catch { return fallback; }
}

/** Convert a data: URL into {mime, b64} or null. */
export function parseDataUrl(url) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url || '');
    if (!m) return null;
    return { mime: m[1] || 'application/octet-stream', b64: m[2] ? m[3] : btoa(decodeURIComponent(m[3])) };
}

export function uid(prefix = 'call') {
    return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
}
