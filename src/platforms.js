// Autres plateformes que Steam/Epic : GOG Galaxy, Ubisoft Connect, EA app, et jeux ajoutés à la main.
// Les visuels manquants sont cherchés une fois (GOG : API publique GOG ; sinon magasin Steam par nom)
// puis mis en cache dans art-cache.json.
const fs = require('fs');
const path = require('path');
const { regQuery, safeLoad } = require('./reg');
const { fillBuiltinArt } = require('./builtin-art');

function regTree(key) {
  try {
    const out = regQuery(key, ['/s']);
    const tree = {};
    let cur = null;
    for (const line of out.split(/\r?\n/)) {
      if (/^HKEY_/.test(line)) { cur = tree[line.trim()] = {}; continue; }
      const m = line.match(/^\s{4}(.+?)\s{4}REG_\w+\s{4}(.*)$/);
      if (m && cur) cur[m[1]] = m[2].trim();
    }
    return tree;
  } catch { return {}; }
}

const exists = (p) => { try { return !!p && fs.existsSync(p); } catch { return false; } };

function base(store, id, name, extra = {}) {
  return {
    key: `${store}:${id}`, store, platformId: String(id), name, developer: '', publisher: '',
    installed: false, needsUpdate: false, sizeOnDisk: 0, installDir: '', library: '',
    playtime: 0, lastPlayed: 0, releaseDate: 0, reviewPct: 0, controller: '', moods: [],
    favorite: false, hidden: false, processNames: [], art: { cover: '', hero: '', logo: '', header: '' },
    ...extra,
  };
}

function loadGog() {
  const games = [];
  const seen = new Set();
  for (const v of Object.values(regTree('HKLM\\SOFTWARE\\WOW6432Node\\GOG.com\\Games'))) {
    if (!v.gameID || !v.gameName || v.dependsOn) continue; // dependsOn = DLC
    if (seen.has(v.path)) continue;
    seen.add(v.path);
    const exe = v.exe || v.launchCommand || '';
    games.push(base('gog', v.gameID, v.gameName, {
      installed: exists(v.path), installDir: v.path || '', library: v.path ? path.dirname(v.path) : '',
      exe, workingDir: v.workingDir || v.path, launchParam: v.launchParam || '',
      buildId: v.buildId || '', ver: v.ver || v.version || '',
      processNames: exe ? [path.basename(exe).toLowerCase()] : [],
    }));
  }
  return games;
}

function loadUbisoft() {
  const games = [];
  for (const [k, v] of Object.entries(regTree('HKLM\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs'))) {
    const id = k.split('\\').pop();
    if (!/^\d+$/.test(id) || !v.InstallDir) continue;
    const dir = path.normalize(v.InstallDir);
    const name = path.basename(dir.replace(/[\\/]+$/, ''));
    games.push(base('ubisoft', id, name, { installed: exists(dir), installDir: dir, library: path.dirname(dir) }));
  }
  return games;
}

function loadEa() {
  const root = path.join(process.env.ProgramData || 'C:\\ProgramData', 'EA Desktop', 'InstallData');
  const games = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return games; }
  for (const d of dirs) {
    let offer = '';
    try { offer = (fs.readdirSync(path.join(root, d.name)).find((f) => f.startsWith('base-')) || '').slice(5); } catch { /* rien */ }
    if (!offer) continue;
    const name = d.name.replace(/([a-z])([A-Z])/g, '$1 $2'); // ItTakesTwo → It Takes Two
    // EA ne dit pas où le jeu est installé : c'est l'EA app qui lance ou propose l'installation.
    games.push(base('ea', offer, name, { managed: true }));
  }
  return games;
}

function loadCustom(list = []) {
  return list.filter((c) => c && c.id && c.exe).map((c) => base('custom', c.id, c.name, {
    installed: exists(c.exe), installDir: path.dirname(c.exe), library: path.dirname(path.dirname(c.exe)),
    exe: c.exe, args: c.args || '', workingDir: path.dirname(c.exe),
    processNames: [path.basename(c.exe).toLowerCase()],
    customCover: c.cover || '',
  }));
}

// ---------- Visuels ----------
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function steamArtByName(name) {
  const r = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=french&cc=FR`);
  if (!r.ok) return null;
  const items = ((await r.json()).items || []).filter((i) => i.type === 'app');
  const hit = items.find((i) => norm(i.name) === norm(name)) || items.find((i) => norm(i.name).startsWith(norm(name)));
  if (!hit) return null;
  const input = { ids: [{ appid: hit.id }], context: { language: 'french', country_code: 'FR' }, data_request: { include_assets: true, include_basic_info: true } };
  const r2 = await fetch(`https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`);
  const item = r2.ok ? (((await r2.json()).response || {}).store_items || [])[0] : null;
  const a = (item && item.assets) || {};
  const fmt = a.asset_url_format || `steam/apps/${hit.id}/\${FILENAME}`;
  const url = (f) => (f ? 'https://shared.akamai.steamstatic.com/store_item_assets/' + fmt.replace('${FILENAME}', f) : '');
  const devs = item && item.basic_info && item.basic_info.developers;
  return {
    steamAppId: hit.id,
    developer: devs && devs[0] ? devs[0].name : '',
    art: { cover: url(a.library_capsule), hero: url(a.library_hero), logo: '', header: url(a.header) },
  };
}

async function gogArt(id) {
  const r = await fetch(`https://api.gog.com/v2/games/${id}?locale=fr-FR`);
  if (!r.ok) return null;
  const j = await r.json();
  const l = j._links || {};
  const href = (k) => (l[k] && l[k].href) || '';
  const dev = ((j._embedded || {}).developers || [])[0];
  return {
    developer: dev ? dev.name : '',
    art: { cover: href('boxArtImage'), hero: href('galaxyBackgroundImage') || href('backgroundImage'), logo: href('logo'), header: href('backgroundImage') || href('galaxyBackgroundImage') },
  };
}

function applyArt(games, cache) {
  for (const g of games) {
    const c = cache[g.key];
    if (c) {
      g.art = { ...g.art, ...Object.fromEntries(Object.entries(c.art || {}).filter(([, v]) => v)) };
      if (!g.developer && c.developer) g.developer = c.developer;
      if (c.steamAppId) g.steamAppId = c.steamAppId;
    }
    if (g.customCover) g.art.cover = g.customCover;
    fillBuiltinArt(g); // visuels intégrés pour les jeux introuvables (LoL, VALORANT, Minecraft…)
  }
}

// Renvoie true si de nouveaux visuels ont été trouvés.
async function resolveArt(games, cache) {
  let changed = false;
  for (const g of games) {
    if (cache[g.key]) continue;
    try {
      cache[g.key] = (g.store === 'gog' ? await gogArt(g.platformId) : null) || (await steamArtByName(g.originalName || g.name)) || { art: {} };
      changed = true;
    } catch { /* hors ligne : on réessaiera au prochain lancement */ }
  }
  return changed;
}

function loadPlatforms(customList) {
  return [...safeLoad('GOG', loadGog), ...safeLoad('Ubisoft', loadUbisoft), ...safeLoad('EA', loadEa), ...safeLoad('jeux ajoutés', () => loadCustom(customList))];
}

module.exports = { loadPlatforms, applyArt, resolveArt, base };
