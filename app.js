'use strict';
/* global REPO, API, ON_GITHUB, cfg, saveCfg, store, findVideoUrls, sendCommand, addUrls, esc, DEFAULT_BASICS */

const TYPES = ['plat', 'entrée', 'apéro', 'dessert', 'petit-déj', 'goûter', 'boisson', 'sauce', 'autre'];
const TYPE_ICON = { plat: '🍲', 'entrée': '🥗', 'apéro': '🧀', dessert: '🍰', 'petit-déj': '🥞', 'goûter': '🍪', boisson: '🥤', sauce: '🫙', autre: '🍽️' };
const MAX_MISSING = 2;
const APP_VERSION = 9;

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
async function loadData(fromPoll = false) {
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
  renderFilters();
  render();
  if (!fromPoll) checkPending();
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
    box.textContent = `Analyse de ${pendingCount > 1 ? `${pendingCount} demandes` : 'ta recette'} en cours… (≈ 2 min)`;
    clearTimeout(pollTimer);
    if (pendingCount) {
      if (before) loadData(true); // pendant un import, les recettes arrivent par paquets de 3
      pollTimer = setTimeout(checkPending, 20000);
    } else if (before) loadData(); // une analyse vient de finir : on recharge
  } catch { /* pas grave */ }
}

// ---------------------------------------------------------------- personnes
function people() {
  return [...new Set(recipes.flatMap((r) => r.par || []))].sort((a, b) => a.localeCompare(b, 'fr'));
}
const personColor = (p) => `var(--p${Math.max(0, people().indexOf(p)) % 4})`;
function whoHtml(r) {
  return (r.par || []).map((p) => `<span class="who"><i style="background:${personColor(p)}"></i>${esc(p)}</span>`).join(' ');
}

// ---------------------------------------------------------------- filtres
const TYPE_LABEL = { plat: 'Plats', 'entrée': 'Entrées', 'apéro': 'Apéros', dessert: 'Desserts', 'petit-déj': 'Petit-déj', 'goûter': 'Goûters', boisson: 'Boissons', sauce: 'Sauces', autre: 'Autres' };
const TIMES = [[0, 'Tout temps'], [15, '≤ 15 min'], [30, '≤ 30 min'], [45, '≤ 45 min'], [60, '≤ 1 h']];
let fType = '';
let fQui = '';
const fmtTime = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60}` : ''}`);
const pill = (k, v, label, on, extra = '') => `<button class="pill${on ? ' on' : ''}${extra}" data-k="${k}" data-v="${esc(v)}">${label}</button>`;

function renderFilters() {
  const used = TYPES.filter((t) => recipes.some((r) => r.type === t));
  if (fType && !used.includes(fType)) fType = '';
  if (fQui && !people().includes(fQui)) fQui = '';
  $('#fType').innerHTML = pill('type', '', '✨ Tout', !fType)
    + used.map((t) => pill('type', t, `${TYPE_ICON[t] || ''} ${TYPE_LABEL[t] || t}`, fType === t)).join('');
  const who = people();
  $('#fMore').innerHTML = TIMES.map(([v, l]) => pill('time', v, v ? l : `⏱ ${l}`, tempsMax === v)).join('')
    + (who.length > 1 ? '<span class="sep"></span>' + pill('qui', '', '👫 Nous deux', !fQui)
      + who.map((p) => `<button class="pill person${fQui === p ? ' on' : ''}" style="--pc:${personColor(p)}" data-k="qui" data-v="${esc(p)}">${esc(p)}</button>`).join('') : '');
  const bases = [...new Set(recipes.flatMap((r) => (r.ingredients || []).map((i) => (i.base || '').trim().toLowerCase())).filter(Boolean))].sort();
  $('#ingList').innerHTML = bases.map((b) => `<option value="${esc(b)}">`).join('');
  const { prenom } = cfg();
  $('#hello').textContent = `Salut${prenom ? ` ${prenom}` : ''} 👋`;
}

function filtered() {
  return recipes.filter((r) => (!fType || r.type === fType) && (!fQui || (r.par || []).includes(fQui))
    && (!tempsMax || (r.temps_min != null && r.temps_min <= tempsMax)));
}

// ---------------------------------------------------------------- affichage
function media(r, cls = '') {
  const icon = TYPE_ICON[r.type] || '🍽️';
  if (!r.image) return `<div class="ph ${cls}">${icon}</div>`;
  const raw = `https://raw.githubusercontent.com/${REPO.owner}/${REPO.name}/main/${esc(r.image)}`;
  return `<img src="${esc(r.image)}" alt="" loading="lazy" onerror="if(this.dataset.f){this.outerHTML='<div class=&quot;ph&quot;>${icon}</div>'}else{this.dataset.f=1;this.src='${raw}'}">`;
}

function tile(r, s) {
  let badge = '';
  if (r.statut !== 'ok') badge = '<span class="t-badge todo">À compléter</span>';
  else if (s && mine.length) {
    badge = s.missing.length
      ? `<span class="t-badge miss">Manque : ${esc(s.missing.join(', '))}</span>`
      : '<span class="t-badge ok">✓ Tu as tout</span>';
  }
  const who = (r.par || []).map((p) => `<i style="background:${personColor(p)}" title="${esc(p)}">${esc((p[0] || '?').toUpperCase())}</i>`).join('');
  return `<button class="tile" data-id="${esc(r.id)}">${media(r)}
    <div class="t-top">${r.temps_min ? `<span class="t-time">⏱ ${fmtTime(r.temps_min)}</span>` : '<span></span>'}<span class="t-who">${who}</span></div>
    <div class="t-cap">${badge}<h3>${esc(r.titre)}</h3><span class="t-tag">${TYPE_ICON[r.type] || ''} ${esc(TYPE_LABEL[r.type] ? r.type : 'autre')}</span></div>
  </button>`;
}

const section = (title, items, sub = '') => `<div class="section-title"><h2>${title}</h2><span>${sub}</span></div><div class="grid">${items}</div>`;
const emptyBox = (icon, title, text) => `<div class="empty"><b>${icon}</b><p><strong>${title}</strong></p><p>${text}</p></div>`;

function render() {
  const out = $('#results');
  const list = filtered();
  $('#chips').innerHTML = mine.map((m, i) => `<button class="chip" data-i="${i}" aria-label="Retirer ${esc(m)}">${esc(m)}<span>✕</span></button>`).join('');
  $('#ingInput').placeholder = mine.length ? 'Autre ingrédient…' : "Ce que j'ai dans le frigo…";

  if (!recipes.length) {
    lastShown = [];
    out.innerHTML = emptyBox('🥘', 'Le carnet est vide', 'Partage une vidéo Instagram ou TikTok vers « Ajouter aux recettes ».');
    return;
  }
  if (!mine.length) {
    lastShown = list.filter((r) => r.statut === 'ok');
    const todo = list.filter((r) => r.statut !== 'ok');
    out.innerHTML = (list.length ? '' : emptyBox('🔍', 'Aucune recette', 'Rien ne correspond à ces filtres.'))
      + (lastShown.length ? section(fType ? TYPE_LABEL[fType] || 'Nos recettes' : 'Nos recettes', lastShown.map((r) => tile(r)).join(''), `${lastShown.length}`) : '')
      + (todo.length ? section('À compléter', todo.map((r) => tile(r)).join(''), `${todo.length}`) : '');
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
    out.innerHTML = emptyBox('🤷', 'Rien de faisable', `Même en acceptant ${MAX_MISSING} ingrédients manquants. Essaie avec autre chose !`);
    return;
  }
  const titles = ['Tu peux le faire 🎉', 'Il manque 1 ingrédient', 'Il manque 2 ingrédients'];
  out.innerHTML = '<p class="basics-note">Sel, poivre, huile & co. ne comptent pas.</p>' + [0, 1, 2].map((n) => {
    const g = scored.filter((x) => x.s.missing.length === n);
    return g.length ? section(titles[n], g.map((x) => tile(x.r, x.s)).join(''), `${g.length}`) : '';
  }).join('');
}

// ---------------------------------------------------------------- fiche recette
function openRecipe(id) {
  const r = recipes.find((x) => x.id === id);
  if (!r) return;
  const mineKeys = mine.map(keyOf);
  const basics = basicKeys();
  let have = 0;
  let needed = 0;
  const ings = (r.ingredients || []).map((i) => {
    const k = keyOf(i.base || i.nom);
    let cls = '';
    let mk = '';
    if (isBasic(k, basics)) cls = 'basic';
    else if (mine.length) {
      needed += 1;
      if (mineKeys.some((m) => matches(m, k))) { cls = 'have'; mk = '✓'; have += 1; } else cls = 'miss';
    }
    return `<li class="${cls}"><span class="mk">${mk}</span><span>${esc(i.nom)}</span></li>`;
  }).join('');
  const steps = (r.etapes || []).map((e) => `<li><span>${esc(e)}</span></li>`).join('');
  const meta = [r.temps_min ? `⏱ ${fmtTime(r.temps_min)}` : '', r.portions ? `👥 ${r.portions} pers.` : '', `${TYPE_ICON[r.type] || '🍽️'} ${esc(r.type || 'autre')}`]
    .filter(Boolean).map((m) => `<span>${m}</span>`).join('');
  $('#recipeBody').innerHTML = `
    <div class="d-hero">${media(r)}<button class="d-back" data-close aria-label="Retour">←</button></div>
    <div class="d-body">
      <h2>${esc(r.titre)}</h2>
      <div class="d-meta">${meta}</div>
      <div class="d-by">Ajoutée par ${whoHtml(r)}${r.auteur_video ? ` · vidéo de ${esc(r.auteur_video)}` : ''}</div>
      ${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}
      <section class="d-card"><h3>Ingrédients <small>${mine.length && needed ? `${have}/${needed} dans ton frigo` : `${(r.ingredients || []).length}`}</small></h3>
        ${ings ? `<ul class="ings">${ings}</ul>` : '<p class="small">Aucun ingrédient enregistré : regarde la vidéo.</p>'}</section>
      <section class="d-card"><h3>Étapes</h3>${steps ? `<ol class="steps">${steps}</ol>` : '<p class="small">Pas d\'étapes : regarde la vidéo.</p>'}</section>
      <div class="d-tools">
        <button class="ghost" data-act="edit">✏️ Modifier</button>
        <button class="ghost" data-act="retry">🔄 Réanalyser</button>
        <button class="danger" data-act="del">🗑 Supprimer</button>
      </div>
    </div>
    <div class="d-bar"><a href="${esc(r.url)}" target="_blank" rel="noopener">▶ Voir la vidéo</a></div>`;
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
      renderFilters();
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
    renderFilters();
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
  $('#appVer').textContent = `Version ${APP_VERSION}`;
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

// Version HTML (format par défaut d'Instagram). Deux variantes :
// - ancienne : un bloc par entrée, un bloc « Nom : X » sans lien = début de la collection X ;
// - nouvelle : un bloc par collection, qui commence par « Nom : X » puis contient toutes ses vidéos.
function scanHtml(html, fileName, groups) {
  let current = groupLabel(fileName);
  const add = (u) => { if (!groups.has(current)) groups.set(current, new Set()); groups.get(current).add(u); };
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const sel = 'div.uiBoxWhite, div._a6-g';
  const blocks = [...doc.querySelectorAll(sel)].filter((b) => !b.parentElement?.closest(sel));
  const urlsOf = (el) => {
    const out = [...el.querySelectorAll('a[href]')].flatMap((a) => findVideoUrls(a.getAttribute('href')));
    const w = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT); // texte nœud par nœud : sinon l'URL se colle au texte suivant
    while (w.nextNode()) out.push(...findVideoUrls(w.currentNode.textContent));
    return [...new Set(out)];
  };
  if (!blocks.length) { urlsOf(doc.body || doc.documentElement).forEach(add); return; }
  const isCollections = /saved_collections/i.test(fileName);
  for (const b of blocks) {
    if (isCollections) {
      const nodes = [];
      const w = doc.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) { const t = w.currentNode.textContent.trim(); if (t) nodes.push({ t, inLink: !!w.currentNode.parentElement.closest('a') }); }
      const i = nodes.findIndex((n) => NAME_LABEL.test(fixText(n.t).replace(/\s*:$/, '')));
      const v = i >= 0 ? nodes[i + 1] : null;
      if (v && !v.inLink && !/^https?:/i.test(v.t)) current = `Collection « ${fixText(v.t).trim()} »`;
    }
    urlsOf(b).forEach(add);
  }
}

// Squelette d'un fichier d'export, sans liens ni textes personnels (pour diagnostiquer un format inconnu).
const KEEP_LABEL = /^(nom|name|url|l.{1,3}gende|caption|titre|title|type|confidentialit.*|privacy|.*time|heure.*|date.*|collection)\s*:?$/i;
function skeleton(text, name) {
  if (/\.json$/i.test(name)) {
    const shape = (o, d = 0) => {
      if (d > 7) return '…';
      if (Array.isArray(o)) return o.length <= 3 ? o.map((x) => shape(x, d + 1)) : [...o.slice(0, 2).map((x) => shape(x, d + 1)), `…x${o.length}`, shape(o[o.length - 1], d + 1)];
      if (o && typeof o === 'object') {
        const r = {};
        for (const [k, v] of Object.entries(o).slice(0, 12)) r[k] = k === 'label' && typeof v === 'string' && KEEP_LABEL.test(fixText(v)) ? fixText(v) : shape(v, d + 1);
        return r;
      }
      return typeof o === 'string' ? (findVideoUrls(o).length ? '<lien vidéo>' : `<texte ${o.length}>`) : typeof o;
    };
    try { return JSON.stringify(shape(JSON.parse(text)), null, 1).slice(0, 6000); } catch { return 'JSON illisible'; }
  }
  const doc = new DOMParser().parseFromString(text, 'text/html');
  const sel = 'div.uiBoxWhite, div._a6-g';
  const blocks = [...doc.querySelectorAll(sel)].filter((b) => !b.parentElement?.closest(sel)).slice(0, 2);
  const root = blocks.length ? blocks : [doc.body];
  return root.map((b) => {
    const c = b.cloneNode(true);
    const w = doc.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    const ts = [];
    while (w.nextNode()) ts.push(w.currentNode);
    ts.forEach((n) => { const t = n.textContent.trim(); if (t && !KEEP_LABEL.test(fixText(t))) n.textContent = findVideoUrls(t).length ? '<lien vidéo>' : `<texte ${t.length}>`; });
    c.querySelectorAll('[href]').forEach((a) => a.setAttribute('href', findVideoUrls(a.getAttribute('href')).length ? 'lien-video' : 'lien'));
    c.querySelectorAll('img,[src]').forEach((x) => x.removeAttribute('src'));
    return c.outerHTML;
  }).join('\n').slice(0, 6000);
}

async function importFile(file) {
  const box = $('#importResult');
  box.innerHTML = '<p class="small">Lecture du fichier…</p>';
  const groups = new Map();
  let names = [];
  let savedFile = null;
  const scanText = (text, name) => {
    if (/saved_collections/i.test(name)) savedFile = { text, name };
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
  const noCollections = savedFile && !entries.some(([g]) => g.startsWith('Collection'));
  box.innerHTML = `${noCollections ? '<p class="small">⚠️ Je n’ai pas réussi à séparer tes collections. <button id="btnDebug" class="ghost">Envoyer le format à Claude</button><br>(seulement la structure du fichier : ni liens, ni légendes)</p>' : ''}<p class="small">Coche ce que tu veux importer :</p><div class="groups">${entries.map(([g, s], i) => `<label><input type="checkbox" data-i="${i}" ${/recet/i.test(g) ? 'checked' : ''}> ${esc(g)} <small>(${s.size})</small></label>`).join('')}</div><button id="btnDoImport" class="primary">Importer</button>`;
  if (noCollections) {
    $('#btnDebug').onclick = async () => {
      try {
        await sendRaw('[debug] format export', `Fichier : ${savedFile.name}
Version ${APP_VERSION}

\`\`\`
${skeleton(savedFile.text, savedFile.name)}
\`\`\``);
        toast('Envoyé ✓ dis-le à Claude');
      } catch (e) { toast(e.message); }
    };
  }
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
document.querySelector('.filters').addEventListener('click', (e) => {
  const b = e.target.closest('.pill');
  if (!b) return;
  const { k, v } = b.dataset;
  if (k === 'type') fType = v;
  if (k === 'time') tempsMax = +v;
  if (k === 'qui') fQui = v;
  renderFilters();
  render();
});
$('#btnRandom').addEventListener('click', () => {
  const pool = lastShown.length ? lastShown : filtered().filter((r) => r.statut === 'ok');
  if (!pool.length) { toast('Aucune recette à tirer avec ces filtres'); return; }
  openRecipe(pool[Math.floor(Math.random() * pool.length)].id);
});
$('#results').addEventListener('click', (e) => { const c = e.target.closest('.tile'); if (c) openRecipe(c.dataset.id); });
$('#recipeBody').addEventListener('click', (e) => {
  const a = e.target.closest('[data-act]');
  if (a) { recipeAction(a.dataset.act); return; }
  const li = e.target.closest('.ings li');
  if (li) { // case à cocher pendant qu'on cuisine
    li.classList.toggle('done');
    const mk = li.querySelector('.mk');
    if (!li.classList.contains('have')) mk.textContent = li.classList.contains('done') ? '✓' : '';
  }
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
