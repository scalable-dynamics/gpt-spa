// Unit tests: feed synthetic upstream SSE streams through each provider adapter and check the unified events.
// Run: npm test  (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as openai from '../src/providers/openai.js';
import * as xai from '../src/providers/xai.js';
import * as anthropic from '../src/providers/anthropic.js';
import { collectEvents, parseSSE } from '../src/util.js';
import { listTools, callTool } from '../src/mcp.js';

function sse(events) {
    const text = events.map((e) => (typeof e === 'string' ? e : `data: ${JSON.stringify(e)}\n\n`)).join('');
    return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function withFetch(handler, fn) {
    const orig = globalThis.fetch;
    globalThis.fetch = handler;
    return fn().finally(() => { globalThis.fetch = orig; });
}

const params = { model: 'x', system: 'sys', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object', properties: {} } }, { type: 'web_search' }] };

test('parseSSE handles multi-line data, comments and CRLF', async () => {
    const body = new Response(': keepalive\r\nevent: message\r\ndata: {"a":\r\ndata: 1}\r\n\r\ndata: [DONE]\n\n').body;
    const out = [];
    for await (const ev of parseSSE(body)) out.push(ev);
    assert.deepEqual(out, [{ event: 'message', data: '{"a":\n1}' }, { event: undefined, data: '[DONE]' }]);
});

test('OpenAI Responses stream → unified events (text, citation, tool call, usage)', async () => {
    let captured;
    await withFetch(async (url, init) => {
        captured = { url, body: JSON.parse(init.body) };
        return sse([
            { type: 'response.created', response: {} },
            { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message', role: 'assistant', content: [] } },
            { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Hello ' },
            { type: 'response.output_text.annotation.added', item_id: 'msg_1', annotation: { type: 'url_citation', url: 'https://example.com', title: 'Example' } },
            { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'world' },
            { type: 'response.output_item.added', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'f', arguments: '' } },
            { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"a":' },
            { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '1}' },
            { type: 'response.output_item.done', output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"a":1}' } },
            { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 10, output_tokens: 5 } } }
        ]);
    }, async () => {
        const r = await collectEvents(openai.chat({ key: 'k' }, params));
        assert.equal(r.text, 'Hello world');
        assert.deepEqual(r.citations, [{ url: 'https://example.com', title: 'Example' }]);
        assert.deepEqual(r.tool_calls, [{ id: 'call_1', name: 'f', arguments: '{"a":1}' }]);
        assert.deepEqual(r.usage, { input: 10, output: 5 });
        assert.equal(r.finish, 'tool_calls');
    });
    assert.equal(captured.url, 'https://api.openai.com/v1/responses');
    assert.equal(captured.body.instructions, 'sys');
    assert.deepEqual(captured.body.tools.map((t) => t.type), ['function', 'web_search']);
    assert.equal(captured.body.tools[0].name, 'f');
});

test('OpenAI: unified tool history round-trips into function_call / function_call_output items', async () => {
    let captured;
    await withFetch(async (url, init) => { captured = JSON.parse(init.body); return sse([{ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] } }]); }, async () => {
        const r = await collectEvents(openai.chat({ key: 'k' }, {
            model: 'gpt-5.6-luna', messages: [
                { role: 'user', content: 'q' },
                { role: 'assistant', content: '', tool_calls: [{ id: 'call_9', name: 'f', arguments: '{}' }] },
                { role: 'tool', tool_call_id: 'call_9', content: '{"r":1}' }
            ]
        }));
        assert.equal(r.text, 'ok'); // fallback: text taken from response.completed when no deltas were streamed
    });
    assert.deepEqual(captured.input.map((i) => i.type || i.role), ['user', 'function_call', 'function_call_output']);
    assert.equal(captured.input[1].call_id, 'call_9');
    assert.equal(captured.reasoning.summary, 'auto');
});

test('xAI Responses stream → unified events incl. x_search tool mapping and images', async () => {
    let captured;
    await withFetch(async (url, init) => {
        captured = { url, body: JSON.parse(init.body) };
        return sse([
            { type: 'response.output_text.delta', delta: 'Grok says hi' },
            { type: 'response.output_item.done', item: { type: 'image_generation_call', result: 'AAAA' } },
            { type: 'response.completed', response: { status: 'completed', citations: ['https://x.com/post/1'], usage: { input_tokens: 1, output_tokens: 2 } } },
            'data: [DONE]\n\n'
        ]);
    }, async () => {
        const r = await collectEvents(xai.chat({ key: 'k' }, { model: 'grok-4.6', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'x_search' }, { type: 'image_generation' }], reasoning_effort: 'low' }));
        assert.equal(r.text, 'Grok says hi');
        assert.equal(r.images.length, 1);
        assert.deepEqual(r.citations, [{ url: 'https://x.com/post/1', title: undefined }]);
    });
    assert.equal(captured.url, 'https://api.x.ai/v1/responses');
    assert.deepEqual(captured.body.tools, [{ type: 'x_search' }, { type: 'image_generation', action: 'auto' }]);
    assert.deepEqual(captured.body.reasoning, { effort: 'low' });
});

test('Anthropic Messages stream → unified events (thinking, tool_use, web search citations, refusal)', async () => {
    let captured;
    await withFetch(async (url, init) => {
        captured = { url, headers: init.headers, body: JSON.parse(init.body) };
        return sse([
            { type: 'message_start', message: { usage: { input_tokens: 7 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
            { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://a.example', title: 'A' }] } },
            { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Answer' } },
            { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://b.example', title: 'B' } } },
            { type: 'content_block_start', index: 3, content_block: { type: 'tool_use', id: 'toolu_1', name: 'f', input: {} } },
            { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{"a":' } },
            { type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '2}' } },
            { type: 'content_block_stop', index: 3 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
            { type: 'message_stop' }
        ]);
    }, async () => {
        const r = await collectEvents(anthropic.chat({ key: 'k' }, { ...params, model: 'claude-opus-5', reasoning_effort: 'high', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', url: 'data:image/png;base64,QUJD' }] }] }));
        assert.equal(r.text, 'Answer');
        assert.equal(r.reasoning, 'hmm');
        assert.deepEqual(r.citations.map((c) => c.url), ['https://a.example', 'https://b.example']);
        assert.deepEqual(r.tool_calls, [{ id: 'toolu_1', name: 'f', arguments: '{"a":2}' }]);
        assert.equal(r.finish, 'tool_calls');
        assert.deepEqual(r.usage, { input: 7, output: 3 });
    });
    assert.equal(captured.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(captured.headers['anthropic-version'], '2023-06-01');
    assert.match(captured.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
    assert.equal(captured.body.fallbacks, 'default');
    assert.deepEqual(captured.body.thinking, { type: 'adaptive', display: 'summarized' });
    assert.deepEqual(captured.body.output_config, { effort: 'high' });
    assert.equal(captured.body.tools[1].type, 'web_search_20260209');
    assert.equal(captured.body.messages[0].content[1].source.media_type, 'image/png');
    assert.equal(captured.body.temperature, undefined);
});

test('Anthropic: tool results become tool_result blocks in a user turn; haiku gets no thinking/effort', async () => {
    let captured;
    await withFetch(async (url, init) => { captured = JSON.parse(init.body); return sse([{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }]); }, async () => {
        await collectEvents(anthropic.chat({ key: 'k' }, {
            model: 'claude-haiku-4-5', reasoning_effort: 'high', messages: [
                { role: 'user', content: 'q' },
                { role: 'assistant', content: 'calling', tool_calls: [{ id: 'toolu_9', name: 'f', arguments: '{"x":1}' }] },
                { role: 'tool', tool_call_id: 'toolu_9', content: 'result' }
            ]
        }));
    });
    assert.equal(captured.thinking, undefined);
    assert.equal(captured.output_config, undefined);
    assert.equal(captured.messages[1].content[1].type, 'tool_use');
    assert.deepEqual(captured.messages[1].content[1].input, { x: 1 });
    assert.equal(captured.messages[2].role, 'user');
    assert.equal(captured.messages[2].content[0].type, 'tool_result');
});

test('MCP client: initialize → tools/list → tools/call over JSON and SSE bodies with session id', async () => {
    const seen = [];
    await withFetch(async (url, init) => {
        const msg = JSON.parse(init.body);
        seen.push({ method: msg.method, session: init.headers['Mcp-Session-Id'], version: init.headers['MCP-Protocol-Version'] });
        if (msg.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'test', version: '1' }, capabilities: {} } }), { headers: { 'content-type': 'application/json', 'mcp-session-id': 'sess-1' } });
        if (msg.method === 'notifications/initialized') return new Response(null, { status: 202 });
        if (msg.method === 'tools/list') return sse([{ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } }]);
        if (msg.method === 'tools/call') return sse([{ jsonrpc: '2.0', method: 'notifications/progress', params: {} }, { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `echo:${msg.params.arguments.text}` }] } }]);
        return new Response('nope', { status: 500 });
    }, async () => {
        const list = await listTools('https://mcp.test/mcp', {});
        assert.deepEqual(list.tools.map((t) => t.name), ['echo']);
        assert.equal(list.protocolVersion, '2025-06-18');
        const res = await callTool('https://mcp.test/mcp', {}, 'echo', { text: 'hi' });
        assert.deepEqual(res.content, [{ type: 'text', text: 'echo:hi' }]);
    });
    assert.deepEqual(seen.map((s) => s.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.equal(seen[2].session, 'sess-1');
    assert.equal(seen[2].version, '2025-06-18');
});

test('Responses parser: paragraph breaks between agentic narration bursts and new content parts', async () => {
    await withFetch(async () => sse([
        { type: 'response.output_item.added', output_index: 0, item: { id: 'm1', type: 'message' } },
        { type: 'response.output_text.delta', item_id: 'm1', delta: 'Looking that up.' },
        { type: 'response.output_item.added', output_index: 1, item: { id: 'ws1', type: 'web_search_call' } },
        { type: 'response.output_text.delta', item_id: 'm1', delta: 'Found it: 24.19.0.' },
        { type: 'response.output_text.delta', item_id: 'm1', delta: 'Next I check the notes.' },
        { type: 'response.output_text.delta', item_id: 'm1', delta: ' e.g. fine' },
        { type: 'response.content_part.added', item_id: 'm1', part: { type: 'output_text' } },
        { type: 'response.output_text.delta', item_id: 'm1', delta: 'Done.' },
        { type: 'response.completed', response: {} }
    ]), async () => {
        const r = await collectEvents(xai.chat({ key: 'k' }, { model: 'grok-4.6', messages: [{ role: 'user', content: 'x' }] }));
        assert.equal(r.text, 'Looking that up.\n\nFound it: 24.19.0.\n\nNext I check the notes. e.g. fine\n\nDone.');
    });
});

test('Workers AI embeddings: advertised only with the AI binding, default when OpenAI is absent, batches of 100', async () => {
    const { buildCatalog } = await import('../src/catalog.js');
    const cf = await import('../src/providers/cloudflare.js');
    const noBinding = buildCatalog({}, { openai: '', xai: 'k', anthropic: '', mock: '', cloudflare: '' });
    assert.equal(noBinding.providers.cloudflare, undefined);
    assert.equal(noBinding.defaults.embeddings, null);
    const withBinding = buildCatalog({}, { openai: '', xai: 'k', anthropic: '', mock: '', cloudflare: 'ai' });
    assert.equal(withBinding.providers.cloudflare.enabled, true);
    assert.equal(withBinding.defaults.embeddings, 'cloudflare');
    assert.equal(withBinding.defaults.chat, 'xai', 'Workers AI never becomes the chat default');
    const withOpenAI = buildCatalog({}, { openai: 'k', xai: '', anthropic: '', mock: '', cloudflare: 'ai' });
    assert.equal(withOpenAI.defaults.embeddings, 'openai');

    const calls = [];
    const env = { AI: { run: async (model, { text }) => { calls.push({ model, n: text.length }); return { data: text.map(() => [0.1, 0.2, 0.3]) }; } } };
    const r = await cf.embeddings({ env }, { input: Array.from({ length: 150 }, (_, i) => `t${i}`) });
    assert.equal(r.embeddings.length, 150);
    assert.deepEqual(calls.map((c) => c.n), [100, 50]);
    assert.equal(r.model, '@cf/baai/bge-base-en-v1.5');
    assert.equal(r.dims, 3);
    await assert.rejects(cf.embeddings({ env: {} }, { input: ['x'] }), /binding is not configured/);
});
