/* Partagé entre l'appli (index.html) et la page de partage (share.html). */
'use strict';

// Dépôt GitHub : déduit de l'adresse (xxx.github.io/<dépôt>/), sinon valeurs de test locales.
const REPO = (() => {
  if (location.hostname.endsWith('.github.io')) {
    return { owner: location.hostname.split('.')[0], name: location.pathname.split('/').filter(Boolean)[0] || '' };
  }
  return { owner: 'neocpt', name: 'recettes' };
})();
const API = `https://api.github.com/repos/${REPO.owner}/${REPO.name}`;
const ON_GITHUB = location.hostname.endsWith('.github.io');

// ---- réglages (stockés sur le téléphone)
const DEFAULT_BASICS = ['sel', 'poivre', 'eau', 'huile', 'sucre', 'farine'];
const store = {
  get(k, def) { try { const v = localStorage.getItem('recettes.' + k); return v == null ? def : JSON.parse(v); } catch { return def; } },
  set(k, v) { try { localStorage.setItem('recettes.' + k, JSON.stringify(v)); } catch { /* stockage indisponible */ } },
};
const cfg = () => ({ prenom: '', token: '', basiques: DEFAULT_BASICS, ...store.get('cfg', {}) });
const saveCfg = (patch) => store.set('cfg', { ...cfg(), ...patch });

// ---- liens vidéo
const VIDEO_RE = /https?:\/\/(?:www\.|m\.)?(?:instagram\.com\/(?:[\w.]+\/)?(?:p|reels?|tv)\/[\w-]+|tiktokv?\.com\/[^\s"'<>]*?(?:video|share\/video)\/\d+|(?:vm|vt)\.tiktok\.com\/[\w-]+|tiktok\.com\/t\/[\w-]+)[^\s"'<>]*/gi;
const findVideoUrls = (text) => [...new Set((String(text || '').match(VIDEO_RE) || []).map((u) => u.replace(/[).,;]+$/, '')))];

// ---- envoi d'une demande (= une issue GitHub, traitée automatiquement par le robot)
async function sendCommand(title, body) {
  const { token } = cfg();
  if (!token) throw new Error("Ajoute d'abord ton code d'accès dans les réglages ⚙️");
  const r = await fetch(`${API}/issues`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: `[recette] ${title}`, body }),
  });
  if (r.status === 401 || r.status === 403 || r.status === 404) throw new Error("Code d'accès refusé : vérifie-le dans les réglages ⚙️");
  if (!r.ok) throw new Error(`GitHub a répondu ${r.status}, réessaie dans un moment`);
  return r.json();
}

const addUrls = (urls, par) => sendCommand(urls.length > 1 ? `import (${urls.length})` : 'ajout', `par: ${par}\n${urls.join('\n')}`);

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
