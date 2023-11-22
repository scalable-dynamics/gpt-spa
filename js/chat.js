export function createConversation(systemPrompt, getCompletion, getImage, vectorSearch) {
    const messages = [{ role: "system", content: systemPrompt }];
    return async (content, onTextReceived = undefined, useVectorSearch = false, generateImage = false) => {
        const useVision = Array.isArray(content)
        if (useVectorSearch) {
            const results = await vectorSearch(useVision ? content[0].text : content);
            if (results.length > 0) {
                const retrieval = results[0].text;
                messages.push({ content: `More details: ${retrieval}`, role: 'user' });
            }
        }
        messages.push({ content, role: 'user' });
        if (generateImage) {
            messages.push({ content: 'Create a prompt for DALL-E to generate an image. Only return the prompt, NO OTHER TEXT.', role: 'user' });
        }
        const response = await getCompletion(messages, onTextReceived, useVision);
        messages.push({ content: response, role: 'assistant' });
        if (generateImage) {
            return await getImage(response);
        } else {
            return response;
        }
    }
}