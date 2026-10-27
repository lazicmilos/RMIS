import { encodePath } from './github.js';

const PDFJS_DIR = new URL('./vendor/pdfjs/', import.meta.url);
const OFFICE_VIEWER = 'https://view.officeapps.live.com/op/embed.aspx?src=';
// Microsoft's viewer refuses larger files.
const OFFICE_LIMITS_MB = { doc: 10, docx: 10, ppt: 10, pptx: 10, xls: 5, xlsx: 5 };
const NOT_PUBLISHED = 'Fajl još nije objavljen na sajtu. Ako je upravo otpremljen, sačekaj minut i pokušaj ponovo.';

const dialog = document.getElementById('preview-dialog');
const titleEl = document.getElementById('preview-title');
const body = document.getElementById('preview-body');
const openLink = document.getElementById('preview-open');
const downloadLink = document.getElementById('preview-download');

const extension = (name) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();

export const canPreview = (name) => {
  const ext = extension(name);
  return ext === 'pdf' || ext === 'txt' || ext in OFFICE_LIMITS_MB;
};

let pdfjsPromise = null;
function loadPdfJs() {
  pdfjsPromise ??= import(new URL('pdf.min.js', PDFJS_DIR).href).then(
    (pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.js', PDFJS_DIR).href;
      return pdfjs;
    },
    (err) => {
      pdfjsPromise = null;
      throw err;
    },
  );
  return pdfjsPromise;
}

// Each open bumps the session so stale async renders stop touching the DOM.
let session = 0;
let currentDoc = null;

function message(text, kind = '') {
  const p = document.createElement('p');
  p.className = `preview-message ${kind}`;
  p.textContent = text;
  return p;
}

async function renderPdf(href, isCurrent) {
  const pdfjs = await loadPdfJs();
  let doc;
  try {
    doc = await pdfjs.getDocument({
      url: href,
      isEvalSupported: false, // Keeps the CSP free of 'unsafe-eval'.
      standardFontDataUrl: new URL('standard_fonts/', PDFJS_DIR).href,
    }).promise;
  } catch (err) {
    throw new Error(err?.name === 'MissingPDFException' || err?.status === 404 ? NOT_PUBLISHED : 'PDF nije moguće otvoriti.');
  }
  if (!isCurrent()) return doc.destroy();
  currentDoc = doc;

  const pages = document.createElement('div');
  pages.className = 'pdf-pages';
  body.replaceChildren(pages);
  const { paddingLeft, paddingRight } = getComputedStyle(pages);
  const availableWidth = pages.clientWidth - parseFloat(paddingLeft) - parseFloat(paddingRight);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);

  for (let n = 1; n <= doc.numPages && isCurrent(); n++) {
    const page = await doc.getPage(n);
    const cssScale = Math.min(availableWidth / page.getViewport({ scale: 1 }).width, 2);
    const viewport = page.getViewport({ scale: cssScale * pixelRatio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = `${Math.floor(viewport.width / pixelRatio)}px`;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `Strana ${n} od ${doc.numPages}`);
    pages.append(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  }
}

async function renderText(href, isCurrent) {
  const res = await fetch(href, { cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 404 ? NOT_PUBLISHED : 'Fajl nije moguće učitati.');
  const text = await res.text();
  if (!isCurrent()) return;
  const pre = document.createElement('pre');
  pre.className = 'text-preview';
  pre.textContent = text;
  body.replaceChildren(pre);
}

function renderOffice(href, isCurrent, file) {
  const ext = extension(file.name);
  if (location.protocol !== 'https:') {
    throw new Error('Pregled Office fajlova radi samo na objavljenom (javnom) sajtu.');
  }
  if (file.size > OFFICE_LIMITS_MB[ext] * 1024 ** 2) {
    throw new Error(`Pregled ${ext.toUpperCase()} fajlova je moguć do ${OFFICE_LIMITS_MB[ext]} MB. Preuzmi fajl.`);
  }
  if (!isCurrent()) return;
  const frame = document.createElement('iframe');
  frame.className = 'office-frame';
  frame.title = `Pregled: ${file.name}`;
  frame.src = OFFICE_VIEWER + encodeURIComponent(new URL(href, location.href).href);
  body.replaceChildren(frame);
}

/** @param {{name: string, path: string, size: number}} file */
export function openPreview(file, title) {
  const id = ++session;
  const isCurrent = () => id === session && dialog.open;
  const href = encodePath(file.path);
  const ext = extension(file.name);

  titleEl.textContent = title;
  openLink.href = href;
  downloadLink.href = href;
  downloadLink.download = file.name;
  body.replaceChildren(message('Učitavanje pregleda…'));
  dialog.showModal();

  const render = ext === 'pdf' ? renderPdf : ext === 'txt' ? renderText : renderOffice;
  Promise.resolve()
    .then(() => render(href, isCurrent, file))
    .catch((err) => {
      if (isCurrent()) body.replaceChildren(message(err.message, 'error'));
    });
}

dialog.addEventListener('close', () => {
  session++;
  currentDoc?.destroy();
  currentDoc = null;
  body.replaceChildren(); // Stops iframes and frees canvases.
});

// Click on the backdrop closes the preview.
dialog.addEventListener('click', (e) => {
  if (e.target === dialog) dialog.close();
});

document.getElementById('preview-close').addEventListener('click', () => dialog.close());
