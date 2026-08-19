// biz-bot — bots that work together in rooms. Entry point: wires the sidebar, chat, configure tab, rooms and settings.
import * as api from './api.js';
import { createStore } from './store.js';
import createVectorStore from './vectors.js';
import { onFilesDropped } from './files.js';
import { hasNativeRecognition, isListening, startSpeech, stopSpeech } from './speech.js';
import { addMessage, addSystemNote, avatarHtml, escapeHtml, providerBadge, toast } from './ui.js';
import { createBotForm, editSwarm } from './botform.js';
import { openSettings } from './settings.js';
import { createEngine } from './swarm.js';
import { startVoiceSession } from './voice.js';
import { buildSystemPrompt, resolveModel } from './agent.js';
import { buildTools, nativeToolsFor } from './tools.js';
import { chatlog } from './chatlog.js';

// ---------- default bots (seeded once; users can edit or delete them) ----------
const DEFAULT_BOTS = [
    {
        name: 'Assistant', title: 'General assistant', provider: 'openai', builtin: true,
        description: 'Coordinates work, answers directly when it can, and delegates to specialists.',
        welcome: 'Hello! I can answer questions, read your documents, search the web, and pull in other bots when useful. What are we working on?',
        instructions: 'You are a helpful, precise assistant. Answer directly when you can. Use search_documents/read_document for uploaded files, web_search for current information, and ask_bot to bring in specialist bots when their tools or expertise clearly help.',
        tools: ['web_search', 'document_search', 'summarize_document', 'memory', 'ask_bot']
    },
    {
        name: 'Researcher', title: 'Web & X research', provider: 'xai',
        description: 'Finds current information on the web and X, and links every claim to a source.',
        welcome: 'I dig up current information from the web and X. What should I look into?',
        instructions: 'You are a meticulous researcher. Search the web (and X when opinions or breaking news matter), verify across sources, and present findings as concise bullet points with a link for every claim. Flag uncertainty explicitly.',
        tools: ['web_search', 'x_search', 'memory', 'ask_bot']
    },
    {
        name: 'Analyst', title: 'Document analysis', provider: 'anthropic',
        description: 'Reads long documents (PDFs) carefully and produces structured summaries and answers grounded in the text.',
        welcome: 'Drop in a PDF or text file and ask me anything about it — I will summarise, compare and extract details.',
        instructions: 'You are a careful document analyst. Use list_documents, read_document and search_documents to ground every statement in the uploaded material; quote or reference sections. Produce structured, well-organised summaries with headings and bullet points.',
        tools: ['document_search', 'summarize_document', 'memory', 'ask_bot']
    },
    {
        name: 'Artist', title: 'Image generation', provider: 'xai',
        description: 'Turns ideas into images and can describe images the user shares.',
        welcome: 'Describe the image you want and I will create it.',
        instructions: 'You are a visual designer. Turn requests into rich, specific image prompts (subject, style, lighting, composition) and call generate_image. Offer one or two variations when asked. Describe images that are shared with you.',
        tools: ['image_generation', 'ask_bot']
    }
];

const DEFAULT_SWARM = { name: 'Research team', goal: 'Answer the user\'s question thoroughly: Researcher gathers current sources, Analyst works through uploaded documents, Assistant coordinates and writes the final answer.', bots: ['Assistant', 'Researcher', 'Analyst'], coordinator: 'Assistant' };

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const els = {
    outputHost: $('output-container'), botLinks: $('bot-links'), swarmLinks: $('swarm-links'), sidebarToggle: $('sidebar-toggle'),
    createButton: $('create-button'), createSwarmButton: $('create-swarm-button'), settingsButton: $('settings-button'), connStatus: $('conn-status'),
    title: $('title'), titleMeta: $('title-meta'), titleAvatar: $('title-avatar'), restartButton: $('restart-button'), shareButton: $('share-button'), editSwarmButton: $('edit-swarm-button'), voiceButton: $('voice-button'),
    tabs: $('tabs'), configTabBtn: $('config-tab-btn'), chatPanel: $('chat-panel'), configPanel: $('config-panel'), setupBanner: $('setup-banner'), busyBar: $('busy-bar'),
    upload: $('upload'), micButton: $('mic-button'), chatInput: $('chat-input'), sendButton: $('send-button'), stopButton: $('stop-button'), attachments: $('attachments'), inputHint: $('input-hint'),
    form: $('form'), deleteButton: $('delete-button'), duplicateButton: $('duplicate-button'), cancelButton: $('cancel-button'), saveButton: $('save-button')
};

// ---------- chat views ----------
// Every chat (bot or room) renders into its own view element inside #output-container; switching chats just swaps
// which view is visible. An in-flight turn keeps rendering into *its* view (never into whatever chat is on screen),
// and coming back to a chat shows the exact DOM it had — nothing is re-rendered or lost.
const views = new Map(); // log key → element
let activeKey = null;
function viewFor(key) {
    let v = views.get(key);
    if (!v) { v = document.createElement('div'); v.className = 'chat-view'; v.dataset.key = key; v.hidden = true; els.outputHost.appendChild(v); views.set(key, v); }
    return v;
}
function showView(key) {
    const v = viewFor(key);
    for (const other of views.values()) other.hidden = other !== v;
    activeKey = key;
    return v;
}
function dropView(key) { views.get(key)?.remove(); views.delete(key); }
Object.defineProperty(els, 'output', { get: () => (activeKey ? viewFor(activeKey) : els.outputHost) });

// ---------- state ----------
const store = createStore(DEFAULT_BOTS);
if (!store.listSwarms().length && !localStorage.getItem('swarms-seeded')) { try { store.saveSwarm(DEFAULT_SWARM); } catch { } localStorage.setItem('swarms-seeded', '1'); }
let catalog = null;
let connected = false;
let current = { kind: 'bot', name: DEFAULT_BOTS[0].name };
let creating = false;
let pendingImages = [];            // data URLs to send with the next message
const runs = new Map();            // log key → AbortController of the turn running in that chat

const vectorStore = createVectorStore(async (texts) => {
    const cat = catalog || await ensureCatalog();
    const provider = cat?.defaults?.embeddings || undefined;
    if (!provider) throw new Error('No embeddings provider available: enable Workers AI (the "ai" binding in wrangler.jsonc) or set OPENAI_API_KEY on the worker');
    const r = await api.embeddings(texts, { provider });
    return { vectors: r.embeddings, model: `${provider}/${r.model || ''}` };
});
const engine = createEngine({ store, vectorStore, getCatalog: () => ensureCatalog(), container: els.outputHost });
const botForm = createBotForm(els.form, { store, getCatalog: () => ensureCatalog() });

// Chat logs (persistent, IndexedDB) — one per bot and per swarm.
const logKey = () => (current.kind === 'swarm' ? `swarm:${current.id}` : `bot:${current.name}`);
const logFor = (key) => ({ get entries() { return chatlog.get(key); }, append: (e) => chatlog.append(key, e) });

// ---------- connection ----------
// One-time cleanup of settings that no longer exist (v2.0 pre-release stored these in the browser).
for (const k of ['WORKER_URL', 'APP_TOKEN', 'OPENAI_API_KEY', 'XAI_API_KEY', 'ANTHROPIC_API_KEY']) localStorage.removeItem(k);

async function connect() {
    const health = await api.probeWorker();
    connected = !!health;
    els.connStatus.className = `conn-status ${connected ? 'ok' : 'bad'}`;
    els.connStatus.title = connected ? `API connected — providers: ${Object.entries(health.providers).filter(([, v]) => v).map(([k]) => k).join(', ') || 'none configured'}` : 'API not reachable';
    const noProviders = connected && !Object.values(health.providers).some(Boolean);
    els.setupBanner.hidden = connected && !noProviders;
    if (!connected) els.setupBanner.innerHTML = '<b>API not reachable.</b> The worker that serves this page also serves <code>/api/*</code>; run <code>npm run dev</code> locally or redeploy with <code>npm run deploy</code>.';
    else if (noProviders) els.setupBanner.innerHTML = '<b>No provider keys configured.</b> Add at least one secret to the worker: <code>npx wrangler secret put OPENAI_API_KEY</code> (or <code>XAI_API_KEY</code>, <code>ANTHROPIC_API_KEY</code>), then redeploy. Locally, put them in <code>.dev.vars</code>.';
    if (connected) { catalog = null; await ensureCatalog().catch(() => { }); checkVersion(health.version); }
    return connected;
}

/** If the deployed worker is newer than this page (stale cache after a deploy), reload once. */
function checkVersion(serverVersion) {
    const mine = document.querySelector('meta[name="app-version"]')?.content;
    if (!serverVersion || !mine || serverVersion === mine) return;
    const key = `reloaded-for-${serverVersion}`;
    if (!sessionStorage.getItem(key)) { sessionStorage.setItem(key, '1'); location.reload(); }
    else toast(`A newer version (${serverVersion}) is deployed — hard-refresh to update.`, 'info', 8000);
}

async function ensureCatalog() {
    if (catalog) return catalog;
    catalog = await api.getCatalog(true);
    reconcileBots(catalog);
    return catalog;
}

/** Bots (and voices) that point at a provider with no key on the worker are moved to a configured one, quietly. */
function reconcileBots(cat) {
    const providers = cat?.providers || {};
    const anyEnabled = Object.values(providers).some((p) => p.enabled && p.models?.length);
    if (!anyEnabled) return;
    const ttsDefault = cat.defaults?.tts || '';
    for (const bot of store.listBots()) {
        const r = resolveModel(bot, cat);
        const voiceOk = bot.voice?.provider && providers[bot.voice.provider]?.enabled && providers[bot.voice.provider]?.tts;
        const patch = {};
        if (r.fallback) { patch.provider = r.provider; patch.model = r.model; }
        if (!voiceOk && ttsDefault !== (bot.voice?.provider || '')) patch.voice = { provider: ttsDefault, voice: '' };
        if (Object.keys(patch).length) store.saveBot({ ...bot, ...patch }, bot.name);
    }
}

function resolvedBot(bot) {
    const r = resolveModel(bot, catalog);
    return { ...bot, provider: r.provider, model: r.model };
}

// ---------- sidebar ----------
function renderSidebar() {
    els.botLinks.innerHTML = '';
    for (const bot of store.listBots()) {
        const li = document.createElement('li');
        li.innerHTML = `<a href="#" class="${current.kind === 'bot' && current.name === bot.name ? 'active' : ''}">${avatarHtml(bot)}<span class="link-text"><span class="link-name">${escapeHtml(bot.name)}</span><span class="link-sub">${escapeHtml(bot.title || bot.provider)}</span></span></a>`;
        li.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); els.sidebarToggle.checked = false; loadBot(bot.name); });
        els.botLinks.appendChild(li);
    }
    els.swarmLinks.innerHTML = '';
    for (const swarm of store.listSwarms()) {
        const li = document.createElement('li');
        li.innerHTML = `<a href="#" class="${current.kind === 'swarm' && current.id === swarm.id ? 'active' : ''}"><span class="avatar avatar-letter avatar-swarm">🐝</span><span class="link-text"><span class="link-name">${escapeHtml(swarm.name)}</span><span class="link-sub">${swarm.bots.map(escapeHtml).join(', ')}</span></span></a>`;
        li.querySelector('a').addEventListener('click', (e) => { e.preventDefault(); els.sidebarToggle.checked = false; loadSwarm(swarm.id); });
        els.swarmLinks.appendChild(li);
    }
}

// ---------- tabs ----------
function showTab(name) {
    els.tabs.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    els.chatPanel.hidden = name !== 'chat';
    els.configPanel.hidden = name !== 'config';
}
els.tabs.addEventListener('click', async (e) => {
    const btn = e.target.closest('.tab-btn');
    if (!btn) return;
    if (btn.dataset.tab === 'config') {
        if (current.kind !== 'bot') return;
        await botForm.load(store.getBot(current.name));
        creating = false;
    }
    showTab(btn.dataset.tab);
});

// ---------- rendering a persisted chat log ----------
function renderEntry(entry, botsByName) {
    if (entry.kind === 'user') {
        const ui = addMessage(els.output, { sender: 'You', role: 'user', content: entry.text });
        (entry.images || []).forEach((src) => ui.addImage(src));
    } else if (entry.kind === 'bot') {
        const bot = botsByName.get(entry.from) || { name: entry.from };
        const r = resolveModel(bot, catalog);
        const tags = [entry.via ? `<span class="handoff-tag">via ${escapeHtml(entry.via)}</span>` : '', entry.inReplyTo ? `<span class="handoff-tag">asked by ${escapeHtml(entry.inReplyTo)}</span>` : '', entry.voice ? '<span class="model">voice</span>' : ''].filter(Boolean).join(' ');
        const ui = addMessage(els.output, { sender: entry.from, bot: { ...bot, provider: r.provider }, content: entry.text || '', meta: `${providerBadge(entry.provider || r.provider)} <span class="model">${escapeHtml(entry.model || r.model || '')}</span> ${tags}` });
        for (const t of entry.tools || []) ui.addTool(t.name, t.args).done(t.result ?? '', !!t.error);
        if (entry.citations?.length) ui.addCitations(entry.citations);
        (entry.images || []).forEach((src) => ui.addImage(src));
    } else if (entry.kind === 'handoff') {
        addSystemNote(els.output, `🤝 <b>@${escapeHtml(entry.from)}</b> → <b>@${escapeHtml(entry.to)}</b>: ${escapeHtml(entry.text).slice(0, 400)}`, 'handoff');
    } else if (entry.kind === 'note') {
        addSystemNote(els.output, escapeHtml(entry.text), 'routing');
    }
}

// ---------- loading a bot / swarm ----------
async function loadBot(name, { keepHistory = true } = {}) {
    const bot = store.getBot(name);
    if (!bot) return loadBot(store.listBots()[0]?.name);
    current = { kind: 'bot', name };
    localStorage.setItem('lastOpened', JSON.stringify(current));
    creating = false;
    renderSidebar();
    showTab('chat');
    els.configTabBtn.hidden = false;
    els.editSwarmButton.hidden = true;
    els.voiceButton.hidden = !(catalog?.providers?.xai?.enabled && catalog?.providers?.xai?.capabilities?.realtime);
    els.title.textContent = bot.name;
    els.titleAvatar.innerHTML = avatarHtml(bot);
    const rb = resolvedBot(bot);
    els.titleMeta.innerHTML = `${providerBadge(rb.provider)} <span class="model">${escapeHtml(rb.model || '')}</span>${bot.title ? ` · ${escapeHtml(bot.title)}` : ''}${bot.tools?.length ? ` · ${bot.tools.length} tools` : ''}`;
    const key = `bot:${name}`;
    if (!keepHistory) { await chatlog.clear(key); dropView(key); }
    const view = showView(key);
    updateBusy();
    const entries = await chatlog.load(key);
    if (current.kind !== 'bot' || current.name !== name) return; // user navigated away while loading
    if (!view.dataset.rendered) { // first visit: build the view from the persisted log
        view.dataset.rendered = '1';
        if (!entries.length) addMessage(view, { sender: bot.name, bot, content: bot.welcome });
        else { const byName = new Map(store.listBots().map((b) => [b.name, b])); for (const e of entries) renderEntry(e, byName); }
    }
    await ensureBotFilesEmbedded(bot);
    updateHint();
}

async function loadSwarm(id, { keepHistory = true } = {}) {
    const swarm = store.getSwarm(id);
    if (!swarm) return loadBot(store.listBots()[0]?.name);
    current = { kind: 'swarm', id };
    localStorage.setItem('lastOpened', JSON.stringify(current));
    renderSidebar();
    showTab('chat');
    els.configTabBtn.hidden = true;
    els.editSwarmButton.hidden = false;
    els.voiceButton.hidden = true;
    els.title.textContent = swarm.name;
    els.titleAvatar.innerHTML = `<span class="avatar avatar-letter avatar-swarm">🐝</span>`;
    const members = swarm.bots.map((n) => store.getBot(n)).filter(Boolean);
    els.titleMeta.innerHTML = members.map((b) => `<span class="member-chip">${avatarHtml(b)}${escapeHtml(b.name)}${swarm.coordinator === b.name ? ' ★' : ''}</span>`).join('') + (swarm.goal ? `<span class="goal" title="${escapeHtml(swarm.goal)}"> · goal: ${escapeHtml(swarm.goal.slice(0, 80))}${swarm.goal.length > 80 ? '…' : ''}</span>` : '');
    const key = `swarm:${id}`;
    if (!keepHistory) { await chatlog.clear(key); dropView(key); }
    const view = showView(key);
    updateBusy();
    const entries = await chatlog.load(key);
    if (current.kind !== 'swarm' || current.id !== id) return;
    if (!view.dataset.rendered) {
        view.dataset.rendered = '1';
        if (!entries.length) {
            addSystemNote(els.output, `Room <b>${escapeHtml(swarm.name)}</b> with ${members.map((b) => `<b>@${escapeHtml(b.name)}</b>`).join(', ')}. ${swarm.coordinator ? `<b>@${escapeHtml(swarm.coordinator)}</b> coordinates unaddressed messages.` : 'Unaddressed messages are routed automatically.'} Use <b>@Name</b> to assign work, <b>@everyone</b> to ask all.`, 'intro');
        } else {
            const byName = new Map(store.listBots().map((b) => [b.name, b]));
            for (const e of entries) renderEntry(e, byName);
        }
    }
    for (const b of members) await ensureBotFilesEmbedded(b);
    updateHint();
}

async function ensureBotFilesEmbedded(bot) {
    if (!bot.files?.length || !connected) return;
    const existing = await vectorStore.listDocuments([`bot:${bot.name}`]);
    const missing = bot.files.filter((f) => !existing.some((d) => d.name === f.name));
    if (!missing.length) return;
    const note = addSystemNote(els.output, `Indexing ${missing.length} file(s) for <b>${escapeHtml(bot.name)}</b>…`, 'routing');
    for (const f of missing) {
        try { await vectorStore.storeDocument(f.name, f.content, `bot:${bot.name}`); }
        catch (e) { toast(`Could not embed ${f.name}: ${e.message}`, 'error'); }
    }
    note.remove();
}

function updateHint() {
    if (current.kind === 'swarm') {
        const swarm = store.getSwarm(current.id);
        els.inputHint.innerHTML = swarm ? swarm.bots.map((n) => `<button class="mention-chip" data-mention="${escapeHtml(n)}">@${escapeHtml(n)}</button>`).join('') + `<button class="mention-chip" data-mention="everyone">@everyone</button>` : '';
        els.inputHint.querySelectorAll('.mention-chip').forEach((b) => b.onclick = () => { els.chatInput.value = `@${b.dataset.mention} ${els.chatInput.value}`; els.chatInput.focus(); });
    } else {
        const skills = store.listSkills();
        els.inputHint.innerHTML = skills.length ? `<span class="hint-label">Skills:</span>` + skills.map((s) => `<button class="mention-chip" data-skill="${escapeHtml(s.name)}" title="${escapeHtml(s.description)}">/${escapeHtml(s.name)}</button>`).join('') : '';
        els.inputHint.querySelectorAll('[data-skill]').forEach((b) => b.onclick = () => { els.chatInput.value = `/${b.dataset.skill} ${els.chatInput.value}`; els.chatInput.focus(); });
    }
}

// ---------- sending ----------
function expandSkills(text) {
    const m = /^\/([a-zA-Z0-9_-]+)\s*/.exec(text);
    if (!m) return text;
    const skill = store.getSkill(m[1]) || store.listSkills().find((s) => s.name.toLowerCase() === m[1].toLowerCase());
    if (!skill) return text;
    return `${text.slice(m[0].length)}\n\n[Skill "${skill.name}" — follow these instructions]\n${skill.instructions}`;
}

async function send() {
    const raw = els.chatInput.value.trim();
    const key = logKey();
    if (!raw && !pendingImages.length) return;
    if (runs.has(key)) { toast('This chat is still answering — stop it first or wait', 'info'); return; }
    if (!connected) { toast('The API is not reachable right now', 'error'); return; }
    const text = expandSkills(raw || 'Please look at the attached image(s).');
    const images = pendingImages.slice();
    pendingImages = [];
    renderAttachments();
    els.chatInput.value = '';
    autoSize();
    const controller = new AbortController();
    runs.set(key, controller);
    updateBusy();
    const signal = controller.signal;
    const log = logFor(key);
    const container = viewFor(key); // this chat's view — the turn renders here even if the user navigates away
    const who = { ...current };
    try {
        await chatlog.load(key);
        const ui = addMessage(container, { sender: 'You', role: 'user', content: raw });
        images.forEach((src) => ui.addImage(src));
        if (who.kind === 'bot') {
            const bot = resolvedBot(store.getBot(who.name));
            const cat = await ensureCatalog();
            await engine.runDirectMessage({ bot, log, text, images, signal, catalog: cat, container });
        } else {
            const swarm = store.getSwarm(who.id);
            await engine.runSwarmMessage({ swarm, log, text, images, signal, container });
        }
    } catch (e) {
        if (e.name === 'AbortError') addSystemNote(container, '⏹ stopped', 'routing');
        else { console.error(e); addSystemNote(container, `⚠️ ${escapeHtml(e.message || String(e))}`, 'routing'); if (logKey() === key) toast(e.message || String(e), 'error'); }
    } finally {
        await chatlog.flush().catch(() => { });
        if (runs.get(key) === controller) runs.delete(key);
        updateBusy();
    }
}

/** Busy UI (send/stop buttons, progress bar) reflects the chat currently on screen. */
function updateBusy() {
    const v = runs.has(logKey());
    els.sendButton.hidden = v;
    els.stopButton.hidden = !v;
    els.busyBar.hidden = !v;
    els.chatInput.disabled = false;
}
els.stopButton.addEventListener('click', () => runs.get(logKey())?.abort());
els.sendButton.addEventListener('click', send);
els.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
els.chatInput.addEventListener('input', autoSize);
// Mobile viewport: size the app to the *visual* viewport (excludes browser chrome and the on-screen keyboard) so the
// input bar is always on screen; iOS scrolls the page to reveal a focused field, so pin the window back to the top.
function fitViewport() {
    const vv = window.visualViewport;
    // height × scale = the visual viewport in layout pixels, so pinch-zooming does not shrink the app
    const h = Math.round(vv ? vv.height * (vv.scale || 1) : window.innerHeight);
    if (h > 0) document.documentElement.style.setProperty('--app-h', `${h}px`);
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (vv && typing && (vv.scale || 1) === 1 && (vv.offsetTop > 0 || window.scrollY > 0)) window.scrollTo(0, 0);
}
fitViewport();
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', fitViewport);
window.addEventListener('resize', fitViewport);
window.addEventListener('orientationchange', () => setTimeout(fitViewport, 100));
els.chatInput.addEventListener('focus', () => setTimeout(fitViewport, 300));
function autoSize() {
    els.chatInput.style.height = 'auto';
    els.chatInput.style.height = Math.min(els.chatInput.scrollHeight, 200) + 'px';
}

// ---------- attachments / files ----------
function renderAttachments() {
    els.attachments.innerHTML = pendingImages.map((src, i) => `<span class="attachment"><img src="${src}" alt=""><button data-i="${i}" title="Remove">×</button></span>`).join('');
    els.attachments.querySelectorAll('button').forEach((b) => b.onclick = () => { pendingImages.splice(+b.dataset.i, 1); renderAttachments(); });
}
const addFiles = onFilesDropped(document.body, async (files) => {
    for (const f of files) {
        if (f.kind === 'image') { pendingImages.push(f.content); renderAttachments(); continue; }
        if (f.kind === 'audio') {
            if (!connected) { toast('API not reachable — cannot transcribe audio', 'error'); continue; }
            const note = addSystemNote(els.output, `Transcribing <b>${escapeHtml(f.name)}</b>…`, 'routing');
            try { const r = await api.transcribe(f.blob, { provider: catalog?.defaults?.stt }); els.chatInput.value = (els.chatInput.value + ' ' + (r.text || '')).trim(); autoSize(); }
            catch (e) { toast(`Transcription failed: ${e.message}`, 'error'); }
            note.remove();
            continue;
        }
        if (!f.content?.trim()) { toast(`${f.name} is empty`, 'error'); continue; }
        if (!connected) { toast('API not reachable — cannot index documents', 'error'); continue; }
        const scope = current.kind === 'swarm' ? `swarm:${current.id}` : `bot:${current.name}`;
        const note = addSystemNote(els.output, `Indexing <b>${escapeHtml(f.name)}</b> (${Math.round(f.content.length / 1024)} KB)…`, 'routing');
        try {
            const chunks = await vectorStore.storeDocument(f.name, f.content, scope, (done, total) => { note.innerHTML = `Indexing <b>${escapeHtml(f.name)}</b>… ${done}/${total} chunks`; });
            note.innerHTML = `📄 Added <b>${escapeHtml(f.name)}</b> (${chunks} passages). Ask about it, or say “summarize ${escapeHtml(f.name)}”.`;
            const key = logKey();
            await chatlog.load(key);
            chatlog.append(key, { kind: 'note', text: `The user uploaded document "${f.name}" (${chunks} passages) — available via list_documents/read_document/search_documents.` });
        } catch (e) {
            note.innerHTML = `⚠️ Could not index ${escapeHtml(f.name)}: ${escapeHtml(e.message)}`;
        }
    }
});
els.upload.addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

// ---------- microphone ----------
// Prefer the worker's speech-to-text (xAI / OpenAI) — consistent across browsers; the built-in recognizer is only a
// fallback (Edge on macOS, for example, reports "language-not-supported"). Push-to-talk: click to start, click to stop.
function micReset() { els.micButton.classList.remove('active'); els.micButton.title = 'Speech input'; }
async function startMic({ forceNative = false } = {}) {
    const workerStt = connected && catalog?.defaults?.stt ? (blob) => api.transcribe(blob, { provider: catalog.defaults.stt }) : null;
    const useWorker = workerStt && !forceNative;
    if (!useWorker && !hasNativeRecognition()) throw new Error('No speech-to-text available (configure XAI_API_KEY or OPENAI_API_KEY on the worker)');
    els.micButton.classList.add('active');
    els.micButton.title = useWorker ? 'Listening… click to stop and transcribe' : 'Listening…';
    await startSpeech((text, isFinal, err) => {
        if (err) {
            micReset();
            if (!useWorker && workerStt && /language|not-allowed|service|network|audio-capture/.test(String(err))) {
                toast('Browser speech recognition unavailable here — using the worker\'s speech-to-text instead', 'info');
                startMic().catch((e) => toast(e.message, 'error'));
            } else toast(`Speech input error: ${err}`, 'error');
            return;
        }
        els.chatInput.value = text || '';
        autoSize();
        if (isFinal) { micReset(); if (text && text.trim() && !/^\(transcribing/.test(text)) send(); }
    }, { transcribe: useWorker ? workerStt : null });
}
els.micButton.addEventListener('click', async () => {
    if (isListening()) { stopSpeech(); return; }
    try { await startMic(); } catch (e) { toast(e.message, 'error'); micReset(); }
});

// ---------- header actions ----------
els.restartButton.addEventListener('click', () => {
    runs.get(logKey())?.abort();
    if (voiceSession) { voiceSession.stop(); voiceSession = null; }
    if (current.kind === 'bot') loadBot(current.name, { keepHistory: false });
    else loadSwarm(current.id, { keepHistory: false });
});
els.editSwarmButton.addEventListener('click', async () => {
    const swarm = store.getSwarm(current.id);
    const r = await editSwarm({ store, swarm });
    if (r?.deleted) { runs.get(`swarm:${swarm.id}`)?.abort(); chatlog.clear(`swarm:${swarm.id}`); dropView(`swarm:${swarm.id}`); renderSidebar(); return loadBot(store.listBots()[0]?.name); }
    if (r) { renderSidebar(); loadSwarm(r.id); }
});
els.shareButton.addEventListener('click', () => {
    const url = new URL(location.origin + location.pathname);
    if (current.kind === 'bot') {
        const bot = store.getBot(current.name);
        const entries = chatlog.get(`bot:${bot.name}`).filter((e) => e.kind === 'user' || e.kind === 'bot');
        if (!els.configPanel.hidden || !entries.length) {
            url.hash = `bot/${toBase64(JSON.stringify({ ...bot, icon: undefined, files: [] }))}`;
        } else {
            url.hash = `conversation/${toBase64(JSON.stringify({ bot: bot.name, entries: entries.map((e) => ({ kind: e.kind, from: e.from, text: e.text })) }))}`;
        }
    } else {
        const swarm = store.getSwarm(current.id);
        const members = swarm.bots.map((n) => store.getBot(n)).filter(Boolean).map((b) => ({ ...b, icon: undefined, files: [] }));
        url.hash = `room/${toBase64(JSON.stringify({ name: swarm.name, goal: swarm.goal, bots: swarm.bots, coordinator: swarm.coordinator, members }))}`;
    }
    if (url.href.length > 8000) { toast('Too large to share as a link — use Settings → Data → Export instead', 'error'); return; }
    navigator.clipboard.writeText(url.href).then(() => toast('Share link copied to clipboard'));
});

// ---------- configure tab ----------
els.createButton.addEventListener('click', async () => {
    els.sidebarToggle.checked = false; // close the drawer on phones
    creating = true;
    current = { kind: 'bot', name: '' };
    renderSidebar();
    els.configTabBtn.hidden = false;
    els.editSwarmButton.hidden = true;
    els.voiceButton.hidden = true;
    els.title.textContent = 'New bot';
    els.titleAvatar.innerHTML = '';
    els.titleMeta.innerHTML = '';
    await botForm.load(null);
    showTab('config');
});
els.createSwarmButton.addEventListener('click', async () => {
    els.sidebarToggle.checked = false;
    const r = await editSwarm({ store });
    if (r && !r.deleted) { renderSidebar(); loadSwarm(r.id); }
});
els.saveButton.addEventListener('click', async () => {
    try {
        const values = botForm.values();
        const previous = creating ? null : botForm.editingName;
        const bot = store.saveBot(values, previous);
        if (previous && previous !== bot.name) { const old = await chatlog.load(`bot:${previous}`); if (old.length) { chatlog.replace(`bot:${bot.name}`, old); await chatlog.clear(`bot:${previous}`); } dropView(`bot:${previous}`); dropView(`bot:${bot.name}`); }
        creating = false;
        renderSidebar();
        toast(`Saved ${bot.name}`);
        await loadBot(bot.name);
    } catch (e) { alert(e.message); }
});
els.cancelButton.addEventListener('click', () => { creating = false; loadBot(current.name || store.listBots()[0]?.name); });
els.deleteButton.addEventListener('click', () => {
    if (creating) return loadBot(store.listBots()[0]?.name);
    if (!confirm(`Delete bot "${current.name}"?`)) return;
    runs.get(`bot:${current.name}`)?.abort();
    chatlog.clear(`bot:${current.name}`);
    dropView(`bot:${current.name}`);
    store.deleteBot(current.name);
    renderSidebar();
    loadBot(store.listBots()[0]?.name);
});
els.duplicateButton.addEventListener('click', () => {
    if (creating) return;
    const copy = store.duplicateBot(current.name);
    if (copy) { renderSidebar(); loadBot(copy.name); toast(`Created ${copy.name}`); }
});

// ---------- realtime voice (xAI, beta) ----------
let voiceSession = null;
els.voiceButton.addEventListener('click', async () => {
    if (voiceSession) { voiceSession.stop(); voiceSession = null; els.voiceButton.classList.remove('active'); els.voiceButton.textContent = '🎙 Voice'; return; }
    const rawBot = store.getBot(current.name);
    if (!rawBot) return;
    const bot = resolvedBot(rawBot);
    const key = `bot:${bot.name}`;
    await chatlog.load(key);
    const log = logFor(key);
    const view = viewFor(key); // the voice session renders into this bot's view even if the user navigates
    const note = addSystemNote(view, '🎙 Starting voice session…', 'routing');
    let botUi = null;
    let botEntry = null; // persisted entry for the bot's current spoken reply
    let toolRecords = [];
    const currentBotUi = () => (botUi ||= addMessage(view, { sender: bot.name, bot, meta: `${providerBadge('xai')} <span class="model">voice</span>` }));
    const finishBotEntry = () => { botUi = null; botEntry = null; toolRecords = []; };
    try {
        const cat = await ensureCatalog();
        // Same tools as text chat: function tools run in the browser (ask_bot, generate_image, documents, MCP…),
        // native xAI tools (web/X search) run server-side inside the realtime session.
        const toolUi = { get addImage() { return (src, alt) => { currentBotUi().addImage(src, alt); if (botEntry) { (botEntry.images ||= []).push(src); chatlog.update(key, botEntry, {}); } }; }, get addAudio() { return (b, a) => currentBotUi().addAudio(b, a); }, addNote: (h) => currentBotUi().addNote(h) };
        const ctx = await engine.createDirectContext({ bot, ui: toolUi, log, container: view });
        const tools = await buildTools({ ...ctx, bot, ui: ctx.ui });
        voiceSession = await startVoiceSession({
            bot,
            instructions: buildSystemPrompt(bot, { store }) + '\nYou are in a spoken conversation: keep replies short and natural. When you use a tool, say briefly what you are doing, then report the result.',
            voice: bot.voice?.provider === 'xai' ? bot.voice.voice : 'eve',
            tools,
            toolUi,
            nativeTools: nativeToolsFor(bot, cat).filter((t) => t.type === 'web_search' || t.type === 'x_search'),
            onStatus: (s) => { note.innerHTML = `🎙 Voice: <b>${escapeHtml(s)}</b> — click Voice again to stop.`; if (s === 'closed') { voiceSession = null; els.voiceButton.classList.remove('active'); els.voiceButton.textContent = '🎙 Voice'; } },
            onTranscript: ({ role, text, final }) => {
                if (role === 'user') { addMessage(view, { sender: 'You', role: 'user', content: text }); log.append({ kind: 'user', text, voice: true }); finishBotEntry(); return; }
                currentBotUi().set(text);
                if (!botEntry) botEntry = log.append({ kind: 'bot', from: bot.name, text, voice: true, provider: 'xai', model: 'voice', tools: toolRecords });
                else chatlog.update(key, botEntry, { text });
                if (final) finishBotEntry();
            },
            onToolCall: (name, args) => {
                const chip = currentBotUi().addTool(name, args);
                if (!botEntry) botEntry = log.append({ kind: 'bot', from: bot.name, text: '', voice: true, provider: 'xai', model: 'voice', tools: toolRecords });
                const record = { name, args, result: '', error: false };
                toolRecords.push(record);
                return { done(result, isError) { chip.done(result, isError); record.result = typeof result === 'string' ? result.slice(0, 4000) : JSON.stringify(result ?? '').slice(0, 4000); record.error = !!isError; if (botEntry) chatlog.update(key, botEntry, {}); } };
            },
            onError: (e) => toast(e.message, 'error')
        });
        els.voiceButton.classList.add('active');
        els.voiceButton.textContent = '⏹ Stop voice';
    } catch (e) {
        note.innerHTML = `⚠️ Voice unavailable: ${escapeHtml(e.message)}`;
        toast(e.message, 'error');
    }
});

// ---------- settings ----------
async function settings() {
    await openSettings({ store, onChanged: () => { renderSidebar(); botForm.refreshLists?.(); updateHint(); } });
    await connect();
    if (current.kind === 'bot' && current.name) loadBot(current.name); else if (current.kind === 'swarm') loadSwarm(current.id);
}
els.settingsButton.addEventListener('click', () => { els.sidebarToggle.checked = false; settings(); });

// ---------- share links ----------
function toBase64(str) { return btoa(unescape(encodeURIComponent(str))); }
function fromBase64(str) { return decodeURIComponent(escape(atob(str))); }
async function handleHash() {
    if (!location.hash) return false;
    const hash = location.hash.substring(1);
    history.replaceState(null, '', location.pathname + location.search);
    try {
        if (hash.startsWith('bot/')) {
            const bot = JSON.parse(fromBase64(hash.slice(4)));
            if (!store.getBot(bot.name) || confirm(`A bot named "${bot.name}" already exists. Overwrite it?`)) { store.saveBot(bot); renderSidebar(); await loadBot(bot.name); return true; }
        } else if (hash.startsWith('conversation/')) {
            const conv = JSON.parse(fromBase64(hash.slice('conversation/'.length)));
            const name = store.getBot(conv.bot) ? conv.bot : store.listBots()[0].name;
            // v2 shape {entries:[{kind,from,text}]}; legacy shapes {messages:[{role,content}]} / [{role,content}]
            const src = conv.entries || (Array.isArray(conv) ? conv : conv.messages || []);
            const entries = src.map((m) => (m.kind ? { kind: m.kind, from: m.from || name, text: m.text || '' } : { kind: m.role === 'user' ? 'user' : 'bot', from: name, text: typeof m.content === 'string' ? m.content : '' }));
            await chatlog.load(`bot:${name}`);
            chatlog.replace(`bot:${name}`, entries);
            dropView(`bot:${name}`);
            await loadBot(name);
            return true;
        } else if (hash.startsWith('room/') || hash.startsWith('swarm/')) { // "swarm/" = links shared before the rename
            const swarm = JSON.parse(fromBase64(hash.slice(hash.indexOf('/') + 1)));
            for (const b of swarm.members || []) if (!store.getBot(b.name)) store.saveBot(b);
            const saved = store.saveSwarm({ name: swarm.name, goal: swarm.goal, bots: swarm.bots, coordinator: swarm.coordinator });
            renderSidebar(); await loadSwarm(saved.id); return true;
        } else if (hash.startsWith('gpt/')) { // v1 share links
            const gpt = JSON.parse(fromBase64(hash.slice(4)));
            store.saveBot({ ...gpt, tools: [] }); renderSidebar(); await loadBot(gpt.name); return true;
        }
    } catch (e) { console.error('bad share link', e); toast('Could not open share link', 'error'); }
    return false;
}

// ---------- boot ----------
(async function init() {
    // Text-to-speech now reads every reply aloud, so drop it from the *default* bots that shipped with it enabled
    // (user-created bots are untouched). One-time.
    if (!localStorage.getItem('migr:tts-auto')) {
        for (const b of store.listBots()) if (b.builtin && (b.tools || []).includes('text_to_speech')) store.saveBot({ ...b, tools: b.tools.filter((t) => t !== 'text_to_speech') }, b.name);
        localStorage.setItem('migr:tts-auto', '1');
    }
    // Swarm transcripts used to live in localStorage; move them into the chat log once.
    for (const [id, transcript] of Object.entries(store.takeLegacyTranscripts())) { await chatlog.load(`swarm:${id}`); chatlog.replace(`swarm:${id}`, transcript); }
    await connect();
    renderSidebar();
    if (!(await handleHash())) {
        let last = null;
        try { last = JSON.parse(localStorage.getItem('lastOpened') || 'null'); } catch { }
        if (last?.kind === 'swarm' && store.getSwarm(last.id)) await loadSwarm(last.id);
        else if (last?.kind === 'bot' && store.getBot(last.name)) await loadBot(last.name);
        else await loadBot(store.getBot(DEFAULT_BOTS[0].name) ? DEFAULT_BOTS[0].name : store.listBots()[0]?.name);
    }
    if (!connected) toast('API not reachable — see the banner for setup steps', 'error', 6000);
})();
