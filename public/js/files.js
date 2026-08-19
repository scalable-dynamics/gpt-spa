// File ingestion: drag & drop / upload → {name, type, content}. PDFs are extracted with pdf.js,
// images become data URLs, everything else is read as text.
import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs';

export function onFilesDropped(element, onFilesAdded) {
    element.addEventListener('dragover', preventDefaults, false);
    element.addEventListener('dragenter', preventDefaults, false);
    element.addEventListener('drop', async (e) => {
        preventDefaults(e);
        addFiles(e.dataTransfer.files);
    }, false);
    return async function addFiles(files) {
        const contents = [];
        for (const file of Array.from(files || [])) {
            try {
                contents.push(await readAnyFile(file));
            } catch (e) {
                console.error('File read error', e);
                alert(`Error reading file ${file.name}: ${e.message || e}`);
            }
        }
        if (contents.length) await onFilesAdded(contents);
    };
}

export async function readAnyFile(file) {
    const name = file.name;
    const type = file.type || guessType(name);
    if (type === 'application/pdf' || /\.pdf$/i.test(name)) {
        return { name, type: 'application/pdf', content: await readPdf(file), kind: 'document' };
    }
    if (type.startsWith('image/')) {
        return { name, type, content: await readDataUrl(file), kind: 'image' };
    }
    if (type.startsWith('audio/')) {
        return { name, type, content: await readDataUrl(file), kind: 'audio', blob: file };
    }
    return { name, type: type || 'text/plain', content: await readText(file), kind: 'document' };
}

function guessType(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    return ({ md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', json: 'application/json', html: 'text/html', js: 'text/javascript', py: 'text/x-python', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', webm: 'audio/webm' })[ext] || '';
}

function readText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (event) => resolve(event.target.result);
        reader.onerror = reject;
        reader.readAsText(file);
    });
}

function readDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function readPdf(file) {
    const data = new Uint8Array(await file.arrayBuffer());
    const pdfDoc = await pdfjsLib.getDocument({ data }).promise;
    const pages = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();
        let last = null;
        let text = '';
        for (const item of textContent.items) {
            if (last && item.transform && last.transform && Math.abs(item.transform[5] - last.transform[5]) > 2) text += '\n';
            else if (text && !text.endsWith(' ') && !text.endsWith('\n')) text += ' ';
            text += item.str;
            last = item;
        }
        pages.push(`[Page ${i}]\n${text.trim()}`);
    }
    return pages.join('\n\n');
}

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}
