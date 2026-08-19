// Persistent state for bots, swarms (group chats of bots), skills, memory and MCP servers.
// Everything lives in the browser's localStorage — nothing is stored server-side.

const KEYS = { bots: 'bots', swarms: 'swarms', skills: 'skills', memory: 'memory', mcp: 'mcpServers', legacy: 'gpts' };

function read(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
}

function write(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
}

export function slug(name) {
    return String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export function newId(prefix = 'id') {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/** Normalise a bot object (fills defaults; migrates legacy GPT records). */
export function normalizeBot(bot, defaults = {}) {
    const b = { ...bot };
    b.name = (b.name || '').trim();
    b.description = b.description || '';
    b.title = b.title || '';
    b.welcome = b.welcome || `Hello, I'm ${b.name}. How can I help?`;
    b.instructions = b.instructions || 'You are a helpful assistant.';
    b.icon = b.icon || '';
    b.provider = b.provider || defaults.provider || 'openai';
    b.model = b.model || defaults.model || '';
    b.reasoning = b.reasoning || 'default';
    if (typeof b.voice === 'string' || !b.voice) b.voice = { provider: b.provider, voice: typeof b.voice === 'string' ? b.voice : '' };
    b.tools = Array.isArray(b.tools) ? b.tools : [];
    b.mcpServers = Array.isArray(b.mcpServers) ? b.mcpServers : [];
    b.skills = Array.isArray(b.skills) ? b.skills : [];
    b.files = Array.isArray(b.files) ? b.files : [];
    b.canDelegate = b.canDelegate !== false;
    b.builtin = !!b.builtin;
    return b;
}

/** Legacy tool names from the GPT era → new tool ids. */
const LEGACY_TOOL_MAP = {
    'Image Generation (DALL-E)': 'image_generation',
    'Text-to-speech (TTS)': 'text_to_speech',
    'Bing Search': 'web_search'
};

export function createStore(defaultBots = []) {
    let bots = read(KEYS.bots, null);
    if (!bots) {
        // Migrate legacy "gpts" storage → bots.
        const legacy = read(KEYS.legacy, null);
        bots = {};
        if (legacy) {
            for (const [name, gpt] of Object.entries(legacy)) {
                if (typeof gpt.action === 'function') continue;
                const tools = (gpt.tools || []).map((t) => LEGACY_TOOL_MAP[t] || `bot:${t}`);
                bots[name] = normalizeBot({ ...gpt, name, tools });
            }
        }
        for (const bot of defaultBots) if (!bots[bot.name]) bots[bot.name] = normalizeBot(bot);
        write(KEYS.bots, bots);
    } else {
        let changed = false;
        for (const bot of defaultBots) if (!bots[bot.name]) { bots[bot.name] = normalizeBot(bot); changed = true; }
        for (const [name, bot] of Object.entries(bots)) {
            const norm = normalizeBot({ ...bot, name: bot.name || name });
            if (JSON.stringify(norm) !== JSON.stringify(bot)) { bots[name] = norm; changed = true; }
        }
        if (changed) write(KEYS.bots, bots);
    }

    let swarms = read(KEYS.swarms, {});
    let skills = read(KEYS.skills, {});
    let memory = read(KEYS.memory, { shared: [], bots: {} });
    let mcpServers = read(KEYS.mcp, []);

    const api = {
        // ---- bots ----
        listBots() { return Object.values(bots).sort((a, b) => a.name.localeCompare(b.name)); },
        getBot(name) { return bots[name] ? normalizeBot(bots[name]) : null; },
        saveBot(bot, previousName) {
            const b = normalizeBot(bot);
            if (!b.name) throw new Error('Please enter a name');
            if (b.name.includes(':') || b.name.includes('@')) throw new Error('Names cannot contain ":" or "@"');
            if (previousName && previousName !== b.name) {
                delete bots[previousName];
                // update references in swarms and other bots' tools
                for (const s of Object.values(swarms)) s.bots = s.bots.map((n) => (n === previousName ? b.name : n));
                for (const other of Object.values(bots)) other.tools = (other.tools || []).map((t) => (t === `bot:${previousName}` ? `bot:${b.name}` : t));
                if (memory.bots[previousName]) { memory.bots[b.name] = memory.bots[previousName]; delete memory.bots[previousName]; }
                write(KEYS.swarms, swarms); write(KEYS.memory, memory);
            }
            bots[b.name] = b;
            write(KEYS.bots, bots);
            return b;
        },
        deleteBot(name) {
            delete bots[name];
            for (const s of Object.values(swarms)) s.bots = s.bots.filter((n) => n !== name);
            delete memory.bots[name];
            write(KEYS.bots, bots); write(KEYS.swarms, swarms); write(KEYS.memory, memory);
        },
        duplicateBot(name) {
            const src = bots[name];
            if (!src) return null;
            let copyName = `${src.name} copy`;
            let i = 2;
            while (bots[copyName]) copyName = `${src.name} copy ${i++}`;
            const copy = normalizeBot({ ...src, name: copyName, builtin: false });
            bots[copyName] = copy;
            write(KEYS.bots, bots);
            return copy;
        },
        importBots(list) {
            for (const bot of list) bots[bot.name] = normalizeBot(bot);
            write(KEYS.bots, bots);
        },

        // ---- swarms (group chats) ----
        listSwarms() { return Object.values(swarms).sort((a, b) => a.name.localeCompare(b.name)); },
        getSwarm(id) { return swarms[id] || null; },
        saveSwarm(swarm) {
            const s = { id: swarm.id || newId('swarm'), name: (swarm.name || '').trim(), goal: swarm.goal || '', bots: [...new Set(swarm.bots || [])], coordinator: swarm.coordinator || '' };
            if (!s.name) throw new Error('Please name the room');
            if (s.bots.length < 1) throw new Error('Add at least one bot to the room');
            swarms[s.id] = s;
            write(KEYS.swarms, swarms);
            return s;
        },
        deleteSwarm(id) { delete swarms[id]; write(KEYS.swarms, swarms); },
        /** One-time migration: transcripts used to live on the swarm object; return and drop them. */
        takeLegacyTranscripts() {
            const out = {};
            let changed = false;
            for (const s of Object.values(swarms)) if (Array.isArray(s.transcript)) { if (s.transcript.length) out[s.id] = s.transcript; delete s.transcript; changed = true; }
            if (changed) write(KEYS.swarms, swarms);
            return out;
        },

        // ---- skills (reusable instruction blocks) ----
        listSkills() { return Object.values(skills).sort((a, b) => a.name.localeCompare(b.name)); },
        getSkill(name) { return skills[name] || null; },
        saveSkill(skill, previousName) {
            const s = { name: (skill.name || '').trim(), description: skill.description || '', instructions: skill.instructions || '' };
            if (!s.name) throw new Error('Please name the skill');
            if (previousName && previousName !== s.name) delete skills[previousName];
            skills[s.name] = s;
            write(KEYS.skills, skills);
            return s;
        },
        deleteSkill(name) { delete skills[name]; write(KEYS.skills, skills); },

        // ---- memory ----
        getMemory(botName) {
            return { shared: memory.shared || [], bot: (botName && memory.bots[botName]) || [] };
        },
        addMemory(text, botName) {
            const entry = { id: newId('mem'), text: String(text).trim(), at: Date.now() };
            if (!entry.text) return null;
            if (botName) (memory.bots[botName] ||= []).push(entry);
            else (memory.shared ||= []).push(entry);
            write(KEYS.memory, memory);
            return entry;
        },
        deleteMemory(id) {
            memory.shared = (memory.shared || []).filter((m) => m.id !== id);
            for (const k of Object.keys(memory.bots)) memory.bots[k] = memory.bots[k].filter((m) => m.id !== id);
            write(KEYS.memory, memory);
        },
        clearMemory(botName) {
            if (botName) memory.bots[botName] = []; else memory.shared = [];
            write(KEYS.memory, memory);
        },

        // ---- MCP servers (global registry; bots reference by name) ----
        listMcpServers() { return [...mcpServers]; },
        saveMcpServer(server, previousName) {
            const s = { name: (server.name || '').trim(), url: (server.url || '').trim(), headers: server.headers || {}, requireApproval: !!server.requireApproval };
            if (!s.name || !s.url) throw new Error('MCP server needs a name and URL');
            mcpServers = mcpServers.filter((x) => x.name !== s.name && x.name !== previousName);
            mcpServers.push(s);
            write(KEYS.mcp, mcpServers);
            return s;
        },
        deleteMcpServer(name) {
            mcpServers = mcpServers.filter((x) => x.name !== name);
            for (const b of Object.values(bots)) b.tools = (b.tools || []).filter((t) => t !== `mcp:${name}`);
            write(KEYS.mcp, mcpServers); write(KEYS.bots, bots);
        },

        exportAll() {
            return { bots: Object.values(bots), swarms: Object.values(swarms), skills: Object.values(skills), memory, mcpServers };
        },
        importAll(data) {
            if (data.bots) for (const b of data.bots) bots[b.name] = normalizeBot(b);
            if (data.swarms) for (const s of data.swarms) swarms[s.id] = s;
            if (data.skills) for (const s of data.skills) skills[s.name] = s;
            if (data.memory) memory = data.memory;
            if (data.mcpServers) mcpServers = data.mcpServers;
            write(KEYS.bots, bots); write(KEYS.swarms, swarms); write(KEYS.skills, skills); write(KEYS.memory, memory); write(KEYS.mcp, mcpServers);
        }
    };
    return api;
}
