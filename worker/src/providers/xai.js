// xAI (Grok) adapter — Responses API (recommended), Grok Imagine images, TTS/STT voice, realtime tokens.
// Docs: https://docs.x.ai/developers/rest-api-reference/inference/chat
import { HttpError, throwUpstream } from '../util.js';
import { parseResponsesStream, toInputItems, toToolChoice } from './responses.js';

export const id = 'xai';
export const label = 'xAI';
export const secretName = 'XAI_API_KEY';
const BASE = 'https://api.x.ai/v1';

export const catalog = {
    label: 'xAI (Grok)',
    models: [
        { id: 'grok-4.6', label: 'Grok 4.6 (recommended)', vision: true, reasoning: true, default: true, context: 500000 },
        { id: 'grok-4.5', label: 'Grok 4.5', vision: true, reasoning: true, context: 500000 },
        { id: 'grok-4.3', label: 'Grok 4.3 (fast, 1M context)', vision: true, reasoning: true, fast: true, context: 1000000 },
        { id: 'grok-4.20-multi-agent', label: 'Grok 4.20 multi-agent (leader + specialists)', vision: true, reasoning: true, context: 1000000, note: 'Runs 4 or 16 internal agents; effort controls the count' },
        { id: 'grok-4.20-reasoning', label: 'Grok 4.20 reasoning', vision: true, reasoning: true, context: 1000000 },
        { id: 'grok-4.20-non-reasoning', label: 'Grok 4.20 non-reasoning', vision: true, reasoning: false, fast: true, context: 1000000 },
        { id: 'grok-build-0.1', label: 'Grok Build 0.1 (coding)', vision: true, reasoning: true, context: 256000 }
    ],
    reasoning_levels: ['low', 'medium', 'high', 'xhigh'],
    image: [
        { id: 'grok-imagine-image-2.0', label: 'Grok Imagine Image 2.0', default: true },
        { id: 'grok-imagine-image-quality', label: 'Grok Imagine Image (quality)' },
        { id: 'grok-imagine-image', label: 'Grok Imagine Image (fast)' }
    ],
    tts: {
        models: [{ id: 'grok-tts', label: 'Grok TTS', default: true }],
        voices: ['eve', 'ara', 'leo', 'rex', 'sal', 'carina', 'zagan', 'helix', 'orion', 'luna', 'iris', 'altair', 'zenith', 'perseus', 'helios', 'lux', 'kepler', 'rigel', 'cosmo', 'celeste', 'ursa', 'sirius', 'lumen', 'castor', 'naksh', 'atlas'].map((v) => ({ id: v, label: v[0].toUpperCase() + v.slice(1) }))
    },
    stt: { models: [{ id: 'grok-stt', label: 'Grok STT', default: true }] },
    embeddings: [],
    realtime: { model: 'grok-voice-latest', url: 'wss://api.x.ai/v1/realtime' },
    capabilities: { web_search: true, x_search: true, code_execution: true, image_generation: true, tts: true, stt: true, embeddings: false, search: true, mcp_native: true, realtime: true }
};

const headers = (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' });
const isReasoningModel = (model) => !/non-reasoning/.test(model);
const supportsEffort = (model) => !/non-reasoning|4\.20-0309-reasoning|4\.20-reasoning|build/.test(model);

function toTools(tools) {
    const out = [];
    for (const t of tools || []) {
        if (t.type === 'function') out.push({ type: 'function', name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} } });
        else if (t.type === 'web_search') out.push({ type: 'web_search', ...(t.allowed_domains ? { filters: { allowed_domains: t.allowed_domains.slice(0, 5) } } : {}) });
        else if (t.type === 'x_search') out.push({ type: 'x_search', ...(t.from_date ? { from_date: t.from_date } : {}), ...(t.to_date ? { to_date: t.to_date } : {}), ...(t.allowed_x_handles ? { allowed_x_handles: t.allowed_x_handles.slice(0, 20) } : {}) });
        else if (t.type === 'code_execution') out.push({ type: 'code_interpreter' });
        else if (t.type === 'image_generation') out.push({ type: 'image_generation', action: 'auto' });
        else if (t.type === 'mcp' && t.server_url) out.push({ type: 'mcp', server_label: t.server_label || 'mcp', server_url: t.server_url, ...(t.headers ? { headers: t.headers } : {}), ...(t.authorization ? { authorization: t.authorization } : {}), ...(t.allowed_tools ? { allowed_tools: t.allowed_tools } : {}) });
    }
    return out;
}

// ---------- chat ----------
export async function* chat({ key, signal }, params) {
    const model = params.model;
    const body = {
        model,
        input: toInputItems(params.messages, { systemRole: 'system' }),
        stream: true,
        store: false
    };
    if (params.system) body.instructions = params.system;
    const tools = toTools(params.tools);
    if (tools.length) body.tools = tools;
    const tc = toToolChoice(params.tool_choice);
    if (tc) body.tool_choice = tc;
    if (params.max_tokens) body.max_output_tokens = params.max_tokens;
    if (params.reasoning_effort && supportsEffort(model)) body.reasoning = { effort: params.reasoning_effort };
    if (!isReasoningModel(model) && params.temperature != null) body.temperature = params.temperature;
    if (params.response_format?.type === 'json_schema' && params.response_format.schema) {
        body.text = { format: { type: 'json_schema', name: params.response_format.name || 'result', schema: params.response_format.schema, strict: params.response_format.strict !== false } };
    }
    // Sources come back as structured citations (annotations + response.citations) which the UI renders itself;
    // xAI's inline "[[N]](url)" markup is disabled because its internal render directive can leak into text.
    if (tools.some((t) => t.type === 'web_search' || t.type === 'x_search')) body.include = ['web_search_call.action.sources', 'no_inline_citations'];

    const res = await fetch(`${BASE}/responses`, { method: 'POST', headers: headers(key), body: JSON.stringify(body), signal });
    if (!res.ok) await throwUpstream(res, 'xAI');
    yield* parseResponsesStream(res.body, 'xAI');
}

// ---------- images (Grok Imagine) ----------
export async function image({ key }, { model, prompt, n = 1, aspect_ratio, resolution, quality }) {
    const body = { model: model || 'grok-imagine-image-2.0', prompt, n: Math.min(Math.max(+n || 1, 1), 4), response_format: 'url' };
    if (aspect_ratio) body.aspect_ratio = aspect_ratio;
    if (resolution) body.resolution = resolution;
    if (quality && /image-2\.0/.test(body.model)) body.quality = quality;
    const res = await fetch(`${BASE}/images/generations`, { method: 'POST', headers: headers(key), body: JSON.stringify(body) });
    if (!res.ok) await throwUpstream(res, 'xAI images');
    const data = await res.json();
    return { images: (data.data || []).map((d) => ({ url: d.url, b64: d.b64_json, mime: d.mime_type || 'image/jpeg', revised_prompt: d.revised_prompt })), model: body.model };
}

/** Image editing (JSON body): edit an existing image (data URL or https URL) with a prompt. */
export async function imageEdit({ key }, { model, prompt, image }) {
    const body = { model: model || 'grok-imagine-image-2.0', prompt, image: { type: 'image_url', url: image }, response_format: 'url' };
    const res = await fetch(`${BASE}/images/edits`, { method: 'POST', headers: headers(key), body: JSON.stringify(body) });
    if (!res.ok) await throwUpstream(res, 'xAI image edit');
    const data = await res.json();
    return { images: (data.data || []).map((d) => ({ url: d.url, b64: d.b64_json, mime: d.mime_type || 'image/jpeg' })), model: body.model };
}

// ---------- speech (TTS) ----------
export async function speech({ key }, { voice, input, format = 'mp3', language, speed }) {
    const codec = format === 'wav' ? 'wav' : format === 'pcm' ? 'pcm' : 'mp3';
    // `language` is required by /v1/tts ('auto' lets the model detect; default to English).
    const body = { text: String(input).slice(0, 15000), voice_id: (voice || 'eve').toLowerCase(), language: language || 'en', output_format: { codec, sample_rate: 24000, ...(codec === 'mp3' ? { bit_rate: 128000 } : {}) } };
    if (speed) body.speed = Math.min(Math.max(+speed, 0.7), 1.5);
    const res = await fetch(`${BASE}/tts`, { method: 'POST', headers: headers(key), body: JSON.stringify(body) });
    if (!res.ok) await throwUpstream(res, 'xAI tts');
    return { body: res.body, contentType: res.headers.get('content-type') || (codec === 'mp3' ? 'audio/mpeg' : `audio/${codec}`) };
}

// ---------- transcription (STT) ----------
export async function transcribe({ key }, { file, language }) {
    const form = new FormData();
    // 'format' (punctuation/casing) requires 'language'; default to English. The file field must be last.
    form.append('language', language || 'en');
    form.append('format', 'true');
    form.append('file', file, file.name || 'audio.webm');
    const res = await fetch(`${BASE}/stt`, { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
    if (!res.ok) await throwUpstream(res, 'xAI stt');
    const data = await res.json();
    return { text: data.text || '', language: data.language, duration: data.duration, model: 'grok-stt' };
}

// ---------- search (web_search / x_search server tools) ----------
export async function search({ key, signal }, { query, mode = 'web', max_results = 5, model, from_date, to_date }) {
    const m = model || 'grok-4.3';
    const tools = [];
    if (mode === 'web' || mode === 'both') tools.push({ type: 'web_search' });
    if (mode === 'x' || mode === 'both') tools.push({ type: 'x_search', from_date, to_date });
    let answer = '';
    const citations = [];
    for await (const ev of chat({ key, signal }, {
        model: m,
        system: `You are a research assistant. Use ${mode === 'x' ? 'X search' : mode === 'both' ? 'web and X search' : 'web search'} to answer the query with current information in a concise, factual summary (under 200 words). Include links to sources.`,
        messages: [{ role: 'user', content: query }],
        tools,
        reasoning_effort: 'low',
        max_tokens: 2048
    })) {
        if (ev.type === 'text') answer += ev.delta;
        else if (ev.type === 'citation' && !citations.some((c) => c.url === ev.url)) citations.push({ url: ev.url, title: ev.title });
        else if (ev.type === 'error') throw new HttpError(ev.status || 502, ev.message);
    }
    return { answer: answer.trim(), citations: citations.slice(0, max_results * 2), provider: 'xai', model: m };
}

// ---------- realtime voice: ephemeral client secret for the browser ----------
export async function realtimeToken({ key }, { expires = 300 } = {}) {
    const res = await fetch(`${BASE}/realtime/client_secrets`, { method: 'POST', headers: headers(key), body: JSON.stringify({ expires_after: { seconds: Math.min(Math.max(+expires || 300, 60), 3600) } }) });
    if (!res.ok) await throwUpstream(res, 'xAI realtime');
    const data = await res.json();
    return { client_secret: data.value, expires_at: data.expires_at, url: catalog.realtime.url, model: catalog.realtime.model };
}
