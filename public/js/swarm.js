// Conversation engine for single-bot chats and swarms (group chats of bots).
//  - @Bot mentions assign ownership; "@everyone" addresses all bots; unaddressed messages are routed by the
//    swarm's coordinator (if any) or by a quick router call.
//  - Bots collaborate through tools: ask_bot (synchronous delegation) and message_bot (asynchronous hand-off).
//    Hand-offs are queued and processed as additional rounds, so bots can pass work along without the user relaying.
//  - Everything a bot says or hands off is appended to a shared transcript that all members see.

import { resolveModel, runBotTurn, userContent } from './agent.js';
import { autoSpeak } from './tools.js';
import { chat as chatOnce, mcpTools as fetchMcpTools } from './api.js';
import { addMessage, addSystemNote, askApproval, escapeHtml, providerBadge } from './ui.js';

const MAX_ROUNDS = 6;       // hand-off rounds per user message
const MAX_DELEGATION_DEPTH = 2;

export function transcriptToMessages(transcript, botName, { images = [] } = {}) {
    const messages = [];
    for (const entry of transcript) {
        if (entry.kind === 'user') {
            messages.push({ role: 'user', content: entry.text });
        } else if (entry.kind === 'bot' && entry.from === botName) {
            messages.push({ role: 'assistant', content: entry.text || '(no reply)' });
        } else if (entry.kind === 'bot') {
            messages.push({ role: 'user', content: `[Message from bot "${entry.from}"]\n${entry.text}` });
        } else if (entry.kind === 'handoff') {
            messages.push({ role: 'user', content: `[Hand-off from "${entry.from}" to ${entry.to === 'everyone' ? 'everyone' : `"${entry.to}"`}]\n${entry.text}` });
        } else if (entry.kind === 'note') {
            messages.push({ role: 'user', content: `[System note] ${entry.text}` });
        }
    }
    // Merge consecutive same-role turns so every provider gets a tidy alternating history.
    const merged = [];
    for (const m of messages) {
        const last = merged[merged.length - 1];
        if (last && last.role === m.role && typeof last.content === 'string' && typeof m.content === 'string') last.content += `\n\n${m.content}`;
        else merged.push({ ...m });
    }
    if (images.length && merged.length && merged[merged.length - 1].role === 'user') {
        const last = merged[merged.length - 1];
        last.content = userContent(last.content, images);
    }
    if (!merged.length || merged[0].role !== 'user') merged.unshift({ role: 'user', content: '(conversation start)' });
    return merged;
}

export function parseMentions(text, members) {
    const lower = text.toLowerCase();
    if (/(^|\s)@everyone\b/.test(lower)) return members.map((m) => m.name);
    const hits = [];
    for (const m of members) {
        const handle = '@' + m.name.toLowerCase();
        const compact = '@' + m.name.toLowerCase().replace(/\s+/g, '');
        if (lower.includes(handle) || lower.includes(compact)) hits.push(m.name);
    }
    return hits;
}

export function createEngine({ store, vectorStore, getCatalog, container: defaultContainer }) {
    const mcpCache = new Map();
    async function mcpToolsCached(server) {
        const key = `${server.url}|${JSON.stringify(server.headers || {})}`;
        if (!mcpCache.has(key)) {
            mcpCache.set(key, fetchMcpTools(server.url, server.headers).catch((e) => { mcpCache.delete(key); throw e; }));
        }
        return mcpCache.get(key);
    }

    async function pickRouter(catalog) {
        const providers = catalog?.providers || {};
        for (const p of ['openai', 'xai', 'anthropic']) {
            const fast = providers[p]?.models?.find((m) => m.fast) || providers[p]?.models?.[0];
            if (fast && providers[p]?.enabled !== false) return { provider: p, model: fast.id };
        }
        return null;
    }

    async function routeOwners({ swarm, members, text, catalog }) {
        const router = await pickRouter(catalog);
        if (!router) return [members[0].name];
        try {
            const res = await chatOnce({
                provider: router.provider, model: router.model, max_tokens: 200,
                system: `You route messages in a group chat of AI bots. Given the bots and the user's message, choose which bot(s) should respond. Prefer a single owner; choose several only when the request clearly needs different specialists in parallel. Reply with JSON only.`,
                messages: [{ role: 'user', content: `Bots:\n${members.map((m) => `- ${m.name}: ${m.title || ''} ${m.description || m.instructions.slice(0, 160)}`).join('\n')}\n\nRoom goal: ${swarm.goal || '(none)'}\n\nUser message:\n${text}` }],
                response_format: { type: 'json_schema', name: 'route', schema: { type: 'object', properties: { owners: { type: 'array', items: { type: 'string' } } }, required: ['owners'], additionalProperties: false } }
            });
            const parsed = JSON.parse(res.text || '{}');
            const owners = (parsed.owners || []).filter((n) => members.some((m) => m.name === n));
            if (owners.length) return owners;
        } catch (e) {
            console.warn('router failed, defaulting to first bot', e);
        }
        return [members[0].name];
    }

    /**
     * Run a user message in a room (swarm). `log` = {entries, append(entry)} (see chatlog.js). Renders into `container`.
     */
    async function runSwarmMessage({ swarm, log, text, images = [], signal, container = defaultContainer }) {
        const catalog = await getCatalog();
        const members = swarm.bots.map((n) => store.getBot(n)).filter(Boolean);
        if (!members.length) throw new Error('This room has no bots');
        const swarmCtx = { id: swarm.id, name: swarm.name, goal: swarm.goal, members };
        const transcript = log.entries;
        const push = (entry) => log.append(entry);

        push({ kind: 'user', text, images });

        let owners = parseMentions(text, members);
        let coordinatorNudge = '';
        if (!owners.length) {
            const coordinator = members.find((m) => m.name === swarm.coordinator);
            if (coordinator) {
                owners = [coordinator.name];
                coordinatorNudge = `You are the coordinator of this room. Decompose the user's request, delegate parts to the best-suited bots with ask_bot (call several ask_bot tools in ONE turn to run them in parallel), review what comes back, and synthesise one final answer for the user. Do the work yourself only when no other bot is better suited.`;
            } else {
                owners = await routeOwners({ swarm, members, text, catalog });
                addSystemNote(container, `↪ routed to ${owners.map((o) => `<b>@${escapeHtml(o)}</b>`).join(', ')}`, 'routing');
            }
        }

        const queue = owners.map((name) => ({ bot: name, reason: 'user', images }));
        let rounds = 0;
        const seenHandoffs = new Set();

        while (queue.length && rounds < MAX_ROUNDS) {
            rounds++;
            const batch = queue.splice(0, queue.length);
            const handoffs = [];
            await Promise.all(batch.map(async (item) => {
                const bot = members.find((m) => m.name === item.bot);
                if (!bot) return;
                const r = resolveModel(bot, catalog);
                const ui = addMessage(container, { sender: bot.name, bot: { ...bot, provider: r.provider }, meta: `${providerBadge(r.provider)} <span class="model">${escapeHtml(r.model || '')}</span>${item.reason !== 'user' ? ` <span class="handoff-tag">via ${escapeHtml(item.reason)}</span>` : ''}`, loading: true });
                const messages = transcriptToMessages(transcript, bot.name, { images: item.reason === 'user' ? item.images || [] : [] });
                const ctx = makeCtx({ bot, catalog, swarm: swarmCtx, members, log, ui, depth: 0, handoffs, seenHandoffs, signal, container });
                try {
                    const result = await runBotTurn({ bot, messages, ctx, ui, signal, extraSystem: item.reason === 'user' ? coordinatorNudge : '' });
                    push({ kind: 'bot', from: bot.name, text: result.text, citations: result.citations, images: result.images, tools: result.toolCalls, via: item.reason !== 'user' ? item.reason : undefined });
                    autoSpeak({ bot, catalog, result, ui });
                } catch (e) {
                    ui.set(`⚠️ ${e.message || e}`);
                    push({ kind: 'note', text: `${bot.name} failed: ${e.message || e}` });
                }
            }));
            for (const h of handoffs) {
                push({ kind: 'handoff', from: h.from, to: h.to, text: h.message });
                addSystemNote(container, `🤝 <b>@${escapeHtml(h.from)}</b> → <b>@${escapeHtml(h.to)}</b>: ${escapeHtml(h.message).slice(0, 400)}`, 'handoff');
                const targets = h.to === 'everyone' ? members.filter((m) => m.name !== h.from).map((m) => m.name) : [h.to];
                for (const t of targets) if (members.some((m) => m.name === t) && !queue.some((q) => q.bot === t)) queue.push({ bot: t, reason: `hand-off from ${h.from}` });
            }
        }
        if (queue.length) addSystemNote(container, `⏸ stopped after ${MAX_ROUNDS} hand-off rounds (pending: ${queue.map((q) => q.bot).join(', ')})`, 'routing');
    }

    /**
     * Run a user message in a direct chat with one bot. `log` = {entries, append(entry)}; the model context is
     * derived from the log (so it survives refreshes) and the reply is appended to it.
     */
    async function runDirectMessage({ bot, log, text, images = [], signal, catalog: cat, container = defaultContainer }) {
        const catalog = cat || await getCatalog();
        const r = resolveModel(bot, catalog);
        const ui = addMessage(container, { sender: bot.name, bot: { ...bot, provider: r.provider }, meta: `${providerBadge(r.provider)} <span class="model">${escapeHtml(r.model || '')}</span>`, loading: true });
        const members = store.listBots();
        log.append({ kind: 'user', text, images });
        const messages = transcriptToMessages(log.entries, bot.name, { images });
        const ctx = makeCtx({ bot, catalog, swarm: null, members, log, ui, depth: 0, handoffs: null, seenHandoffs: new Set(), signal, container });
        try {
            const result = await runBotTurn({ bot, messages, ctx, ui, signal });
            log.append({ kind: 'bot', from: bot.name, text: result.text || '', citations: result.citations, images: result.images, tools: result.toolCalls });
            await autoSpeak({ bot, catalog, result, ui });
            return result;
        } catch (e) {
            ui.set(`⚠️ ${e.message || e}`);
            log.append({ kind: 'note', text: `${bot.name} failed: ${e.message || e}` });
            throw e;
        }
    }

    function makeCtx({ bot, catalog, swarm, members, log, ui, depth, handoffs, seenHandoffs, signal, container = defaultContainer }) {
        const ctx = {
            store, vectorStore, catalog, swarm, ui, depth,
            availableBots: members.filter((b) => b.canDelegate !== false),
            mcpToolsCached,
            approve: (title, detail) => askApproval(container, { title, detail }),
            askBot: async (targetName, task, meta) => {
                if (depth >= MAX_DELEGATION_DEPTH) return 'Delegation depth limit reached; do the task yourself.';
                const target = store.getBot(targetName);
                if (!target) return `Unknown bot "${targetName}"`;
                const tr = resolveModel(target, catalog);
                const subUi = addMessage(container, { sender: target.name, bot: { ...target, provider: tr.provider }, meta: `${providerBadge(tr.provider)} <span class="model">${escapeHtml(tr.model || '')}</span> <span class="handoff-tag">asked by ${escapeHtml(bot.name)}</span>`, loading: true });
                const subCtx = makeCtx({ bot: target, catalog, swarm, members, log, ui: subUi, depth: depth + 1, handoffs, seenHandoffs, signal, container });
                // In a swarm the delegate sees the shared transcript; in a direct chat it only gets the task.
                const base = swarm && log ? transcriptToMessages(log.entries, target.name) : [];
                const messages = [...base, { role: 'user', content: `[Request from bot "${bot.name}"] ${task}` }];
                try {
                    const result = await runBotTurn({ bot: target, messages, ctx: subCtx, ui: subUi, signal });
                    log?.append({ kind: 'bot', from: target.name, text: result.text, citations: result.citations, images: result.images, tools: result.toolCalls, inReplyTo: bot.name });
                    return result.text || '(no reply)';
                } catch (e) {
                    subUi.set(`⚠️ ${e.message || e}`);
                    return `Error from ${target.name}: ${e.message || e}`;
                }
            }
        };
        if (handoffs) {
            ctx.messageBot = (targetName, message) => {
                const target = String(targetName || '').replace(/^@/, '').trim();
                const text = String(message || '').trim();
                const known = target === 'everyone' || members.some((m) => m.name === target);
                if (!known || !text || target === bot.name) return false;
                const key = `${bot.name}>${target}:${text}`;
                if (seenHandoffs.has(key)) return false;
                seenHandoffs.add(key);
                handoffs.push({ from: bot.name, to: target, message: text });
                return true;
            };
        }
        return ctx;
    }

    /** Tool context for a direct (non-swarm) session — used by voice mode so it gets the same tools as text chat. */
    async function createDirectContext({ bot, ui, log, signal, container = defaultContainer }) {
        const catalog = await getCatalog();
        return makeCtx({ bot, catalog, swarm: null, members: store.listBots(), log, ui, depth: 0, handoffs: null, seenHandoffs: new Set(), signal, container });
    }

    return { runSwarmMessage, runDirectMessage, createDirectContext, mcpToolsCached, transcriptToMessages, parseMentions };
}
