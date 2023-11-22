import * as pdfjsLib from 'https://mozilla.github.io/pdf.js/build/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://mozilla.github.io/pdf.js/build/pdf.worker.mjs';

export function onFilesDropped(element, onFilesAdded) {
    element.addEventListener('dragover', prevent_defaults, false);
    element.addEventListener('dragenter', prevent_defaults, false);
    element.addEventListener('drop', async (e) => {
        prevent_defaults(e);
        addFiles(e.dataTransfer.files);
    }, false);
    return async function addFiles(files) {
        const contents = [];
        for (let i = 0; i < files.length; i++) {
            const name = files[i].name;
            const type = files[i].type;
            try {
                if (type === 'application/pdf') {
                    contents.push({
                        name,
                        type,
                        content: await read_pdf(files[i])
                    });
                } else if (type.indexOf('image') === 0) {
                    contents.push({
                        name,
                        type,
                        content: await read_image(files[i])
                    })
                } else {
                    contents.push({
                        name,
                        type,
                        content: await read_file(files[i])
                    });
                }
            } catch (e) {
                console.error('FileReader error: ', e);
                alert(`Error reading file ${name}`)
            }
        }
        onFilesAdded(contents);
    }
}

function read_file(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => {
            resolve(event.target.result);
        };
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

function read_image(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = function () {
            resolve(reader.result);
        }
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

function read_pdf(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (event) => {
            try {
                const pdfData = new Uint8Array(reader.result);
                const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;
                let content = "";
                for (let i = 1; i <= pdfDoc.numPages; i++) {
                    const page = await pdfDoc.getPage(i);
                    const textContent = await page.getTextContent();
                    content += textContent.items.map(item => item.str).join(" ");
                }
                resolve(content);
            } catch (error) {
                reject(error);
            }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(file);
    });
}

function prevent_defaults(e) {
    e.preventDefault();
    e.stopPropagation();
}