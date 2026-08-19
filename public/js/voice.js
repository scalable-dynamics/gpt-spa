// Realtime voice mode (beta) — talks to xAI's realtime speech-to-speech API from the browser.
// The worker mints a short-lived client secret (/api/realtime/token); audio never touches the worker.
// Protocol: OpenAI-Realtime-style events over WebSocket (session.update, input_audio_buffer.append,
// response.output_audio.delta, response.output_audio_transcript.delta, response.function_call_arguments.done,
// response.done, error). Function tools are executed in the browser exactly like the text tool loop.
import { realtimeToken } from './api.js';

const SAMPLE_RATE = 24000;

/**
 * @param {object} opts
 *   bot, instructions, voice, tools ([{def, run}] from tools.buildTools), nativeTools ([{type:'web_search'}...]),
 *   toolUi (message controller with addImage/addAudio for tool output), onTranscript({role, text, final}),
 *   onStatus(status), onError(err), onToolCall(name, args) → chip controller
 */
export async function startVoiceSession({ bot, instructions, voice, tools = [], nativeTools = [], toolUi = null, onTranscript, onStatus, onError, onToolCall }) {
    const { client_secret, url, model } = await realtimeToken('xai');

    // Safari/iOS: the AudioContext must be created and resumed inside a user gesture (the Voice button click),
    // and createMediaStreamSource needs the context to run at the microphone's native rate — so we keep the default
    // rate and downsample to 24 kHz for the wire (playback buffers are created at 24 kHz and resampled by the browser).
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    await audioCtx.resume().catch(() => { });
    const inputRate = audioCtx.sampleRate;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const source = audioCtx.createMediaStreamSource(stream);
    const processor = audioCtx.createScriptProcessor(4096, 1, 1);
    let playhead = 0;
    let closed = false;
    let assistantText = '';
    const seenUserItems = new Set();
    let lastUserText = '';
    const handledCalls = new Set();
    const pendingCalls = new Map(); // call_id → {name, arguments}
    const byName = new Map(tools.map((t) => [t.def.name, t]));

    const ws = new WebSocket(`${url}?model=${encodeURIComponent(model)}`, [`xai-client-secret.${client_secret}`]);
    ws.binaryType = 'arraybuffer';
    const send = (obj) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); };

    ws.onopen = () => {
        onStatus?.('connected');
        const sessionTools = [
            ...tools.map((t) => ({ type: 'function', name: t.def.name, description: t.def.description, parameters: t.def.parameters })),
            ...nativeTools
        ];
        send({
            type: 'session.update',
            session: {
                instructions: instructions || bot?.instructions || 'You are a helpful voice assistant.',
                voice: voice || 'eve',
                turn_detection: { type: 'server_vad' },
                audio: { input: { format: { type: 'audio/pcm', rate: SAMPLE_RATE } }, output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE } } },
                ...(sessionTools.length ? { tools: sessionTools, tool_choice: 'auto' } : {})
            }
        });
        processor.onaudioprocess = (e) => {
            if (closed || ws.readyState !== WebSocket.OPEN) return;
            const input = downsample(e.inputBuffer.getChannelData(0), inputRate, SAMPLE_RATE);
            const pcm = new Int16Array(input.length);
            for (let i = 0; i < input.length; i++) pcm[i] = Math.max(-1, Math.min(1, input[i])) * 0x7fff;
            send({ type: 'input_audio_buffer.append', audio: b64FromBytes(new Uint8Array(pcm.buffer)) });
        };
        source.connect(processor);
        processor.connect(audioCtx.destination);
    };

    async function runFunctionCall(callId, name, argsJson) {
        if (!callId || handledCalls.has(callId)) return;
        handledCalls.add(callId);
        let args = {};
        try { args = argsJson ? JSON.parse(argsJson) : {}; } catch { args = { _raw: argsJson }; }
        const chip = onToolCall?.(name, args);
        const tool = byName.get(name);
        let output;
        try {
            if (!tool) throw new Error(`Unknown tool ${name}`);
            const out = await tool.run(args, { chip, bot, ui: toolUi });
            output = typeof out === 'string' ? out : JSON.stringify(out);
            chip?.done(output.length > 4000 ? output.slice(0, 4000) + '…' : output, !!(out && typeof out === 'object' && out.error));
        } catch (e) {
            output = JSON.stringify({ error: e.message || String(e) });
            chip?.done(e.message || String(e), true);
        }
        send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: output.slice(0, 60000) } });
        send({ type: 'response.create' });
    }

    ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        switch (msg.type) {
            case 'session.created':
            case 'session.updated':
                onStatus?.('listening');
                break;
            case 'input_audio_buffer.speech_started':
                playhead = audioCtx.currentTime; // barge-in: drop queued playback
                onStatus?.('listening');
                break;
            case 'conversation.item.input_audio_transcription.completed':
            case 'conversation.item.input_audio_transcription.done': {
                const text = (msg.transcript || '').trim();
                const key = msg.item_id || text;
                // The transcript can be delivered more than once (per item / per event variant) — show it once.
                if (!text || seenUserItems.has(key) || text === lastUserText) break;
                seenUserItems.add(key);
                lastUserText = text;
                onTranscript?.({ role: 'user', text, final: true });
                break;
            }
            case 'response.output_audio_transcript.delta':
            case 'response.audio_transcript.delta':
                assistantText += msg.delta || '';
                onTranscript?.({ role: 'assistant', text: assistantText, final: false });
                onStatus?.('speaking');
                break;
            case 'response.output_audio.delta':
            case 'response.audio.delta':
                playPcm(msg.delta);
                break;
            case 'response.function_call_arguments.delta': {
                const id = msg.call_id || msg.item_id;
                const p = pendingCalls.get(id) || { name: msg.name, arguments: '' };
                p.arguments += msg.delta || '';
                if (msg.name) p.name = msg.name;
                pendingCalls.set(id, p);
                break;
            }
            case 'response.function_call_arguments.done': {
                const id = msg.call_id || msg.item_id;
                const p = pendingCalls.get(id) || {};
                const name = msg.name || p.name;
                const args = msg.arguments ?? p.arguments ?? '{}';
                pendingCalls.delete(id);
                if (name) runFunctionCall(id, name, args);
                break;
            }
            case 'response.output_item.done': {
                const item = msg.item || {};
                if (item.type === 'function_call' && item.name) runFunctionCall(item.call_id || item.id, item.name, item.arguments || '{}');
                break;
            }
            case 'response.done':
                if (assistantText) onTranscript?.({ role: 'assistant', text: assistantText, final: true });
                assistantText = '';
                onStatus?.('listening');
                break;
            case 'error':
                onError?.(new Error(msg.error?.message || msg.message || 'Realtime error'));
                break;
            default:
                break;
        }
    };
    ws.onerror = () => onError?.(new Error('Voice connection error'));
    ws.onclose = () => { onStatus?.('closed'); cleanup(); };

    function playPcm(b64) {
        if (!b64) return;
        const bytes = bytesFromB64(b64);
        const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
        const buffer = audioCtx.createBuffer(1, pcm.length, SAMPLE_RATE);
        const ch = buffer.getChannelData(0);
        for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 0x8000;
        const src = audioCtx.createBufferSource();
        src.buffer = buffer;
        src.connect(audioCtx.destination);
        const at = Math.max(audioCtx.currentTime + 0.02, playhead);
        src.start(at);
        playhead = at + buffer.duration;
    }

    function cleanup() {
        if (closed) return;
        closed = true;
        try { processor.disconnect(); source.disconnect(); } catch { }
        stream.getTracks().forEach((t) => t.stop());
        audioCtx.close().catch(() => { });
    }

    return {
        say(text) { send({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }); send({ type: 'response.create' }); },
        stop() { cleanup(); try { ws.close(); } catch { } }
    };
}

function downsample(samples, fromRate, toRate) {
    if (fromRate === toRate) return samples;
    const ratio = fromRate / toRate;
    const out = new Float32Array(Math.floor(samples.length / ratio));
    for (let i = 0; i < out.length; i++) {
        const start = Math.floor(i * ratio), end = Math.min(Math.floor((i + 1) * ratio), samples.length);
        let sum = 0;
        for (let j = start; j < end; j++) sum += samples[j];
        out[i] = end > start ? sum / (end - start) : samples[start] || 0;
    }
    return out;
}

function b64FromBytes(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}
function bytesFromB64(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}
