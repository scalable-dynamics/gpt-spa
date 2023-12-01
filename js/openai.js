export async function initOpenAI(getConfig) {
    const apiUrl = 'https://api.openai.com/v1'
    const apiKey = await getConfig('OPENAI_API_KEY')
    const apiOrg = await getConfig('OPENAI_API_ORG')
    if (!apiKey || !apiOrg) {
        const msg = 'Missing OpenAI config'
        alert(msg)
        throw new Error(msg)
    }
    const headers = {
        'Authorization': `Bearer ${apiKey}`,
        'OpenAI-Organization': apiOrg
    }
    return {
        getCompletion: get_completion.bind(null, `${apiUrl}/chat/completions`, headers),
        getVision: get_vision.bind(null, apiUrl, headers),
        getImage: get_image.bind(null, apiUrl, headers),
        playSpeech: play_speech.bind(null, apiUrl, headers),
        getTranscription: get_transcription.bind(null, apiUrl, headers),
        getEmbeddings: get_vectors.bind(null, apiUrl, headers)
    }
}

export async function initAzureOpenAI(getConfig) {
    const apiUrl = await getConfig('AZURE_OPENAI_API_URL')
    const apiKey = await getConfig('AZURE_OPENAI_API_KEY')
    const model = await getConfig('AZURE_OPENAI_GPT_MODEL_DEPLOYMENT')
    if(!apiUrl || !apiKey || !model){
        const msg = 'Missing Azure OpenAI config'
        alert(msg)
        throw new Error(msg)
    }
    const headers = {
        'api-key': apiKey
    }
    return {
        ...(await initOpenAI(getConfig)),
        getCompletion: get_completion.bind(null, `${apiUrl}/openai/deployments/${model}/chat/completions?api-version=2023-07-01-preview`, headers)
    }
}

async function get_completion(apiUrl, headers, messages, onTextReceived = undefined, max_tokens = 150, retryCount = 0) {
    const response = await fetch(apiUrl, {
        headers: {
            ...headers,
            'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
            model: 'gpt-4-1106-preview',
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
                                if (data.choices[0].finish_reason === "length" && retryCount++ < 3 && max_tokens < 1000) {
                                    onTextReceived("", true)
                                    return await get_completion(apiUrl, headers, messages, onTextReceived, max_tokens * 2, retryCount)
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
        if (data && data.choices && data.choices[0] && data.choices[0].finish_reason === "length" && retryCount++ < 3 && max_tokens < 1000) {
            return await get_completion(apiUrl, headers, messages, onTextReceived, max_tokens * 2, retryCount)
        }
        else if (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
            return data.choices[0].message.content.trim()
        } else {
            return ""
        }
    }
}

async function get_vision(baseUrl, headers, image_url, max_tokens = 150) {
    const response = await fetch(`${baseUrl}/chat/completions`, {
        headers: {
            ...headers,
            'Content-Type': 'application/json'
        },
        method: 'POST',
        body: JSON.stringify({
            model: 'gpt-4-vision-preview',
            messages: [
                {
                    role: 'user',
                    content: [
                        {
                            type: 'text',
                            text: 'Describe the image using great detail, using one or two sentences.'
                        },
                        {
                            type: 'image',
                            image_url
                        }
                    ]
                }
            ],
            max_tokens,
            temperature: 0.1,
            top_p: 1
        })
    })
    const data = await response.json()
    if (data && data.choices && data.choices[0] && data.choices[0].finish_details && data.choices[0].finish_details.type === "max_tokens" && max_tokens < 500) {
        return await get_vision(baseUrl, headers, images, max_tokens * 2)
    }
    else if (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) {
        return data.choices[0].message.content.trim()
    } else {
        return ""
    }
}

async function get_image(baseUrl, headers, prompt) {
    const response = await fetch(`${baseUrl}/images/generations`, {
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
        return {
            url: image.data[0].url,
            alt: image.data[0].revised_prompt
        }
    }
}

async function play_speech(baseUrl, headers, input, voice = 'alloy') {
    const response = await fetch(`${baseUrl}/audio/speech`, {
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
    return reader.read().then(function processAudio({ done, value }) {
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

async function get_transcription(baseUrl, headers, audioBlob) {
    const formData = new FormData();
    formData.append('file', audioBlob, 'recording.webm');
    formData.append('model', 'whisper-1');
    const response = await fetch(`${baseUrl}/audio/transcriptions`, {
        headers,
        method: 'POST',
        body: formData
    })
    const data = await response.json()
    return data.text
}

async function get_vectors(baseUrl, headers, input) {
    const response = await fetch(`${baseUrl}/embeddings`, {
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