// Settings modal: status, MCP servers, skills, memory, import/export. (Provider keys live only in the worker.)
import * as api from './api.js';
import { escapeHtml, toast } from './ui.js';

const ICON = {
    plug: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 7v-4M15 7v-4M6 7h12v3a6 6 0 0 1-12 0zM12 16v5"/></svg>',
    edit: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17v3M13.5 6.5l3 3"/></svg>',
    trash: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
    plus: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    lock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>',
    close: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>'
};

export function openSettings({ store, onChanged }) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `<div class="modal wide settings">
          <div class="modal-head"><h2>Settings</h2><button class="icon-btn" id="st-close" title="Close">${ICON.close}</button></div>
          <div class="tabs-inline">
            <button class="tab-btn active" data-tab="status">Status</button>
            <button class="tab-btn" data-tab="mcp">MCP servers</button>
            <button class="tab-btn" data-tab="skills">Skills</button>
            <button class="tab-btn" data-tab="memory">Memory</button>
            <button class="tab-btn" data-tab="data">Data</button>
          </div>

          <section data-panel="status">
            <div id="st-status" class="status-box">Checking…</div>
            <div class="row-actions"><button class="btn secondary sm" id="st-test">Re-check</button></div>
          </section>

          <section data-panel="mcp" hidden>
            <p class="help">Remote MCP servers (Streamable HTTP). Enable a server on a bot in its Configure tab to give it the server's tools.</p>
            <div id="st-mcp-list" class="cards"></div>
            <div class="row-actions"><button class="btn secondary sm" id="mcp-new">${ICON.plus} Add server</button></div>
            <form id="mcp-form" class="inline-form" hidden>
              <h3 id="mcp-form-title">Add MCP server</h3>
              <div class="form-grid">
                <label>Name <input id="mcp-name" type="text" placeholder="cloudflare-docs" autocomplete="off"></label>
                <label>URL <input id="mcp-url" type="url" placeholder="https://docs.mcp.cloudflare.com/mcp" autocomplete="off"></label>
                <label class="wide"><span>Authorization header <small>(optional)</small></span> <input id="mcp-auth" type="password" placeholder="Bearer …" autocomplete="off"></label>
                <label class="wide check-inline"><input id="mcp-approve" type="checkbox"> Ask me before each tool call</label>
              </div>
              <div id="mcp-result" class="result" hidden></div>
              <div class="row-actions">
                <button type="button" class="btn secondary sm" id="mcp-cancel">Cancel</button>
                <button type="button" class="btn secondary sm" id="mcp-test">${ICON.plug} Test connection</button>
                <button type="submit" class="btn sm" id="mcp-save">${ICON.check} Save server</button>
              </div>
            </form>
            <p class="help small">Try <code>https://docs.mcp.cloudflare.com/mcp</code> or <code>https://mcp.deepwiki.com/mcp</code>.</p>
          </section>

          <section data-panel="skills" hidden>
            <p class="help">Skills are reusable instruction blocks (steps, decision rules, expected output). Enable them per bot; a bot loads a skill with <code>use_skill</code>, or type <code>/skill-name</code> in chat.</p>
            <div id="st-skill-list" class="cards"></div>
            <div class="row-actions"><button class="btn secondary sm" id="sk-new">${ICON.plus} Add skill</button></div>
            <form id="sk-form" class="inline-form" hidden>
              <h3 id="sk-form-title">Add skill</h3>
              <div class="form-grid">
                <label>Name <input id="sk-name" type="text" placeholder="weekly-report" autocomplete="off"></label>
                <label>Description <input id="sk-desc" type="text" placeholder="How to write the Monday status report"></label>
                <label class="wide">Instructions <textarea id="sk-text" rows="6"></textarea></label>
              </div>
              <div class="row-actions">
                <button type="button" class="btn secondary sm" id="sk-cancel">Cancel</button>
                <button type="submit" class="btn sm" id="sk-save">${ICON.check} Save skill</button>
              </div>
            </form>
          </section>

          <section data-panel="memory" hidden>
            <p class="help">Facts bots saved with the memory tool. Shared memory is visible to every bot.</p>
            <div id="st-memory"></div>
            <div class="row-actions"><button class="btn danger sm" id="mem-clear">${ICON.trash} Clear shared memory</button></div>
          </section>

          <section data-panel="data" hidden>
            <p class="help">Everything is stored locally in your browser (localStorage + IndexedDB). Export to move it elsewhere.</p>
            <div class="row-actions"><button class="btn secondary sm" id="dt-export">Export JSON</button><label class="btn secondary sm file-btn">Import JSON<input id="dt-import" type="file" accept="application/json" hidden></label></div>
          </section>
        </div>`;
        document.body.appendChild(overlay);
        const $ = (sel) => overlay.querySelector(sel);

        overlay.querySelectorAll('.tab-btn').forEach((b) => b.onclick = () => {
            overlay.querySelectorAll('.tab-btn').forEach((x) => x.classList.toggle('active', x === b));
            overlay.querySelectorAll('section[data-panel]').forEach((s) => s.hidden = s.dataset.panel !== b.dataset.tab);
        });

        // ---- Status ----
        async function checkStatus() {
            $('#st-status').textContent = 'Checking…';
            const h = await api.probeWorker();
            if (h) {
                const providers = Object.entries(h.providers).map(([k, v]) => `<span class="pill ${v ? 'on' : 'off'}">${escapeHtml(k)} ${v ? '✓' : '✗'}</span>`).join(' ')
                    + ` <span class="pill ${h.embeddings ? 'on' : 'off'}" title="Document embeddings (OpenAI or Workers AI)">embeddings ${h.embeddings ? '✓' : '✗'}</span>`;
                $('#st-status').innerHTML = `<div>API reachable${h.version ? ` · v${escapeHtml(h.version)}` : ''}</div><div class="pills">${providers}</div>`;
            } else {
                $('#st-status').textContent = 'The /api endpoint is not reachable from this page.';
            }
        }
        $('#st-test').onclick = checkStatus;
        checkStatus();

        // ---- MCP ----
        let editingServer = null;
        const mcpForm = $('#mcp-form');
        const mcpResult = $('#mcp-result');
        function showMcpForm(server) {
            editingServer = server?.name || null;
            $('#mcp-form-title').textContent = server ? `Edit “${server.name}”` : 'Add MCP server';
            $('#mcp-name').value = server?.name || '';
            $('#mcp-url').value = server?.url || '';
            $('#mcp-auth').value = server?.headers?.Authorization || '';
            $('#mcp-approve').checked = !!server?.requireApproval;
            mcpResult.hidden = true;
            mcpForm.hidden = false;
            $('#mcp-name').focus();
        }
        function hideMcpForm() { mcpForm.hidden = true; editingServer = null; }
        function mcpValues() {
            return { name: $('#mcp-name').value, url: $('#mcp-url').value, headers: $('#mcp-auth').value ? { Authorization: $('#mcp-auth').value } : {}, requireApproval: $('#mcp-approve').checked };
        }
        async function testServer(server, target) {
            target.hidden = false;
            target.innerHTML = `<span class="muted">Connecting to ${escapeHtml(server.url)}…</span>`;
            try {
                const r = await api.mcpTools(server.url, server.headers);
                target.innerHTML = `<div class="ok">${ICON.check} ${escapeHtml(r.server?.name || 'server')} ${escapeHtml(r.server?.version || '')} · protocol ${escapeHtml(r.protocolVersion || '')} · ${r.tools.length} tool${r.tools.length === 1 ? '' : 's'}</div>` +
                    `<ul class="tool-list">${r.tools.slice(0, 40).map((t) => `<li><code>${escapeHtml(t.name)}</code> <span class="muted">${escapeHtml((t.description || '').slice(0, 110))}</span></li>`).join('')}${r.tools.length > 40 ? `<li class="muted">…and ${r.tools.length - 40} more</li>` : ''}</ul>`;
            } catch (e) {
                target.innerHTML = `<div class="err">✖ ${escapeHtml(e.message)}</div>`;
            }
        }
        function renderMcp() {
            const list = store.listMcpServers();
            $('#st-mcp-list').innerHTML = list.length ? list.map((s) => `
              <div class="card" data-name="${escapeHtml(s.name)}">
                <div class="card-main">
                  <div class="card-title">${escapeHtml(s.name)} ${s.requireApproval ? `<span class="tag" title="Asks before each tool call">${ICON.lock} approval</span>` : ''}</div>
                  <div class="card-sub mono">${escapeHtml(s.url)}</div>
                </div>
                <div class="card-actions">
                  <button class="icon-btn" data-act="test" title="Test connection">${ICON.plug}</button>
                  <button class="icon-btn" data-act="edit" title="Edit">${ICON.edit}</button>
                  <button class="icon-btn danger" data-act="remove" title="Remove">${ICON.trash}</button>
                </div>
                <div class="result card-result" hidden></div>
              </div>`).join('') : '<div class="empty">No MCP servers yet.</div>';
            $('#st-mcp-list').querySelectorAll('.card').forEach((card) => {
                const server = list.find((x) => x.name === card.dataset.name);
                card.querySelector('[data-act="test"]').onclick = () => testServer(server, card.querySelector('.card-result'));
                card.querySelector('[data-act="edit"]').onclick = () => showMcpForm(server);
                card.querySelector('[data-act="remove"]').onclick = () => { if (confirm(`Remove MCP server “${server.name}”?`)) { store.deleteMcpServer(server.name); renderMcp(); onChanged?.(); } };
            });
        }
        renderMcp();
        $('#mcp-new').onclick = () => showMcpForm(null);
        $('#mcp-cancel').onclick = hideMcpForm;
        $('#mcp-test').onclick = () => testServer(mcpValues(), mcpResult);
        mcpForm.onsubmit = (e) => {
            e.preventDefault();
            try { store.saveMcpServer(mcpValues(), editingServer); hideMcpForm(); renderMcp(); onChanged?.(); toast('MCP server saved'); }
            catch (err) { alert(err.message); }
        };

        // ---- Skills ----
        let editingSkill = null;
        const skForm = $('#sk-form');
        function showSkillForm(skill) {
            editingSkill = skill?.name || null;
            $('#sk-form-title').textContent = skill ? `Edit “${skill.name}”` : 'Add skill';
            $('#sk-name').value = skill?.name || ''; $('#sk-desc').value = skill?.description || ''; $('#sk-text').value = skill?.instructions || '';
            skForm.hidden = false; $('#sk-name').focus();
        }
        function renderSkills() {
            const list = store.listSkills();
            $('#st-skill-list').innerHTML = list.length ? list.map((s) => `
              <div class="card" data-name="${escapeHtml(s.name)}">
                <div class="card-main"><div class="card-title">/${escapeHtml(s.name)}</div><div class="card-sub">${escapeHtml(s.description || '')}</div></div>
                <div class="card-actions"><button class="icon-btn" data-act="edit" title="Edit">${ICON.edit}</button><button class="icon-btn danger" data-act="remove" title="Remove">${ICON.trash}</button></div>
              </div>`).join('') : '<div class="empty">No skills yet.</div>';
            $('#st-skill-list').querySelectorAll('.card').forEach((card) => {
                const skill = list.find((x) => x.name === card.dataset.name);
                card.querySelector('[data-act="edit"]').onclick = () => showSkillForm(skill);
                card.querySelector('[data-act="remove"]').onclick = () => { if (confirm(`Remove skill “${skill.name}”?`)) { store.deleteSkill(skill.name); renderSkills(); onChanged?.(); } };
            });
        }
        renderSkills();
        $('#sk-new').onclick = () => showSkillForm(null);
        $('#sk-cancel').onclick = () => { skForm.hidden = true; editingSkill = null; };
        skForm.onsubmit = (e) => {
            e.preventDefault();
            try { store.saveSkill({ name: $('#sk-name').value, description: $('#sk-desc').value, instructions: $('#sk-text').value }, editingSkill); skForm.hidden = true; editingSkill = null; renderSkills(); onChanged?.(); toast('Skill saved'); }
            catch (err) { alert(err.message); }
        };

        // ---- Memory ----
        function renderMemory() {
            const all = store.exportAll().memory;
            const rows = [...(all.shared || []).map((m) => ({ ...m, scope: 'shared' })), ...Object.entries(all.bots || {}).flatMap(([bot, list]) => list.map((m) => ({ ...m, scope: bot })))];
            $('#st-memory').innerHTML = rows.length ? `<div class="cards">${rows.map((m) => `<div class="card"><div class="card-main"><div class="card-sub"><span class="tag">${escapeHtml(m.scope)}</span></div><div>${escapeHtml(m.text)}</div></div><div class="card-actions"><button class="icon-btn danger" data-del="${m.id}" title="Forget">${ICON.trash}</button></div></div>`).join('')}</div>` : '<div class="empty">Nothing remembered yet.</div>';
            $('#st-memory').querySelectorAll('[data-del]').forEach((b) => b.onclick = () => { store.deleteMemory(b.dataset.del); renderMemory(); });
        }
        renderMemory();
        $('#mem-clear').onclick = () => { if (confirm('Clear shared memory?')) { store.clearMemory(); renderMemory(); } };

        // ---- Data ----
        $('#dt-export').onclick = () => {
            const blob = new Blob([JSON.stringify(store.exportAll(), null, 2)], { type: 'application/json' });
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'biz-bot-export.json'; a.click();
        };
        $('#dt-import').onchange = async (e) => {
            const file = e.target.files[0]; if (!file) return;
            try { store.importAll(JSON.parse(await file.text())); toast('Imported'); onChanged?.(); } catch (err) { alert(`Import failed: ${err.message}`); }
        };

        const close = () => { overlay.remove(); resolve(true); };
        $('#st-close').onclick = close;
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
    });
}
