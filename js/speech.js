const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recognition = new SpeechRecognition();
recognition.lang = 'en-US';
recognition.interimResults = false;
recognition.maxAlternatives = 1;
recognition.continuous = false;
let listening = false;

export function startSpeech(onInput) {
    recognition.onresult = function (event) {
        const last = event.results.length - 1;
        const text = event.results[last][0].transcript;
        const isFinal = event.results[last].isFinal;
        onInput(text, isFinal);
        listening = false;
    }
    recognition.start();
    listening = true;
}

export function stopSpeech() {
    if (!listening) return;
    recognition.stop();
    listening = false;
}
