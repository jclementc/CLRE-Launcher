// CLRE-Launcher : simplifier, rendre cohérent, rendre fluide.
/* global state, api, VIEWS, ICONS, esc, render, go, back, load, loading, emptyBox, byId, games, toast, toastUndo, modal, doAction,
   gameTabs, gameTabContent, saveLocal, platIcon, storeOf, readExtraSettings, applyLook, sync, fmtRel */

// ---------- 1 · Fiche d'un jeu : 4 onglets ----------
const TAB_GROUP = { news: 'overview', shots: 'overview', sessions: 'activity', journal: 'activity', perf: 'activity', saves: 'files', mods: 'files' };
const SUBS = { activity: [['sessions', 'Sessions'], ['journal', 'Journal'], ['perf', 'Performances']], files: [['saves', 'Sauvegardes'], ['mods', 'Mods']] };
const _gameTabsU = gameTabs;
const _gameTabContentU = gameTabContent;
function withTab(tab, fn) { const keep = state.route.tab; state.route.tab = tab; try { return fn(); } finally { state.route.tab = keep; } }
// eslint-disable-next-line no-global-assign
gameTabs = function (g) {
  // On garde les onglets que la fiche propose vraiment (succès seulement si Steam, mods seulement si Workshop…)
  const avail = new Set([...withTab(state.route.tab, () => _gameTabsU(g)).matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]));
  const cur = state.route.tab || 'overview';
  const tabs = [['overview', 'Aperçu'], ...(avail.has('achievements') ? [['achievements', 'Succès']] : []), ['activity', 'Activité'], ['files', 'Fichiers']]
    .filter(([id]) => id !== 'files' || avail.has('saves') || avail.has('mods'));
  return `<nav class="tabs" aria-label="Sections du jeu">${tabs.map(([id, l]) => `<button type="button" class="${cur === id ? 'on' : ''}" data-tab="${id}">${l}</button>`).join('')}</nav>`;
};
// eslint-disable-next-line no-global-assign
gameTabContent = function (g) {
  const tab = state.route.tab;
  if (SUBS[tab]) {
    const avail = new Set([...withTab('overview', () => _gameTabsU(g)).matchAll(/data-tab="([^"]+)"/g)].map((m) => m[1]));
    const subs = SUBS[tab].filter(([id]) => avail.has(id) || id === 'perf' || id === 'journal');
    const sub = subs.find(([id]) => id === state.route.sub) ? state.route.sub : subs[0][0];
    return `<div class="sub-tabs seg-chips" role="tablist">${subs.map(([id, l]) => `<button type="button" class="${sub === id ? 'on' : ''}" data-sub="${id}">${l}</button>`).join('')}</div>
      <div class="sub-body">${withTab(sub, () => _gameTabContentU(g))}</div>`;
  }
  return _gameTabContentU(g);
};
document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-sub],[data-tab]');
  if (!t) return;
  if (t.dataset.sub) { e.stopPropagation(); state.route = { ...state.route, sub: t.dataset.sub }; render({ quiet: true }); return; }
  // Anciens onglets (liens, notifications) : on les range dans le bon groupe
  const grp = TAB_GROUP[t.dataset.tab];
  if (grp) { e.stopPropagation(); state.route = { ...state.route, tab: grp === 'overview' ? undefined : grp, sub: t.dataset.tab }; render({ quiet: true }); }
}, true);

// Aperçu : actualités et captures à la suite
function overviewExtras(g) {
  const avail = withTab('overview', () => _gameTabsU(g));
  let html = '';
  if (/data-tab="news"/.test(avail)) { const n = withTab('news', () => _gameTabContentU(g)); if (n && !/class="empty"/.test(n)) html += `<section class="stack ov-extra"><h2 class="section">Actualités</h2>${n}</section>`; }
  if (/data-tab="shots"/.test(avail)) { const s = withTab('shots', () => _gameTabContentU(g)); if (s && !/class="empty"/.test(s)) html += `<section class="stack ov-extra"><h2 class="section">Tes captures</h2>${s}</section>`; }
  return html;
}

// ---------- 2 · Accueil personnalisable ----------
const homeHidden = () => new Set(state.local.homeHidden || []);
function homeSections() {
  return [...document.querySelectorAll('#view > section, #view > .stack')].map((s) => {
    const h = s.querySelector('h2');
    return h && s.id !== 'home-hero' ? { el: s, name: h.textContent.trim() } : null;
  }).filter(Boolean);
}
function openHomeCustomizer() {
  const names = [...new Set([...homeSections().map((x) => x.name), ...(state.local.homeHidden || [])])];
  const hid = homeHidden();
  modal(`<h2>Personnaliser l’accueil</h2><p>Choisis les rangées que tu veux voir sur « Pour toi ».</p>
    <div class="home-toggles">${names.map((n) => `<label class="row row-switch hc"><span class="row-label">${esc(n)}</span><input type="checkbox" data-home-sec="${esc(n)}" ${hid.has(n) ? '' : 'checked'}></label>`).join('')}</div>
    <div class="m-actions"><button type="button" class="btn btn-primary" data-close>Terminé</button></div>`, (dlg) => {
    dlg.addEventListener('change', (e) => {
      const n = e.target.dataset.homeSec;
      if (!n) return;
      const h = homeHidden();
      if (e.target.checked) h.delete(n); else h.add(n);
      state.local.homeHidden = [...h];
      saveLocal();
      render({ quiet: true });
    });
  });
}

// ---------- 3 · Une seule recherche ----------
const shopViews = ['shop', 'shopapp', 'wishlist'];
const searchBox = document.getElementById('search');
const setSearchHint = () => { searchBox.placeholder = shopViews.includes(state.route.view) ? 'Rechercher sur le magasin Steam' : 'Rechercher'; };
searchBox.addEventListener('input', (e) => { if (shopViews.includes(state.route.view)) e.stopImmediatePropagation(); }, true);
searchBox.addEventListener('keydown', (e) => {
  if (!shopViews.includes(state.route.view)) return;
  if (e.key === 'Enter') {
    e.stopImmediatePropagation(); e.preventDefault();
    state.shop = { ...state.shop, tab: 'home', q: searchBox.value.trim(), tag: '', count: 40 };
    go({ view: 'shop' });
  }
}, true);

// ---------- 7 · Jaquettes de secours ----------
function fallbackArt(el, g) {
  if (!el || el.querySelector('.fb-art')) return;
  el.classList.add('noart');
  el.insertAdjacentHTML('afterbegin', `<span class="fb-art" aria-hidden="true">${typeof platIcon === 'function' ? platIcon(g.store || 'steam', 30) : ''}<b>${esc(g.name)}</b><small>${esc(storeOf(g))}</small></span>`);
}
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!img || img.tagName !== 'IMG') return;
  const host = img.closest('.cover, .tile');
  if (!host) return;
  const card = img.closest('[data-open]');
  const g = card && byId(card.dataset.open);
  img.remove();
  if (g) fallbackArt(host, g);
}, true);
function fixMissingArt() {
  document.querySelectorAll('[data-open] .cover img, [data-open].tile > img').forEach((img) => {
    const src = img.getAttribute('src');
    if (src && src !== 'undefined') return;
    const card = img.closest('[data-open]');
    const g = card && byId(card.dataset.open);
    const host = img.closest('.cover, .tile');
    img.remove();
    if (g && host) fallbackArt(host, g);
  });
}

// ---------- 9 · Réglages appliqués tout de suite ----------
let prefTimer = null;
function autoSavePrefs(form, now) {
  clearTimeout(prefTimer);
  prefTimer = setTimeout(async () => {
    const f = new FormData(form);
    const patch = {
      system: { closeToTray: !!f.get('closeToTray'), shortcut: !!f.get('shortcut'), autostart: !!f.get('autostart') },
      settings: readExtraSettings(f),
    };
    let resync = false;
    if (f.get('steamId') && state.lib && f.get('steamId') !== state.lib.user.id64) { patch.steamId = f.get('steamId'); resync = true; }
    if (f.get('apiKey')) { patch.apiKey = String(f.get('apiKey')).trim(); resync = true; form.querySelector('[name="apiKey"]').value = ''; }
    if (f.get('clearKey')) { patch.apiKey = null; resync = true; }
    if (f.get('sgdbKey')) { patch.sgdbKey = String(f.get('sgdbKey')).trim(); form.querySelector('[name="sgdbKey"]').value = ''; }
    if (f.get('clearSgdbKey')) patch.sgdbKey = null;
    await api.setPrefs(patch);
    if (state.prefs) state.prefs.settings = { ...(state.prefs.settings || {}), ...patch.settings };
    if (typeof applyLook === 'function') applyLook();
    form.classList.remove('dirty');
    const s = form.querySelector('.prefs-saved');
    if (s) { s.classList.remove('show'); void s.offsetWidth; s.classList.add('show'); }
    if (resync) { for (const k of ['friends', 'wishlist']) delete state.cache[k]; state.cache.ach = {}; sync(true); }
    render({ quiet: true });
  }, now ? 0 : 450);
}
new MutationObserver(() => {
  const dlg = document.getElementById('settings');
  const form = dlg && dlg.querySelector('.prefs-form');
  if (!form || form.dataset.auto) return;
  form.dataset.auto = '1';
  const foot = form.querySelector('.prefs-foot');
  if (foot) foot.innerHTML = '<span class="prefs-saved">Enregistré</span><span class="prefs-hint">Les changements s’appliquent tout de suite</span><button type="button" class="btn btn-ghost" data-close-prefs>Fermer</button>';
  form.addEventListener('change', (e) => { if (e.target.id !== 'prefs-q' && e.target.type !== 'password') autoSavePrefs(form, true); });
  form.addEventListener('input', (e) => { if (e.target.id !== 'prefs-q' && e.target.type !== 'password' && e.target.tagName === 'INPUT' && e.target.type === 'text') autoSavePrefs(form); });
  form.addEventListener('focusout', (e) => { if (e.target.name === 'apiKey' && e.target.value) autoSavePrefs(form, true); });
  form.addEventListener('click', (e) => { if (e.target.closest('[data-close-prefs]')) { e.preventDefault(); dlg.close(); } });
  // Les dossiers choisis (sauvegardes, PresentMon) remplissent des champs cachés : on enregistre aussi à la fermeture
  dlg.addEventListener('close', () => { if (form.isConnected) autoSavePrefs(form, true); }, { once: true });
  // Les boutons de couleur d'accent et de thème posent des valeurs sans « change » natif : on écoute les clics aussi
  form.addEventListener('click', (e) => { if (e.target.closest('.swatches, .seg-chips label')) setTimeout(() => autoSavePrefs(form, true), 30); });
}).observe(document.getElementById('settings'), { childList: true, subtree: true });

// ---------- 10 · Transitions ----------
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const _goU = go;
// eslint-disable-next-line no-global-assign
go = function (route, push = true) {
  if (reduce || !document.startViewTransition) return _goU(route, push);
  // La route change tout de suite (le reste du code peut la lire), seul l'affichage est animé
  const c = document.getElementById('content');
  if (push) state.history.push({ ...state.route, scroll: c.scrollTop });
  state.route = route;
  document.startViewTransition(() => { c.scrollTo({ top: 0 }); render(); });
  return undefined;
};
// La jaquette cliquée « devient » l'image de la fiche
document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-open]');
  if (!card || e.target.closest('[data-act]')) return;
  document.querySelectorAll('[style*="view-transition-name"]').forEach((el) => { el.style.viewTransitionName = ''; });
  const art = card.querySelector('.cover img, img');
  if (art) art.style.viewTransitionName = 'game-art';
}, true);

// ---------- 12 · Centre de notifications ----------
let inbox = [];
let unread = 0;
const bell = document.createElement('button');
bell.type = 'button';
bell.className = 'icon-btn bell';
bell.setAttribute('aria-label', 'Notifications');
bell.title = 'Notifications';
bell.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg><span class="badge" hidden></span>';
const right = document.querySelector('.topbar-right');
right.insertBefore(bell, right.querySelector('[data-act="couch"]'));
const seenKey = () => Number(state.local.inboxSeen || 0);
function updateBell() {
  unread = inbox.filter((x) => x.t > seenKey()).length;
  const b = bell.querySelector('.badge');
  b.hidden = !unread;
  b.textContent = unread > 9 ? '9+' : String(unread);
}
api.inboxGet().then((l) => { inbox = l || []; updateBell(); }).catch(() => {});
api.onInbox((item) => { inbox = [item, ...inbox].slice(0, 50); updateBell(); });
const KIND_ICON = { downloads: ICONS.download, promos: ICONS.bag || ICONS.heart, friends: ICONS.heart, updates: ICONS.download, storage: ICONS.disk || ICONS.drive, recaps: ICONS.recap || ICONS.star, party: ICONS.party || ICONS.star };
function toggleInbox() {
  const open = document.getElementById('inbox');
  if (open) { open.remove(); return; }
  const p = document.createElement('div');
  p.id = 'inbox';
  p.className = 'inbox';
  const ago = (t) => (typeof fmtRel === 'function' ? fmtRel(Math.floor(t / 1000)) : new Date(t).toLocaleString('fr-FR'));
  p.innerHTML = `<div class="ib-head"><b>Notifications</b>${inbox.length ? '<button type="button" class="link-btn" data-ib-clear>Tout effacer</button>' : ''}</div>
    <div class="ib-list">${inbox.length ? inbox.map((x, i) => `<button type="button" class="ib-item ${x.t > seenKey() ? 'new' : ''}" data-ib="${i}"><span class="ib-ic">${KIND_ICON[x.kind] || ICONS.star}</span><span class="ib-txt"><b>${esc(x.title)}</b><span>${esc(x.body || '')}</span><small>${esc(ago(x.t))}</small></span></button>`).join('') : '<div class="ib-empty">Rien de nouveau. Téléchargements, promos, soirées et récaps apparaîtront ici.</div>'}</div>`;
  document.body.appendChild(p);
  const r = bell.getBoundingClientRect();
  p.style.top = `${r.bottom + 8}px`;
  p.style.right = `${window.innerWidth - r.right}px`;
  requestAnimationFrame(() => p.classList.add('on'));
  state.local.inboxSeen = Date.now(); saveLocal(); updateBell();
  p.addEventListener('click', async (e) => {
    if (e.target.closest('[data-ib-clear]')) { await api.inboxClear(); inbox = []; p.remove(); updateBell(); return; }
    const it = e.target.closest('[data-ib]');
    if (!it) return;
    const x = inbox[Number(it.dataset.ib)];
    p.remove();
    if (x && x.route) go(x.route);
  });
}
bell.addEventListener('click', (e) => { e.stopPropagation(); toggleInbox(); });
document.addEventListener('mousedown', (e) => { const p = document.getElementById('inbox'); if (p && !p.contains(e.target) && !bell.contains(e.target)) p.remove(); }, true);

// ---------- Après chaque rendu ----------
const _renderU = render;
// eslint-disable-next-line no-global-assign
render = function (opts) {
  // Onglet d'origine (lien, notification) → son groupe
  const r = state.route;
  if (r.view === 'game' && TAB_GROUP[r.tab]) state.route = { ...r, tab: TAB_GROUP[r.tab] === 'overview' ? undefined : TAB_GROUP[r.tab], sub: r.tab };
  _renderU(opts);
  setSearchHint();
  fixMissingArt();
  if (state.route.view === 'game' && (!state.route.tab || state.route.tab === 'overview')) {
    const g = byId(state.route.id);
    const cols = document.querySelector('#view .cols');
    if (g && cols && !document.querySelector('.ov-extra')) cols.insertAdjacentHTML('afterend', overviewExtras(g));
  }
  if (state.route.view === 'home') {
    const hid = homeHidden();
    homeSections().forEach(({ el, name }) => { el.hidden = hid.has(name); });
    if (!document.getElementById('home-custom')) document.getElementById('view').insertAdjacentHTML('beforeend', `<div class="home-custom" id="home-custom"><button type="button" class="btn btn-ghost" data-act="home-custom">Personnaliser l’accueil</button>${hid.size ? `<small>${hid.size} rangée${hid.size > 1 ? 's' : ''} masquée${hid.size > 1 ? 's' : ''}</small>` : ''}</div>`);
  }
  // L'image de la fiche reçoit le nom de la transition
  const hero = document.querySelector('#game-hero img.bg');
  if (hero) hero.style.viewTransitionName = 'game-art';
};
const _doActionU = doAction;
// eslint-disable-next-line no-global-assign
doAction = async function (act, id, el) {
  if (act === 'home-custom') return openHomeCustomizer();
  return _doActionU(act, id, el);
};
