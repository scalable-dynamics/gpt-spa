// Model catalog served to the SPA. Static (kept in the provider adapters) so the UI never needs a key to render.
import * as openai from './providers/openai.js';
import * as xai from './providers/xai.js';
import * as anthropic from './providers/anthropic.js';
import * as mock from './providers/mock.js';
import * as cloudflare from './providers/cloudflare.js';

export function buildCatalog(env, keys) {
    const providers = {};
    for (const p of [openai, xai, anthropic, mock, cloudflare]) {
        if (p.id === 'mock' && !keys.mock) continue;         // only advertised when ENABLE_MOCK=true
        if (p.id === 'cloudflare' && !keys.cloudflare) continue; // only when the Workers AI binding exists
        providers[p.id] = { ...p.catalog, id: p.id, enabled: !!keys[p.id] };
    }
    const enabled = Object.values(providers).filter((p) => p.enabled);
    const first = (pred) => enabled.find(pred)?.id || null;
    return {
        providers,
        defaults: {
            chat: first((p) => p.models?.length),
            image: first((p) => p.image?.length),
            tts: first((p) => p.tts),
            stt: first((p) => p.stt),
            embeddings: ['openai', 'mock', 'cloudflare'].find((id) => providers[id]?.enabled && providers[id]?.embeddings?.length) || first((p) => p.embeddings?.length),
            search: first((p) => p.capabilities?.search)
        },
        search: { default: first((p) => p.capabilities?.search) },
        version: '2.0.0'
    };
}
