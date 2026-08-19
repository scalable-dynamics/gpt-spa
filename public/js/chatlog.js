// Persistent per-chat conversation log (IndexedDB) for bots and swarms — survives refreshes and settings changes.
// Entries: {kind:'user', text, images} | {kind:'bot', from, text, citations, images, tools:[{name,args,result,error}], inReplyTo?, via?}
//          {kind:'handoff', from, to, text} | {kind:'note', text}   — all with `at` timestamps.
// Reads go through an in-memory cache so callers can treat a log as a plain array; writes are debounced.

const DB_NAME = 'gpt-spa-chats';
const STORE = 'logs';
const MAX_ENTRIES = 500;

let dbPromise = null;
const cache = new Map();   // key → entries[]
const loading = new Map(); // key → in-flight read promise
const timers = new Map();

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => { const db = req.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
const db = () => (dbPromise ||= openDb());

async function read(key) {
    const d = await db();
    return new Promise((resolve, reject) => {
        const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key);
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => reject(req.error);
    });
}

async function write(key, entries) {
    const d = await db();
    return new Promise((resolve, reject) => {
        const tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(entries, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

const pending = new Map(); // key → in-flight write promise
function flushSoon(key, delay = 150) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => flushNow(key), delay));
}
function flushNow(key) {
    clearTimeout(timers.get(key)); timers.delete(key);
    const p = write(key, cache.get(key) || []).catch((e) => console.warn('chatlog write failed', e)).finally(() => { if (pending.get(key) === p) pending.delete(key); });
    pending.set(key, p);
    return p;
}

export const chatlog = {
    /** Load (and cache) the entries for a chat key such as "bot:Assistant" or "swarm:swarm_x". */
    async load(key) {
        if (cache.has(key)) return cache.get(key);
        // one read per key: two concurrent loads must not each set the cache (the second would drop entries the
        // first caller appended in between)
        if (!loading.has(key)) {
            loading.set(key, read(key).catch((e) => { console.warn('chatlog read failed', e); return []; }).then((entries) => {
                if (!cache.has(key)) cache.set(key, entries);
                loading.delete(key);
                return cache.get(key);
            }));
        }
        return loading.get(key);
    },
    /** Cached entries (empty array until load() has run). */
    get(key) { return cache.get(key) || []; },
    append(key, entry) {
        const entries = cache.get(key) || [];
        const e = { at: Date.now(), ...entry };
        entries.push(e);
        if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
        cache.set(key, entries);
        flushNow(key); // appends are written straight away; only streaming updates are debounced
        return e;
    },
    /** Replace the last entry (used to update a streaming bot entry once it is final). */
    update(key, entry, patch) {
        Object.assign(entry, patch);
        flushSoon(key);
        return entry;
    },
    replace(key, entries) {
        cache.set(key, entries.slice(-MAX_ENTRIES));
        flushNow(key);
    },
    async clear(key) {
        cache.set(key, []);
        clearTimeout(timers.get(key));
        try { await write(key, []); } catch { }
    },
    /** Force pending writes to disk (e.g. before unload or before a turn is reported finished). */
    async flush() {
        for (const key of [...timers.keys()]) flushNow(key);
        await Promise.all([...pending.values()]);
    }
};

if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { chatlog.flush(); });
