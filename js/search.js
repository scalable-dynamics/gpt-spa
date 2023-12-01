export default (getConfig) => async function search(prompt) {
    const BING_SEARCH_KEY = await getConfig('BING_SEARCH_KEY')
    const response = await fetch(`https://api.bing.microsoft.com/v7.0/search?count=3&responseFilter=Webpages&q=${encodeURIComponent(prompt)}`, {
        headers: {
            'Ocp-Apim-Subscription-Key': BING_SEARCH_KEY,
            'Content-Type': 'application/json'
        },
        method: 'GET'
    })
    const data = await response.json()
    return data.webPages.value.map(result => `### [${result.name}](${result.url})
> ${result.snippet}
`).join('\n')
}
