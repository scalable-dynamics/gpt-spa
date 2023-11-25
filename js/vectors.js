export default function createVectorStore(getEmbeddings) {
    let db = [];
    return {
        clear() {
            db = [];
        },
        vectorSearch: vector_search.bind(null, db, getEmbeddings),
        storeDocument: store_document.bind(null, db, getEmbeddings),
        storeVector: store_vector.bind(null, db),
        retrieveVectors: retrieve_vectors.bind(null, db)
    }
}

async function vector_search(embeddingsDB, getEmbeddings, text) {
    const embeddings = await getEmbeddings([text]);
    const single = embeddings[0];
    if (!single) return [];
    const results = retrieve_vectors(embeddingsDB, single.embedding);
    return results;
}

async function store_document(embeddingsDB, getEmbeddings, name, text) {
    for (const chunk of chunk_text(text, 500)) {
        if (chunk.length == 0) break;
        if (!chunk.join('').trim()) break;
        const embeddings = await getEmbeddings(chunk);
        for (const { embedding, text } of embeddings) {
            store_vector(embeddingsDB, name, text, embedding);
        }
    }
}

function store_vector(embeddingsDB, name, text, embedding) {
    embeddingsDB.push({ name, text, embedding });
}

function retrieve_vectors(embeddingsDB, target_embedding, count = 5) {
    const results = embeddingsDB.map(({ name, text, embedding }) => ({
        name,
        text,
        relevance: cosine_similarity(embedding, target_embedding),
    })).slice(0, count);
    results.sort((a, b) => b.relevance - a.relevance);
    return results;
}

function cosine_similarity(vecA, vecB) {
    let dotProduct = 0.0, normA = 0.0, normB = 0.0;
    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

function* chunk_text(text, maxChunkSize) {
    const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
    let chunk = '';
    let batch = [];
    const maxBatchSize = 20;

    for (let sentence of sentences) {
        sentence = sentence.trim();
        if ((chunk + ' ' + sentence).length <= maxChunkSize) {
            chunk += ' ' + sentence;
        } else {
            if (chunk.trim()) {
                batch.push(chunk.trim());
                if (batch.length === maxBatchSize) {
                    yield batch;
                    batch = [];
                }
            }
            chunk = sentence;
        }
    }

    if (chunk.trim()) {
        batch.push(chunk.trim());
    }

    if (batch.length) {
        yield batch;
    }
}