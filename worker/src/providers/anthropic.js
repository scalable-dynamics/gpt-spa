// Anthropic (Claude) adapter — Messages API over raw HTTP, normalised to the unified event stream.
// Docs: https://platform.claude.com/docs/en/api/messages
import { HttpError, parseDataUrl, parseSSE, safeJsonParse, throwUpstream, uid } from '../util.js';

export const id = 'anthropic';
export const label = 'Anthropic';
export const secretName = 'ANTHROPIC_API_KEY';
const BASE = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';

export const catalog = {
    label: 'Anthropic',
    models: [
        { id: 'claude-opus-5', label: 'Claude Opus 5', vision: true, reasoning: true, default: true, context: 1000000 },
        { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', vision: true, reasoning: true, fast: true, context: 1000000 },
        { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', vision: true, reasoning: false, fast: true, context: 200000 },
        { id: 'claude-fable-5', label: 'Claude Fable 5', vision: true, reasoning: true, context: 1000000 },
        { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', vision: true, reasoning: true, context: 1000000 },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', vision: true, reasoning: true, context: 1000000 }
    ],
    reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'],
    capabilities: { web_search: true, x_search: false, code_execution: true, image_generation: false, tts: false, stt: false, embeddings: false, search: true }
};

function headers(key, model, extraBetas = []) {
    const betas = [...extraBetas];
    // Refusal fallbacks: on a policy decline the API re-runs the request on Anthropic's recommended fallback model.
    if (/^claude-(opus-5|fable-5|mythos-5)/.test(model)) betas.push('server-side-fallback-2026-07-01');
    const h = { 'x-api-key': key, 'anthropic-version': VERSION, 'content-type': 'application/json' };
    if (betas.length) h['anthropic-beta'] = betas.join(',');
    return h;
}

function supportsEffort(model) { return !/haiku/.test(model); }
function supportsAdaptiveThinking(model) { return !/haiku|opus-4-[015]|sonnet-4-[05]|opus-4-1/.test(model); }
function supportsThinkingDisplay(model) { return /opus-5|sonnet-5|fable-5|mythos-5|opus-4-[78]/.test(model); }
function usesFallbackDefault(model) { return /^claude-(opus-5|fable-5|mythos-5)/.test(model); }

// ---------- message conversion ----------
function toContentBlocks(content) {
    if (typeof content === 'string') return content;
    const blocks = [];
    for (const part of content || []) {
        if (part.type === 'text') blocks.push({ type: 'text', text: part.text });
        else if (part.type === 'image') {
            const data = parseDataUrl(part.url || part.data);
            if (data) blocks.push({ type: 'image', source: { type: 'base64', media_type: data.mime, data: data.b64 } });
            else if (part.url) blocks.push({ type: 'image', source: { type: 'url', url: part.url } });
        } else if (part.type === 'document' || part.type === 'file') {
            const data = parseDataUrl(part.url || part.data);
            if (data) blocks.push({ type: 'document', source: { type: 'base64', media_type: data.mime, data: data.b64 }, title: part.name });
        }
    }
    return blocks.length ? blocks : ' ';
}

function toAnthropicMessages(messages) {
    const out = [];
    for (const m of messages) {
        if (m.role === 'system') continue;
        if (m.role === 'assistant') {
            const blocks = [];
            const text = typeof m.content === 'string' ? m.content : (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
            if (text && text.trim()) blocks.push({ type: 'text', text });
            for (const tc of m.tool_calls || []) {
                blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: safeJsonParse(tc.arguments, {}) ?? {} });
            }
            if (!blocks.length) blocks.push({ type: 'text', text: '(no content)' });
            out.push({ role: 'assistant', content: blocks });
        } else if (m.role === 'tool') {
            const block = { type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) };
            const last = out[out.length - 1];
            if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
            else out.push({ role: 'user', content: [block] });
        } else {
            out.push({ role: 'user', content: toContentBlocks(m.content) });
        }
    }
    // Anthropic requires the first message to be from the user.
    if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: '(conversation start)' });
    return out;
}

function toAnthropicTools(tools) {
    const out = [];
    for (const t of tools || []) {
        if (t.type === 'function') out.push({ name: t.name, description: t.description || '', input_schema: t.parameters || { type: 'object', properties: {} } });
        else if (t.type === 'web_search') out.push({ type: 'web_search_20260209', name: 'web_search', max_uses: t.max_uses || 5, ...(t.allowed_domains ? { allowed_domains: t.allowed_domains } : {}) });
        else if (t.type === 'web_fetch') out.push({ type: 'web_fetch_20260209', name: 'web_fetch', max_uses: t.max_uses || 5 });
        else if (t.type === 'code_execution') out.push({ type: 'code_execution_20260120', name: 'code_execution' });
        // x_search / image_generation are not available on Anthropic; ignored.
    }
    return out;
}

function toToolChoice(choice) {
    if (!choice || choice === 'auto') return undefined;
    if (choice === 'none') return { type: 'none' };
    if (choice === 'required' || choice === 'any') return { type: 'any' };
    if (typeof choice === 'object' && choice.name) return { type: 'tool', name: choice.name };
    return undefined;
}

// ---------- chat ----------
export async function* chat({ key, signal }, params) {
    const model = params.model;
    const body = {
        model,
        max_tokens: params.max_tokens || 16000,
        messages: toAnthropicMessages(params.messages),
        stream: true
    };
    if (params.system) body.system = params.system;
    const tools = toAnthropicTools(params.tools);
    if (tools.length) body.tools = tools;
    const tc = toToolChoice(params.tool_choice);
    if (tc) body.tool_choice = tc;
    if (supportsAdaptiveThinking(model)) {
        body.thinking = supportsThinkingDisplay(model) ? { type: 'adaptive', display: 'summarized' } : { type: 'adaptive' };
    }
    const outputConfig = {};
    if (params.reasoning_effort && supportsEffort(model)) outputConfig.effort = params.reasoning_effort;
    if (params.response_format?.type === 'json_schema' && params.response_format.schema) {
        outputConfig.format = { type: 'json_schema', schema: params.response_format.schema };
    }
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;
    if (usesFallbackDefault(model)) body.fallbacks = 'default';

    const res = await fetch(`${BASE}/messages`, { method: 'POST', headers: headers(key, model), body: JSON.stringify(body), signal });
    if (!res.ok) await throwUpstream(res, 'Anthropic');

    // Track content blocks by index for tool_use argument accumulation.
    const blocks = new Map();
    let inputTokens = 0, outputTokens = 0;
    let stopReason = 'end_turn';
    for await (const { event, data } of parseSSE(res.body)) {
        const msg = safeJsonParse(data);
        if (!msg) continue;
        const type = msg.type || event;
        if (type === 'message_start') {
            inputTokens = msg.message?.usage?.input_tokens || 0;
        } else if (type === 'content_block_start') {
            const cb = msg.content_block || {};
            blocks.set(msg.index, { type: cb.type, id: cb.id, name: cb.name, json: '' });
            if (cb.type === 'web_search_tool_result' && Array.isArray(cb.content)) {
                for (const r of cb.content) if (r.type === 'web_search_result' && r.url) yield { type: 'citation', url: r.url, title: r.title };
            }
            if (cb.type === 'text' && cb.text) yield { type: 'text', delta: cb.text };
        } else if (type === 'content_block_delta') {
            const d = msg.delta || {};
            const block = blocks.get(msg.index);
            if (d.type === 'text_delta') yield { type: 'text', delta: d.text };
            else if (d.type === 'thinking_delta') { if (d.thinking) yield { type: 'reasoning', delta: d.thinking }; }
            else if (d.type === 'input_json_delta') { if (block) block.json += d.partial_json || ''; }
            else if (d.type === 'citations_delta') {
                const c = d.citation || {};
                if (c.url) yield { type: 'citation', url: c.url, title: c.title };
            }
        } else if (type === 'content_block_stop') {
            const block = blocks.get(msg.index);
            if (block && block.type === 'tool_use') {
                yield { type: 'tool_call', id: block.id || uid('toolu'), name: block.name, arguments: block.json || '{}' };
            }
        } else if (type === 'message_delta') {
            if (msg.delta?.stop_reason) stopReason = msg.delta.stop_reason;
            if (msg.usage?.output_tokens != null) outputTokens = msg.usage.output_tokens;
        } else if (type === 'message_stop') {
            // done
        } else if (type === 'error') {
            throw new HttpError(502, `Anthropic: ${msg.error?.message || 'stream error'}`, msg.error);
        }
    }
    yield { type: 'usage', input: inputTokens, output: outputTokens };
    const finish = stopReason === 'tool_use' ? 'tool_calls' : stopReason === 'max_tokens' ? 'length' : stopReason === 'refusal' ? 'refusal' : 'stop';
    if (finish === 'refusal') yield { type: 'text', delta: '\n\n_(The model declined this request.)_' };
    yield { type: 'done', finish };
}

// ---------- search (web_search server tool + citations) ----------
export async function search({ key, signal }, { query, max_results = 5, model }) {
    const m = model || 'claude-sonnet-5';
    const events = chat({ key, signal }, {
        model: m,
        system: 'You are a research assistant. Use the web_search tool to answer the query with current information, then reply with a concise, factual summary (under 200 words) that cites the sources you used.',
        messages: [{ role: 'user', content: query }],
        tools: [{ type: 'web_search', max_uses: Math.min(max_results, 8) }],
        max_tokens: 2048
    });
    let answer = '';
    const citations = [];
    for await (const ev of events) {
        if (ev.type === 'text') answer += ev.delta;
        else if (ev.type === 'citation' && !citations.some((c) => c.url === ev.url)) citations.push({ url: ev.url, title: ev.title });
        else if (ev.type === 'error') throw new HttpError(ev.status || 502, ev.message);
    }
    return { answer: answer.trim(), citations: citations.slice(0, max_results * 2), provider: 'anthropic', model: m };
}
