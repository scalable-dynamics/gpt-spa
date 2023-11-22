export function contentCard(content) {
    const card = {
        type: 'AdaptiveCard',
        version: '1.5',
        body: [{
            type: 'TextBlock',
            text: content,
            wrap: true
        }]
    }
    const adaptiveCard = new AdaptiveCards.AdaptiveCard();
    adaptiveCard.parse(card);
    return adaptiveCard.render();
}

export function confirmationCard(message) {
    const card = {
        type: 'AdaptiveCard',
        version: '1.5',
        body: [{
            type: 'TextBlock',
            text: message,
            wrap: true
        }],
        actions: [{
            type: 'Action.Submit',
            title: 'Yes',
            data: 'yes'
        }, {
            type: 'Action.Submit',
            title: 'No',
            data: 'no'
        }]
    }
    const adaptiveCard = new AdaptiveCards.AdaptiveCard();
    adaptiveCard.parse(card);
    const renderedCard = adaptiveCard.render();
    return {
        render: () => renderedCard,
        getAnswer: () => new Promise((resolve) => {
            adaptiveCard.onExecuteAction = (action) => {
                renderedCard.parentNode.removeChild(renderedCard)
                resolve(action.data === 'yes')
            }
        })
    }
}

export function questionCard(question, answers = [], defaultValue = "") {
    const card = {
        type: 'AdaptiveCard',
        version: '1.5',
        body: [{
            type: 'TextBlock',
            text: question,
            wrap: true
        }],
        actions: answers.filter(answer => answer && answer.trim()).map(answer => ({
            type: 'Action.Submit',
            title: answer,
            data: answer
        }))
    }
    if (card.actions.length == 0) {
        card.body = [{
            type: "Input.Text",
            id: "answer",
            label: question,
            value: defaultValue,
            isMultiline: question.indexOf('prompt') > -1
        }];
        card.actions.push({
            type: 'Action.Submit',
            title: 'Save'
        });
    }
    const adaptiveCard = new AdaptiveCards.AdaptiveCard();
    adaptiveCard.parse(card);
    const renderedCard = adaptiveCard.render();
    return {
        render: () => renderedCard,
        getAnswer: () => new Promise((resolve) => {
            adaptiveCard.onExecuteAction = (action) => {
                renderedCard.parentNode.removeChild(renderedCard)
                if (action.data === '_cancel_' || (typeof action.data === 'object' && !action.data.answer)) {
                    resolve()
                } else if (typeof action.data === 'object') {
                    resolve(action.data.answer)
                } else {
                    resolve(action.data)
                }
            }
        })
    }
}

export async function configCard(outputContainer, option, text = `Enter the value for ${option}:`, defaultValue = undefined) {
    const value = getQueryString(option) || localStorage.getItem(option)
    if (value) return value
    const question = questionCard(text, undefined, defaultValue)
    outputContainer.appendChild(question.render())
    const answer = await question.getAnswer()
    if (answer) {
        localStorage.setItem(option, answer)
        return answer
    }
}

export function useCardMarkdownRenderer(render) {
    AdaptiveCards.AdaptiveCard.onProcessMarkdown = function (text, result) {
        result.outputHtml = render(text);
        result.didProcess = true;
    };
}

function getQueryString(key) {
    var urlParams = new URLSearchParams(window.location.search)
    return urlParams.get(key)
}