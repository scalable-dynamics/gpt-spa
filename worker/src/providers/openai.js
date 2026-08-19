// OpenAI adapter — Responses API (recommended for new apps), Images, Audio, Embeddings, over raw HTTP.
// Docs: https://developers.openai.com/api/reference/resources/responses/methods/create
import { HttpError, throwUpstream } from '../util.js';
import { parseResponsesStream, toInputItems, toToolChoice } from './responses.js';

export const id = 'openai';
export const label = 'OpenAI';
export const secretName = 'OPENAI_API_KEY';
const BASE = 'https://api.openai.com/v1';

export const catalog = {
    label: 'OpenAI',
    models: [
        { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol (flagship)', vision: true, reasoning: true, default: true, context: 1050000 },
        { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra (balanced)', vision: true, reasoning: true, context: 1050000 },
        { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna (fast & cheap)', vision: true, reasoning: true, fast: true, context: 1050000 },
        { id: 'gpt-5.5', label: 'GPT-5.5', vision: true, reasoning: true, context: 1050000 },
        { id: 'gpt-5.4', label: 'GPT-5.4', vision: true, reasoning: true, context: 1050000 },
        { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', vision: true, reasoning: true, fast: true, context: 400000 },
        { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', vision: true, reasoning: true, fast: true, context: 400000 },
        { id: 'gpt-5.2', label: 'GPT-5.2', vision: true, reasoning: true, context: 400000 },
        { id: 'gpt-5.1', label: 'GPT-5.1', vision: true, reasoning: true, context: 400000 },
        { id: 'gpt-4.1', label: 'GPT-4.1 (non-reasoning)', vision: true, reasoning: false, context: 1047576 },
        { id: 'gpt-4.1-mini', label: 'GPT-4.1 mini', vision: true, reasoning: false, fast: true, context: 1047576 }
    ],
    reasoning_levels: ['low', 'medium', 'high', 'xhigh'],
    image: [{ id: 'gpt-image-2', label: 'GPT Image 2', default: true }],
    tts: {
        models: [{ id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts', default: true }, { id: 'tts-1-hd', label: 'tts-1-hd' }],
        voices: ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'onyx', 'nova', 'sage', 'shimmer', 'verse'].map((v) => ({ id: v, label: v }))
    },
    stt: { models: [{ id: 'gpt-transcribe', label: 'gpt-transcribe', default: true }, { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe' }, { id: 'whisper-1', label: 'whisper-1' }] },
    embeddings: [{ id: 'text-embedding-3-small', label: 'text-embedding-3-small', dims: 1536, default: true }, { id: 'text-embedding-3-large', label: 'text-embedding-3-large', dims: 3072 }],
    capabilities: { web_search: true, x_search: false, code_execution: true, image_generation: true, tts: true, stt: true, embeddings: true, search: true, mcp_native: true }
};

const headers = (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });
const isReasoningModel = (model) => /^(gpt-5|o\d)/.test(model);

// ---------- tools conversion ----------
function toTools(tools) {
    const out = [];
    for (const t of tools || []) {
        if (t.type === 'function') out.push({ type: 'function', name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} }, strict: false });
        else if (t.type === 'web_search') out.push({ type: 'web_search', search_context_size: t.search_context_size || 'medium', ...(t.allowed_domains ? { filters: { allowed_domains: t.allowed_domains } } : {}) });
        else if (t.type === 'code_execution') out.push({ type: 'code_interpreter', container: { type: 'auto' } });
        else if (t.type === 'image_generation') out.push({ type: 'image_generation', model: t.model || 'gpt-image-2', size: t.size || 'auto', quality: t.quality || 'auto', output_format: 'png', partial_images: 0 });
        else if (t.type === 'mcp' && t.server_url) out.push({ type: 'mcp', server_label: t.server_label || 'mcp', server_url: t.server_url, require_approval: 'never', ...(t.headers ? { headers: t.headers } : {}), ...(t.authorization ? { authorization: t.authorization } : {}), ...(t.allowed_tools ? { allowed_tools: t.allowed_tools } : {}) });
        // x_search is xAI-only; ignored here.
    }
    return out;
}

// ---------- chat ----------
export async function* chat({ key, signal }, params) {
    const model = params.model;
    const body = {
        model,
        input: toInputItems(params.messages),
        stream: true,
        store: false
    };
    if (params.system) body.instructions = params.system;
    const tools = toTools(params.tools);
    if (tools.length) body.tools = tools;
    const tc = toToolChoice(params.tool_choice);
    if (tc) body.tool_choice = tc;
    if (params.max_tokens) body.max_output_tokens = params.max_tokens;
    if (isReasoningModel(model)) {
        body.reasoning = { summary: 'auto' };
        if (params.reasoning_effort) body.reasoning.effort = params.reasoning_effort;
    } else if (params.temperature != null) {
        body.temperature = params.temperature;
    }
    if (params.response_format?.type === 'json_schema' && params.response_format.schema) {
        body.text = { format: { type: 'json_schema', name: params.response_format.name || 'result', schema: params.response_format.schema, strict: !!params.response_format.strict } };
    }
    if (tools.some((t) => t.type === 'web_search')) body.include = ['web_search_call.action.sources'];

    const res = await fetch(`${BASE}/responses`, { method: 'POST', headers: headers(key), body: JSON.stringify(body), signal });
    if (!res.ok) await throwUpstream(res, 'OpenAI');

    yield* parseResponsesStream(res.body, 'OpenAI');
}

// ---------- images ----------
export async function image({ key }, { model, prompt, n = 1, size = 'auto', quality = 'auto' }) {
    const body = { model: model || 'gpt-image-2', prompt, n: Math.min(Math.max(+n || 1, 1), 4), size, quality, output_format: 'png' };
    const res = await fetch(`${BASE}/images/generations`, { method: 'POST', headers: headers(key), body: JSON.stringify(body) });
    if (!res.ok) await throwUpstream(res, 'OpenAI images');
    const data = await res.json();
    return { images: (data.data || []).map((d) => ({ b64: d.b64_json, url: d.url, mime: `image/${data.output_format || 'png'}`, revised_prompt: d.revised_prompt })), model: body.model };
}

// ---------- speech ----------
export async function speech({ key }, { model, voice, input, format = 'mp3', instructions, speed }) {
    const body = { model: model || 'gpt-4o-mini-tts', voice: voice || 'marin', input: String(input).slice(0, 4096), response_format: format };
    if (instructions && !/^tts-1/.test(body.model)) body.instructions = instructions;
    if (speed) body.speed = speed;
    const res = await fetch(`${BASE}/audio/speech`, { method: 'POST', headers: headers(key), body: JSON.stringify(body) });
    if (!res.ok) await throwUpstream(res, 'OpenAI speech');
    return { body: res.body, contentType: res.headers.get('content-type') || (format === 'mp3' ? 'audio/mpeg' : `audio/${format}`) };
}

// ---------- transcription ----------
export async function transcribe({ key }, { file, model, language }) {
    const form = new FormData();
    form.append('file', file, file.name || 'audio.webm');
    form.append('model', model || 'gpt-transcribe');
    if (language) form.append('language', language);
    form.append('response_format', 'json');
    const res = await fetch(`${BASE}/audio/transcriptions`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
    if (!res.ok) await throwUpstream(res, 'OpenAI transcription');
    const data = await res.json();
    return { text: data.text || '', model: model || 'gpt-transcribe' };
}

// ---------- embeddings ----------
export async function embeddings({ key }, { input, model }) {
    const res = await fetch(`${BASE}/embeddings`, { method: 'POST', headers: headers(key), body: JSON.stringify({ model: model || 'text-embedding-3-small', input }) });
    if (!res.ok) await throwUpstream(res, 'OpenAI embeddings');
    const data = await res.json();
    const sorted = (data.data || []).sort((a, b) => a.index - b.index).map((d) => d.embedding);
    return { embeddings: sorted, model: data.model, dims: sorted[0]?.length || 0 };
}

// ---------- search (web_search tool + citations) ----------
export async function search({ key, signal }, { query, max_results = 5, model }) {
    const m = model || 'gpt-5.6-luna';
    let answer = '';
    const citations = [];
    for await (const ev of chat({ key, signal }, {
        model: m,
        system: 'You are a research assistant. Search the web and answer the query with current information in a concise, factual summary (under 200 words). Cite sources.',
        messages: [{ role: 'user', content: query }],
        tools: [{ type: 'web_search', search_context_size: 'medium' }],
        tool_choice: 'required',
        reasoning_effort: 'low',
        max_tokens: 2048
    })) {
        if (ev.type === 'text') answer += ev.delta;
        else if (ev.type === 'citation' && !citations.some((c) => c.url === ev.url)) citations.push({ url: ev.url, title: ev.title });
        else if (ev.type === 'error') throw new HttpError(ev.status || 502, ev.message);
    }
    return { answer: answer.trim(), citations: citations.slice(0, max_results * 2), provider: 'openai', model: m };
}
