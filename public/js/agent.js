// A single bot "turn": streams a reply from the worker, executes any tool calls in the browser, feeds the
// results back, and repeats until the model produces a final answer (or the iteration cap is hit).

import { chatStream } from './api.js';
import { buildTools, nativeToolsFor } from './tools.js';

const MAX_ITERATIONS = 8;

/**
 * Resolve the provider/model a bot will actually run on. If the bot's provider has no key on the worker,
 * fall back to the first configured provider (and its default model) so the app keeps working.
 * Returns {provider, model, fallback:boolean, wanted:string}.
 */
export function resolveModel(bot, catalog) {
    const providers = catalog?.providers || {};
    const wanted = bot.provider;
    const pick = (id) => {
        const p = providers[id];
        return { provider: id, model: (id === wanted && bot.model) || p?.models?.find((m) => m.default)?.id || p?.models?.[0]?.id || bot.model || '' };
    };
    if (!catalog || providers[wanted]?.enabled !== false) return { ...pick(wanted), fallback: false, wanted };
    const order = ['openai', 'xai', 'anthropic', 'mock'];
    const alt = order.find((id) => providers[id]?.enabled && providers[id]?.models?.length) || Object.keys(providers).find((id) => providers[id].enabled && providers[id].models?.length);
    if (!alt) return { ...pick(wanted), fallback: false, wanted };
    return { ...pick(alt), fallback: true, wanted };
}

export function buildSystemPrompt(bot, { store, swarm, skills = [], now = new Date() } = {}) {
    const parts = [];
    parts.push(bot.instructions || 'You are a helpful assistant.');
    parts.push(`\nYour name is "${bot.name}"${bot.title ? ` (${bot.title})` : ''}. Today is ${now.toDateString()}.`);
    if (bot.description) parts.push(`About you: ${bot.description}`);
    if (skills.length) {
        parts.push(`\nSkills available to you (call use_skill to load full instructions when relevant):\n${skills.map((s) => `- ${s.name}: ${s.description || ''}`).join('\n')}`);
    }
    if (store) {
        const mem = store.getMemory(bot.name);
        const lines = [...mem.shared.map((m) => `- (shared) ${m.text}`), ...mem.bot.map((m) => `- ${m.text}`)].slice(-40);
        if (lines.length) parts.push(`\nMemory (facts saved earlier — verify against authoritative sources when it matters):\n${lines.join('\n')}`);
    }
    if (swarm) {
        parts.push(`\nYou are a member of the room "${swarm.name}" (a group chat of bots working with the user).${swarm.goal ? ` Shared goal: ${swarm.goal}` : ''}
Members: ${swarm.members.map((b) => `${b.name}${b.title ? ` — ${b.title}` : ''}${b.description ? ` (${b.description})` : ''}`).join('; ')}.
Rules: take ownership of the part addressed to you and do it well; hand off other parts to the best-suited bot with ask_bot (needs the answer now) or message_bot (asynchronous). Address bots by @name. Do not repeat work another bot already did in the transcript. Keep one owner per stage. Say clearly what you did and what remains.`);
    }
    if ((bot.tools || []).includes('text_to_speech')) {
        parts.push(`\nVoice: your replies are read aloud to the user automatically with a text-to-speech voice. Write for the ear — natural spoken sentences, no Markdown, lists, tables or URLs, and keep it reasonably short. You do not need to call speak for your own reply.`);
    }
    parts.push(`\nFormatting: use Markdown. When you used tools, be brief about the mechanics and focus on the answer. Cite sources with links when you searched. After a tool result, continue from where you left off — never repeat text you already wrote earlier in the same reply.`);
    return parts.join('\n');
}

/**
 * Run one bot turn.
 * @param {object} opts
 *   bot, messages (unified: {role, content}), ctx (see tools.buildTools), ui (message controller), signal
 * @returns {Promise<{text, citations, images, toolCalls, usage}>}
 */
export async function runBotTurn({ bot: configuredBot, messages, ctx, ui, signal, extraSystem = '' }) {
    const resolved = resolveModel(configuredBot, ctx.catalog);
    const bot = { ...configuredBot, provider: resolved.provider, model: resolved.model };
    const tools = await buildTools({ ...ctx, bot, ui });
    const nativeTools = nativeToolsFor(bot, ctx.catalog);
    const byName = new Map(tools.map((t) => [t.def.name, t]));
    const system = buildSystemPrompt(bot, { store: ctx.store, swarm: ctx.swarm, skills: (bot.skills || []).map((n) => ctx.store.getSkill(n)).filter(Boolean) }) + (extraSystem ? `\n${extraSystem}` : '');
    const convo = [...messages];
    const allCitations = [];
    const allImages = [];
    const toolCalls = [];
    let usage = null;
    let finalText = '';

    for (let i = 0; i < MAX_ITERATIONS; i++) {
        let iterationText = '';
        const result = await chatStream({
            provider: bot.provider,
            model: bot.model,
            system,
            messages: convo,
            tools: [...tools.map((t) => t.def), ...nativeTools],
            reasoning_effort: bot.reasoning && bot.reasoning !== 'default' ? bot.reasoning : undefined,
            max_tokens: bot.maxTokens || undefined
        }, (ev) => {
            if (ev.type === 'text') { iterationText += ev.delta; ui?.append(ev.delta); }
            else if (ev.type === 'reasoning') ui?.appendReasoning(ev.delta);
            else if (ev.type === 'citation') { if (!allCitations.some((c) => c.url === ev.url)) allCitations.push({ url: ev.url, title: ev.title }); ui?.addCitations(allCitations); }
            else if (ev.type === 'image') { const src = ev.url || `data:${ev.mime || 'image/png'};base64,${ev.b64}`; allImages.push(src); ui?.addImage(src); }
        }, signal);
        usage = result.usage || usage;
        finalText = iterationText;

        if (!result.tool_calls.length) {
            return { text: finalText, citations: allCitations, images: allImages, toolCalls, usage, finish: result.finish };
        }
        // A hand-off (message_bot) ends this bot's turn: the swarm engine wakes the target bot next, so there is
        // nothing for this model to continue — asking it to would only make it repeat itself.
        const handoffOnly = result.tool_calls.every((c) => c.name === 'message_bot');

        // Record the assistant turn (with tool calls) then execute tools (in parallel).
        convo.push({ role: 'assistant', content: iterationText, tool_calls: result.tool_calls });
        if (iterationText.trim()) ui?.append('\n\n');
        const results = await Promise.all(result.tool_calls.map(async (call) => {
            const tool = byName.get(call.name);
            let args = {};
            try { args = call.arguments ? JSON.parse(call.arguments) : {}; } catch { args = { _raw: call.arguments }; }
            const chip = ui?.addTool(call.name, args);
            const record = { name: call.name, args, result: '', error: false };
            toolCalls.push(record);
            if (!tool) {
                chip?.done(`Unknown tool ${call.name}`, true);
                record.result = `Unknown tool ${call.name}`; record.error = true;
                return { role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify({ error: `Unknown tool ${call.name}` }) };
            }
            try {
                const out = await tool.run(args, { ui, chip, bot });
                const content = typeof out === 'string' ? out : JSON.stringify(out);
                const isErr = !!(out && typeof out === 'object' && out.error);
                chip?.done(content.length > 4000 ? content.slice(0, 4000) + '…' : content, isErr);
                record.result = content.slice(0, 4000); record.error = isErr;
                return { role: 'tool', tool_call_id: call.id, name: call.name, content: content.slice(0, 60000) };
            } catch (e) {
                chip?.done(e.message || String(e), true);
                record.result = e.message || String(e); record.error = true;
                return { role: 'tool', tool_call_id: call.id, name: call.name, content: JSON.stringify({ error: e.message || String(e) }) };
            }
        }));
        convo.push(...results);
        if (handoffOnly) return { text: finalText, citations: allCitations, images: allImages, toolCalls, usage, finish: 'stop' };
    }
    ui?.append('\n\n_(stopped: too many tool iterations)_');
    return { text: finalText, citations: allCitations, images: allImages, toolCalls, usage, finish: 'length' };
}

/** Utility: turn uploaded images in a user turn into content parts. */
export function userContent(text, images = []) {
    if (!images.length) return text;
    return [{ type: 'text', text }, ...images.map((url) => ({ type: 'image', url }))];
}
