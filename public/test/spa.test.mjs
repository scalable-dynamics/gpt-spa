// SPA unit tests (run in Node with light browser shims): store migration, swarm helpers, chunking,
// tool composition, and the agent tool loop against a mocked worker stream.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

// ---- browser shims (minimal) ----
const mem = new Map();
globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
    clear: () => mem.clear()
};
globalThis.window = undefined; // ui.js guards on typeof window
if (!globalThis.crypto?.subtle) globalThis.crypto = (await import('node:crypto')).webcrypto;

const { createStore, normalizeBot } = await import('../js/store.js');
const { transcriptToMessages, parseMentions } = await import('../js/swarm.js');
const { chunkText } = await import('../js/vectors.js');
const { buildTools, nativeToolsFor, BUILTIN_TOOLS, fn, speakable, autoSpeak, ttsFor } = await import('../js/tools.js');
const { runBotTurn, buildSystemPrompt } = await import('../js/agent.js');
const { audioFilename } = await import('../js/api.js');

const CATALOG = {
    providers: {
        openai: { id: 'openai', enabled: true, models: [{ id: 'gpt-x', default: true, fast: true }], image: [{ id: 'img' }], tts: { voices: [{ id: 'marin' }] }, embeddings: [{ id: 'emb' }], capabilities: { web_search: true, code_execution: true, search: true } },
        xai: { id: 'xai', enabled: true, models: [{ id: 'grok-x', default: true }], image: [{ id: 'gimg' }], tts: { voices: [{ id: 'eve' }] }, capabilities: { web_search: true, x_search: true, code_execution: true, search: true, realtime: true } },
        anthropic: { id: 'anthropic', enabled: false, models: [{ id: 'claude-x', default: true }], capabilities: { web_search: true, code_execution: true, search: true } }
    },
    defaults: { chat: 'openai', image: 'xai', tts: 'openai', stt: 'openai', embeddings: 'openai', search: 'xai' }
};

test('store migrates legacy "gpts" records into bots and maps legacy tools', () => {
    mem.clear();
    localStorage.setItem('gpts', JSON.stringify({
        ChatGPT: { name: 'ChatGPT', welcome: 'hi', instructions: 'You are helpful.', tools: ['Image Generation (DALL-E)', 'Text-to-speech (TTS)', 'Bing Search', 'Quote of the day'], voice: 'nova' }
    }));
    const store = createStore([{ name: 'Assistant', provider: 'openai', instructions: 'x' }]);
    const bots = store.listBots().map((b) => b.name);
    assert.deepEqual(bots, ['Assistant', 'ChatGPT']);
    const migrated = store.getBot('ChatGPT');
    assert.deepEqual(migrated.tools, ['image_generation', 'text_to_speech', 'web_search', 'bot:Quote of the day']);
    assert.deepEqual(migrated.voice, { provider: 'openai', voice: 'nova' });
    assert.equal(migrated.provider, 'openai');
});

test('store: rename keeps swarm membership, memory and delegation references in sync', () => {
    mem.clear();
    const store = createStore([{ name: 'A', instructions: 'a' }, { name: 'B', instructions: 'b', tools: ['bot:A'] }]);
    const swarm = store.saveSwarm({ name: 'Team', bots: ['A', 'B'], coordinator: 'A' });
    store.addMemory('likes tea', 'A');
    store.saveBot({ ...store.getBot('A'), name: 'Alpha' }, 'A');
    assert.equal(store.getBot('A'), null);
    assert.deepEqual(store.getSwarm(swarm.id).bots, ['Alpha', 'B']);
    assert.deepEqual(store.getBot('B').tools, ['bot:Alpha']);
    assert.equal(store.getMemory('Alpha').bot[0].text, 'likes tea');
    assert.throws(() => store.saveBot({ name: 'bad@name' }), /cannot contain/);
    assert.throws(() => store.saveSwarm({ name: 'x', bots: [] }), /at least one bot/);
    // legacy transcripts stored on the swarm object are handed to the caller once (migration to the chat log)
    localStorage.setItem('swarms', JSON.stringify({ [swarm.id]: { ...store.getSwarm(swarm.id), transcript: [{ kind: 'user', text: 'hello' }] } }));
    const store2 = createStore([]);
    const legacy = store2.takeLegacyTranscripts();
    assert.deepEqual(legacy[swarm.id].map((e) => e.text), ['hello']);
    assert.deepEqual(store2.takeLegacyTranscripts(), {});
    assert.equal(store2.getSwarm(swarm.id).transcript, undefined);
    store.deleteBot('B');
    assert.deepEqual(store.getSwarm(swarm.id).bots, ['Alpha']);
});

test('normalizeBot fills defaults', () => {
    const b = normalizeBot({ name: ' Zed ' }, { provider: 'xai' });
    assert.equal(b.name, 'Zed');
    assert.equal(b.provider, 'xai');
    assert.match(b.welcome, /Zed/);
    assert.deepEqual(b.tools, []);
    assert.equal(b.canDelegate, true);
});

test('parseMentions: names, compact handles, @everyone', () => {
    const members = [{ name: 'Researcher' }, { name: 'Data Analyst' }, { name: 'Artist' }];
    assert.deepEqual(parseMentions('@Researcher find it and @dataanalyst check', members), ['Researcher', 'Data Analyst']);
    assert.deepEqual(parseMentions('hey @everyone', members), ['Researcher', 'Data Analyst', 'Artist']);
    assert.deepEqual(parseMentions('no mentions here', members), []);
});

test('transcriptToMessages: perspective per bot, merging, hand-offs, images on the last user turn', () => {
    const transcript = [
        { kind: 'user', text: 'Q1' },
        { kind: 'bot', from: 'A', text: 'A says' },
        { kind: 'bot', from: 'B', text: 'B says' },
        { kind: 'handoff', from: 'B', to: 'A', text: 'take over' },
        { kind: 'note', text: 'file uploaded' },
        { kind: 'user', text: 'Q2' }
    ];
    const forA = transcriptToMessages(transcript, 'A', { images: ['data:image/png;base64,AAAA'] });
    assert.deepEqual(forA.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.match(forA[2].content[0].text, /\[Message from bot "B"\]\nB says/);
    assert.match(forA[2].content[0].text, /\[Hand-off from "B" to "A"\]\ntake over/);
    assert.match(forA[2].content[0].text, /\[System note\] file uploaded/);
    assert.match(forA[2].content[0].text, /Q2$/);
    assert.equal(forA[2].content[1].type, 'image');
    const forB = transcriptToMessages(transcript, 'B');
    assert.deepEqual(forB.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.match(forB[0].content, /\[Message from bot "A"\]/);
    // a transcript that starts with a bot message gets a synthetic user opener
    assert.equal(transcriptToMessages([{ kind: 'bot', from: 'A', text: 'hi' }], 'A')[0].role, 'user');
});

test('chunkText splits long text into overlapping sentence chunks', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const chunks = [...chunkText(text, 300)];
    assert.ok(chunks.length > 3);
    assert.ok(chunks.every((c) => c.length <= 330));
    // overlap: the last sentence of chunk N appears at the start of chunk N+1
    const lastSentence = chunks[0].split('. ').filter(Boolean).at(-1).replace(/\.$/, '');
    assert.ok(chunks[1].startsWith(lastSentence));
    assert.deepEqual([...chunkText('')], []);
});

// ---- minimal in-memory IndexedDB shim (enough for vectors.js) ----
function fakeIndexedDB() {
    const dbs = new Map();
    const req = (run) => { const r = {}; queueMicrotask(() => { try { r.result = run(); r.onsuccess?.({ target: r }); } catch (e) { r.error = e; r.onerror?.({ target: r }); } }); return r; };
    return {
        open(name) {
            const r = {};
            queueMicrotask(() => {
                let db = dbs.get(name);
                const fresh = !db;
                if (fresh) {
                    const stores = new Map();
                    db = {
                        objectStoreNames: { contains: (n) => stores.has(n) },
                        createObjectStore(n) { stores.set(n, new Map()); return { createIndex() { } }; },
                        transaction(n) {
                            const store = stores.get(n);
                            const t = {};
                            queueMicrotask(() => queueMicrotask(() => t.oncomplete?.()));
                            t.objectStore = () => ({
                                put: (v) => store.set(v.id, v), delete: (id) => store.delete(id), clear: () => store.clear(),
                                getAll: () => req(() => [...store.values()])
                            });
                            return t;
                        }
                    };
                    dbs.set(name, db);
                }
                r.result = db;
                if (fresh) r.onupgradeneeded?.({ target: r });
                r.onsuccess?.({ target: r });
            });
            return r;
        }
    };
}

test('vector store: records carry the embedding model; a model switch re-indexes and search only compares like with like', async () => {
    globalThis.indexedDB = fakeIndexedDB();
    const { default: createVectorStore } = await import('../js/vectors.js');
    let model = 'cloudflare/bge';
    const calls = [];
    const embed = async (texts) => { calls.push(texts.length); return { vectors: texts.map((t) => (model === 'cloudflare/bge' ? [1, 0, 0] : [0, 1, 0, 0])), model }; };
    const vs = createVectorStore(embed);
    const text = 'Cats purr when content. Dogs wag their tails. Parrots can mimic speech.';
    assert.equal(await vs.storeDocument('pets.txt', text, 'bot:A'), 1);
    assert.equal(calls.length, 1);
    // same document again with the same model → cached (one probe call, no re-embed)
    await vs.storeDocument('pets.txt', text, 'bot:A');
    assert.deepEqual(calls, [1, 1]);
    let hits = await vs.search('purring cats', { scopes: ['bot:A'], minScore: 0.1 });
    assert.equal(hits.length, 1);
    // the embedder switches model (e.g. OPENAI_API_KEY added later): old vectors are ignored, not compared
    model = 'openai/text-embedding-3-small';
    hits = await vs.search('purring cats', { scopes: ['bot:A'], minScore: 0.1 });
    assert.equal(hits.length, 0, 'vectors from a different model must not be scored');
    // re-uploading re-indexes with the new model
    await vs.storeDocument('pets.txt', text, 'bot:A');
    hits = await vs.search('purring cats', { scopes: ['bot:A'], minScore: 0.1 });
    assert.equal(hits.length, 1);
    assert.deepEqual((await vs.listDocuments(['bot:A'])).map((d) => d.name), ['pets.txt']);
    delete globalThis.indexedDB;
});

test('text-to-speech: replies of a TTS bot are spoken automatically (markdown stripped), not twice, and never without the tool', async () => {
    assert.equal(speakable('## Hi\n\n**Bold** and `code` — see [docs](https://x.y/z) and https://a.b/c\n\n- one\n- two'), 'Hi\nBold and code — see docs and link\none\ntwo');
    assert.ok(speakable('A sentence. '.repeat(500)).length <= 3000);
    const cat = { providers: { xai: { enabled: true, tts: { voices: [{ id: 'eve' }] } }, openai: { enabled: false, tts: { voices: [] } } }, defaults: { tts: 'xai' } };
    assert.deepEqual(ttsFor({ provider: 'xai', voice: { provider: 'xai', voice: 'eve' } }, cat), { provider: 'xai', voice: 'eve' });
    assert.deepEqual(ttsFor({ provider: 'anthropic', voice: { provider: 'openai', voice: 'marin' } }, cat), { provider: 'xai', voice: undefined }, 'falls back to a configured TTS provider');
    // stub the worker's /api/speech
    const calls = [];
    globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return new Response(new Blob([new Uint8Array(2000)], { type: 'audio/mpeg' }), { status: 200, headers: { 'content-type': 'audio/mpeg' } }); };
    const played = [];
    const ui = { addAudio: (blob, autoplay) => played.push({ size: blob.size, autoplay }), addNote: () => { } };
    const bot = { name: 'Talk', provider: 'xai', tools: ['text_to_speech'], voice: { provider: 'xai', voice: 'eve' } };
    assert.equal(await autoSpeak({ bot, catalog: cat, result: { text: 'Hey **there**!', toolCalls: [] }, ui }), true);
    assert.equal(played.length, 1);
    assert.equal(calls[0].body.input, 'Hey there!');
    assert.equal(calls[0].body.voice, 'eve');
    // already spoke via the speak tool → no second playback
    assert.equal(await autoSpeak({ bot, catalog: cat, result: { text: 'x', toolCalls: [{ name: 'speak', args: {}, result: '{}' }] }, ui }), false);
    // tool not enabled → silent
    assert.equal(await autoSpeak({ bot: { ...bot, tools: [] }, catalog: cat, result: { text: 'x', toolCalls: [] }, ui }), false);
    assert.equal(played.length, 1);
    delete globalThis.fetch;
});

test('nativeToolsFor only passes provider-native tools', () => {
    const bot = { provider: 'xai', tools: ['web_search', 'x_search', 'code_execution', 'image_generation', 'memory'] };
    assert.deepEqual(nativeToolsFor(bot, CATALOG), [{ type: 'web_search' }, { type: 'x_search' }, { type: 'code_execution' }]);
    assert.deepEqual(nativeToolsFor({ ...bot, provider: 'openai' }, CATALOG), [{ type: 'web_search' }, { type: 'code_execution' }]);
    assert.ok(BUILTIN_TOOLS.some((t) => t.id === 'ask_bot'));
});

function fakeStore(overrides = {}) {
    return {
        listMcpServers: () => [], getSkill: () => null, listSkills: () => [], addMemory: () => ({}), getMemory: () => ({ shared: [], bot: [] }),
        ...overrides
    };
}
const fakeVectors = { listDocuments: async () => [{ name: 'doc.pdf', chunks: 3 }], search: async () => [], getDocumentText: async () => 'full text' };

test('buildTools composes function tools from the bot config (search falls back to a function tool when not native)', async () => {
    const bot = { name: 'A', provider: 'anthropic', tools: ['web_search', 'x_search', 'image_generation', 'text_to_speech', 'document_search', 'summarize_document', 'memory', 'ask_bot'], skills: ['s1'] };
    const store = fakeStore({ getSkill: (n) => (n === 's1' ? { name: 's1', description: 'd', instructions: 'do it' } : null) });
    const tools = await buildTools({ bot, store, vectorStore: fakeVectors, catalog: CATALOG, availableBots: [{ name: 'A' }, { name: 'B', canDelegate: true }], askBot: async () => 'ok', messageBot: () => true, depth: 0, mcpToolsCached: async () => ({ tools: [] }) });
    const names = tools.map((t) => t.def.name).sort();
    // anthropic has native web_search → no web_search function tool; x_search is not native there → function tool
    assert.deepEqual(names, ['ask_bot', 'generate_image', 'list_bots', 'list_documents', 'message_bot', 'read_document', 'recall', 'remember', 'search_documents', 'speak', 'use_skill', 'x_search']);
    for (const t of tools) { assert.equal(t.def.type, 'function'); assert.equal(t.def.parameters.type, 'object'); }
    const ask = tools.find((t) => t.def.name === 'ask_bot');
    assert.deepEqual(ask.def.parameters.properties.bot.enum, ['B']);
    const read = tools.find((t) => t.def.name === 'read_document');
    assert.deepEqual(await read.run({ name: 'doc.pdf' }), { name: 'doc.pdf', part: 1, of: 1, text: 'full text' });
});

test('buildTools: MCP tools are namespaced and gated by approval', async () => {
    let approved = 0, called = 0;
    globalThis.fetch = async (url, init) => { called++; return new Response(JSON.stringify({ content: [{ type: 'text', text: 'pong' }], isError: false }), { headers: { 'content-type': 'application/json' } }); };
    const store = fakeStore({ listMcpServers: () => [{ name: 'srv', url: 'https://mcp.example/mcp', headers: {}, requireApproval: true }] });
    const bot = { name: 'A', provider: 'openai', tools: ['mcp:srv'] };
    const tools = await buildTools({ bot, store, vectorStore: fakeVectors, catalog: CATALOG, availableBots: [], depth: 0, mcpToolsCached: async () => ({ tools: [{ name: 'ping', description: 'Ping', input_schema: { type: 'object', properties: { x: { type: 'string' } } } }] }), approve: async () => { approved++; return approved > 1; } });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].def.name, 'srv__ping');
    assert.match(tools[0].def.description, /\[MCP: srv\]/);
    assert.deepEqual(await tools[0].run({ x: 1 }), { denied: true, note: 'The user denied this action.' }); // first approval denied
    assert.equal(called, 0);
    assert.equal(await tools[0].run({ x: 1 }), 'pong');
    assert.equal(called, 1);
});

test('buildSystemPrompt includes name, memory, skills and room rules', () => {
    const store = fakeStore({ getMemory: () => ({ shared: [{ text: 'shared fact' }], bot: [{ text: 'bot fact' }] }) });
    const p = buildSystemPrompt({ name: 'Zed', title: 'Analyst', instructions: 'Be careful.' }, { store, swarm: { name: 'Team', goal: 'ship', members: [{ name: 'Zed' }, { name: 'Ann', title: 'Writer' }] }, skills: [{ name: 'k', description: 'kd' }] });
    for (const needle of ['Be careful.', '"Zed"', '(Analyst)', '(shared) shared fact', '- bot fact', 'k: kd', 'room "Team"', 'Shared goal: ship', 'Ann — Writer', 'ask_bot']) assert.ok(p.includes(needle), `missing ${needle}`);
});

function sseResponse(events) {
    return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

test('runBotTurn: streams text, executes tool calls in the browser, feeds results back, stops when done', async () => {
    const requests = [];
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        requests.push(body);
        if (requests.length === 1) return sseResponse([{ type: 'text', delta: 'Let me check. ' }, { type: 'tool_call', id: 'c1', name: 'search_documents', arguments: '{"query":"tea"}' }, { type: 'done', finish: 'tool_calls' }]);
        return sseResponse([{ type: 'text', delta: 'Found ' }, { type: 'text', delta: 'it.' }, { type: 'citation', url: 'https://a.example', title: 'A' }, { type: 'usage', input: 1, output: 2 }, { type: 'done', finish: 'stop' }]);
    };
    const searched = [];
    const vectorStore = { ...fakeVectors, search: async (q) => { searched.push(q); return [{ name: 'doc.pdf', score: 0.9, text: 'tea is nice' }]; } };
    const events = [];
    const ui = { append: (d) => events.push(['text', d]), appendReasoning: () => { }, addTool: (name, args) => { events.push(['tool', name, args]); return { done: (r, err) => events.push(['tool-done', name, !!err]) }; }, addCitations: (c) => events.push(['cite', c.length]), addImage: () => { } };
    const bot = { name: 'A', provider: 'openai', model: 'gpt-x', instructions: 'inst', tools: ['document_search'] };
    const result = await runBotTurn({ bot, messages: [{ role: 'user', content: 'tea?' }], ui, ctx: { store: fakeStore(), vectorStore, catalog: CATALOG, availableBots: [], depth: 0, mcpToolsCached: async () => ({ tools: [] }) } });
    assert.equal(result.text, 'Found it.');
    assert.deepEqual(result.citations, [{ url: 'https://a.example', title: 'A' }]);
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].name, 'search_documents');
    assert.deepEqual(result.toolCalls[0].args, { query: 'tea' });
    assert.match(result.toolCalls[0].result, /tea is nice/);
    assert.equal(result.toolCalls[0].error, false);
    assert.deepEqual(searched, ['tea']);
    assert.equal(requests.length, 2);
    // second request carries the assistant tool call + tool result, and function tool definitions
    assert.equal(requests[1].messages[1].role, 'assistant');
    assert.deepEqual(requests[1].messages[1].tool_calls, [{ id: 'c1', name: 'search_documents', arguments: '{"query":"tea"}' }]);
    assert.equal(requests[1].messages[2].role, 'tool');
    assert.equal(requests[1].messages[2].tool_call_id, 'c1');
    assert.match(requests[1].messages[2].content, /tea is nice/);
    assert.ok(requests[1].tools.some((t) => t.name === 'search_documents'));
    assert.match(requests[1].system, /inst/);
    assert.deepEqual(events.filter((e) => e[0] === 'tool').map((e) => e[1]), ['search_documents']);
    assert.ok(events.some((e) => e[0] === 'tool-done' && e[2] === false));
});

test('runBotTurn: unknown tool and tool errors are reported back to the model instead of crashing', async () => {
    let n = 0;
    globalThis.fetch = async () => (++n === 1
        ? sseResponse([{ type: 'tool_call', id: 'c1', name: 'nope', arguments: '{}' }, { type: 'tool_call', id: 'c2', name: 'read_document', arguments: 'not json' }, { type: 'done', finish: 'tool_calls' }])
        : sseResponse([{ type: 'text', delta: 'ok' }, { type: 'done', finish: 'stop' }]));
    const ui = { append() { }, appendReasoning() { }, addTool: () => ({ done() { } }), addCitations() { }, addImage() { } };
    const bot = { name: 'A', provider: 'openai', model: 'gpt-x', instructions: 'i', tools: ['summarize_document'] };
    const result = await runBotTurn({ bot, messages: [{ role: 'user', content: 'x' }], ui, ctx: { store: fakeStore(), vectorStore: { ...fakeVectors, getDocumentText: async () => '' , listDocuments: async () => [] }, catalog: CATALOG, availableBots: [], depth: 0, mcpToolsCached: async () => ({ tools: [] }) } });
    assert.equal(result.text, 'ok');
    assert.equal(n, 2);
});

test('audioFilename picks an extension the transcription APIs accept (Safari records audio/mp4)', () => {
    assert.equal(audioFilename('audio/mp4'), 'recording.m4a');
    assert.equal(audioFilename('audio/webm;codecs=opus'), 'recording.webm');
    assert.equal(audioFilename('audio/mpeg'), 'recording.mp3');
    assert.equal(audioFilename(''), 'recording.webm');
});

test('fn() builds strict function schemas', () => {
    const d = fn('x', 'desc', { a: { type: 'string' } }, ['a']);
    assert.deepEqual(d, { type: 'function', name: 'x', description: 'desc', parameters: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'], additionalProperties: false } });
});

test('resolveModel falls back to a configured provider when the bot\'s provider has no key', async () => {
    const { resolveModel } = await import('../js/agent.js');
    const cat = { providers: { openai: { enabled: false, models: [{ id: 'gpt-x', default: true }] }, xai: { enabled: true, models: [{ id: 'grok-x', default: true }] }, anthropic: { enabled: true, models: [{ id: 'claude-x', default: true }] } } };
    assert.deepEqual(resolveModel({ provider: 'openai', model: 'gpt-x' }, cat), { provider: 'xai', model: 'grok-x', fallback: true, wanted: 'openai' });
    assert.deepEqual(resolveModel({ provider: 'anthropic', model: '' }, cat), { provider: 'anthropic', model: 'claude-x', fallback: false, wanted: 'anthropic' });
    assert.deepEqual(resolveModel({ provider: 'anthropic', model: 'claude-y' }, cat), { provider: 'anthropic', model: 'claude-y', fallback: false, wanted: 'anthropic' });
    // no catalog yet (offline) → keep the configured values
    assert.equal(resolveModel({ provider: 'openai', model: 'gpt-x' }, null).provider, 'openai');
});
