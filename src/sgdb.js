// Client SteamGridDB (API v2). Tourne dans le processus principal : la clé API ne passe jamais côté interface.
// Doc : https://www.steamgriddb.com/api/v2
//
// SteamGridDB ne distingue pas « bannière » et « arrière-plan » : les deux viennent de la catégorie « heroes ».
const { readJsonSafe, writeJsonAtomic } = require('./fsutil');

const BASE = 'https://www.steamgriddb.com/api/v2';
const PAGE = 50; // taille de page fixée par l'API

// Pour chaque type de visuel du launcher : catégorie SteamGridDB et filtres (images fixes ; le contenu NSFW dépend du réglage)
const KINDS = {
  cover: { path: 'grids', params: { dimensions: '600x900,342x482,660x930', types: 'static' } },
  header: { path: 'heroes', params: { types: 'static' } },
  hero: { path: 'heroes', params: { types: 'static' } },
  logo: { path: 'logos', params: { types: 'static' } },
};

// Adresses d'images acceptées pour le téléchargement (CDN de SteamGridDB uniquement)
const isSgdbImage = (url) => { try { const u = new URL(url); return u.protocol === 'https:' && /(^|\.)steamgriddb\.com$/i.test(u.hostname); } catch { return false; } };

class SteamGridDb {
  // getKey : () => clé API ; cacheFile : correspondances jeu du launcher -> jeu SteamGridDB
  constructor({ getKey, getNsfw = () => false, cacheFile }) {
    this.getKey = getKey;
    this.getNsfw = getNsfw;
    this.cacheFile = cacheFile;
    this.ids = readJsonSafe(cacheFile, {});
  }

  get hasKey() { return !!this.getKey(); }

  async _get(route, params = {}) {
    const key = this.getKey();
    if (!key) throw new Error('Ajoute ta clé API SteamGridDB dans Réglages › Général');
    const q = new URLSearchParams({ nsfw: this.getNsfw() ? 'any' : 'false', humor: 'false', ...params }).toString();
    let r;
    try {
      r = await fetch(`${BASE}${route}${q ? '?' + q : ''}`, { headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'CLRE-Launcher' }, signal: AbortSignal.timeout(20000) });
    } catch { throw new Error('SteamGridDB est injoignable (hors ligne ?)'); }
    if (r.status === 401 || r.status === 403) throw new Error('Clé API SteamGridDB refusée : vérifie-la dans les réglages');
    if (r.status === 404) return null;
    if (r.status === 429) throw new Error('Trop de requêtes vers SteamGridDB, réessaie dans un instant');
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.success === false) throw new Error((j && j.errors && j.errors[0]) || `SteamGridDB a répondu ${r.status}`);
    return j.data;
  }

  // Vérifie la clé (renvoie true, ou lève une erreur lisible)
  async test() { await this._get('/search/autocomplete/portal'); return true; }

  search(term) {
    const t = String(term || '').trim();
    return t ? this._get('/search/autocomplete/' + encodeURIComponent(t)).then((d) => (d || []).slice(0, 15).map((x) => ({ id: x.id, name: x.name, year: x.release_date ? new Date(x.release_date * 1000).getFullYear() : null }))) : Promise.resolve([]);
  }

  // Jeu SteamGridDB correspondant à un jeu du launcher : choix manuel, sinon AppID Steam, sinon recherche par nom
  async resolve(g) {
    const hit = this.ids[g.key];
    if (hit) return hit;
    let found = null;
    const appid = g.store === 'steam' ? g.appid : g.steamAppId;
    if (appid) { const d = await this._get(`/games/steam/${appid}`); if (d) found = { id: d.id, name: d.name }; }
    if (!found) { const d = await this._get('/search/autocomplete/' + encodeURIComponent(g.originalName || g.name)); if (d && d[0]) found = { id: d[0].id, name: d[0].name }; }
    if (!found) throw new Error(`« ${g.originalName || g.name} » est introuvable sur SteamGridDB`);
    return found;
  }

  // Mémorise la correspondance (automatique, ou choisie par l'utilisateur quand la détection se trompe)
  remember(key, game) { this.ids[key] = { id: game.id, name: game.name }; this._save(); }
  forget(key) { delete this.ids[key]; this._save(); }
  _save() { try { writeJsonAtomic(this.cacheFile, this.ids, true); } catch { /* cache facultatif */ } }

  // Visuels proposés pour un type, du plus populaire au moins populaire (ordre de l'API)
  async options(g, type, page = 0) {
    const kind = KINDS[type];
    if (!kind) throw new Error('Type de visuel inconnu');
    const game = await this.resolve(g);
    this.remember(g.key, game);
    const data = (await this._get(`/${kind.path}/game/${game.id}`, { ...kind.params, page: String(page) })) || [];
    return {
      game,
      more: data.length >= PAGE,
      items: data.filter((x) => isSgdbImage(x.url)).map((x) => ({ id: x.id, url: x.url, thumb: isSgdbImage(x.thumb) ? x.thumb : x.url, width: x.width, height: x.height, score: x.score, style: x.style, author: x.author && x.author.name })),
    };
  }
}

module.exports = { SteamGridDb, isSgdbImage, KINDS };
