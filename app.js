'use strict';
/* global REPO, API, ON_GITHUB, cfg, saveCfg, store, findVideoUrls, sendCommand, addUrls, esc, DEFAULT_BASICS */

const TYPES = ['plat', 'entrée', 'apéro', 'dessert', 'petit-déj', 'goûter', 'boisson', 'sauce', 'autre'];
const TYPE_ICON = { plat: '🍲', 'entrée': '🥗', 'apéro': '🧀', dessert: '🍰', 'petit-déj': '🥞', 'goûter': '🍪', boisson: '🥤', sauce: '🫙', autre: '🍽️' };
const MAX_MISSING = 2;

const $ = (s) => document.querySelector(s);
let recipes = [];
let mine = store.get('mesIngredients', []);
let tempsMax = 0;
let pendingCount = 0;
let pollTimer = null;
let lastShown = [];

// ---------------------------------------------------------------- normalisation / correspondance
const norm = (s) => String(s || '').toLowerCase().replace(/œ/g, 'oe').replace(/æ/g, 'ae').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();
const sing = (w) => (w.length > 3 ? w.replace(/(s|x)$/, '') : w);
const keyOf = (s) => norm(s).split(' ').map(sing).join(' ');
const contains = (big, small) => (` ${big} `).includes(` ${small} `);
const matches = (a, b) => a === b || contains(a, b) || contains(b, a);
const basicKeys = () => (cfg().basiques || DEFAULT_BASICS).map(keyOf).filter(Boolean);
const isBasic = (k, basics) => basics.some((b) => k === b || contains(k, b));

function score(r, mineKeys, basics) {
  const needed = [...new Set((r.ingredients || []).map((i) => keyOf(i.base || i.nom)).filter(Boolean))]
    .filter((k) => !isBasic(k, basics));
  const have = needed.filter((k) => mineKeys.some((m) => matches(m, k)));
  const missing = needed.filter((k) => !have.includes(k));
  return { needed, have, missing };
}

// Nom d'ingrédient « générique » à partir d'une ligne tapée à la main (« 2 blancs de poulet » → « blancs de poulet »)
const UNITS = String.raw`g|gr|grammes?|kg|mg|ml|cl|dl|l|litres?|c\.? ?[àa] ?[sc]\.?|cas|cac|cs|cc|cuill[eè]res?(?: [àa] (?:soupe|caf[ée]))?|pinc[ée]es?|tasses?|verres?|sachets?|bo[iî]tes?|tranches?|gousses?|brins?|feuilles?|poign[ée]es?|morceaux?|filets?|pots?|bottes?|branches?|cubes?|zestes?|bouquets?`;
function baseOf(line) {
  let s = line.toLowerCase().replace(/\(.*?\)/g, ' ').split(/[,:]/)[0];
  s = s.replace(/^[\s\d.,/½¼¾⅓⅔x×-]+/, '');
  s = s.replace(new RegExp(`^(?:${UNITS})\\b\\.?\\s*`, 'i'), '');
  s = s.replace(/^(?:de la |de l'|de l’|de |d'|d’|du |des |la |le |les |l'|l’|un |une )/, '');
  return s.trim() || line.trim().toLowerCase();
}

// ---------------------------------------------------------------- données
async function loadData() {
  const token = cleanToken(cfg().token);
  let data = null;
  // Avec un code d'accès, l'API GitHub donne la version la plus fraîche (le site met ~1 min à se mettre à jour).
  // Sans code, on lit seulement le site : GitHub limite les appels anonymes à 60/heure.
  if (ON_GITHUB && token) {
    try {
      const h = { Accept: 'application/vnd.github.raw+json', Authorization: `Bearer ${token}` };
      const r = await fetch(`${API}/contents/data/recipes.json`, { headers: h, cache: 'no-store' });
      if (r.ok) data = await r.json();
    } catch { /* on tente la copie du site */ }
  }
  if (!data) {
    try {
      const r = await fetch(`data/recipes.json?t=${Date.now()}`, { cache: 'no-store' });
      if (r.ok) data = await r.json();
    } catch { /* hors ligne */ }
  }
  if (Array.isArray(data)) { recipes = data; store.set('cache', data); } else recipes = store.get('cache', []);
  fillSelects();
  render();
  checkPending();
}

async function checkPending() {
  const token = cleanToken(cfg().token);
  if (!ON_GITHUB || !token) return;
  try {
    const h = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` };
    const r = await fetch(`${API}/issues?state=open&per_page=100&creator=${REPO.owner}`, { headers: h, cache: 'no-store' });
    if (!r.ok) return;
    const open = (await r.json()).filter((i) => !i.pull_request && i.title.toLowerCase().startsWith('[recette]'));
    const before = pendingCount;
    pendingCount = open.length;
    const box = $('#pending');
    box.hidden = !pendingCount;
    box.textContent = `⏳ ${pendingCount} demande${pendingCount > 1 ? 's' : ''} en cours d'analyse (≈ 2 min)…`;
    clearTimeout(pollTimer);
    if (pendingCount) pollTimer = setTimeout(checkPending, 20000);
    else if (before) loadData(); // une analyse vient de finir : on recharge
  } catch { /* pas grave */ }
}

// ---------------------------------------------------------------- personnes
function people() {
  return [...new Set(recipes.flatMap((r) => r.par || []))].sort((a, b) => a.localeCompare(b, 'fr'));
}
function whoHtml(r) {
  const all = people();
  return (r.par || []).map((p) => `<span class="who"><i class="dot" style="background:var(--p${all.indexOf(p) % 4})"></i>${esc(p)}</span>`).join(' ');
}

// ---------------------------------------------------------------- affichage
function fillSelects() {
  const fType = $('#fType');
  const fQui = $('#fQui');
  const keepT = fType.value;
  const keepQ = fQui.value;
  const used = TYPES.filter((t) => recipes.some((r) => r.type === t));
  fType.innerHTML = '<option value="">Tous les types</option>' + used.map((t) => `<option value="${esc(t)}">${TYPE_ICON[t] || ''} ${esc(t)}</option>`).join('');
  fQui.innerHTML = '<option value="">De nous deux</option>' + people().map((p) => `<option value="${esc(p)}">Ajoutées par ${esc(p)}</option>`).join('');
  fType.value = used.includes(keepT) ? keepT : '';
  fQui.value = people().includes(keepQ) ? keepQ : '';
  const bases = [...new Set(recipes.flatMap((r) => (r.ingredients || []).map((i) => (i.base || '').trim().toLowerCase())).filter(Boolean))].sort();
  $('#ingList').innerHTML = bases.map((b) => `<option value="${esc(b)}">`).join('');
  $('#count').textContent = recipes.length ? `· ${recipes.length}` : '';
}

function filtered() {
  const t = $('#fType').value;
  const q = $('#fQui').value;
  return recipes.filter((r) => (!t || r.type === t) && (!q || (r.par || []).includes(q))
    && (!tempsMax || (r.temps_min != null && r.temps_min <= tempsMax)));
}

function card(r, s) {
  const img = r.image
    ? `<img class="thumb" src="${esc(r.image)}" alt="" loading="lazy" onerror="if(this.dataset.f){this.outerHTML='<div class=&quot;thumb&quot;>${TYPE_ICON[r.type] || '🍽️'}</div>'}else{this.dataset.f=1;this.src='https://raw.githubusercontent.com/${REPO.owner}/${REPO.name}/main/${esc(r.image)}'}">`
    : `<div class="thumb">${TYPE_ICON[r.type] || '🍽️'}</div>`;
  let line = '';
  if (s && mine.length) {
    line = s.missing.length
      ? `<div class="missing">Il manque : ${esc(s.missing.join(', '))}</div>`
      : '<div class="okline">✓ Tu as tout</div>';
  }
  const badge = r.statut !== 'ok' ? '<span class="badge">à compléter</span>' : '';
  return `<button class="card" data-id="${esc(r.id)}">${img}<div class="info">
    <div class="t">${esc(r.titre)}</div>
    <div class="meta">${r.temps_min ? `<span>⏱ ${r.temps_min} min</span>` : ''}<span>${TYPE_ICON[r.type] || ''} ${esc(r.type || '')}</span>${whoHtml(r)}${badge}</div>
    ${line}</div></button>`;
}

function render() {
  const out = $('#results');
  const list = filtered();
  $('#chips').innerHTML = mine.map((m, i) => `<button class="chip" data-i="${i}" aria-label="Retirer ${esc(m)}">${esc(m)}<span>×</span></button>`).join('');

  if (!recipes.length) {
    lastShown = [];
    out.innerHTML = `<div class="empty">Aucune recette pour l'instant.<br>Partage une vidéo depuis Instagram ou TikTok vers « Recettes » 🙂</div>`;
    return;
  }
  if (!mine.length) {
    lastShown = list.filter((r) => r.statut === 'ok');
    const todo = list.filter((r) => r.statut !== 'ok');
    out.innerHTML = (list.length ? '' : '<div class="empty">Aucune recette avec ces filtres.</div>')
      + (lastShown.length ? `<h2 class="section">Toutes nos recettes <small>${lastShown.length}</small></h2>${lastShown.map((r) => card(r)).join('')}` : '')
      + (todo.length ? `<h2 class="section">À compléter <small>${todo.length}</small></h2>${todo.map((r) => card(r)).join('')}` : '');
    return;
  }
  const mineKeys = mine.map(keyOf);
  const basics = basicKeys();
  const scored = list.filter((r) => r.statut === 'ok')
    .map((r) => ({ r, s: score(r, mineKeys, basics) }))
    .filter(({ s }) => s.have.length && s.missing.length <= MAX_MISSING)
    .sort((a, b) => a.s.missing.length - b.s.missing.length || b.s.have.length - a.s.have.length);
  lastShown = scored.map((x) => x.r);
  if (!scored.length) {
    out.innerHTML = `<div class="empty">Rien de faisable avec ça (même en acceptant ${MAX_MISSING} ingrédients manquants).</div>`;
    return;
  }
  const titles = ['Tu peux le faire', 'Il manque 1 ingrédient', 'Il manque 2 ingrédients'];
  out.innerHTML = [0, 1, 2].map((n) => {
    const g = scored.filter((x) => x.s.missing.length === n);
    return g.length ? `<h2 class="section">${titles[n]} <small>${g.length}</small></h2>${g.map((x) => card(x.r, x.s)).join('')}` : '';
  }).join('');
}

// ---------------------------------------------------------------- fiche recette
function openRecipe(id) {
  const r = recipes.find((x) => x.id === id);
  if (!r) return;
  const mineKeys = mine.map(keyOf);
  const basics = basicKeys();
  const ings = (r.ingredients || []).map((i) => {
    const k = keyOf(i.base || i.nom);
    let cls = '';
    let mk = '•';
    if (isBasic(k, basics)) cls = 'basic';
    else if (mine.length && mineKeys.some((m) => matches(m, k))) { cls = 'have'; mk = '✓'; } else if (mine.length) { cls = 'miss'; mk = '✗'; }
    return `<li class="${cls}"><span class="mk">${mk}</span><span>${esc(i.nom)}</span></li>`;
  }).join('');
  const steps = (r.etapes || []).map((e) => `<li>${esc(e)}</li>`).join('');
  const hero = r.image
    ? `<div class="r-hero"><img src="${esc(r.image)}" alt="" onerror="this.parentNode.remove()"><button class="r-close" data-close aria-label="Fermer">✕</button></div>`
    : '<button class="r-close static" data-close aria-label="Fermer">✕</button>';
  $('#recipeBody').innerHTML = `${hero}
    <h2>${esc(r.titre)}</h2>
    <div class="meta">${r.temps_min ? `<span>⏱ ${r.temps_min} min</span>` : ''}${r.portions ? `<span>👥 ${r.portions} pers.</span>` : ''}<span>${TYPE_ICON[r.type] || ''} ${esc(r.type)}</span><span>ajoutée par ${whoHtml(r)}</span></div>
    <a class="video-link" href="${esc(r.url)}" target="_blank" rel="noopener">▶ Voir la vidéo${r.auteur_video ? ` de ${esc(r.auteur_video)}` : ''} ↗</a>
    ${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}
    <h3>Ingrédients</h3>${ings ? `<ul class="ings">${ings}</ul>` : '<p class="small">Aucun ingrédient enregistré.</p>'}
    <h3>Étapes</h3>${steps ? `<ol class="steps">${steps}</ol>` : '<p class="small">Pas d\'étapes : regarde la vidéo.</p>'}
    <div class="r-actions">
      <button class="ghost" data-act="edit">✏️ Modifier</button>
      <button class="ghost" data-act="retry">🔄 Réanalyser</button>
      <button class="danger" data-act="del">🗑 Supprimer</button>
    </div>`;
  $('#recipeBody').dataset.id = id;
  const d = $('#dlgRecipe');
  if (!d.open) d.showModal();
  d.scrollTop = 0;
}

async function recipeAction(act) {
  const id = $('#recipeBody').dataset.id;
  const r = recipes.find((x) => x.id === id);
  if (!r) return;
  try {
    if (act === 'edit') return openEdit(r);
    if (act === 'retry') {
      await sendCommand(`réanalyse ${r.titre}`, JSON.stringify({ action: 'reessayer', id }));
      toast('Réanalyse lancée, résultat dans ≈ 2 min');
    }
    if (act === 'del') {
      if (!confirm(`Supprimer « ${r.titre} » pour vous deux ?`)) return;
      await sendCommand(`suppression ${r.titre}`, JSON.stringify({ action: 'suppr', id }));
      recipes = recipes.filter((x) => x !== r);
      $('#dlgRecipe').close();
      fillSelects();
      render();
      toast('Recette supprimée');
    }
    checkPending();
  } catch (e) { toast(e.message); }
}

function openEdit(r) {
  const f = $('#editForm');
  f.type.innerHTML = TYPES.map((t) => `<option>${esc(t)}</option>`).join('');
  f.titre.value = r.titre || '';
  f.temps_min.value = r.temps_min ?? '';
  f.type.value = TYPES.includes(r.type) ? r.type : 'autre';
  f.ingredients.value = (r.ingredients || []).map((i) => i.nom).join('\n');
  f.etapes.value = (r.etapes || []).join('\n');
  f.dataset.id = r.id;
  $('#dlgEdit').showModal();
}

async function saveEdit(e) {
  e.preventDefault();
  const f = e.target;
  const r = recipes.find((x) => x.id === f.dataset.id);
  if (!r) return;
  const old = new Map((r.ingredients || []).map((i) => [i.nom, i.base]));
  const data = {
    titre: f.titre.value.trim(),
    temps_min: f.temps_min.value ? parseInt(f.temps_min.value, 10) : null,
    type: f.type.value,
    ingredients: f.ingredients.value.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((nom) => ({ nom, base: old.get(nom) || baseOf(nom) })),
    etapes: f.etapes.value.split('\n').map((l) => l.trim()).filter(Boolean),
  };
  try {
    await sendCommand(`modif ${data.titre}`, JSON.stringify({ action: 'modif', id: r.id, data }));
    Object.assign(r, data, { statut: 'ok', note: '' });
    $('#dlgEdit').close();
    fillSelects();
    render();
    openRecipe(r.id);
    toast('Modifications envoyées ✓');
    checkPending();
  } catch (err) { toast(err.message); }
}

// ---------------------------------------------------------------- réglages / import
function openSettings() {
  const c = cfg();
  const f = $('#settingsForm');
  f.prenom.value = c.prenom;
  f.token.value = c.token;
  f.basiques.value = (c.basiques || DEFAULT_BASICS).join(', ');
  $('#dlgSettings').showModal();
}

async function saveSettings(e) {
  e.preventDefault();
  const f = e.target;
  const token = cleanToken(f.token.value);
  saveCfg({
    prenom: f.prenom.value.trim(),
    token,
    basiques: f.basiques.value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
  });
  $('#dlgSettings').close();
  render();
  toast(token ? 'Vérification du code…' : 'Réglages enregistrés');
  if (token) toast(await checkToken(token));
  loadData();
}

// Parcourt un export Instagram/TikTok (JSON ou HTML) et regroupe les liens vidéo par collection.
const groupLabel = (fileName) => (/saved_collections/i.test(fileName) ? 'Instagram · sans collection'
  : /saved_posts/i.test(fileName) ? 'Instagram · tous les enregistrements'
    : /liked_posts|likes/i.test(fileName) ? 'Instagram · publications aimées'
      : fileName.split('/').pop());
const NAME_LABEL = /^(name|nom)$/i;
// Instagram encode mal les accents dans ses exports (« RÃ©sultat ») : on les répare.
const fixText = (s) => { try { return decodeURIComponent(escape(s)); } catch { return s; } };

function scanExport(root, fileName, groups) {
  let current = groupLabel(fileName);
  const add = (u) => { if (!groups.has(current)) groups.set(current, new Set()); groups.get(current).add(u); };
  (function walk(n) {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n === 'string') { findVideoUrls(n).forEach(add); return; }
    if (!n || typeof n !== 'object') return;
    // en-tête de collection : un nom, mais aucun lien vidéo (ancien format string_map_data, nouveau label_values)
    const smd = n.string_map_data;
    const lv = Array.isArray(n.label_values) ? n.label_values.find((l) => NAME_LABEL.test(fixText(l.label || ''))) : null;
    const name = smd?.Name?.value ?? smd?.Nom?.value ?? lv?.value;
    if (/saved_collections/i.test(fileName) && (n.title === 'Collection' || name != null)) {
      current = `Collection « ${fixText(name || '?').trim()} »`;
      // ancien format : en-tête seul, les vidéos suivent ; nouveau format : les vidéos sont dedans
      if (!findVideoUrls(JSON.stringify(n)).length) return;
    }
    for (const [k, v] of Object.entries(n)) {
      const prev = current;
      if (/favorite ?videos?/i.test(k)) current = 'TikTok · favoris';
      else if (/(like ?list|liked ?videos?)/i.test(k)) current = 'TikTok · vidéos aimées';
      walk(v);
      if (current.startsWith('TikTok') && !prev.startsWith('TikTok')) current = prev;
    }
  }(root));
}

// Version HTML (format par défaut d'Instagram) : chaque entrée est un bloc ; un bloc sans lien = nom de collection.
function scanHtml(html, fileName, groups) {
  let current = groupLabel(fileName);
  const add = (u) => { if (!groups.has(current)) groups.set(current, new Set()); groups.get(current).add(u); };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const sel = 'div.uiBoxWhite, div._a6-g';
  const blocks = [...doc.querySelectorAll(sel)].filter((b) => !b.parentElement?.closest(sel));
  const urlsOf = (el) => [...new Set([...el.querySelectorAll('a[href]')].flatMap((a) => findVideoUrls(a.getAttribute('href')))
    .concat(findVideoUrls(el.textContent)))];
  if (!blocks.length) { urlsOf(doc).forEach(add); return; }
  for (const b of blocks) {
    const urls = urlsOf(b);
    if (urls.length) { urls.forEach(add); continue; }
    if (!/saved_collections/i.test(fileName)) continue;
    const texts = [];
    const w = doc.createTreeWalker(b, NodeFilter.SHOW_TEXT);
    while (w.nextNode()) { const t = w.currentNode.textContent.trim(); if (t) texts.push(t); }
    const i = texts.findIndex((t) => NAME_LABEL.test(t.replace(/\s*:$/, '')));
    const name = i >= 0 ? texts[i + 1] : texts.find((t) => !/^(collection|name|nom|creation time|update time|date)/i.test(t) && !/\d{4}|\d{1,2}:\d{2}/.test(t));
    if (name) current = `Collection « ${name} »`;
  }
}

async function importFile(file) {
  const box = $('#importResult');
  box.innerHTML = '<p class="small">Lecture du fichier…</p>';
  const groups = new Map();
  let names = [];
  const scanText = (text, name) => {
    if (/\.json$/i.test(name)) { try { scanExport(JSON.parse(text), name, groups); } catch { /* JSON illisible */ } } else scanHtml(text, name, groups);
  };
  try {
    if (/\.zip$/i.test(file.name) || file.type.includes('zip')) {
      await loadScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');
      const zip = await window.JSZip.loadAsync(file);
      const all = Object.values(zip.files).filter((f) => !f.dir && /\.(json|html?)$/i.test(f.name));
      names = all.map((f) => f.name);
      let files = all.filter((f) => /saved|liked|favorite|user_data|likes/i.test(f.name));
      if (!files.length) files = all;
      for (const f of files) scanText(await f.async('string'), f.name);
    } else {
      names = [file.name];
      scanText(await file.text(), file.name);
    }
  } catch (e) {
    box.innerHTML = `<p class="small">Fichier illisible (${esc(e.message)}).</p>`;
    return;
  }
  const known = new Set(recipes.map((r) => r.url));
  if (!groups.size) {
    box.innerHTML = `<p class="small">Aucun lien Instagram/TikTok trouvé. Fichiers lus (${names.length}) :</p><p class="small">${names.slice(0, 15).map(esc).join('<br>') || '(aucun fichier .json ou .html)'}</p><p class="small">Fais une capture de ce message pour Claude.</p>`;
    return;
  }
  const entries = [...groups.entries()];
  box.innerHTML = `<p class="small">Coche ce que tu veux importer :</p><div class="groups">${entries.map(([g, s], i) => `<label><input type="checkbox" data-i="${i}" ${/recet/i.test(g) ? 'checked' : ''}> ${esc(g)} <small>(${s.size})</small></label>`).join('')}</div><button id="btnDoImport" class="primary">Importer</button>`;
  $('#btnDoImport').onclick = async () => {
    const urls = new Set();
    box.querySelectorAll('input:checked').forEach((c) => entries[c.dataset.i][1].forEach((u) => { if (!known.has(u)) urls.add(u); }));
    if (!urls.size) { toast('Rien de coché'); return; }
    if (!cfg().prenom) { toast('Indique ton prénom au-dessus'); return; }
    try {
      await addUrls([...urls], cfg().prenom);
      box.innerHTML = `<p class="small">✅ ${urls.size} vidéos envoyées. L'analyse prend ≈ 30 s par vidéo, tu peux fermer l'appli.</p>`;
      checkPending();
    } catch (e) { toast(e.message); }
  };
}

function loadScript(src) {
  return new Promise((ok, ko) => {
    if (document.querySelector(`script[src="${src}"]`)) { ok(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => ko(new Error('connexion impossible'));
    document.head.appendChild(s);
  });
}

// ---------------------------------------------------------------- divers
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function addIngredient(raw) {
  const items = raw.split(/[,;\n]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const it of items) if (!mine.includes(it)) mine.push(it);
  store.set('mesIngredients', mine);
  render();
}

// ---------------------------------------------------------------- événements
const input = $('#ingInput');
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); if (input.value.trim()) { addIngredient(input.value); input.value = ''; } }
  if (e.key === 'Backspace' && !input.value && mine.length) { mine.pop(); store.set('mesIngredients', mine); render(); }
});
input.addEventListener('input', () => { // choix dans la liste d'autocomplétion, ou virgule tapée sur mobile
  const v = input.value;
  if (v.includes(',')) { addIngredient(v); input.value = ''; return; }
  if ([...$('#ingList').options].some((o) => o.value === v.trim().toLowerCase()) && v.trim()) { addIngredient(v); input.value = ''; }
});
input.addEventListener('blur', () => { if (input.value.trim()) { addIngredient(input.value); input.value = ''; } });
$('#chips').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  mine.splice(+c.dataset.i, 1);
  store.set('mesIngredients', mine);
  render();
});
$('#fTemps').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  tempsMax = +b.dataset.v;
  $('#fTemps').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
  render();
});
$('#fType').addEventListener('change', render);
$('#fQui').addEventListener('change', render);
$('#btnRandom').addEventListener('click', () => {
  const pool = lastShown.length ? lastShown : filtered().filter((r) => r.statut === 'ok');
  if (!pool.length) { toast('Aucune recette à tirer avec ces filtres'); return; }
  openRecipe(pool[Math.floor(Math.random() * pool.length)].id);
});
$('#results').addEventListener('click', (e) => { const c = e.target.closest('.card'); if (c) openRecipe(c.dataset.id); });
$('#recipeBody').addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (a) recipeAction(a.dataset.act);
});
document.querySelectorAll('dialog').forEach((d) => {
  d.addEventListener('click', (e) => { if (e.target.closest('[data-close]') || e.target === d) d.close(); });
});
$('#editForm').addEventListener('submit', saveEdit);
$('#settingsForm').addEventListener('submit', saveSettings);
$('#btnSettings').addEventListener('click', openSettings);
$('#importFile').addEventListener('change', (e) => { if (e.target.files[0]) importFile(e.target.files[0]); });
$('#btnManual').addEventListener('click', async () => {
  const urls = findVideoUrls($('#manualUrl').value);
  if (!urls.length) { toast('Lien Instagram ou TikTok non reconnu'); return; }
  if (!cfg().prenom) { toast('Indique ton prénom au-dessus'); return; }
  try { await addUrls(urls, cfg().prenom); $('#manualUrl').value = ''; toast('Ajoutée ✓ analyse en cours'); checkPending(); } catch (err) { toast(err.message); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadData(); });

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
if (!cfg().prenom) setTimeout(openSettings, 300);
loadData();
