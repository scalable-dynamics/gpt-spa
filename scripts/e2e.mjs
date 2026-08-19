#!/usr/bin/env node
// Browser end-to-end smoke test (no provider keys needed — uses the worker's Mock provider).
// Starts `wrangler dev -e e2e` (no Workers AI binding → no Cloudflare login needed) with ENABLE_MOCK=true, then drives the real UI in Chromium (installed Chrome) and
// WebKit (Safari engine, iPhone viewport): direct chat streaming, tool loop with document search, image tool,
// swarm routing + hand-off, settings/MCP against a live public server, and captures the README screenshot.
//   node scripts/e2e.mjs [--browser chromium|webkit|all] [--screenshot docs/screenshot.png] [--port 8790] [--headed]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium, webkit, devices } from 'playwright';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const PORT = Number(opt('port', 8790));
const BASE = `http://localhost:${PORT}`;
const BROWSERS = opt('browser', 'all') === 'all' ? ['chromium', 'webkit'] : [opt('browser', 'all')];
const SCREENSHOT = opt('screenshot', '');
const HEADED = args.includes('--headed');

let failures = 0;
const step = async (name, fn) => {
    try { const d = await fn(); console.log(`  ✓ ${name}${d ? ` — ${d}` : ''}`); }
    catch (e) { failures++; console.log(`  ✗ ${name} — ${e.message || e}`); }
};

async function waitFor(url, ms = 30000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { const r = await fetch(url); if (r.ok) return await r.json(); } catch { }
        await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(`worker did not start at ${url}`);
}

function startWorker() {
    // Mock-only: blank any real provider keys from .dev.vars so the run is deterministic and free.
    const child = spawn('npx', ['wrangler', 'dev', '-e', 'e2e', '--port', String(PORT), '--var', 'ENABLE_MOCK:true', '--var', 'OPENAI_API_KEY:', '--var', 'XAI_API_KEY:', '--var', 'ANTHROPIC_API_KEY:', '--log-level', 'error'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } });
    child.stdout.on('data', () => { });
    child.stderr.on('data', (d) => { const s = d.toString(); if (/error/i.test(s)) process.stderr.write(s); });
    return child;
}

async function runInBrowser(kind, mobile) {
    const launcher = kind === 'webkit' ? webkit : chromium;
    const launchOpts = { headless: !HEADED };
    if (kind === 'chromium') launchOpts.channel = process.env.PLAYWRIGHT_CHROMIUM_CHANNEL || 'chrome';
    let browser;
    try { browser = await launcher.launch(launchOpts); }
    catch (e) {
        if (kind === 'chromium') { browser = await chromium.launch({ headless: !HEADED }); } else throw e;
    }
    const context = await browser.newContext(mobile ? { ...devices['iPhone 13'], permissions: [] } : { viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    console.log(`\n${kind}${mobile ? ' (iPhone 13 viewport, mobile UA)' : ''}`);

    await page.goto(BASE, { waitUntil: 'networkidle' });
    // Force every default bot onto the mock provider (simulates picking it in Configure) and reload.
    await page.evaluate(() => {
        const bots = JSON.parse(localStorage.getItem('bots') || '{}');
        for (const b of Object.values(bots)) { b.provider = 'mock'; b.model = 'mock-1'; b.voice = { provider: 'mock', voice: 'mock' }; }
        localStorage.setItem('bots', JSON.stringify(bots));
        localStorage.removeItem('lastOpened');
    });
    await page.reload({ waitUntil: 'networkidle' });

    // Every chat keeps its own (hidden) view in the DOM, so selectors are scoped to the view on screen.
    const inView = (sel) => (sel.includes('.chat-view') || sel.startsWith('#') ? sel : `.chat-view:not([hidden]) ${sel}`);
    const send = async (text, waitSel, timeout = 20000) => {
        await page.fill('#chat-input', text);
        await page.press('#chat-input', 'Enter');
        if (waitSel) await page.waitForSelector(inView(waitSel), { timeout });
        await page.waitForSelector('#stop-button', { state: 'hidden', timeout });
    };
    const openDrawer = async () => { if (!(await page.$eval('#sidebar-toggle', (el) => el.checked))) { await page.click('label.sidebar-toggle-label'); await page.waitForTimeout(350); } };
    const openBot = async (name) => { if (mobile) await openDrawer(); await page.click(`#bot-links a:has-text("${name}")`); await page.waitForTimeout(400); };

    await step('app boots with default bots and swarm', async () => {
        const bots = await page.$$eval('#bot-links li', (els) => els.length);
        const swarms = await page.$$eval('#swarm-links li', (els) => els.length);
        if (bots < 4 || swarms < 1) throw new Error(`bots=${bots} swarms=${swarms}`);
        return `${bots} bots, ${swarms} swarm`;
    });

    if (mobile) await step('mobile: sidebar toggle opens the drawer', async () => {
        await page.click('label.sidebar-toggle-label');
        await page.waitForTimeout(400); // CSS transition
        const left = await page.$eval('aside', (el) => getComputedStyle(el).left);
        if (left !== '0px') throw new Error(`aside left=${left}`);
        await page.click('#bot-links a:has-text("Assistant")');
        const after = await page.$eval('#sidebar-toggle', (el) => el.checked);
        if (after) throw new Error('drawer stayed open');
        // tapping outside the drawer (the scrim) closes it
        await page.click('label.sidebar-toggle-label'); await page.waitForTimeout(350);
        const vp = page.viewportSize();
        await page.mouse.click(vp.width - 20, Math.round(vp.height / 2));
        if (await page.$eval('#sidebar-toggle', (el) => el.checked)) throw new Error('tap outside did not close the drawer');
        // "+ New" bot closes the drawer and shows the form
        await page.click('label.sidebar-toggle-label'); await page.waitForTimeout(350);
        await page.click('#create-button');
        if (await page.$eval('#sidebar-toggle', (el) => el.checked)) throw new Error('drawer stayed open after + New');
        await page.waitForSelector('#config-panel:not([hidden])');
        await openDrawer();
        await page.click('#bot-links a:has-text("Assistant")'); // back to the chat
        await page.waitForSelector('#chat-panel:not([hidden])');
        return 'drawer opens, closes on link / tap-outside / + New';
    });

    await openBot('Assistant');
    await step('direct chat streams a reply', async () => {
        await send('hello there', '.output-message.role-bot .message-text >> text=/Mock reply/');
        const text = await page.$$eval('.chat-view:not([hidden]) .output-message', (els) => els.at(-1).innerText);
        if (!/hello there/.test(text)) throw new Error(text.slice(0, 120));
    });

    await step('document upload → indexed → search_documents tool loop', async () => {
        await page.setInputFiles('#upload', { name: 'animals.txt', mimeType: 'text/plain', buffer: Buffer.from('Cats are small carnivorous mammals. Purring is a sign of contentment in cats. Dogs are loyal companions.') });
        await page.waitForSelector(inView('.system-note >> text=/Added animals.txt/'), { timeout: 15000 });
        await send('!tool search_documents {"query":"cats purring"}', '.tool-chip.done');
        const chip = await page.$eval('.chat-view:not([hidden]) .tool-chip.done .tool-result', (el) => el.textContent);
        if (!/animals.txt/.test(chip)) throw new Error(chip.slice(0, 120));
        // direct-chat persistence: reload keeps the exchange and the tool card
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForSelector(inView('.tool-chip.done'), { timeout: 15000 });
        const heads = await page.$$eval('.chat-view:not([hidden]) .output-message .message-head h3', (els) => els.map((e) => e.innerText));
        if (!heads.includes('You')) throw new Error('user message not restored: ' + heads.join(','));
        return 'passage found in animals.txt (persisted across reload)';
    });

    await step('ask_bot delegation renders a nested bot bubble', async () => {
        await send('!tool ask_bot {"bot":"Artist","task":"draw something"}', '.output-message:has-text("asked by Assistant")');
        return 'Artist answered on behalf of Assistant';
    });

    await openBot('Artist');
    await step('image generation tool shows an image', async () => {
        await send('!tool generate_image {"prompt":"a cat"}', '.message-image img');
    });

    await step('text-to-speech: enabling it on a bot reads replies aloud (audio player on the reply)', async () => {
        await openBot('Artist');
        await page.click('#config-tab-btn');
        await page.check('[name="tool"][value="text_to_speech"]');
        await page.click('#save-button');
        await page.waitForSelector('#chat-panel:not([hidden])');
        await send('say something short', 'audio.message-audio');
        const n = await page.$$eval('.chat-view:not([hidden]) audio.message-audio', (els) => els.length);
        // the explicit speak tool still works and does not double-speak the reply
        await send('!tool speak {"text":"hello"}', '.tool-chip.done');
        await page.waitForTimeout(400);
        const n2 = await page.$$eval('.chat-view:not([hidden]) audio.message-audio', (els) => els.length);
        if (n2 !== n + 1) throw new Error(`expected one more audio player after speak tool (${n} → ${n2})`);
        await page.click('#config-tab-btn');
        await page.uncheck('[name="tool"][value="text_to_speech"]');
        await page.click('#save-button');
        await page.waitForSelector('#chat-panel:not([hidden])');
        return `${n2} audio players`;
    });

    await step('settings: add + test a live MCP server (Cloudflare docs)', async () => {
        if (mobile) await openDrawer();
        await page.click('#settings-button');
        await page.click('.modal .tab-btn[data-tab="mcp"]');
        await page.click('#mcp-new');
        await page.fill('#mcp-name', 'cloudflare-docs');
        await page.fill('#mcp-url', 'https://docs.mcp.cloudflare.com/mcp');
        await page.click('#mcp-test');
        await page.waitForSelector('#mcp-result .ok', { timeout: 30000 });
        const summary = await page.$eval('#mcp-result .ok', (el) => el.innerText);
        await page.click('#mcp-save');
        await page.waitForSelector('#st-mcp-list .card[data-name="cloudflare-docs"]');
        // per-row test button works too
        await page.click('#st-mcp-list .card[data-name="cloudflare-docs"] [data-act="test"]');
        await page.waitForSelector('#st-mcp-list .card-result .ok', { timeout: 30000 });
        await page.click('#st-close');
        await page.waitForSelector('.modal-overlay', { state: 'detached' });
        return summary;
    });

    await step('configure: enable MCP server on Artist, call its tool through the loop', async () => {
        await openBot('Artist');
        await page.click('#config-tab-btn');
        await page.check('[name="mcp"][value="mcp:cloudflare-docs"]');
        await page.click('#save-button');
        await page.waitForSelector('#chat-panel:not([hidden])');
        await send('!tool cloudflare-docs__search_cloudflare_documentation {"query":"workers static assets"}', '.tool-chip.done', 40000);
        const chip = await page.$$eval('.chat-view:not([hidden]) .tool-chip.done .tool-name', (els) => els.at(-1).innerText);
        if (!/search cloudflare documentation/i.test(chip)) throw new Error(chip);
    });

    await step('swarm: @mention routing, hand-off wakes the next bot, transcript persisted', async () => {
        if (mobile) await openDrawer();
        await page.click('#swarm-links a');
        await page.waitForTimeout(500);
        await page.click('#restart-button');
        await page.waitForTimeout(300);
        await send('What is the capital of France?', '.output-message:has(h3:has-text("Assistant")) .message-text >> text=/Mock reply/');
        await send('@Researcher !tool message_bot {"bot":"Analyst","message":"Please summarise the findings for the user."}', '.system-note.handoff', 30000);
        await page.waitForSelector(inView('.output-message:has(h3:has-text("Analyst"))'), { timeout: 30000 });
        const heads = await page.$$eval('.chat-view:not([hidden]) .output-message .message-head h3', (els) => els.map((e) => e.innerText));
        const expected = ['You', 'Assistant', 'You', 'Researcher', 'Analyst'];
        if (JSON.stringify(heads.slice(-5)) !== JSON.stringify(expected)) throw new Error(heads.join(' > '));
        const entries = await page.evaluate(() => new Promise((resolve, reject) => {
            const id = Object.values(JSON.parse(localStorage.getItem('swarms')))[0].id;
            const req = indexedDB.open('gpt-spa-chats');
            req.onerror = () => reject(req.error);
            req.onsuccess = () => { const get = req.result.transaction('logs').objectStore('logs').get(`swarm:${id}`); get.onsuccess = () => resolve((get.result || []).map((e) => e.kind)); get.onerror = () => reject(get.error); };
        }));
        if (JSON.stringify(entries) !== JSON.stringify(['user', 'bot', 'user', 'bot', 'handoff', 'bot'])) throw new Error(entries.join(','));
        // persistence: reload and the swarm conversation (incl. tool cards) is still there
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForSelector(inView('.output-message .message-head h3:has-text("Analyst")'), { timeout: 15000 });
        const after = await page.$$eval('.chat-view:not([hidden]) .output-message .message-head h3', (els) => els.map((e) => e.innerText));
        if (JSON.stringify(after.slice(-5)) !== JSON.stringify(expected)) throw new Error('after reload: ' + after.join(' > '));
        const chips = await page.$$eval('.chat-view:not([hidden]) .tool-chip.done', (els) => els.length);
        if (chips < 1) throw new Error('tool cards not restored after reload');
        return heads.slice(-5).join(' > ') + ` (persisted, ${chips} tool cards restored)`;
    });

    await step('room turn in flight survives navigating to a bot and back (renders in its own view, nothing lost)', async () => {
        // still in the room from the previous step; start a slow turn and leave immediately
        await page.fill('#chat-input', 'Bonjour !slow 2500');
        await page.keyboard.press('Enter');
        await page.waitForSelector('.chat-view:not([hidden]) #stop-button, #stop-button:not([hidden])', { timeout: 5000 });
        await openBot('Assistant');
        // the bot's view is on screen: no room bubbles, no busy state (its own chat is idle)
        const botView = await page.evaluate(() => ({
            texts: [...document.querySelectorAll('.chat-view:not([hidden]) .output-message .message-text')].map((e) => e.innerText),
            stopHidden: document.getElementById('stop-button').hidden, busyHidden: document.getElementById('busy-bar').hidden
        }));
        if (botView.texts.some((t) => /Bonjour/.test(t))) throw new Error('room message leaked into the bot view');
        if (!botView.stopHidden || !botView.busyHidden) throw new Error('bot view shows the room\'s busy state');
        // sending in the bot while the room is running works independently
        await send('hi from the bot', '.chat-view:not([hidden]) .output-message.role-bot .message-text >> text=/Mock reply/');
        // back to the room: the user message and the (finished or finishing) reply are there, busy state clears
        if (mobile) await openDrawer();
        await page.click('#swarm-links a');
        // the user bubble and a finished bot reply after it must be in the (now visible) room view
        await page.waitForFunction(() => {
            const msgs = [...document.querySelectorAll('.chat-view:not([hidden]) .output-message')];
            const i = msgs.findIndex((m) => m.classList.contains('role-user') && /Bonjour/.test(m.innerText));
            return i >= 0 && msgs.slice(i + 1).some((m) => m.classList.contains('role-bot') && !m.classList.contains('loading') && m.querySelector('.message-text')?.innerText.trim().length > 20);
        }, null, { timeout: 15000 }).catch(async () => {
            const dump = await page.evaluate(() => [...document.querySelectorAll('.chat-view')].map((v) => `${v.dataset.key}${v.hidden ? '(hidden)' : ''}: ` + [...v.querySelectorAll('.output-message .message-text, .system-note')].map((n) => n.innerText.slice(0, 60).replace(/\n/g, ' ')).join(' | ')).join('\n'));
            throw new Error(`room reply not visible after coming back\n${dump}`);
        });
        await page.waitForFunction(() => document.getElementById('stop-button').hidden, null, { timeout: 15000 });
        const heads = await page.$$eval('.chat-view:not([hidden]) .output-message .message-head h3', (els) => els.map((e) => e.innerText));
        if (!heads.includes('Analyst') || heads.filter((h) => h === 'You').length < 3) throw new Error('earlier room messages missing: ' + heads.join(' > '));
        const entries = await page.evaluate(() => new Promise((resolve, reject) => {
            const id = Object.values(JSON.parse(localStorage.getItem('swarms')))[0].id;
            const req = indexedDB.open('gpt-spa-chats');
            req.onerror = () => reject(req.error);
            req.onsuccess = () => { const get = req.result.transaction('logs').objectStore('logs').get(`swarm:${id}`); get.onsuccess = () => resolve((get.result || []).map((e) => e.kind)); get.onerror = () => reject(get.error); };
        }));
        if (entries.length < 8 || entries.at(-1) !== 'bot') throw new Error('room log incomplete: ' + entries.join(','));
        return `${heads.length} bubbles in the room, log ${entries.length} entries`;
    });

    if (SCREENSHOT && kind === 'chromium' && !mobile) {
        mkdirSync('docs', { recursive: true });
        await page.setViewportSize({ width: 1400, height: 860 });
        await page.waitForTimeout(300);
        await page.screenshot({ path: SCREENSHOT });
        console.log(`  📸 saved ${SCREENSHOT}`);
    }
    if (mobile) await step('mobile: no horizontal overflow, input bar within the visual viewport (also with the keyboard up)', async () => {
        const measure = () => page.evaluate(() => {
            const r = document.querySelector('.input-content').getBoundingClientRect();
            const vv = window.visualViewport;
            return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bottom: Math.round(r.bottom), vh: Math.round(vv ? vv.height : window.innerHeight), appH: getComputedStyle(document.documentElement).getPropertyValue('--app-h').trim() };
        });
        let m = await measure();
        if (m.sw > m.cw + 1) throw new Error(`horizontal overflow ${m.sw} > ${m.cw}`);
        if (m.bottom > m.vh) throw new Error(`input bar bottom ${m.bottom} below viewport ${m.vh}`);
        if (!/px$/.test(m.appH)) throw new Error(`--app-h not set from the visual viewport (${m.appH})`);
        // an on-screen keyboard shrinks the visual viewport — emulate that with a shorter viewport
        const size = page.viewportSize();
        await page.setViewportSize({ width: size.width, height: Math.round(size.height * 0.55) });
        await page.waitForTimeout(150);
        const k = await measure();
        await page.setViewportSize(size);
        if (k.bottom > k.vh) throw new Error(`with keyboard: input bar bottom ${k.bottom} below viewport ${k.vh}`);
        return `width ${m.cw}px, input bottom ${m.bottom}/${m.vh}px, keyboard ${k.bottom}/${k.vh}px`;
    });
    if (mobile) await step('mobile: dialogs fit the viewport and scroll (settings, new swarm)', async () => {
        const check = async (label) => {
            const d = await page.evaluate(() => {
                const modal = document.querySelector('.modal-overlay .modal');
                const r = modal.getBoundingClientRect();
                const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
                modal.scrollTop = 1e6; // try to scroll to the end
                return { top: Math.round(r.top), bottom: Math.round(r.bottom), vh: Math.round(vh), scrollable: modal.scrollHeight > modal.clientHeight + 1, scrolledTo: modal.scrollTop, maxScroll: modal.scrollHeight - modal.clientHeight, overflowY: getComputedStyle(modal).overflowY };
            });
            if (d.top < 0 || d.bottom > d.vh) throw new Error(`${label}: dialog ${d.top}..${d.bottom} outside viewport ${d.vh}`);
            if (d.scrollable && d.scrolledTo < d.maxScroll - 1) throw new Error(`${label}: dialog did not scroll (${d.scrolledTo}/${d.maxScroll})`);
            return d;
        };
        const size = page.viewportSize();
        await openDrawer(); // settings lives in the drawer on phones
        await page.click('#settings-button');
        await page.waitForSelector('.modal-overlay .modal.settings');
        await page.click('.modal-overlay .tab-btn[data-tab="mcp"]');
        await page.click('#mcp-new');
        const s1 = await check('settings');
        await page.setViewportSize({ width: size.width, height: Math.round(size.height * 0.55) }); // keyboard-sized viewport
        await page.waitForTimeout(150);
        const s2 = await check('settings+keyboard');
        await page.setViewportSize(size);
        await page.click('#st-close');
        await page.waitForSelector('.modal-overlay', { state: 'detached' });
        await openDrawer();
        await page.click('#create-swarm-button');
        await page.waitForSelector('.modal-overlay .modal.wide');
        const s3 = await check('new swarm');
        await page.click('.modal-overlay .cancel');
        await page.waitForSelector('.modal-overlay', { state: 'detached' });
        await page.evaluate(() => { document.getElementById('sidebar-toggle').checked = false; });
        // "New bot" opens the Configure panel: after scrolling to the end, the Save/Delete buttons must be on screen
        await openDrawer();
        await page.click('#create-button');
        await page.waitForSelector('#config-panel:not([hidden])');
        const nb = await page.evaluate(() => { const p = document.querySelector('#config-panel'); p.scrollTop = 1e6; const r = document.querySelector('#config-panel .buttons').getBoundingClientRect(); const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight; return { bottom: Math.round(r.bottom), vh: Math.round(vh) }; });
        if (nb.bottom > nb.vh) throw new Error(`new bot: buttons bottom ${nb.bottom} below viewport ${nb.vh}`);
        await page.evaluate(() => { document.getElementById('sidebar-toggle').checked = false; });
        return `settings ${s1.top}..${s1.bottom}/${s1.vh} (scroll ${s1.maxScroll}px), keyboard ${s2.top}..${s2.bottom}/${s2.vh}, swarm ${s3.top}..${s3.bottom}/${s3.vh}, new-bot buttons ${nb.bottom}/${nb.vh}`;
    });

    await step('no page/console errors', async () => {
        // WebKit logs "Button failed to load, iconName = …" for its own <audio controls> UI in mobile layouts — not ours.
        const real = errors.filter((e) => !/favicon|net::ERR_ABORTED|Failed to load resource|Button failed to load, iconName/.test(e));
        if (real.length) throw new Error(real.slice(0, 3).join(' | '));
    });
    await browser.close();
}

(async () => {
    const worker = startWorker();
    try {
        const health = await waitFor(`${BASE}/api/health`);
        if (!health.providers?.mock) throw new Error('mock provider not enabled');
        if (Object.entries(health.providers).some(([k, v]) => k !== 'mock' && v)) throw new Error('real providers still enabled — e2e must be mock-only');
        for (const kind of BROWSERS) {
            await runInBrowser(kind, false);
            if (kind === 'webkit') await runInBrowser('webkit', true);
        }
    } catch (e) {
        failures++;
        console.error('fatal:', e.message || e);
    } finally {
        worker.kill('SIGINT');
        setTimeout(() => worker.kill('SIGKILL'), 3000).unref();
    }
    console.log(failures ? `\n${failures} step(s) failed` : '\nall e2e steps passed');
    process.exit(failures ? 1 : 0);
})();
