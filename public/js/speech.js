// Voice input: browser SpeechRecognition when available, otherwise MediaRecorder → worker transcription
// (OpenAI gpt-4o-transcribe / xAI speech-to-text). Voice output is handled by the worker's /api/speech.

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

let recognition = null;
let recorder = null;
let chunks = [];
let listening = false;

export function hasNativeRecognition() {
    return !!SpeechRecognition;
}

/**
 * Start capturing speech. `onInput(text, isFinal)` receives interim/final text.
 * If `transcribe` (async blob → {text}) is provided, MediaRecorder is used instead of the browser recognizer.
 */
export async function startSpeech(onInput, { transcribe = null, lang = 'en-US' } = {}) {
    if (listening) return;
    listening = true;
    if (!transcribe && SpeechRecognition) {
        recognition = new SpeechRecognition();
        recognition.lang = lang;
        recognition.interimResults = true;
        recognition.maxAlternatives = 1;
        recognition.continuous = false;
        recognition.onresult = (event) => {
            const last = event.results.length - 1;
            const text = Array.from(event.results).map((r) => r[0].transcript).join(' ');
            onInput(text, event.results[last].isFinal);
        };
        recognition.onend = () => { listening = false; };
        recognition.onerror = (e) => { listening = false; onInput('', true, e.error); };
        recognition.start();
        return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
        listening = false;
        throw new Error('Microphone access is not available in this browser');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : (MediaRecorder.isTypeSupported('audio/mp4') ? 'audio/mp4' : '');
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        listening = false;
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        chunks = [];
        if (!blob.size) { onInput('', true); return; }
        onInput('(transcribing…)', false);
        try {
            const result = await transcribe(blob);
            onInput(result?.text || '', true);
        } catch (e) {
            onInput('', true, e.message || String(e));
        }
    };
    recorder.start();
}

export function stopSpeech() {
    if (recognition) { try { recognition.stop(); } catch { } recognition = null; }
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    else listening = false;
}

export function isListening() {
    return listening;
}
