// Tool registry: built-in tools every bot can enable, MCP tools discovered from configured servers, and
// swarm tools (talking to other bots). Each tool has a function-calling definition and a `run` implementation
// that executes in the browser (calling the worker where needed).

import * as api from './api.js';

export const BUILTIN_TOOLS = [
    { id: 'web_search', label: 'Web search', description: 'Search the web for current information (xAI, OpenAI or Anthropic search)' },
    { id: 'x_search', label: 'X (Twitter) search', description: 'Search posts on X via xAI' },
    { id: 'image_generation', label: 'Image generation', description: 'Create images with xAI Grok Imagine or OpenAI gpt-image' },
    { id: 'text_to_speech', label: 'Text-to-speech (replies read aloud)', description: 'Replies are read aloud in the bot\'s voice (xAI or OpenAI); the bot can also speak extra text' },
    { id: 'document_search', label: 'Document search (vectors)', description: 'Semantic search across uploaded documents' },
    { id: 'summarize_document', label: 'Summarize document', description: 'Read a full uploaded document (e.g. a PDF) and summarise it' },
    { id: 'memory', label: 'Memory', description: 'Remember facts and preferences across conversations' },
    { id: 'code_execution', label: 'Code execution (native)', description: 'Provider-hosted code sandbox (OpenAI / xAI / Anthropic)' },
    { id: 'ask_bot', label: 'Talk to other bots', description: 'Delegate to and message other bots (rooms)' }
];

const NATIVE_SEARCH = { web_search: true, x_search: true, code_execution: true };

/** Tools that are executed natively by the provider (passed straight through to the worker). */
export function nativeToolsFor(bot, catalog) {
    const caps = catalog?.providers?.[bot.provider]?.capabilities || {};
    const out = [];
    for (const id of bot.tools || []) {
        if (!NATIVE_SEARCH[id]) continue;
        if (id === 'web_search' && caps.web_search) out.push({ type: 'web_search' });
        if (id === 'x_search' && caps.x_search) out.push({ type: 'x_search' });
        if (id === 'code_execution' && caps.code_execution) out.push({ type: 'code_execution' });
    }
    return out;
}

/**
 * Build the function-tool set for a bot.
 * ctx: { store, vectorStore, catalog, bot, swarm(optional), askBot(name, task) , messageBot(name, message), listBots(), ui, approve(title, detail) }
 */
export async function buildTools(ctx) {
    const { bot, store, vectorStore, catalog } = ctx;
    const enabled = new Set(bot.tools || []);
    const caps = catalog?.providers?.[bot.provider]?.capabilities || {};
    const tools = [];

    // ---- Web / X search as function tools when the provider has no native search (or to reach xAI search from any bot)
    if (enabled.has('web_search') && !caps.web_search) {
        tools.push({
            def: fn('web_search', 'Search the web for up-to-date information. Returns a short answer with source URLs.', {
                query: { type: 'string', description: 'What to search for' }
            }, ['query']),
            run: async ({ query }) => {
                const provider = catalog?.defaults?.search;
                if (!provider) return { error: 'No search-capable provider is configured on the worker.' };
                const r = await api.search({ provider, query, mode: 'web' });
                return { answer: r.answer, sources: r.citations };
            }
        });
    }
    if (enabled.has('x_search') && !caps.x_search) {
        tools.push({
            def: fn('x_search', 'Search recent posts on X (Twitter) via xAI. Returns a summary with links.', {
                query: { type: 'string', description: 'What to search for on X' }
            }, ['query']),
            run: async ({ query }) => {
                if (!catalog?.providers?.xai?.enabled) return { error: 'X search needs XAI_API_KEY on the worker.' };
                const r = await api.search({ provider: 'xai', query, mode: 'x' });
                return { answer: r.answer, sources: r.citations };
            }
        });
    }

    // ---- Image generation
    if (enabled.has('image_generation')) {
        tools.push({
            def: fn('generate_image', 'Generate an image from a text prompt. Use when the user asks for a picture, illustration, logo, diagram, etc.', {
                prompt: { type: 'string', description: 'Detailed description of the image to create' },
                provider: { type: 'string', enum: ['xai', 'openai'], description: 'Optional: which image model family to use' }
            }, ['prompt']),
            run: async ({ prompt, provider }, meta) => {
                const enabledFor = (id) => catalog?.providers?.[id]?.enabled && catalog?.providers?.[id]?.image?.length;
                const p = (provider && enabledFor(provider) ? provider : null) || catalog?.defaults?.image;
                if (!p) return { error: 'No image-generation provider is configured on the worker (needs XAI_API_KEY or OPENAI_API_KEY).' };
                const r = await api.generateImage({ provider: p, prompt });
                const images = (r.images || []).map((im) => im.url || `data:${im.mime || 'image/png'};base64,${im.b64}`);
                images.forEach((src) => meta?.ui?.addImage(src, r.images?.[0]?.revised_prompt || prompt));
                return { images: images.map((u, i) => ({ url: u.startsWith('data:') ? '(inline image shown to user)' : u, revised_prompt: r.images?.[i]?.revised_prompt })), note: 'The image has been displayed to the user; describe it briefly.' };
            }
        });
    }

    // ---- Text to speech (replies of a TTS-enabled bot are also spoken automatically — see speakText/autoSpeak)
    if (enabled.has('text_to_speech')) {
        tools.push({
            def: fn('speak', 'Speak text aloud to the user in your voice. Your normal replies are already read aloud automatically, so only call this for something different from your reply (e.g. reading a passage, spelling, a different phrasing).', {
                text: { type: 'string', description: 'The text to speak (keep under ~1500 characters)' }
            }, ['text']),
            run: async ({ text }, meta) => {
                const r = await speakText({ bot, catalog, text, ui: meta?.ui });
                return r.error ? r : { spoken: true, characters: text.length };
            }
        });
    }

    // ---- Documents (vector search + full read)
    const scopes = ['shared', `bot:${bot.name}`, ...(ctx.swarm ? [`swarm:${ctx.swarm.id}`] : [])];
    if (enabled.has('document_search')) {
        tools.push({
            def: fn('search_documents', 'Semantic search across the documents the user uploaded (PDFs, text files). Returns the most relevant passages with document names.', {
                query: { type: 'string', description: 'Search query' },
                count: { type: 'integer', description: 'How many passages to return (default 5)' }
            }, ['query']),
            run: async ({ query, count }) => {
                const docs = await vectorStore.listDocuments(scopes);
                if (!docs.length) return { results: [], note: 'No documents have been uploaded yet.' };
                const results = await vectorStore.search(query, { scopes, count: Math.min(Math.max(count || 5, 1), 12) });
                return { results: results.map((r) => ({ document: r.name, score: +r.score.toFixed(3), passage: r.text })) };
            }
        });
    }
    if (enabled.has('summarize_document') || enabled.has('document_search')) {
        tools.push({
            def: fn('list_documents', 'List the documents that have been uploaded and are available to read or search.', {}, []),
            run: async () => ({ documents: (await vectorStore.listDocuments(scopes)).map((d) => ({ name: d.name, chunks: d.chunks })) })
        });
    }
    if (enabled.has('summarize_document')) {
        tools.push({
            def: fn('read_document', 'Read the full text of an uploaded document (e.g. to summarise a PDF). Long documents are returned in parts; pass `part` to continue.', {
                name: { type: 'string', description: 'Exact document name as listed by list_documents' },
                part: { type: 'integer', description: 'Which part to read (1-based, default 1). Each part is ~12000 characters.' }
            }, ['name']),
            run: async ({ name, part }) => {
                let text = await vectorStore.getDocumentText(name, scopes);
                if (!text) {
                    const docs = await vectorStore.listDocuments(scopes);
                    const match = docs.find((d) => d.name.toLowerCase() === String(name).toLowerCase()) || docs.find((d) => d.name.toLowerCase().includes(String(name).toLowerCase()));
                    if (match) text = await vectorStore.getDocumentText(match.name, scopes);
                }
                if (!text) return { error: `Document "${name}" not found. Use list_documents to see available names.` };
                const SIZE = 12000;
                const parts = Math.ceil(text.length / SIZE);
                const p = Math.min(Math.max(part || 1, 1), parts);
                return { name, part: p, of: parts, text: text.slice((p - 1) * SIZE, p * SIZE) };
            }
        });
    }

    // ---- Memory
    if (enabled.has('memory')) {
        tools.push({
            def: fn('remember', 'Save a durable fact, preference or summary to memory so it is available in future conversations.', {
                text: { type: 'string', description: 'What to remember (one concise sentence)' },
                scope: { type: 'string', enum: ['bot', 'shared'], description: '"bot" = only this bot remembers; "shared" = every bot can see it (default bot)' }
            }, ['text']),
            run: async ({ text, scope }) => {
                const entry = store.addMemory(text, scope === 'shared' ? null : bot.name);
                return { saved: !!entry };
            }
        });
        tools.push({
            def: fn('recall', 'Search memory for previously saved facts.', { query: { type: 'string', description: 'What to look for' } }, ['query']),
            run: async ({ query }) => {
                const mem = store.getMemory(bot.name);
                const all = [...mem.shared.map((m) => ({ ...m, scope: 'shared' })), ...mem.bot.map((m) => ({ ...m, scope: 'bot' }))];
                const q = String(query || '').toLowerCase().split(/\W+/).filter(Boolean);
                const scored = all.map((m) => ({ m, s: q.reduce((acc, w) => acc + (m.text.toLowerCase().includes(w) ? 1 : 0), 0) }));
                const hits = scored.filter((x) => x.s > 0 || !q.length).sort((a, b) => b.s - a.s).slice(0, 10).map((x) => ({ text: x.m.text, scope: x.m.scope }));
                return { memories: hits.length ? hits : all.slice(-10).map((m) => ({ text: m.text, scope: m.scope })) };
            }
        });
    }

    // ---- MCP servers (tools discovered live; names are prefixed with the server name)
    for (const t of (bot.tools || [])) {
        if (!t.startsWith('mcp:')) continue;
        const server = store.listMcpServers().find((s) => s.name === t.slice(4));
        if (!server) continue;
        try {
            const { tools: mcpTools } = await ctx.mcpToolsCached(server);
            for (const mt of mcpTools) {
                const safeName = `${sanitize(server.name)}__${sanitize(mt.name)}`.slice(0, 64);
                tools.push({
                    def: { type: 'function', name: safeName, description: `[MCP: ${server.name}] ${mt.description || mt.name}`.slice(0, 1024), parameters: normalizeSchema(mt.input_schema) },
                    run: async (args, meta) => {
                        if (server.requireApproval && ctx.approve) {
                            const ok = await ctx.approve(`${bot.name} wants to call ${server.name} → ${mt.name}`, JSON.stringify(args, null, 2));
                            if (!ok) return { denied: true, note: 'The user denied this action.' };
                        }
                        const r = await api.mcpCall(server.url, server.headers, mt.name, args);
                        const text = (r.content || []).map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
                        (r.content || []).filter((c) => c.type === 'image' && c.data).forEach((c) => meta?.ui?.addImage(`data:${c.mimeType || 'image/png'};base64,${c.data}`, mt.name));
                        if (r.isError) return { error: text || 'MCP tool error' };
                        return r.structuredContent ?? (text || '(no content)');
                    }
                });
            }
        } catch (e) {
            console.warn('MCP tools unavailable for', server.name, e);
            ctx.ui?.addNote?.(`⚠️ Could not load MCP tools from <b>${server.name}</b>: ${e.message}`);
        }
    }

    // ---- Swarm: talk to other bots
    const otherBots = (ctx.availableBots || []).filter((b) => b.name !== bot.name);
    if (enabled.has('ask_bot') && ctx.askBot && otherBots.length && (ctx.depth || 0) < 2) {
        const names = otherBots.map((b) => b.name);
        tools.push({
            def: fn('list_bots', 'List the other bots you can collaborate with, and what each is good at.', {}, []),
            run: async () => ({ bots: otherBots.map((b) => ({ name: b.name, title: b.title, description: b.description || b.instructions.slice(0, 200), provider: b.provider, model: b.model, tools: b.tools })) })
        });
        tools.push({
            def: fn('ask_bot', 'Delegate a task to another bot and wait for its answer. Use for work another bot is better suited for (its tools, model or expertise). Give it all the context it needs — it cannot see this conversation unless it is in the same room.', {
                bot: { type: 'string', enum: names, description: 'Name of the bot to ask' },
                task: { type: 'string', description: 'The task or question, fully self-contained' }
            }, ['bot', 'task']),
            run: async ({ bot: target, task }, meta) => {
                const answer = await ctx.askBot(target, task, meta);
                return { from: target, answer };
            }
        });
        if (ctx.messageBot) {
            tools.push({
                def: fn('message_bot', 'Hand off work asynchronously: send a message to another bot in this room. It will act on it in the shared conversation after you finish. Prefer ask_bot when you need the answer now.', {
                    bot: { type: 'string', enum: [...names, 'everyone'], description: 'Bot to notify, or "everyone"' },
                    message: { type: 'string', description: 'The message / hand-off instructions' }
                }, ['bot', 'message']),
                run: async ({ bot: target, message }) => {
                    const ok = ctx.messageBot(target, message);
                    return ok ? { queued: true, to: target } : { queued: false, error: `Could not hand off to "${target}" (unknown bot, empty message, or duplicate hand-off).` };
                }
            });
        }
    }

    // ---- Skills are just prompt text; expose a helper to read a skill on demand
    const skills = (bot.skills || []).map((n) => store.getSkill(n)).filter(Boolean);
    if (skills.length) {
        tools.push({
            def: fn('use_skill', 'Load the full instructions for one of your skills before performing that kind of task.', {
                skill: { type: 'string', enum: skills.map((s) => s.name) }
            }, ['skill']),
            run: async ({ skill }) => ({ skill, instructions: store.getSkill(skill)?.instructions || '' })
        });
    }

    return tools;
}

/** Which TTS provider/voice a bot speaks with (bot.voice → the bot's own provider → the worker default). */
export function ttsFor(bot, catalog) {
    const voice = bot.voice?.voice ? bot.voice : { provider: bot.provider, voice: '' };
    const ttsOk = (id) => catalog?.providers?.[id]?.enabled && catalog?.providers?.[id]?.tts;
    const provider = (voice.provider && ttsOk(voice.provider) ? voice.provider : null) || catalog?.defaults?.tts || null;
    return provider ? { provider, voice: provider === voice.provider ? voice.voice || undefined : undefined } : null;
}

/** Synthesize `text` with the bot's voice and play it in the message (adds an audio player). */
export async function speakText({ bot, catalog, text, ui, autoplay = true }) {
    const tts = ttsFor(bot, catalog);
    if (!tts) return { error: 'No text-to-speech provider is configured on the worker.' };
    const input = speakable(text);
    if (!input) return { error: 'Nothing to speak.' };
    const blob = await api.speech({ provider: tts.provider, voice: tts.voice, input });
    ui?.addAudio?.(blob, autoplay);
    return { spoken: true, characters: input.length };
}

/** Markdown → something a TTS voice can read (no symbols, links or code fences); capped at ~3000 characters. */
export function speakable(text, max = 3000) {
    let t = String(text || '')
        .replace(/```[\s\S]*?```/g, ' (code omitted) ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                 // images
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')               // links → text
        .replace(/^#{1,6}\s+/gm, '')                            // headings
        .replace(/^\s*[-*+]\s+/gm, '')                          // bullets
        .replace(/^\s*\|.*\|\s*$/gm, '')                       // table rows
        .replace(/[*_`~>#]+/g, '')                              // emphasis, code, quotes
        .replace(/https?:\/\/\S+/g, 'link')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{2,}/g, '\n')
        .trim();
    if (t.length > max) { const cut = t.slice(0, max); const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? ')); t = (end > max * 0.5 ? cut.slice(0, end + 1) : cut) ; }
    return t;
}

/** After a bot turn: speak the reply when the bot has text_to_speech enabled and did not already call speak. */
export async function autoSpeak({ bot, catalog, result, ui }) {
    if (!(bot.tools || []).includes('text_to_speech')) return false;
    if (!result?.text?.trim()) return false;
    if ((result.toolCalls || []).some((c) => c.name === 'speak' && !c.error)) return false;
    try { const r = await speakText({ bot, catalog, text: result.text, ui }); return !r.error; }
    catch (e) { ui?.addNote?.(`🔇 Could not speak the reply: ${e.message || e}`); return false; }
}

export function fn(name, description, properties, required = []) {
    return { type: 'function', name, description, parameters: { type: 'object', properties, required, additionalProperties: false } };
}

function sanitize(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function normalizeSchema(schema) {
    const s = schema && typeof schema === 'object' ? { ...schema } : { type: 'object', properties: {} };
    if (s.type !== 'object') { s.type = 'object'; }
    if (!s.properties) s.properties = {};
    return s;
}
