// Cloudflare Workers AI adapter — embeddings only (bge-base-en-v1.5, 768 dims). Needs the `ai` binding in
// wrangler.jsonc; no API key. Lets document search work when no provider with an embeddings API is configured.
import { HttpError } from '../util.js';

export const id = 'cloudflare';
export const label = 'Cloudflare Workers AI';
export const secretName = 'AI binding (wrangler.jsonc "ai")';

export const catalog = {
    label: 'Cloudflare Workers AI',
    models: [],
    embeddings: [{ id: '@cf/baai/bge-base-en-v1.5', label: 'bge-base-en-v1.5 (Workers AI)', dims: 768, default: true }],
    capabilities: { web_search: false, x_search: false, code_execution: false, image_generation: false, tts: false, stt: false, embeddings: true, search: false }
};

export async function embeddings({ env }, { input, model }) {
    if (!env?.AI) throw new HttpError(400, 'Workers AI binding is not configured (add "ai": {"binding": "AI"} to wrangler.jsonc)');
    const m = model || '@cf/baai/bge-base-en-v1.5';
    const out = [];
    for (let i = 0; i < input.length; i += 100) { // Workers AI accepts up to 100 texts per call
        const batch = input.slice(i, i + 100).map((t) => String(t).slice(0, 2000));
        let res;
        try { res = await env.AI.run(m, { text: batch }); }
        catch (e) { throw new HttpError(502, `Workers AI: ${e.message || e}`); }
        if (!res?.data) throw new HttpError(502, 'Workers AI returned no embeddings');
        out.push(...res.data);
    }
    return { embeddings: out, model: m, dims: out[0]?.length || 0 };
}
