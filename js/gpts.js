export default (container, ...defaultGPTs) => {
    const gpts = JSON.parse(localStorage.getItem('gpts')) || defaultGPTs.reduce((obj, gpt) => {
        obj[gpt.name] = gpt;
        return obj;
    }, {});
    const form = createForm(container);
    return {
        create() {
            form.name.value = '';
            form.welcome.value = '';
            form.icon.value = '';
            form.instructions.value = '';
            form.useFiles.checked = false;
            form.useDalle.checked = false;
            form.useSpeech.checked = false;
            form.voice.value = 'alloy';
        },
        save(name) {
            const newName = form.name.value.trim();
            if (!newName) {
                alert('Please enter a name')
                return
            }
            if (!form.welcome.value.trim()) {
                alert('Please enter the welcome message')
                return
            }
            if (!form.instructions.value.trim()) {
                alert('Please enter the instructions')
                return
            }
            gpts[newName] = {
                name: newName,
                welcome: form.welcome.value.trim(),
                icon: '',//TODO
                instructions: form.instructions.value.trim(),
                useFiles: form.useFiles.checked,
                useDalle: form.useDalle.checked,
                useSpeech: form.useSpeech.checked,
                voice: form.voice.value
            };
            if (name && newName !== name) {
                delete gpts[name]
            }
            localStorage.setItem('gpts', JSON.stringify(gpts));
        },
        remove(name) {
            if (confirm('Are you sure you want to delete this GPT?')) {
                delete gpts[name]
                localStorage.setItem('gpts', JSON.stringify(gpts));
                return true
            }
        },
        load(name) {
            const gpt = gpts[name];
            if (!gpt) {
                return;
            }
            form.name.value = gpt.name;
            form.welcome.value = gpt.welcome;
            form.icon.value = '';
            form.instructions.value = gpt.instructions;
            form.useFiles.checked = gpt.useFiles;
            form.useDalle.checked = gpt.useDalle;
            form.useSpeech.checked = gpt.useSpeech;
            form.voice.value = gpt.voice;
            return gpt;
        },
        list() {
            return Object.keys(gpts).map((name) => gpts[name]);
        },
        renderList(ul, onSelect) {
            ul.innerHTML = ''
            for (let { name } of this.list()) {
                const li = document.createElement('li')
                const a = document.createElement('a')
                a.innerText = name
                a.href = 'javascript:void(0)'
                li.appendChild(a)
                ul.appendChild(li)
                a.addEventListener('click', (e) => {
                    e.preventDefault()
                    onSelect(name)
                })
            }
        }
    }
}

function createForm(container) {
    container.innerHTML = `
    <label for="name">Name</label>
    <input type="text" id="name" name="name" />
    <label for="welcome">Welcome Message</label>
    <input type="text" id="welcome" name="welcome" />
    <label for="icon" style="display: none;">Icon</label>
    <input type="file" style="display: none;" id="icon" name="icon" placeholder="Image" />
    <label for="instructions">Instructions</label>
    <textarea id="instructions" name="instructions" rows="20"></textarea>
    <label>
        <input type="checkbox" id="use-files" name="use-files" />
        Use files (will search user-uploaded files)
    </label>
    <label>
        <input type="checkbox" id="use-dalle" name="use-dalle" />
        Use DALL-E (will return only images)
    </label>
    <label>
        <input type="checkbox" id="use-speech" name="use-speech" />
        Use speech (will speak every response)
    </label>
    <label for="voice-list">Voice</label>
    <select id="voice-list">
        <option value="alloy" selected>Alloy</option>
        <option value="echo">Echo</option>
        <option value="fable">Fable</option>
        <option value="onyx">Onyx</option>
        <option value="nova">Nova</option>
        <option value="shimmer">Shimmer</option>
    </select>
    `;
    return {
        name: container.querySelector('#name'),
        welcome: container.querySelector('#welcome'),
        icon: container.querySelector('#icon'),
        instructions: container.querySelector('#instructions'),
        useFiles: container.querySelector('#use-files'),
        useDalle: container.querySelector('#use-dalle'),
        useSpeech: container.querySelector('#use-speech'),
        voice: container.querySelector('#voice-list'),
        deleteButton: container.querySelector('#delete-button'),
        saveButton: container.querySelector('#save-button'),
        cancelButton: container.querySelector('#cancel-button')
    }
}