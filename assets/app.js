import { CONFIG } from './config.js';
import { GitHubClient, encodePath } from './github.js';

const TOKEN_KEY = 'rmis.token';
const STORAGE_KINDS = ['sessionStorage', 'localStorage'];

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const adminButton = document.getElementById('admin-button');
const dialog = document.getElementById('login-dialog');
const loginForm = document.getElementById('login-form');
const loginError = document.getElementById('login-error');

const github = new GitHubClient(CONFIG, loadToken());

const state = {
  files: null, // Map<sectionId, FileEntry[]>
  loadError: null,
  isAdmin: false,
};

// ---------- Token storage (may be blocked in private windows) ----------

function storage(kind) {
  try {
    return window[kind];
  } catch {
    return null;
  }
}

function loadToken() {
  for (const kind of STORAGE_KINDS) {
    try {
      const token = storage(kind)?.getItem(TOKEN_KEY);
      if (token) return token;
    } catch {
      // Storage unavailable; fall through.
    }
  }
  return null;
}

function saveToken(token, remember) {
  clearToken();
  try {
    storage(remember ? 'localStorage' : 'sessionStorage')?.setItem(TOKEN_KEY, token);
  } catch {
    // Token then lives only in memory for this page load.
  }
}

function clearToken() {
  for (const kind of STORAGE_KINDS) {
    try {
      storage(kind)?.removeItem(TOKEN_KEY);
    } catch {
      // Nothing to clear.
    }
  }
}

// ---------- Helpers ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith('on')) el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  el.append(...children.flat().filter((child) => child != null && child !== false));
  return el;
}

const collator = new Intl.Collator('sr-Latn', { numeric: true, sensitivity: 'base' });
const byName = (a, b) => collator.compare(a.name, b.name);

const extension = (name) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();
const displayName = (name) => name.slice(0, name.lastIndexOf('.')).replace(/[_-]+/g, ' ').trim();
const searchKey = (text) => text.toLowerCase().replace(/đ/g, 'dj').normalize('NFD').replace(/\p{M}/gu, '');

const TYPE_GROUPS = { pdf: 'pdf', ppt: 'ppt', pptx: 'ppt', doc: 'doc', docx: 'doc', xls: 'xls', xlsx: 'xls' };

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function filesLabel(n) {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} fajl`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} fajla`;
  return `${n} fajlova`;
}

function readAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
    reader.onerror = () => reject(new Error('Fajl nije moguće pročitati.'));
    reader.readAsDataURL(file);
  });
}

function sanitizeName(original) {
  const name = original.normalize('NFC');
  const dot = name.lastIndexOf('.');
  const base = name
    .slice(0, dot)
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_.-]/gu, '')
    .replace(/_+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '');
  return `${base || 'fajl'}.${extension(name)}`;
}

function uniqueName(sectionId, name) {
  const taken = new Set(state.files.get(sectionId).map((f) => f.name.toLowerCase()));
  const dot = name.lastIndexOf('.');
  let candidate = name;
  for (let i = 2; taken.has(candidate.toLowerCase()); i++) {
    candidate = `${name.slice(0, dot)}_${i}${name.slice(dot)}`;
  }
  return candidate;
}

function validateFile(file) {
  const dot = file.name.lastIndexOf('.');
  if (dot < 1 || !CONFIG.allowedExtensions.includes(extension(file.name))) {
    return `tip fajla nije dozvoljen (dozvoljeno: ${CONFIG.allowedExtensions.join(', ')}).`;
  }
  if (file.size === 0) return 'fajl je prazan.';
  if (file.size > CONFIG.maxFileSizeMB * 1024 ** 2) return `fajl je veći od ${CONFIG.maxFileSizeMB} MB.`;
  return null;
}

// ---------- Data ----------

let filesRequest = null;

function loadFiles(force = false) {
  if (force || !filesRequest) {
    filesRequest = github.listTree().then(
      (tree) => {
        state.files = groupBySection(tree);
        state.loadError = null;
      },
      (err) => {
        state.loadError = err;
        filesRequest = null; // Retry on the next navigation.
      },
    );
  }
  return filesRequest;
}

function groupBySection(tree) {
  const groups = new Map(CONFIG.sections.map((s) => [s.id, []]));
  for (const node of tree) {
    if (node.type !== 'blob') continue;
    const [root, section, name, ...nested] = node.path.split('/');
    if (root !== CONFIG.filesDir || nested.length || !name || name.startsWith('.') || !groups.has(section)) continue;
    groups.get(section).push({ name, path: node.path, sha: node.sha, size: node.size });
  }
  for (const list of groups.values()) list.sort(byName);
  return groups;
}

const sectionFiles = (sectionId) => state.files?.get(sectionId) ?? [];

// ---------- Actions ----------

async function uploadFiles(section, files, { statusList, onChange, setBusy }) {
  if (!state.files) return;
  setBusy(true);
  // Sequential on purpose: parallel commits to one branch conflict (409).
  for (const file of files) {
    const row = h('li', { class: 'status pending' }, `Šaljem ${file.name}…`);
    statusList.prepend(row);
    const setRow = (kind, text) => {
      row.className = `status ${kind}`;
      row.textContent = text;
    };

    const problem = validateFile(file);
    if (problem) {
      setRow('error', `${file.name}: ${problem}`);
      continue;
    }
    const name = uniqueName(section.id, sanitizeName(file.name));
    const path = `${CONFIG.filesDir}/${section.id}/${name}`;
    try {
      const content = await readAsBase64(file);
      const res = await github.putFile(path, content, `Upload: ${section.title} / ${name}`);
      const list = state.files.get(section.id);
      list.push({ name, path, sha: res.content.sha, size: res.content.size });
      list.sort(byName);
      onChange();
      setRow('ok', `✓ ${name} je otpremljen. Otvaranje proradi za oko minut (GitHub Pages objavljuje izmenu).`);
    } catch (err) {
      setRow('error', `${name}: ${err.message}`);
    }
  }
  setBusy(false);
}

async function removeFile(section, file, onChange) {
  if (!confirm(`Obrisati „${displayName(file.name)}“?`)) return;
  try {
    await github.deleteFile(file.path, file.sha, `Brisanje: ${section.title} / ${file.name}`);
    const list = state.files.get(section.id);
    list.splice(list.indexOf(file), 1);
    onChange();
  } catch (err) {
    alert(err.message);
  }
}

// ---------- Views ----------

function errorBanner() {
  if (!state.loadError) return null;
  const repoUrl = `https://github.com/${CONFIG.owner}/${CONFIG.repo}/tree/${CONFIG.branch}/${CONFIG.filesDir}`;
  return h(
    'div',
    { class: 'banner', role: 'alert' },
    `Spisak fajlova nije učitan: ${state.loadError.message} `,
    h('a', { href: repoUrl, target: '_blank', rel: 'noopener' }, 'Otvori fajlove na GitHub-u'),
  );
}

function homeView() {
  return h(
    'section',
    { class: 'home' },
    h(
      'div',
      { class: 'hero' },
      h('h1', {}, 'RMIS'),
      h('p', {}, 'Svi materijali za predmet na jednom mestu — vežbe, teorija i seminarski radovi.'),
    ),
    errorBanner(),
    h(
      'div',
      { class: 'cards' },
      CONFIG.sections.map((section, i) =>
        h(
          'a',
          { class: 'card', href: `#${section.id}` },
          h('span', { class: 'card-index' }, String(i + 1).padStart(2, '0')),
          h('h2', {}, section.title),
          h('p', {}, section.description),
          h('span', { class: 'card-count' }, state.files ? filesLabel(sectionFiles(section.id).length) : '—'),
        ),
      ),
    ),
  );
}

function fileItem(section, file, onChange) {
  const ext = extension(file.name);
  const href = encodePath(file.path);
  return h(
    'li',
    { class: 'file' },
    h('span', { class: `file-type type-${TYPE_GROUPS[ext] ?? 'other'}` }, ext.toUpperCase()),
    h(
      'div',
      { class: 'file-info' },
      h('a', { class: 'file-name', href, target: '_blank', rel: 'noopener' }, displayName(file.name)),
      h('span', { class: 'file-meta' }, formatSize(file.size)),
    ),
    h(
      'div',
      { class: 'file-actions' },
      h('a', { class: 'btn btn-ghost', href, download: file.name }, 'Preuzmi'),
      state.isAdmin &&
        h('button', { class: 'btn btn-danger', type: 'button', onClick: () => removeFile(section, file, onChange) }, 'Obriši'),
    ),
  );
}

function uploader(section, onChange) {
  const input = h('input', {
    id: 'file-input',
    class: 'visually-hidden',
    type: 'file',
    multiple: true,
    accept: CONFIG.allowedExtensions.map((ext) => `.${ext}`).join(','),
  });
  const zone = h(
    'label',
    { class: 'dropzone', for: 'file-input' },
    h('strong', {}, 'Prevuci fajlove ovde ili klikni za izbor'),
    h('small', {}, `${CONFIG.allowedExtensions.join(', ').toUpperCase()} · najviše ${CONFIG.maxFileSizeMB} MB po fajlu`),
  );
  const statusList = h('ul', { class: 'upload-status', 'aria-live': 'polite' });

  let busy = false;
  const setBusy = (value) => {
    busy = value;
    input.disabled = value;
    zone.classList.toggle('is-busy', value);
  };
  const start = (files) => {
    if (!busy && files.length) uploadFiles(section, files, { statusList, onChange, setBusy });
  };

  input.addEventListener('change', () => {
    start([...input.files]);
    input.value = '';
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('is-dragging');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-dragging'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('is-dragging');
    start([...e.dataTransfer.files]);
  });

  return h('div', { class: 'uploader' }, input, zone, statusList);
}

function uploadHint() {
  return h(
    'p',
    { class: 'hint' },
    'Upload fajlova je dostupan nakon prijave. ',
    h('button', { class: 'link-button', type: 'button', onClick: openLogin }, 'Prijavi se'),
  );
}

function sectionView(section) {
  const search = h('input', { class: 'search', type: 'search', placeholder: 'Pretraži fajlove…', 'aria-label': 'Pretraži fajlove' });
  const count = h('span', { class: 'count' });
  const list = h('ul', { class: 'file-list' });

  const renderList = () => {
    const files = sectionFiles(section.id);
    const query = searchKey(search.value.trim());
    const visible = files.filter((f) => searchKey(displayName(f.name)).includes(query));
    count.textContent = filesLabel(files.length);
    list.replaceChildren(
      ...(visible.length
        ? visible.map((f) => fileItem(section, f, renderList))
        : [h('li', { class: 'empty' }, files.length ? 'Nema rezultata za ovu pretragu.' : 'Još nema fajlova u ovoj sekciji.')]),
    );
  };
  search.addEventListener('input', renderList);
  renderList();

  return h(
    'section',
    { class: 'section' },
    h('a', { class: 'back', href: '#' }, '← Početna'),
    h('header', { class: 'section-head' }, h('h1', {}, section.title), h('p', {}, section.description)),
    errorBanner(),
    state.isAdmin && state.files ? uploader(section, renderList) : !state.isAdmin && uploadHint(),
    h('div', { class: 'toolbar' }, search, count),
    list,
  );
}

// ---------- Routing ----------

const currentSection = () => CONFIG.sections.find((s) => s.id === location.hash.replace(/^#\/?/, '')) ?? null;

async function render() {
  if (!state.files && !state.loadError) app.replaceChildren(h('p', { class: 'loading' }, 'Učitavanje…'));
  await loadFiles();

  const section = currentSection();
  document.title = section ? `${section.title} · RMIS` : 'RMIS';
  for (const link of nav.querySelectorAll('a')) {
    link.toggleAttribute('aria-current', link.hash === `#${section?.id}`);
  }
  app.replaceChildren(section ? sectionView(section) : homeView());
}

// ---------- Auth ----------

function setAdmin(isAdmin) {
  state.isAdmin = isAdmin;
  adminButton.textContent = isAdmin ? 'Odjava' : 'Prijava';
}

function openLogin() {
  loginError.textContent = '';
  dialog.showModal();
}

adminButton.addEventListener('click', () => {
  if (!state.isAdmin) return openLogin();
  clearToken();
  github.setToken(null);
  setAdmin(false);
  render();
});

document.getElementById('login-cancel').addEventListener('click', () => dialog.close());

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = loginForm.elements.token.value.trim();
  const submit = loginForm.querySelector('[type=submit]');
  submit.disabled = true;
  loginError.textContent = '';
  github.setToken(token);
  try {
    if (!(await github.canPush())) throw new Error('Ovaj nalog nema pravo upisa u repozitorijum.');
    saveToken(token, loginForm.elements.remember.checked);
    setAdmin(true);
    dialog.close();
    loginForm.reset();
    await loadFiles(true); // Authenticated listing also works while the repo is private.
    render();
  } catch (err) {
    github.setToken(null);
    loginError.textContent = err.message;
  } finally {
    submit.disabled = false;
  }
});

// ---------- Boot ----------

async function init() {
  if (github.token) {
    try {
      setAdmin(await github.canPush());
    } catch {
      clearToken();
      github.setToken(null);
    }
  }
  window.addEventListener('hashchange', render);
  render();
}

init();
