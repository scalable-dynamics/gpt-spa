export default (container, ...defaultGPTs) => {
    const gpts = JSON.parse(localStorage.getItem('gpts')) || defaultGPTs.reduce((obj, gpt) => {
        obj[gpt.name] = gpt;
        return obj;
    }, {});
    for (let gpt of defaultGPTs) {
        if (typeof (gpt.action) === 'function') {
            gpts[gpt.name] = gpt;
        }
    }
    const form = createForm(container);
    return {
        create(name, gpt) {
            if (name && gpt) {
                gpts[name] = gpt;
                return;
            }
            form.name.value = '';
            form.description.value = '';
            form.welcome.value = '';
            form.icon.value = '';
            form.instructions.value = '';
            form.voice.value = 'alloy';
            for (let tool of form.tools) {
                tool.checked = false;
            }
        },
        getName() {
            return form.name.value.trim();
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
            const tools = container.querySelectorAll('[name="tool-selection"]')
            gpts[newName] = {
                name: newName,
                description: form.description.value.trim(),
                welcome: form.welcome.value.trim(),
                icon: '',//TODO
                instructions: form.instructions.value.trim(),
                voice: form.voice.value,
                tools: Array.from(tools).filter((tool) => tool.checked).map((tool) => tool.value),
                files: form.selected_files || []
            };
            if (name && newName !== name) {
                console.log('deleting', name)
                delete gpts[name]
            }
            localStorage.setItem('gpts', JSON.stringify(gpts));
            return true;
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
            form.description.value = gpt.description || '';
            form.welcome.value = gpt.welcome;
            form.icon.value = '';
            form.instructions.value = gpt.instructions;
            form.voice.value = gpt.voice || 'alloy';
            form.icon.onchange = (e) => {
                const file = e.target.files[0];
                if (file) {
                    const reader = new FileReader();
                    reader.onloadend = function () {
                        form.selected_icon = reader.result;
                    }
                    reader.readAsDataURL(file);
                }
            }
            form.selected_icon = '';
            form.selected_files = gpt.files || [];
            form.file.onchange = (e) => {
                form.selected_files = [];
                for (let file of e.target.files) {
                    const reader = new FileReader();
                    reader.onloadend = function () {
                        form.selected_files.push({
                            name: file.name,
                            type: file.type,
                            content: reader.result
                        });
                        renderFiles();
                    }
                    reader.readAsText(file);
                }
                form.file.value = '';
            }
            function renderFiles() {
                if (form.selected_files) {
                    form.files.innerHTML = form.selected_files.map(({ name }) => `<label>
    <input type="checkbox" name="file-selection" value="${name}" checked />
    ${name}
</label>`).join('\n')
                    const files = container.querySelectorAll('[name="file-selection"]')
                    for (let file of files) {
                        file.onchange = (e) => {
                            const name = e.target.value;
                            form.selected_files = form.selected_files.filter((file) => file.name !== name)
                            renderFiles();
                        }
                    }
                }
            }
            renderFiles();
            form.tools.innerHTML = Object.keys(gpts).filter((tool) => gpts[tool].description).map((tool) => `<label>
    <input type="checkbox" name="tool-selection" value="${tool}" />
    Use ${tool}
</label>`).join("\n")
            const tools = container.querySelectorAll('[name="tool-selection"]')
            for (let tool of tools) {
                if (tool.value === gpt.name) {
                    tool.parentNode.style.display = 'none';
                } else {
                    tool.parentNode.style.display = 'block';
                    if (gpt.tools) {
                        tool.checked = gpt.tools.includes(tool.value);
                    }
                }
            }
            return gpt;
        },
        list() {
            return Object.keys(gpts).map((name) => gpts[name]);
        },
        renderList(ul, onSelect) {
            ul.innerHTML = ''
            for (let { name, action } of this.list()) {
                if (typeof action === 'function') continue;
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
    <label for="description">Tool Description</label>
    <input type="text" id="description" name="description" />
    <label for="welcome">Welcome Message</label>
    <input type="text" id="welcome" name="welcome" />
    <label for="icon" style="display: none;">Icon</label>
    <input type="file" style="display: none;" id="icon" name="icon" />
    <label for="instructions">Instructions</label>
    <textarea id="instructions" name="instructions" rows="15"></textarea>
    <label for="voice-list">Voice</label>
    <select id="voice-list">
        <option value="alloy" selected>Alloy</option>
        <option value="echo">Echo</option>
        <option value="fable">Fable</option>
        <option value="onyx">Onyx</option>
        <option value="nova">Nova</option>
        <option value="shimmer">Shimmer</option>
    </select>
    <label>Tools</label>
    <div id="gpt-tools"></div>
    <label>Files</label>
    <div id="gpt-files"></div>
    <input type="file" id="gpt-file" name="gpt-file" multiple />
    `;
    return {
        name: container.querySelector('#name'),
        description: container.querySelector('#description'),
        welcome: container.querySelector('#welcome'),
        icon: container.querySelector('#icon'),
        instructions: container.querySelector('#instructions'),
        voice: container.querySelector('#voice-list'),
        tools: container.querySelector('#gpt-tools'),
        file: container.querySelector('#gpt-file'),
        files: container.querySelector('#gpt-files')
    }
}