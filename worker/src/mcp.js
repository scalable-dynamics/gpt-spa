// Minimal Model Context Protocol client (Streamable HTTP transport) for the worker.
// Supports: initialize → notifications/initialized → tools/list → tools/call.
// Responses may arrive as application/json or as text/event-stream; both are handled.

import { HttpError, parseSSE, safeJsonParse } from './util.js';

// 2025-11-25 is the session-based Streamable HTTP flow that virtually every public server speaks today.
// The stateless 2026-07-28 revision is newer but not yet widely deployed; servers negotiate down if needed.
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const CLIENT_INFO = { name: 'biz-bot-worker', version: '2.0.0' };

// Very small in-memory session cache (per isolate). Sessions are cheap to recreate, so a miss is fine.
const sessions = new Map(); // key: serverUrl|headersHash → { sessionId, protocolVersion, expires }

function headersKey(url, headers) {
    return `${url}|${JSON.stringify(headers || {})}`;
}

async function rpc(serverUrl, extraHeaders, message, session) {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        ...(extraHeaders || {})
    };
    if (session?.sessionId) headers['Mcp-Session-Id'] = session.sessionId;
    if (session?.protocolVersion) headers['MCP-Protocol-Version'] = session.protocolVersion;

    const res = await fetch(serverUrl, { method: 'POST', headers, body: JSON.stringify(message) });
    const newSessionId = res.headers.get('mcp-session-id');
    if (newSessionId && session) session.sessionId = newSessionId;

    if (message.id === undefined) {
        // notification: 202/204 expected, no body
        if (!res.ok && res.status !== 202 && res.status !== 204) {
            throw new HttpError(res.status, `MCP notification failed (${res.status})`, await res.text().catch(() => ''));
        }
        return null;
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new HttpError(res.status, `MCP server returned ${res.status}`, safeJsonParse(text, text));
    }
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('text/event-stream')) {
        for await (const { data } of parseSSE(res.body)) {
            const msg = safeJsonParse(data);
            if (!msg) continue;
            if (Array.isArray(msg)) {
                const hit = msg.find((m) => m.id === message.id);
                if (hit) return unwrap(hit);
            } else if (msg.id === message.id) {
                return unwrap(msg);
            }
        }
        throw new HttpError(502, 'MCP server stream ended without a response');
    }
    const body = await res.json();
    const msg = Array.isArray(body) ? body.find((m) => m.id === message.id) : body;
    return unwrap(msg);
}

function unwrap(msg) {
    if (!msg) throw new HttpError(502, 'Empty MCP response');
    if (msg.error) throw new HttpError(502, `MCP error ${msg.error.code}: ${msg.error.message}`, msg.error.data);
    return msg.result;
}

async function connect(serverUrl, extraHeaders) {
    const key = headersKey(serverUrl, extraHeaders);
    const cached = sessions.get(key);
    if (cached && cached.expires > Date.now()) return cached;
    const session = { sessionId: undefined, protocolVersion: undefined, expires: Date.now() + 10 * 60 * 1000 };
    let init, lastError;
    for (const version of PROTOCOL_VERSIONS) {
        try {
            init = await rpc(serverUrl, extraHeaders, {
                jsonrpc: '2.0', id: 1, method: 'initialize',
                params: { protocolVersion: version, capabilities: {}, clientInfo: CLIENT_INFO }
            }, session);
            session.protocolVersion = init?.protocolVersion || version;
            break;
        } catch (e) {
            lastError = e;
            // Only retry with an older version when the server explicitly rejects the protocol version.
            const text = JSON.stringify(e.details || e.message || '');
            if (!(e instanceof HttpError && e.status === 400 && /version/i.test(text))) throw e;
        }
    }
    if (!init) throw lastError || new HttpError(502, 'MCP initialize failed');
    session.serverInfo = init?.serverInfo || null;
    session.capabilities = init?.capabilities || {};
    try {
        await rpc(serverUrl, extraHeaders, { jsonrpc: '2.0', method: 'notifications/initialized' }, session);
    } catch (e) {
        // Some servers reject/ignore the notification; not fatal.
    }
    sessions.set(key, session);
    return session;
}

async function withSession(serverUrl, extraHeaders, fn) {
    let session = await connect(serverUrl, extraHeaders);
    try {
        return await fn(session);
    } catch (e) {
        // If the session expired (404/400 on session id), reconnect once.
        if (e instanceof HttpError && (e.status === 404 || e.status === 400)) {
            sessions.delete(headersKey(serverUrl, extraHeaders));
            session = await connect(serverUrl, extraHeaders);
            return await fn(session);
        }
        throw e;
    }
}

export async function listTools(serverUrl, extraHeaders) {
    return withSession(serverUrl, extraHeaders, async (session) => {
        const tools = [];
        let cursor;
        do {
            const result = await rpc(serverUrl, extraHeaders, {
                jsonrpc: '2.0', id: 2, method: 'tools/list', params: cursor ? { cursor } : {}
            }, session);
            for (const t of result?.tools || []) {
                tools.push({ name: t.name, title: t.title, description: t.description || '', input_schema: t.inputSchema || { type: 'object', properties: {} } });
            }
            cursor = result?.nextCursor;
        } while (cursor && tools.length < 500);
        return { tools, server: session.serverInfo, protocolVersion: session.protocolVersion };
    });
}

export async function callTool(serverUrl, extraHeaders, name, args) {
    return withSession(serverUrl, extraHeaders, async (session) => {
        const result = await rpc(serverUrl, extraHeaders, {
            jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args || {} }
        }, session);
        return {
            content: result?.content || [],
            structuredContent: result?.structuredContent,
            isError: !!result?.isError
        };
    });
}

/** Flatten MCP tool result content into a plain string suitable for a model. */
export function contentToText(content) {
    return (content || []).map((c) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image') return `[image ${c.mimeType || ''} (${(c.data || '').length} b64 chars)]`;
        if (c.type === 'audio') return `[audio ${c.mimeType || ''}]`;
        if (c.type === 'resource_link') return `[resource ${c.uri}${c.name ? ` — ${c.name}` : ''}]`;
        if (c.type === 'resource') return c.resource?.text || `[resource ${c.resource?.uri || ''}]`;
        return JSON.stringify(c);
    }).join('\n');
}
