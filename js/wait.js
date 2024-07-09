import { transcribeAudioFile, textToSpeech as tts, summarize, ocr } from '../node_modules/web-ai-toolkit/dist/web-ai-toolkit.js';

// Transcribe Audio File
export async function transcribeAudio(audioFile) {
    const transcription = await transcribeAudioFile(audioFile, "base", true, "en-US");
    console.log(transcription);
    return transcription;
}

// Text to Speech
export async function textToSpeech(text) {
    const audio = await tts(text);
    console.log(audio);
    return audio;
}

// Summarize Text
export async function summarizeText(text) {
    const summary = await summarize(text);
    console.log(summary);
    return summary;
}

//Optical Character Recognition (OCR)
export async function ocrImage(image) {
    const image_text = await ocr(image);
    console.log(text);
    return image_text;
}

let listening = false;
let audioContext = null;

export async function startSpeech(onInput) {
    if (!listening) {
        audioContext = new AudioContext();
        const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const audioSource = audioContext.createMediaStreamSource(mediaStream);
        const audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);

        audioProcessor.onaudioprocess = (event) => {
            const audioData = event.inputBuffer.getChannelData(0);
            transcribeAudio(audioData).then((text) => {
                onInput(text, true);
            });
        };

        audioSource.connect(audioProcessor);
        audioProcessor.connect(audioContext.destination);
        listening = true;
    }
}

export function stopSpeech() {
    if (listening) {
        audioContext?.close();
        listening = false;
    }
}
