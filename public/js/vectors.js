// Local vector store: chunks documents, embeds them through the worker, and persists vectors in IndexedDB
// so uploads survive a refresh. Search is brute-force cosine similarity (fine for personal document sets).

const DB_NAME = 'gpt-spa-vectors';
const DB_VERSION = 1;
const STORE = 'chunks';

function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(STORE)) {
                const store = db.createObjectStore(STORE, { keyPath: 'id' });
                store.createIndex('doc', 'doc', { unique: false });
                store.createIndex('scope', 'scope', { unique: false });
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

function tx(db, mode, fn) {
    return new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        const out = fn(store);
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    });
}

async function hash(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function* chunkText(text, maxChunkSize = 900, overlapSentences = 1) {
    const sentences = (text.match(/[^.!?\n]+[.!?]*\s*/g) || [text]).map((s) => s.trim()).filter(Boolean);
    let chunk = [];
    let length = 0;
    for (const sentence of sentences) {
        if (length + sentence.length > maxChunkSize && chunk.length) {
            yield chunk.join(' ');
            chunk = chunk.slice(-overlapSentences);
            length = chunk.join(' ').length;
        }
        chunk.push(sentence);
        length += sentence.length + 1;
    }
    if (chunk.length) yield chunk.join(' ');
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * @param {(texts:string[]) => Promise<number[][] | {vectors:number[][], model?:string}>} embed
 *   returns one vector per input text (optionally with the embedding model id, which is stored on each record so
 *   documents indexed by different models never get compared with each other)
 */
export default function createVectorStore(embed) {
    async function embedTexts(texts) {
        const r = await embed(texts);
        return Array.isArray(r) ? { vectors: r, model: '' } : { vectors: r.vectors || r.embeddings || [], model: r.model || '' };
    }
    let dbPromise = null;
    let cache = null; // in-memory mirror: Map<id, record>
    const db = () => (dbPromise ||= openDb());

    async function load() {
        if (cache) return cache;
        const d = await db();
        const all = await new Promise((resolve, reject) => {
            const req = d.transaction(STORE, 'readonly').objectStore(STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });
        cache = new Map(all.map((r) => [r.id, r]));
        return cache;
    }

    return {
        /** Store (or re-use cached vectors for) a document. scope = bot name or 'shared'. */
        async storeDocument(name, text, scope = 'shared', onProgress) {
            const chunks = Array.from(chunkText(text)).filter((c) => c.trim());
            if (!chunks.length) return 0;
            const map = await load();
            const pending = [];
            const records = [];
            for (let i = 0; i < chunks.length; i++) pending.push({ id: `${scope}::${name}::${await hash(chunks[i])}`, index: i, text: chunks[i] });
            // Re-index the whole document when any chunk is missing or was embedded by a different model.
            const existing = pending.map((p) => map.get(p.id));
            let model = existing[0]?.model || '';
            if (existing.every((r) => r && (r.model || '') === model)) {
                // cached — unless the embedder has switched models since (then the cached vectors are unusable)
                const probe = await embedTexts([pending[0].text]);
                if ((probe.model || '') === model) return chunks.length;
            }
            const BATCH = 32;
            for (let i = 0; i < pending.length; i += BATCH) {
                const batch = pending.slice(i, i + BATCH);
                const { vectors, model: m } = await embedTexts(batch.map((b) => b.text));
                model = m || '';
                batch.forEach((b, j) => {
                    records.push({ id: b.id, doc: name, scope, index: b.index, text: b.text, embedding: vectors[j], model });
                });
                onProgress && onProgress(Math.min(i + BATCH, pending.length), pending.length);
            }
            const d = await db();
            await tx(d, 'readwrite', (store) => records.forEach((r) => store.put(r)));
            records.forEach((r) => map.set(r.id, r));
            return chunks.length;
        },
        async removeDocument(name, scope) {
            const map = await load();
            const ids = [...map.values()].filter((r) => r.doc === name && (!scope || r.scope === scope)).map((r) => r.id);
            const d = await db();
            await tx(d, 'readwrite', (store) => ids.forEach((id) => store.delete(id)));
            ids.forEach((id) => map.delete(id));
        },
        async clear(scope) {
            const map = await load();
            const d = await db();
            if (!scope) { await tx(d, 'readwrite', (s) => s.clear()); map.clear(); return; }
            const ids = [...map.values()].filter((r) => r.scope === scope).map((r) => r.id);
            await tx(d, 'readwrite', (store) => ids.forEach((id) => store.delete(id)));
            ids.forEach((id) => map.delete(id));
        },
        async listDocuments(scopes) {
            const map = await load();
            const docs = new Map();
            for (const r of map.values()) {
                if (scopes && !scopes.includes(r.scope)) continue;
                const key = `${r.scope}::${r.doc}`;
                const entry = docs.get(key) || { name: r.doc, scope: r.scope, chunks: 0 };
                entry.chunks++;
                docs.set(key, entry);
            }
            return [...docs.values()];
        },
        async hasVectors(scopes) {
            const map = await load();
            for (const r of map.values()) if (!scopes || scopes.includes(r.scope)) return true;
            return false;
        },
        async search(query, { scopes, count = 5, minScore = 0.2 } = {}) {
            const map = await load();
            const candidates = [...map.values()].filter((r) => !scopes || scopes.includes(r.scope));
            if (!candidates.length) return [];
            const { vectors: [q], model } = await embedTexts([query]);
            return candidates
                .filter((r) => (r.model || '') === (model || '') && r.embedding?.length === q.length)
                .map((r) => ({ name: r.doc, scope: r.scope, text: r.text, index: r.index, score: cosine(r.embedding, q) }))
                .filter((r) => r.score >= minScore)
                .sort((a, b) => b.score - a.score)
                .slice(0, count);
        },
        /** Full text of a stored document (chunks joined in order). */
        async getDocumentText(name, scopes) {
            const map = await load();
            return [...map.values()]
                .filter((r) => r.doc === name && (!scopes || scopes.includes(r.scope)))
                .sort((a, b) => a.index - b.index)
                .map((r) => r.text)
                .join('\n');
        }
    };
}
