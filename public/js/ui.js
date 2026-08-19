// Chat rendering helpers: message bubbles with streaming markdown, tool-call chips, citations, images, audio,
// approval cards and simple modal prompts. No framework — plain DOM.

let autoplayHintShown = false;
const md = (typeof window !== 'undefined' && window.markdownit) ? window.markdownit({ linkify: true, breaks: true }) : null;

export function renderMarkdown(text) {
    const html = md ? md.render(text || '') : escapeHtml(text || '').replace(/\n/g, '<br>');
    return (typeof window !== 'undefined' && window.DOMPurify) ? window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] }) : html;
}

export function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function providerBadge(provider) {
    const labels = { openai: 'OpenAI', xai: 'xAI', anthropic: 'Anthropic' };
    return `<span class="badge badge-${provider || 'none'}">${labels[provider] || provider || ''}</span>`;
}

export function avatarHtml(bot) {
    if (bot?.icon) return `<img class="avatar" src="${bot.icon}" alt="">`;
    const letter = (bot?.name || '?').trim().charAt(0).toUpperCase();
    return `<span class="avatar avatar-letter" data-provider="${bot?.provider || ''}">${escapeHtml(letter)}</span>`;
}

const LOADER = `<div class="loader"><div></div><div></div><div></div><div></div></div>`;

/**
 * Add a message bubble. Returns a controller for streaming updates.
 * opts: {sender, bot, role:'user'|'bot'|'system', meta, collapsible}
 */
export function addMessage(container, { sender, bot = null, role = 'bot', meta = '', content = '', loading = false } = {}) {
    const el = document.createElement('div');
    el.className = `output-message role-${role}`;
    el.innerHTML = `
      <div class="message-head">${role === 'user' ? '<span class="avatar avatar-letter avatar-user">You</span>' : avatarHtml(bot || { name: sender })}
        <h3>${escapeHtml(sender)}</h3>${meta ? `<span class="message-meta">${meta}</span>` : ''}
        <span class="message-actions"></span>
      </div>
      <div class="message-body"><div class="reasoning" hidden></div><div class="message-text"></div><div class="message-extras"></div></div>`;
    container.appendChild(el);
    const textEl = el.querySelector('.message-text');
    const extras = el.querySelector('.message-extras');
    const reasoningEl = el.querySelector('.reasoning');
    let text = content || '';
    let reasoning = '';
    let raf = 0;
    const paint = () => {
        raf = 0;
        textEl.innerHTML = text ? renderMarkdown(text) : (loading ? LOADER : '');
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
    paint();
    scrollToBottom(container);
    const ctl = {
        el,
        get text() { return text; },
        append(delta) { text += delta; loading = false; schedule(); scrollToBottom(container); },
        set(value) { text = value || ''; loading = false; schedule(); scrollToBottom(container); },
        setLoading(v) { loading = v; schedule(); },
        appendReasoning(delta) {
            reasoning += delta;
            reasoningEl.hidden = false;
            if (!reasoningEl.firstChild) reasoningEl.innerHTML = `<details><summary>Thinking…</summary><div class="reasoning-body"></div></details>`;
            reasoningEl.querySelector('.reasoning-body').innerHTML = renderMarkdown(reasoning);
        },
        addTool(name, args) {
            const chip = document.createElement('div');
            chip.className = 'tool-chip running';
            chip.innerHTML = `<div class="tool-head"><span class="spinner" aria-hidden="true"></span><span class="tool-name">${escapeHtml(humanizeToolName(name))}</span><span class="tool-status">running…</span></div>
              <div class="tool-args">${formatValue(args)}</div><div class="tool-result"></div>`;
            extras.appendChild(chip);
            scrollToBottom(container);
            return {
                done(result, isError = false) {
                    chip.classList.remove('running');
                    chip.classList.add(isError ? 'error' : 'done');
                    chip.querySelector('.spinner')?.remove();
                    chip.querySelector('.tool-status').textContent = isError ? 'failed' : 'done';
                    const r = chip.querySelector('.tool-result');
                    const value = parseMaybeJson(result);
                    const summary = summarizeResult(value, isError);
                    const body = formatValue(value);
                    r.innerHTML = `<details><summary>${isError ? '✖' : '✓'} ${escapeHtml(summary)}</summary><div class="tool-result-body">${body}</div></details>`;
                    scrollToBottom(container);
                }
            };
        },
        addCitations(citations) {
            if (!citations?.length) return;
            let box = extras.querySelector('.citations');
            if (!box) { box = document.createElement('div'); box.className = 'citations'; extras.appendChild(box); }
            const seen = new Set();
            const list = citations.filter((c) => c?.url && !seen.has(c.url) && seen.add(c.url));
            const SHOW = 5; // search can return dozens of sources — keep the bubble short (especially on phones)
            const link = (c, i) => `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener" ${i >= SHOW ? 'class="extra" hidden' : ''}>${i + 1}. ${escapeHtml(c.title || safeHost(c.url))}</a>`;
            box.innerHTML = `<span class="citations-title">Sources</span>` + list.map(link).join('')
                + (list.length > SHOW ? `<button class="link-button more-sources">+${list.length - SHOW} more</button>` : '');
            box.querySelector('.more-sources')?.addEventListener('click', (e) => {
                const open = e.target.dataset.open === '1';
                box.querySelectorAll('a.extra').forEach((a) => { a.hidden = open; });
                e.target.dataset.open = open ? '0' : '1';
                e.target.textContent = open ? `+${list.length - SHOW} more` : 'fewer';
            });
        },
        addImage(src, alt = '') {
            const fig = document.createElement('figure');
            fig.className = 'message-image';
            fig.innerHTML = `<a href="${escapeHtml(src)}" target="_blank" rel="noopener"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"></a>${alt ? `<figcaption>${escapeHtml(alt)}</figcaption>` : ''}`;
            extras.appendChild(fig);
            scrollToBottom(container);
        },
        addAudio(blob, autoplay = true) {
            const url = URL.createObjectURL(blob);
            const audio = document.createElement('audio');
            audio.controls = true;
            audio.src = url;
            audio.className = 'message-audio';
            extras.appendChild(audio);
            if (autoplay) audio.play().catch(() => {
                // Autoplay policy (Safari/iOS in particular): the first playback must follow a tap — tell the user once.
                if (!autoplayHintShown) { autoplayHintShown = true; toast('Tap ▶ on the reply to hear it — the browser blocked autoplay', 'info', 5000); }
                audio.classList.add('needs-tap');
            });
            scrollToBottom(container);
            return audio;
        },
        addNote(html) {
            const note = document.createElement('div');
            note.className = 'message-note';
            note.innerHTML = html;
            extras.appendChild(note);
        },
        addAction(label, onClick) {
            const btn = document.createElement('button');
            btn.className = 'link-button';
            btn.textContent = label;
            btn.addEventListener('click', onClick);
            el.querySelector('.message-actions').appendChild(btn);
        },
        remove() { el.remove(); }
    };
    return ctl;
}

// ---------- readable rendering of tool inputs / outputs ----------
export function humanizeToolName(name) {
    const n = String(name || '');
    if (n.includes('__')) { const [server, tool] = n.split('__'); return `${server.replace(/[-_]+/g, ' ')} › ${tool.replace(/[-_]+/g, ' ')}`; }
    return n.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

function humanizeKey(key) {
    return String(key).replace(/^_/, '').replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
}

function parseMaybeJson(value) {
    if (typeof value !== 'string') return value;
    const t = value.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) { try { return JSON.parse(t); } catch { } }
    return value;
}

const LONG = 320;
/** Render any JSON-ish value as readable HTML (key/value lists, nested lists, truncated long text). */
export function formatValue(value, depth = 0) {
    if (value === null || value === undefined || value === '') return '<span class="muted">—</span>';
    if (typeof value === 'boolean') return `<span class="val-bool">${value ? 'yes' : 'no'}</span>`;
    if (typeof value === 'number') return `<span class="val-num">${value}</span>`;
    if (typeof value === 'string') {
        if (/^https?:\/\/\S+$/.test(value)) return `<a href="${escapeHtml(value)}" target="_blank" rel="noopener">${escapeHtml(value.length > 80 ? value.slice(0, 77) + '…' : value)}</a>`;
        if (/^data:image\//.test(value)) return '<span class="muted">(inline image)</span>';
        const text = escapeHtml(value);
        if (value.length <= LONG) return `<span class="val-text">${text.replace(/\n/g, '<br>')}</span>`;
        return `<span class="val-text"><span class="short">${escapeHtml(value.slice(0, LONG))}… <button class="link-button more">more</button></span><span class="full" hidden>${text.replace(/\n/g, '<br>')} <button class="link-button less">less</button></span></span>`;
    }
    if (Array.isArray(value)) {
        if (!value.length) return '<span class="muted">(none)</span>';
        if (value.every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)) && value.join(', ').length < 200) return escapeHtml(value.join(', '));
        return `<ol class="val-list">${value.slice(0, 50).map((v) => `<li>${formatValue(v, depth + 1)}</li>`).join('')}${value.length > 50 ? `<li class="muted">…and ${value.length - 50} more</li>` : ''}</ol>`;
    }
    if (typeof value === 'object') {
        const entries = Object.entries(value).filter(([, v]) => v !== undefined);
        if (!entries.length) return '<span class="muted">(empty)</span>';
        return `<dl class="kv ${depth ? 'nested' : ''}">${entries.map(([k, v]) => `<dt>${escapeHtml(humanizeKey(k))}</dt><dd>${formatValue(v, depth + 1)}</dd>`).join('')}</dl>`;
    }
    return escapeHtml(String(value));
}

function summarizeResult(value, isError) {
    if (isError) return typeof value === 'string' ? value.slice(0, 120) : (value?.error || 'error');
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (value.error) return String(value.error).slice(0, 120);
        if (value.denied) return 'denied by user';
        if (value.queued) return `hand-off queued for ${value.to || 'bot'}`;
        if (Array.isArray(value.images)) return `${value.images.length} image${value.images.length === 1 ? '' : 's'} generated`;
        if (Array.isArray(value.results)) return `${value.results.length} result${value.results.length === 1 ? '' : 's'}`;
        if (Array.isArray(value.documents)) return `${value.documents.length} document${value.documents.length === 1 ? '' : 's'}`;
        if (Array.isArray(value.bots)) return `${value.bots.length} bot${value.bots.length === 1 ? '' : 's'}`;
        if (Array.isArray(value.memories)) return `${value.memories.length} memor${value.memories.length === 1 ? 'y' : 'ies'}`;
        if (typeof value.answer === 'string') return value.answer.replace(/\s+/g, ' ').slice(0, 120);
        if (typeof value.text === 'string') return value.text.replace(/\s+/g, ' ').slice(0, 120);
        if (value.spoken) return 'spoken aloud';
        if (value.saved) return 'saved to memory';
        const first = Object.values(value).find((v) => typeof v === 'string');
        return first ? first.replace(/\s+/g, ' ').slice(0, 120) : 'done';
    }
    if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
    return String(value ?? 'done').replace(/\s+/g, ' ').slice(0, 120);
}

// "more / less" toggles for long values (event delegation, works for chips added later)
if (typeof document !== 'undefined') document.addEventListener('click', (e) => {
    const more = e.target.closest('.val-text .more, .val-text .less');
    if (!more) return;
    const wrap = more.closest('.val-text');
    const isMore = more.classList.contains('more');
    wrap.querySelector('.short').hidden = isMore;
    wrap.querySelector('.full').hidden = !isMore;
});

function safeHost(url) {
    try { return new URL(url).hostname; } catch { return url; }
}

export function addSystemNote(container, html, className = '') {
    const el = document.createElement('div');
    el.className = `system-note ${className}`;
    el.innerHTML = html;
    container.appendChild(el);
    scrollToBottom(container);
    return el;
}

/** Approval card (Allow / Deny). Resolves true/false. */
export function askApproval(container, { title, detail }) {
    return new Promise((resolve) => {
        const el = document.createElement('div');
        el.className = 'approval-card';
        el.innerHTML = `<div class="approval-title">${escapeHtml(title)}</div><pre class="approval-detail">${escapeHtml(detail || '')}</pre>
          <div class="approval-actions"><button class="btn allow">Allow once</button><button class="btn deny">Deny</button></div>`;
        container.appendChild(el);
        scrollToBottom(container);
        el.querySelector('.allow').onclick = () => { el.remove(); resolve(true); };
        el.querySelector('.deny').onclick = () => { el.remove(); resolve(false); };
    });
}

/** Simple modal prompt with a text input. Resolves string or null. */
export function promptModal({ title, label, defaultValue = '', placeholder = '', type = 'text', help = '' }) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `<div class="modal"><h2>${escapeHtml(title)}</h2>${help ? `<p class="help">${help}</p>` : ''}
          <label>${escapeHtml(label)}<input type="${type}" value="${escapeHtml(defaultValue)}" placeholder="${escapeHtml(placeholder)}"></label>
          <div class="modal-actions"><button class="btn secondary cancel">Cancel</button><button class="btn ok">Save</button></div></div>`;
        document.body.appendChild(overlay);
        const input = overlay.querySelector('input');
        input.focus();
        const close = (v) => { overlay.remove(); resolve(v); };
        overlay.querySelector('.cancel').onclick = () => close(null);
        overlay.querySelector('.ok').onclick = () => close(input.value);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value); if (e.key === 'Escape') close(null); });
    });
}

export function scrollToBottom(container) {
    if (container.closest('[hidden]')) return; // a chat that is not on screen must not scroll the one that is
    const scroller = container.closest('.content') || document.scrollingElement;
    requestAnimationFrame(() => { scroller.scrollTop = scroller.scrollHeight; });
}

export function toast(message, kind = 'info', ms = 3500) {
    let host = document.getElementById('toasts');
    if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.appendChild(host); }
    const t = document.createElement('div');
    t.className = `toast toast-${kind}`;
    t.textContent = message;
    host.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
}
