// Bot configuration form (the "Configure" tab) and the swarm editor.
import { BUILTIN_TOOLS } from './tools.js';
import { escapeHtml } from './ui.js';
import { readAnyFile } from './files.js';

export function createBotForm(container, { store, getCatalog, onFilesChanged }) {
    let catalog = null;
    let selectedIcon = '';
    let selectedFiles = [];
    let editingName = null;

    container.innerHTML = `
      <div class="form-grid">
        <label>Name <input type="text" id="bot-name" placeholder="e.g. Researcher"></label>
        <label>Title / role <input type="text" id="bot-title" placeholder="e.g. Web research specialist"></label>
        <label class="wide">Description (standing rules — what this bot owns and how it works)
          <input type="text" id="bot-description" placeholder="Finds and cites current information; never publishes anything"></label>
        <label class="wide">Welcome message <input type="text" id="bot-welcome"></label>
        <label>Provider <select id="bot-provider"></select></label>
        <label>Model <select id="bot-model"></select></label>
        <label>Reasoning effort <select id="bot-reasoning">
            <option value="default">Model default</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
        <label>Avatar <input type="file" id="bot-icon" accept="image/*"><span id="bot-icon-preview" class="icon-preview"></span></label>
        <label>Voice provider <select id="bot-voice-provider"></select></label>
        <label>Voice <select id="bot-voice"></select></label>
        <label class="wide">Instructions (system prompt)
          <textarea id="bot-instructions" rows="12"></textarea></label>
        <fieldset class="wide"><legend>Tools</legend><div id="bot-tools" class="checks"></div></fieldset>
        <fieldset class="wide"><legend>MCP servers <small>(add servers in Settings)</small></legend><div id="bot-mcp" class="checks"></div></fieldset>
        <fieldset class="wide"><legend>Skills <small>(reusable instruction blocks — manage in Settings)</small></legend><div id="bot-skills" class="checks"></div></fieldset>
        <fieldset class="wide"><legend>Files (embedded for document search; PDFs and text)</legend>
          <div id="bot-files" class="checks"></div><input type="file" id="bot-file" multiple></fieldset>
        <label class="wide check-inline"><input type="checkbox" id="bot-delegate" checked> Other bots may delegate work to this bot</label>
      </div>`;

    const $ = (id) => container.querySelector(`#${id}`);
    const els = {
        name: $('bot-name'), title: $('bot-title'), description: $('bot-description'), welcome: $('bot-welcome'), provider: $('bot-provider'),
        model: $('bot-model'), reasoning: $('bot-reasoning'), icon: $('bot-icon'), iconPreview: $('bot-icon-preview'), voiceProvider: $('bot-voice-provider'),
        voice: $('bot-voice'), instructions: $('bot-instructions'), tools: $('bot-tools'), mcp: $('bot-mcp'), skills: $('bot-skills'), files: $('bot-files'),
        file: $('bot-file'), delegate: $('bot-delegate')
    };

    function providerEntries() {
        // Only providers that are actually configured on the worker are offered.
        const all = Object.values(catalog?.providers || {}).filter((p) => p.models?.length);
        const enabled = all.filter((p) => p.enabled);
        return enabled.length ? enabled : all;
    }

    function fillProviders(selected) {
        els.provider.innerHTML = providerEntries().map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('');
        if (selected && [...els.provider.options].some((o) => o.value === selected)) els.provider.value = selected;
        else if (catalog?.defaults?.chat) els.provider.value = catalog.defaults.chat;
    }
    function fillModels(selected) {
        const p = catalog?.providers?.[els.provider.value];
        els.model.innerHTML = (p?.models || []).map((m) => `<option value="${m.id}" title="${escapeHtml(m.note || '')}">${escapeHtml(m.label || m.id)}${m.default ? ' ★' : ''}</option>`).join('');
        const def = p?.models?.find((m) => m.default)?.id;
        els.model.value = selected && [...els.model.options].some((o) => o.value === selected) ? selected : (def || p?.models?.[0]?.id || '');
        const levels = p?.reasoning_levels || [];
        [...els.reasoning.options].forEach((o) => { o.hidden = o.value !== 'default' && levels.length && !levels.includes(o.value); });
    }
    function fillVoiceProviders(selected) {
        const withTts = Object.values(catalog?.providers || {}).filter((p) => p.tts && p.enabled);
        els.voiceProvider.innerHTML = `<option value="">(none)</option>` + withTts.map((p) => `<option value="${p.id}">${escapeHtml(p.label)}</option>`).join('');
        els.voiceProvider.value = selected && withTts.some((p) => p.id === selected) ? selected : (withTts[0]?.id || '');
    }
    function fillVoices(selected) {
        const p = catalog?.providers?.[els.voiceProvider.value];
        const voices = p?.tts?.voices || [];
        els.voice.innerHTML = voices.map((v) => `<option value="${escapeHtml(v.id || v)}">${escapeHtml(v.label || v.id || v)}</option>`).join('');
        if (selected && voices.some((v) => (v.id || v) === selected)) els.voice.value = selected;
    }
    function fillTools(bot) {
        const enabled = new Set(bot?.tools || []);
        const caps = catalog?.providers?.[els.provider.value]?.capabilities || {};
        els.tools.innerHTML = BUILTIN_TOOLS.map((t) => {
            const nativeOnly = t.id === 'code_execution';
            const disabled = nativeOnly && !caps.code_execution;
            return `<label class="${disabled ? 'disabled' : ''}" title="${escapeHtml(t.description)}"><input type="checkbox" name="tool" value="${t.id}" ${enabled.has(t.id) ? 'checked' : ''} ${disabled ? 'disabled' : ''}> ${escapeHtml(t.label)}${disabled ? ' (not on this provider)' : ''}</label>`;
        }).join('');
        const servers = store.listMcpServers();
        els.mcp.innerHTML = servers.length ? servers.map((s) => `<label title="${escapeHtml(s.url)}"><input type="checkbox" name="mcp" value="mcp:${escapeHtml(s.name)}" ${enabled.has(`mcp:${s.name}`) ? 'checked' : ''}> ${escapeHtml(s.name)}${s.requireApproval ? ' 🔒' : ''}</label>`).join('') : '<em>No MCP servers configured yet.</em>';
        const skills = store.listSkills();
        const chosen = new Set(bot?.skills || []);
        els.skills.innerHTML = skills.length ? skills.map((s) => `<label title="${escapeHtml(s.description)}"><input type="checkbox" name="skill" value="${escapeHtml(s.name)}" ${chosen.has(s.name) ? 'checked' : ''}> ${escapeHtml(s.name)}</label>`).join('') : '<em>No skills yet.</em>';
    }
    function renderFiles() {
        els.files.innerHTML = selectedFiles.length ? selectedFiles.map((f) => `<label><input type="checkbox" name="file" value="${escapeHtml(f.name)}" checked> ${escapeHtml(f.name)} <small>(${Math.round((f.content || '').length / 1024)} KB)</small></label>`).join('') : '<em>No files attached.</em>';
        els.files.querySelectorAll('[name="file"]').forEach((cb) => cb.onchange = (e) => {
            selectedFiles = selectedFiles.filter((f) => f.name !== e.target.value);
            renderFiles();
        });
    }

    els.provider.addEventListener('change', () => { fillModels(); fillTools(currentValues()); });
    els.voiceProvider.addEventListener('change', () => fillVoices());
    els.icon.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const data = await readAnyFile(file);
        selectedIcon = data.content;
        els.iconPreview.innerHTML = `<img src="${selectedIcon}" alt="">`;
    });
    els.file.addEventListener('change', async (e) => {
        for (const file of e.target.files) {
            try {
                const data = await readAnyFile(file);
                if (data.kind !== 'document') { alert(`${file.name}: only text and PDF files can be attached to a bot`); continue; }
                selectedFiles = selectedFiles.filter((f) => f.name !== data.name).concat([{ name: data.name, type: data.type, content: data.content }]);
            } catch (err) { alert(`Could not read ${file.name}: ${err.message}`); }
        }
        els.file.value = '';
        renderFiles();
    });

    function currentValues() {
        return {
            name: els.name.value.trim(), title: els.title.value.trim(), description: els.description.value.trim(), welcome: els.welcome.value.trim(),
            provider: els.provider.value, model: els.model.value, reasoning: els.reasoning.value, icon: selectedIcon,
            voice: { provider: els.voiceProvider.value, voice: els.voice.value }, instructions: els.instructions.value.trim(),
            tools: [...container.querySelectorAll('[name="tool"]:checked, [name="mcp"]:checked')].map((c) => c.value),
            skills: [...container.querySelectorAll('[name="skill"]:checked')].map((c) => c.value),
            files: selectedFiles, canDelegate: els.delegate.checked
        };
    }

    return {
        async load(bot) {
            catalog = await getCatalog();
            editingName = bot?.name || null;
            selectedIcon = bot?.icon || '';
            selectedFiles = [...(bot?.files || [])];
            els.name.value = bot?.name || '';
            els.title.value = bot?.title || '';
            els.description.value = bot?.description || '';
            els.welcome.value = bot?.welcome || '';
            els.instructions.value = bot?.instructions || '';
            els.reasoning.value = bot?.reasoning || 'default';
            els.delegate.checked = bot ? bot.canDelegate !== false : true;
            els.iconPreview.innerHTML = selectedIcon ? `<img src="${selectedIcon}" alt="">` : '';
            fillProviders(bot?.provider);
            fillModels(bot?.model);
            fillVoiceProviders(bot?.voice?.provider);
            fillVoices(bot?.voice?.voice);
            fillTools(bot || { tools: ['web_search', 'document_search', 'summarize_document', 'memory', 'ask_bot'] });
            renderFiles();
        },
        values: currentValues,
        get editingName() { return editingName; },
        refreshLists() { fillTools(currentValues()); }
    };
}

/** Swarm (group chat) editor rendered inside a modal. Resolves to the saved swarm or null. */
export function editSwarm({ store, swarm = null }) {
    return new Promise((resolve) => {
        const bots = store.listBots();
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `<div class="modal wide">
          <h2>${swarm ? 'Edit room' : 'New room'}</h2>
          <p class="help">A room is a group chat of 2–6 bots working on a shared goal. Address bots with <b>@Name</b>; leave a message unaddressed and the coordinator (or a router) picks who owns it. Bots can hand work to each other.</p>
          <label>Name <input id="sw-name" type="text" value="${escapeHtml(swarm?.name || '')}" placeholder="e.g. Launch team"></label>
          <label>Shared goal <textarea id="sw-goal" rows="3" placeholder="Describe the shared outcome and who owns the next step">${escapeHtml(swarm?.goal || '')}</textarea></label>
          <fieldset><legend>Members</legend><div class="checks" id="sw-bots">${bots.map((b) => `<label><input type="checkbox" value="${escapeHtml(b.name)}" ${swarm?.bots?.includes(b.name) ? 'checked' : ''}> ${escapeHtml(b.name)}${b.title ? ` <small>— ${escapeHtml(b.title)}</small>` : ''}</label>`).join('') || '<em>Create some bots first.</em>'}</div></fieldset>
          <label>Coordinator (optional — receives unaddressed messages, delegates, and synthesises) <select id="sw-coord"><option value="">Auto-route</option>${bots.map((b) => `<option value="${escapeHtml(b.name)}" ${swarm?.coordinator === b.name ? 'selected' : ''}>${escapeHtml(b.name)}</option>`).join('')}</select></label>
          <div class="modal-actions">${swarm ? '<button class="btn danger delete">Delete room</button>' : ''}<button class="btn secondary cancel">Cancel</button><button class="btn ok">Save</button></div>
        </div>`;
        document.body.appendChild(overlay);
        const close = (v) => { overlay.remove(); resolve(v); };
        overlay.querySelector('.cancel').onclick = () => close(null);
        overlay.querySelector('.delete')?.addEventListener('click', () => { if (confirm('Delete this room?')) { store.deleteSwarm(swarm.id); close({ deleted: true }); } });
        overlay.querySelector('.ok').onclick = () => {
            try {
                const members = [...overlay.querySelectorAll('#sw-bots input:checked')].map((c) => c.value);
                if (members.length > 6) throw new Error('A room can have at most 6 bots');
                const saved = store.saveSwarm({ ...(swarm || {}), name: overlay.querySelector('#sw-name').value, goal: overlay.querySelector('#sw-goal').value, bots: members, coordinator: overlay.querySelector('#sw-coord').value });
                close(saved);
            } catch (e) { alert(e.message); }
        };
    });
}
