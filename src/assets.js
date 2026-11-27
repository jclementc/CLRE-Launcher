// Visuels personnalisés : jaquette, bannière, arrière-plan et logo, jeu par jeu.
// Un visuel perso prend le pas sur celui de la boutique ou des visuels intégrés ; le réinitialiser rétablit l'original.
//
// Les images sont copiées dans le dossier du launcher (servi par steamart://) et référencées dans
// prefs.assetOverrides = { [clé du jeu]: { cover?, header?, hero?, logo? } }.
//
// Point d'entrée pour de futures sources d'images (SteamGridDB…) : setFromUrl(key, type, url)
// télécharge une image https et l'enregistre exactement comme un fichier choisi sur le disque.
const fs = require('fs');
const path = require('path');

// Types de visuels. `aspect` et `hint` servent à l'interface et aux sources externes (filtrage des dimensions).
const ASSET_TYPES = {
  cover: { label: 'Jaquette', hint: 'Portrait, ex. 600×900 (grille de la bibliothèque)', aspect: 2 / 3 },
  header: { label: 'Bannière', hint: 'Paysage, ex. 920×430 (cartes, téléchargements)', aspect: 920 / 430 },
  hero: { label: 'Arrière-plan', hint: 'Très large, ex. 1920×620 (haut de la fiche du jeu)', aspect: 1920 / 620 },
  logo: { label: 'Logo', hint: 'PNG ou WebP à fond transparent', aspect: null },
};
const TYPE_IDS = Object.keys(ASSET_TYPES);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const MAX_BYTES = 20 * 1024 * 1024;
const SCHEME = 'steamart://local/';

const toUrl = (file) => SCHEME + encodeURIComponent(file);
const safe = (s) => String(s).replace(/[^\w-]/g, '_');

class Assets {
  // dir : dossier des images ; readPrefs/writePrefs : accès à prefs.json
  constructor({ dir, readPrefs, writePrefs }) {
    this.dir = dir;
    this.readPrefs = readPrefs;
    this.writePrefs = writePrefs;
  }

  static types() { return ASSET_TYPES; }
  static isType(t) { return TYPE_IDS.includes(t); }

  // Visuels perso d'un jeu, anciennes jaquettes (prefs.coverOverrides) comprises
  _all(p) {
    const out = {};
    for (const [k, url] of Object.entries(p.coverOverrides || {})) out[k] = { cover: url };
    for (const [k, o] of Object.entries(p.assetOverrides || {})) out[k] = { ...(out[k] || {}), ...o };
    return out;
  }

  get(key) { return this._all(this.readPrefs())[key] || {}; }

  // Applique les visuels perso à la liste de jeux. Ajoute g.artCustom = { cover: true, … } (et coverCustom).
  apply(games) {
    const all = this._all(this.readPrefs());
    for (const g of games) {
      const o = all[g.key];
      if (!o) continue;
      g.art = { ...g.art };
      g.artCustom = {};
      for (const t of TYPE_IDS) if (o[t]) { g.art[t] = o[t]; g.artCustom[t] = true; }
      if (g.artCustom.cover) g.coverCustom = true;
    }
  }

  // Enregistre un visuel à partir d'un fichier local
  setFromPath(key, type, file) {
    this._check(type);
    const ext = path.extname(String(file)).toLowerCase();
    if (!path.isAbsolute(file) || !IMAGE_EXT.has(ext)) throw new Error('Ce fichier n’est pas une image');
    if (fs.statSync(file).size > MAX_BYTES) throw new Error('Image trop lourde (20 Mo maximum)');
    return this._save(key, type, ext, (dest) => fs.copyFileSync(file, dest));
  }

  // Télécharge une image https et l'enregistre (source externe : SteamGridDB, etc.)
  async setFromUrl(key, type, url) {
    this._check(type);
    let u;
    try { u = new URL(url); } catch { throw new Error('Adresse invalide'); }
    if (u.protocol !== 'https:') throw new Error('Seules les adresses https sont acceptées');
    const r = await fetch(u, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`Téléchargement impossible (${r.status})`);
    const ext = MIME_EXT[(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()];
    if (!ext) throw new Error('Ce n’est pas une image');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error('Image trop lourde (20 Mo maximum)');
    return this._save(key, type, ext, (dest) => fs.writeFileSync(dest, buf));
  }

  // Rétablit un visuel d'origine, ou tous ceux du jeu si `type` est omis
  reset(key, type) {
    if (type !== undefined && type !== null) this._check(type);
    const p = this.readPrefs();
    const cur = this._all(p)[key];
    if (!cur) return false;
    const gone = type ? [type] : TYPE_IDS;
    for (const t of gone) { this._unlink(cur[t]); delete cur[t]; }
    this._write(p, key, cur);
    return true;
  }

  _check(type) { if (!Assets.isType(type)) throw new Error('Type de visuel inconnu'); }

  _save(key, type, ext, write) {
    key = String(key);
    fs.mkdirSync(this.dir, { recursive: true });
    const dest = path.join(this.dir, `${type}-${safe(key)}-${Date.now().toString(36)}${ext}`);
    write(dest);
    const p = this.readPrefs();
    const cur = this._all(p)[key] || {};
    this._unlink(cur[type]);
    cur[type] = toUrl(dest);
    this._write(p, key, cur);
    return cur[type];
  }

  // Réécrit les visuels d'un jeu et migre au passage l'ancien format (coverOverrides)
  _write(p, key, cur) {
    const all = this._all(p);
    if (Object.keys(cur).length) all[key] = cur; else delete all[key];
    p.assetOverrides = all;
    delete p.coverOverrides;
    this.writePrefs(p);
  }

  // Supprime une image du dossier du launcher (jamais un fichier ailleurs)
  _unlink(url) {
    if (typeof url !== 'string' || !url.startsWith(SCHEME)) return;
    try {
      const f = path.normalize(decodeURIComponent(url.slice(SCHEME.length)));
      if (f.toLowerCase().startsWith(this.dir.toLowerCase() + path.sep)) fs.rmSync(f, { force: true });
    } catch { /* déjà supprimée */ }
  }
}

module.exports = { Assets, ASSET_TYPES };
