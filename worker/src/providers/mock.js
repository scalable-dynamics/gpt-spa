// Mock provider (enabled with ENABLE_MOCK=true) — lets you try the UI, tool loop and swarms without any API keys.
// Behaviour:
//   • "!tool <name> <json>" in the latest user message → emits that tool call once, then summarises the tool result.
//   • JSON-schema requests (router) → picks the first bot mentioned with "@" or the first listed bot.
//   • otherwise streams a short canned reply that echoes the request.
import { uid } from '../util.js';

export const id = 'mock';
export const label = 'Mock (no keys)';
export const secretName = 'ENABLE_MOCK';

export const catalog = {
    label: 'Mock (demo, no keys)',
    models: [{ id: 'mock-1', label: 'Mock model', vision: true, reasoning: false, fast: true, default: true, context: 100000 }],
    reasoning_levels: [],
    image: [{ id: 'mock-image', label: 'Mock image', default: true }],
    tts: { models: [{ id: 'mock-tts', label: 'Mock TTS', default: true }], voices: [{ id: 'mock', label: 'Mock voice' }] },
    stt: { models: [{ id: 'mock-stt', label: 'Mock STT', default: true }] },
    embeddings: [{ id: 'mock-embed', label: 'Mock embeddings (hashed)', dims: 64, default: true }],
    capabilities: { web_search: false, x_search: false, code_execution: false, image_generation: true, tts: true, stt: true, embeddings: true, search: true }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lastText = (m) => (typeof m.content === 'string' ? m.content : (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join(' '));

export async function* chat(_opts, params) {
    const messages = params.messages || [];
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const lastTool = messages[messages.length - 1]?.role === 'tool' ? messages[messages.length - 1] : null;
    const text = lastUser ? lastText(lastUser) : '';
    // `!slow 3000` — start streaming after a delay (tests use it to navigate while a turn is in flight)
    const slow = /!slow\s+(\d+)/.exec(text);
    if (slow) { yield { type: 'reasoning', delta: 'thinking slowly… ' }; await sleep(Math.min(Number(slow[1]), 20000)); }

    if (params.response_format?.type === 'json_schema') {
        const mention = /@([A-Za-z][\w-]*)/.exec(text);
        const listed = /^- ([^:\n]+):/m.exec(text);
        const owner = mention?.[1] || listed?.[1]?.trim() || 'Assistant';
        yield { type: 'text', delta: JSON.stringify({ owners: [owner] }) };
        yield { type: 'done', finish: 'stop' };
        return;
    }
    if (lastTool) {
        const out = `Tool **${lastTool.name}** returned: \`${String(lastTool.content).slice(0, 300)}\`. (mock summary)`;
        for (const w of out.split(' ')) { yield { type: 'text', delta: w + ' ' }; await sleep(8); }
        yield { type: 'usage', input: 10, output: 20 };
        yield { type: 'done', finish: 'stop' };
        return;
    }
    const directives = [...text.matchAll(/!tool\s+([\w-]+)[ \t]*(\{[^\n]*\})?/g)];
    const directive = directives[directives.length - 1];
    if (directive && !text.includes('[Hand-off from')) {
        const available = (params.tools || []).filter((t) => t.type === 'function').map((t) => t.name);
        const name = available.includes(directive[1]) ? directive[1] : available[0];
        yield { type: 'text', delta: `Calling ${name}… ` };
        yield { type: 'tool_call', id: uid('call'), name, arguments: directive[2] || '{}' };
        yield { type: 'done', finish: 'tool_calls' };
        return;
    }
    const tools = (params.tools || []).map((t) => t.name || t.type);
    const reply = `**Mock reply.** You said: “${text.slice(0, 200)}”.\n\nSystem prompt was ${params.system?.length || 0} chars; ${messages.length} message(s); tools available: ${tools.length ? tools.join(', ') : 'none'}.\n\nTip: type \`!tool <tool_name> {"arg":"value"}\` to make me call a tool.`;
    for (const chunk of reply.match(/.{1,12}/gs)) { yield { type: 'text', delta: chunk }; await sleep(10); }
    yield { type: 'usage', input: 5, output: 15 };
    yield { type: 'done', finish: 'stop' };
}

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
export async function image(_o, { prompt }) {
    return { images: [{ b64: PNG_1x1, mime: 'image/png', revised_prompt: `mock image for: ${prompt}` }], model: 'mock-image' };
}
export async function speech() {
    // 0.1s of silence as WAV
    const rate = 8000, n = 800;
    const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf);
    const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
    return { body: new Blob([buf]).stream(), contentType: 'audio/wav' };
}
export async function transcribe() { return { text: 'mock transcription', model: 'mock-stt' }; }
export async function embeddings(_o, { input }) {
    // deterministic bag-of-words hash embedding so similar texts land near each other
    const embed = (t) => { const v = new Array(64).fill(0); for (const w of String(t).toLowerCase().split(/\W+/).filter(Boolean)) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % 64] += 1; } const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
    return { embeddings: input.map(embed), model: 'mock-embed', dims: 64 };
}
export async function search(_o, { query }) {
    return { answer: `Mock search summary for "${query}".`, citations: [{ url: 'https://example.com/mock', title: 'Mock source' }], provider: 'mock', model: 'mock-1' };
}
