# gpt-spa (created by Greg DeCarlo - @mrinreality1 on X)
A customizable GPT in a single page, using OpenAI models text-embedding-ada-002, tts-1, whisper-1, dall-e-3, and gpt-4-vision-preview.

- This example does not use the OpenAI Assistants API, but it does allow you to add files to a local vector db and perform retrieval (RAG) before interacting with the GPT
- Image files can also be uploaded, which will be sent to the GPT 4 Vision model for analysis. Selecting 'Use DALL-E' allows the user to generate an image based on the current conversation (including document retrieval and images)
- Selecting 'Use Speech' will speak the output using the new OpenAI Text-to-Speech model

### Usage
* Enter the OPENAI_API_KEY (this will be saved in localStorage!)
* Enter your OPENAI_API_ORG (if applicable)
* Define your GPT (enter system prompt, cannot be blank)
* Chat with your GPT using the provided controls (must complete steps above)

### Features
1. Have a conversation with your GPT
2. Drag/Drop PDF or text-based files for retrieval-based search
3. Drag/Drop image files and ask your GPT about it
4. Use DALL-E and ask your GPT to generate an image (prompt will be generated using the context)
5. Use Speech and select a voice to hear your GPT outloud

### Upcoming Features
6. Talk to your GPT using Whisper Speech-to-Text transcription
7. Search Bing and include the results in the retrieval (RAG)
8. Have your GPT ask multiple-choice questions and suggest responses
9. Use Microsoft Graph API to send emails, schedule appointments and find people
10. Store memories and set reminders
11. Create charts, diagrams and tabular data using your GPT
12. Connect to external data sources which allow cross-origin resources (CORS)
13. Add multiple GPTs and choose between them
14. GPT builder interface for creating a GPT
15. Calling functions to switch between models or change modality
