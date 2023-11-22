export default function (apiKey, apiOrg) {
    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Organization': apiOrg
    }
    return {
        getCompletion: get_completion.bind(null, headers),
        getImage: get_image.bind(null, headers),
        playSpeech: play_speech.bind(null, headers),
        getTranscription: get_transcription.bind(null, headers),
        getEmbeddings: get_vectors.bind(null, headers)
    }
}

async function get_completion(headers, messages, onTextReceived = undefined, useVision = false, max_tokens = 150) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
        headers: {
            ...headers,
            'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
            //TODO: not working with successive requests (since image content gets added to the messages), but acording to sama its the 'same'
            //model: useVision ? 'gpt-4-vision-preview' : 'gpt-4-1106-preview',
            model: 'gpt-4-vision-preview',
            messages,
            max_tokens,
            temperature: 0.1,
            top_p: 1,
            stream: (onTextReceived !== undefined)
        })
    })
    if (onTextReceived) {
        if (!response.ok) throw new Error(await response.text());
        if (!response.body[Symbol.asyncIterator]) {
            response.body[Symbol.asyncIterator] = () => {
                const reader = response.body.getReader();
                return {
                    next: () => reader.read(),
                };
            };
        }
        let all_text = ""
        const decoder = new TextDecoder()
        for await (const chunk_arr of response.body) {
            const chunk = decoder.decode(chunk_arr, { stream: true })
            const lines = chunk.toString().trim().split("\n")
            for (let line of lines) {
                const data = line.indexOf('{')
                if (data > -1) {
                    const json = line.slice(data);
                    if (json) {
                        try {
                            const data = JSON.parse(json);
                            if (data.choices && data.choices.length > 0) {
                                if (data.choices[0].finish_reason === "length" && max_tokens < 1000) {
                                    onTextReceived("", true)
                                    return await get_completion(headers, onTextReceived, useVision, max_tokens * 2)
                                }
                                const text = data.choices[0].delta.content;
                                if (!text) continue;
                                all_text += text;
                                onTextReceived(text);
                            }
                        } catch (e) {
                            console.error(e)
                            //TODO: handle this better
                        }
                    }
                }
            }
        }
        return all_text
    } else {
        const data = await response.json()
        if (data && data.choices && data.choices[0] && data.choices[0].finish_reason === "length" && max_tokens < 1000) {
            return await get_completion(headers, onTextReceived, useVision, max_tokens * 2)
        }
        else if (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
            return data.choices[0].message.content.trim()
        } else {
            return ""
        }
    }
}

async function get_image(headers, prompt) {
    const response = await fetch("https://api.openai.com/v1/images/generations", {
        headers: {
            ...headers,
            'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
            prompt,
            model: 'dall-e-3',
            size: '1024x1024',
            n: 1
        })
    })
    const image = await response.json()
    if (image && image.data && image.data[0] && image.data[0].url) {
        return image.data[0].url
    }
}

async function play_speech(headers, input, voice = 'alloy') {
    const response = await fetch("https://api.openai.com/v1/audio/speech", {
        headers: {
            ...headers,
            'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
            input,
            voice,
            model: 'tts-1'
        })
    })
    const audioData = [];
    const reader = response.body.getReader();
    const audioObj = new Audio();

    reader.read().then(function processAudio({ done, value }) {
        if (done) {
            audioObj.src = URL.createObjectURL(new Blob(audioData));
            audioObj.play();
            document.body.onclick = () => {
                audioObj.pause();
                document.body.onclick = undefined;
            }
            return;
        }
        audioData.push(value);
        return reader.read().then(processAudio);
    });
}

async function get_transcription(headers, audioBlob) {
    const formData = new FormData();
    formData.append('file', audioBlob, 'recording.webm');
    formData.append('model', 'whisper-1');
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        headers,
        method: 'POST',
        body: formData
    })
    const data = await response.json()
    return data.text
}

async function get_vectors(headers, input) {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
        headers: {
            ...headers,
            'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
            input,
            model: 'text-embedding-ada-002'
        })
    })
    const embeddings = await response.json()
    if (embeddings && embeddings.data) {
        return input.map((input, i) => ({
            embedding: embeddings.data[i].embedding,
            text: input
        }))
    } else {
        return []
    }
}