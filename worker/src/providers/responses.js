// Shared helpers for OpenAI-style "Responses API" providers (OpenAI and xAI both speak this dialect):
// unified messages → `input` items, and SSE event stream → unified events.
import { HttpError, parseSSE, safeJsonParse, uid } from '../util.js';

export function toInputContent(content) {
    if (typeof content === 'string') return [{ type: 'input_text', text: content }];
    const parts = [];
    for (const p of content || []) {
        if (p.type === 'text') parts.push({ type: 'input_text', text: p.text });
        else if (p.type === 'image') parts.push({ type: 'input_image', image_url: p.url || p.data, detail: p.detail || 'auto' });
        else if (p.type === 'document' || p.type === 'file') {
            if (p.url && !/^data:/.test(p.url)) parts.push({ type: 'input_file', file_url: p.url });
            else parts.push({ type: 'input_file', filename: p.name || 'file', file_data: p.url || p.data });
        }
    }
    return parts.length ? parts : [{ type: 'input_text', text: ' ' }];
}

export function toInputItems(messages, { systemRole = 'developer' } = {}) {
    const items = [];
    for (const m of messages) {
        if (m.role === 'system') { items.push({ role: systemRole, content: [{ type: 'input_text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }] }); continue; }
        if (m.role === 'assistant') {
            const text = typeof m.content === 'string' ? m.content : (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
            if (text && text.trim()) items.push({ role: 'assistant', content: [{ type: 'output_text', text }] });
            for (const tc of m.tool_calls || []) items.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments || '{}' });
            continue;
        }
        if (m.role === 'tool') { items.push({ type: 'function_call_output', call_id: m.tool_call_id, output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }); continue; }
        items.push({ role: 'user', content: toInputContent(m.content) });
    }
    return items;
}

export function toToolChoice(choice) {
    if (!choice || choice === 'auto') return undefined;
    if (choice === 'none' || choice === 'required') return choice;
    if (typeof choice === 'object' && choice.name) return { type: 'function', name: choice.name };
    if (typeof choice === 'object' && choice.type) return choice;
    return undefined;
}

/**
 * Parse a Responses-API SSE stream into unified events.
 * Handles text deltas, reasoning summaries, url citations, function calls, generated images, refusals, usage.
 */
export async function* parseResponsesStream(body, providerLabel) {
    const calls = new Map(); // item_id → {call_id, name, arguments}
    let finish = 'stop';
    let usage = null;
    let sawText = false;
    let tail = '';           // last few emitted characters, to decide whether a paragraph break is needed
    let toolSinceText = false; // a tool/search item started after the last text delta (agentic narration rounds)
    const seenCitations = new Set();
    const emitText = (delta) => { sawText = true; toolSinceText = false; tail = (tail + delta).slice(-4); return { type: 'text', delta }; };
    // Grok's agentic mode streams narration bursts between server-side searches with no whitespace between them
    // ("…changelog next.Got the notes."). Insert a paragraph break when text resumes after a tool item, or when a
    // delta starts a new capitalised sentence right after terminal punctuation.
    const needsBreak = (delta) => sawText && !/\s$/.test(tail) && ((toolSinceText && /^[^\s]/.test(delta)) || (/[.!?:]$/.test(tail) && /^[A-Z][a-z]/.test(delta)));
    // Between message items / content parts (e.g. narration between server-side search rounds) make sure the
    // paragraphs don't run together.
    const separator = () => (sawText && !/\n\n$/.test(tail) ? emitText(/\n$/.test(tail) ? '\n' : '\n\n') : null);
    for await (const { data } of parseSSE(body)) {
        if (data === '[DONE]') break;
        const ev = safeJsonParse(data);
        if (!ev || !ev.type) continue;
        switch (ev.type) {
            case 'response.output_text.delta':
                if (ev.delta) { if (needsBreak(ev.delta)) yield emitText('\n\n'); yield emitText(ev.delta); }
                break;
            case 'response.content_part.added': {
                if ((ev.part?.type || 'output_text') === 'output_text') { const sep = separator(); if (sep) yield sep; }
                break;
            }
            case 'response.reasoning_summary_text.delta':
            case 'response.reasoning_text.delta':
                if (ev.delta) yield { type: 'reasoning', delta: ev.delta };
                break;
            case 'response.reasoning_summary_part.done':
            case 'response.reasoning_summary_text.done':
                yield { type: 'reasoning', delta: '\n\n' };
                break;
            case 'response.output_text.annotation.added': {
                const a = ev.annotation || {};
                if (a.type === 'url_citation' && a.url && !seenCitations.has(a.url)) { seenCitations.add(a.url); yield { type: 'citation', url: a.url, title: a.title && !/^\d+$/.test(a.title) ? a.title : undefined }; }
                break;
            }
            case 'response.output_item.added': {
                const item = ev.item || {};
                if (item.type === 'function_call') calls.set(item.id || item.call_id, { call_id: item.call_id, name: item.name, arguments: item.arguments || '' });
                if (sawText && item.type && item.type !== 'message') toolSinceText = true;
                if (item.type === 'message') { const sep = separator(); if (sep) yield sep; }
                break;
            }
            case 'response.function_call_arguments.delta': {
                const c = calls.get(ev.item_id);
                if (c) c.arguments += ev.delta || '';
                break;
            }
            case 'response.function_call_arguments.done': {
                const c = calls.get(ev.item_id);
                if (c && ev.arguments) c.arguments = ev.arguments;
                break;
            }
            case 'response.output_item.done': {
                const item = ev.item || {};
                if (item.type === 'function_call') {
                    const c = calls.get(item.id || item.call_id) || {};
                    calls.delete(item.id || item.call_id);
                    yield { type: 'tool_call', id: item.call_id || c.call_id || uid('call'), name: item.name || c.name, arguments: item.arguments || c.arguments || '{}' };
                    finish = 'tool_calls';
                } else if (item.type === 'image_generation_call' && item.result) {
                    const b64 = String(item.result).replace(/^data:[^,]+,/, '');
                    yield { type: 'image', b64, mime: 'image/png' };
                } else if (item.type === 'web_search_call' || item.type === 'x_search_call') {
                    for (const s of item.action?.sources || []) if (s.url && !seenCitations.has(s.url)) { seenCitations.add(s.url); yield { type: 'citation', url: s.url, title: s.title }; }
                } else if (item.type === 'mcp_call' && item.error) {
                    yield { type: 'text', delta: `\n\n_(MCP call ${item.name} failed: ${typeof item.error === 'string' ? item.error : JSON.stringify(item.error)})_` };
                } else if (item.type === 'message') {
                    for (const part of item.content || []) {
                        if (part.type === 'refusal') { yield { type: 'text', delta: `\n\n_(Refused: ${part.refusal})_` }; finish = 'refusal'; }
                        for (const a of part.annotations || []) if (a.type === 'url_citation' && a.url && !seenCitations.has(a.url)) { seenCitations.add(a.url); yield { type: 'citation', url: a.url, title: a.title && !/^\d+$/.test(a.title) ? a.title : undefined }; }
                        // Some servers only send the full text on item.done (no deltas) — surface it.
                        if (part.type === 'output_text' && part.text && !sawText) yield emitText(part.text);
                    }
                }
                break;
            }
            case 'response.completed':
            case 'response.incomplete': {
                const r = ev.response || {};
                if (r.usage) usage = { input: r.usage.input_tokens, output: r.usage.output_tokens };
                if (r.status === 'incomplete' && r.incomplete_details?.reason === 'max_output_tokens') finish = 'length';
                for (const url of r.citations || []) if (typeof url === 'string' && /^https?:/.test(url) && !seenCitations.has(url)) { seenCitations.add(url); yield { type: 'citation', url }; }
                // Fallback: if the stream never emitted deltas, emit final text from the response object.
                if (!sawText) {
                    for (const item of r.output || []) if (item.type === 'message') for (const part of item.content || []) if (part.type === 'output_text' && part.text) yield emitText(part.text);
                }
                break;
            }
            case 'response.failed':
                throw new HttpError(502, `${providerLabel}: ${ev.response?.error?.message || 'response failed'}`, ev.response?.error);
            case 'error':
                throw new HttpError(502, `${providerLabel}: ${ev.message || ev.error?.message || 'stream error'}`, ev);
            default:
                break;
        }
    }
    if (usage) yield { type: 'usage', ...usage };
    yield { type: 'done', finish };
}
