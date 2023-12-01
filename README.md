# gpt-spa (created by Greg DeCarlo - @mrinreality1 on X)
Customizable GPTs stored on your local browser, using OpenAI models text-embedding-ada-002, tts-1, whisper-1, dall-e-3, and gpt-4-vision-preview. Enhanced with Azure OpenAI support!

### Create Custom GPTs!
![Screenshot of the gpt-spa application](https://github.com/scalable-dynamics/gpt-spa/assets/47045161/4d459004-353a-44bf-96b5-541bf0eaed16)

### Key Features
- Configure GPTs by specifying system prompts and selecting from files, tools, and other GPT models.
- Utilize local vector database for document retrieval (RAG) without relying on the OpenAI Assistants API.
- Upload image files for analysis using the GPT-4 Vision model. Activate 'Image Generation (DALL-E)' in the Configure tab to generate images based on conversation context.
- Activate 'Text-to-Speech (TTS)' to hear outputs using OpenAI's Text-to-Speech model.
- Share your GPT configurations and conversations easily with a URL, ensuring privacy as data is stored only in browser local storage or the URL hash (no server-side data storage).

### Built-in Tools
- Image Generation (DALL-E)
- Text-to-Speech (TTS)
- Bing Search (requires API Key)
- Daily Quotation Generator (powered by GPT)

### Usage Instructions
1. Enter your OPENAI_API_KEY (stored locally)
2. Optionally enter your OPENAI_API_ORG
3. Use the sidebar to select or create custom GPTs
4. Engage with your GPT using the provided controls. Restart or switch GPTs to initiate new conversations

### Advanced Features
1. Dynamic conversations with custom GPTs; shareable links for both conversations and GPT configurations
2. Upload or drag-and-drop PDFs or text files for enhanced retrieval-based searching
3. Upload images and engage with your GPT about their content (local usage only, data is not retained after browser refresh)
4. Request DALL-E to create images based on conversation history, including uploaded images
5. Use TTS with a choice of voices for an auditory experience
6. Switch between multiple GPTs or blend their capabilities
7. Intuitive GPT builder interface
8. **[New]** Direct voice inputs to your GPT via a microphone button
9. **[New]** Enhance context through file saving, leveraging vector search for text-based files
10. **[New]** Integrate Bing search results into retrieval processes (RAG)
11. **[New]** Seamlessly transition between models or modalities using tools and GPT combinations (configurable in the Configure tab)

### Upcoming Enhancements
12. Integration of Whisper Speech-to-Text for conversational inputs
13. Enabling GPTs to pose multiple-choice questions and suggest answers
14. Integration with Microsoft Graph API for email management, appointment scheduling, and contact searches
15. Memory storage and reminder setting functionalities
16. Tools for creating charts, diagrams, and tabular data
17. Support for connecting to external data sources compatible with CORS

### About this repository
- Contributions welcome!
- MIT License
- Author: [Greg DeCarlo](https://linktr.ee/mrinreality)
- README was modified by ChatGPT
