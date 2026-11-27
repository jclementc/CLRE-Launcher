// Sauvegarde des sauvegardes de jeux, à partir de la base communautaire Ludusavi
// (https://github.com/mtkennerly/ludusavi-manifest) qui dit où chaque jeu range ses fichiers.
const fs = require('fs');
const path = require('path');
const { writeAtomic } = require('./fsutil');
const os = require('os');
const { Worker } = require('worker_threads');

const MANIFEST_URL = 'https://raw.githubusercontent.com/mtkennerly/ludusavi-manifest/master/data/manifest.yaml';
const KEEP = 10; // instantanés gardés par jeu

class Saves {
  constructor({ dataDir, documents, getBackupDir }) {
    this.dataDir = dataDir;
    this.documents = documents;
    this.getBackupDir = getBackupDir;
    this.index = null;
    this.indexing = null;
  }

  get manifestFile() { return path.join(this.dataDir, 'ludusavi-manifest.yaml'); }
  get indexFile() { return path.join(this.dataDir, 'ludusavi-index.json'); }

  async ensureManifest() {
    let age = Infinity;
    try { age = Date.now() - fs.statSync(this.manifestFile).mtimeMs; } catch { /* absent */ }
    if (age < 7 * 86400e3) return;
    try {
      const r = await fetch(MANIFEST_URL);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      writeAtomic(this.manifestFile, Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      if (age === Infinity) throw new Error(`Impossible de télécharger la base des sauvegardes (${e.message})`);
    }
  }

  // Index des jeux de la bibliothèque présents dans la base, recalculé si la bibliothèque change.
  async buildIndex(games) {
    const sig = games.map((g) => g.key).sort().join('|').length + ':' + games.length;
    if (this.index && this.index.sig === sig) return this.index.data;
    try {
      const cached = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'));
      const mtime = fs.statSync(this.manifestFile).mtimeMs;
      if (cached.sig === sig && cached.mtime === mtime) { this.index = cached; return cached.data; }
    } catch { /* à reconstruire */ }
    if (this.indexing) return this.indexing;
    this.indexing = (async () => {
      await this.ensureManifest();
      const list = games.map((g) => ({ key: g.key, name: g.originalName || g.name, steamId: g.store === 'steam' ? g.appid : g.steamAppId, gogId: g.store === 'gog' ? g.platformId : null }));
      const data = await new Promise((resolve, reject) => {
        // Dans l'exe, le worker est sorti de l'archive asar (asarUnpack)
        const workerFile = path.join(__dirname, 'saves-worker.js').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
        const w = new Worker(workerFile, { workerData: { file: this.manifestFile, games: list }, resourceLimits: { maxOldGenerationSizeMb: 1024 } });
        w.once('message', resolve);
        w.once('error', reject);
      });
      this.index = { sig, mtime: fs.statSync(this.manifestFile).mtimeMs, data };
      writeAtomic(this.indexFile, JSON.stringify(this.index));
      return data;
    })();
    try { return await this.indexing; } finally { this.indexing = null; }
  }

  // ---------- Résolution des chemins ----------
  placeholders(g, steamAccountId) {
    const home = os.homedir();
    const env = process.env;
    return {
      '<home>': home,
      '<winAppData>': env.APPDATA || path.join(home, 'AppData', 'Roaming'),
      '<winLocalAppData>': env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
      '<winLocalAppDataLow>': path.join(home, 'AppData', 'LocalLow'),
      '<winDocuments>': this.documents,
      '<winPublic>': env.PUBLIC || 'C:\\Users\\Public',
      '<winProgramData>': env.ProgramData || 'C:\\ProgramData',
      '<winDir>': env.WINDIR || 'C:\\Windows',
      '<base>': g.installDir || null,
      '<game>': g.installDir ? path.basename(g.installDir) : null,
      '<root>': g.library || null,
      '<storeUserId>': steamAccountId || '*',
      '<storeGameId>': '*',
      '<osUserName>': os.userInfo().username,
    };
  }

  expand(pattern, g, steamAccountId) {
    let p = pattern;
    for (const [k, v] of Object.entries(this.placeholders(g, steamAccountId))) {
      if (!p.includes(k)) continue;
      if (v == null) return [];
      p = p.split(k).join(v.replace(/\\/g, '/'));
    }
    if (/<[a-zA-Z]+>/.test(p)) return [];
    return globPaths(p);
  }

  async find(g, games, steamAccountId) {
    const idx = await this.buildIndex(games);
    const e = idx[g.key];
    if (!e) return { known: false };
    const found = new Map();
    for (const f of e.files) {
      for (const p of this.expand(f.pattern, g, steamAccountId)) {
        if (isInside(p, g.installDir) && f.tags.includes('config') && !f.tags.includes('save')) continue;
        found.set(path.normalize(p), f.tags);
      }
    }
    // Un fichier déjà contenu dans un dossier trouvé n'est pas copié deux fois
    const all = [...found.keys()];
    const paths = [...found.entries()]
      .filter(([p]) => !all.some((o) => o !== p && isInside(p, o)))
      .map(([p, tags]) => ({ path: p, tags, size: sizeOf(p) }));
    return { known: true, name: e.name, cloud: !!(e.cloud && (e.cloud.steam || e.cloud.epic || e.cloud.gog)), registry: e.registry, paths, total: paths.reduce((s, x) => s + x.size, 0) };
  }

  gameDir(g) { return path.join(this.getBackupDir(), safe(g.originalName || g.name)); } // nom d'origine : renommer un jeu ne doit pas orpheliner ses sauvegardes

  list(g) {
    const dir = this.gameDir(g);
    let snaps = [];
    try { snaps = fs.readdirSync(dir).filter((d) => /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(d)).sort().reverse(); } catch { return []; }
    return snaps.map((s) => {
      let meta = {};
      try { meta = JSON.parse(fs.readFileSync(path.join(dir, s, 'clre-backup.json'), 'utf8')); } catch { /* ancien format */ }
      return { id: s, time: meta.time || 0, size: meta.size || 0, files: (meta.entries || []).length, reason: meta.reason || '' };
    });
  }

  async backup(g, games, steamAccountId, reason = 'manuel') {
    const res = await this.find(g, games, steamAccountId);
    if (!res.known) throw new Error('Ce jeu n’est pas dans la base des sauvegardes');
    if (!res.paths.length) throw new Error('Aucune sauvegarde trouvée sur ce PC pour ce jeu');
    const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
    const dest = path.join(this.gameDir(g), stamp);
    fs.mkdirSync(dest, { recursive: true });
    const entries = [];
    res.paths.forEach((p, i) => {
      const rel = `${i}_${safe(path.basename(p.path))}`;
      fs.cpSync(p.path, path.join(dest, rel), { recursive: true, force: true, errorOnExist: false });
      entries.push({ src: p.path, rel });
    });
    fs.writeFileSync(path.join(dest, 'clre-backup.json'), JSON.stringify({ game: g.name, key: g.key, time: Math.floor(Date.now() / 1000), size: res.total, reason, entries }, null, 2));
    // On ne garde que les derniers instantanés
    for (const old of this.list(g).slice(KEEP)) fs.rmSync(path.join(this.gameDir(g), old.id), { recursive: true, force: true });
    return { id: stamp, size: res.total, files: entries.length };
  }

  restore(g, id) {
    const dir = path.join(this.gameDir(g), id);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'clre-backup.json'), 'utf8'));
    // Filet de sécurité : l'état actuel est copié à côté avant d'être remplacé
    const safety = path.join(this.gameDir(g), `avant-restauration_${Date.now()}`);
    for (const e of meta.entries) {
      if (fs.existsSync(e.src)) fs.cpSync(e.src, path.join(safety, e.rel), { recursive: true, force: true });
      fs.mkdirSync(path.dirname(e.src), { recursive: true });
      fs.cpSync(path.join(dir, e.rel), e.src, { recursive: true, force: true });
    }
    return { restored: meta.entries.length, safety };
  }
}

// ---------- Outils fichiers ----------
const safe = (s) => String(s).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'jeu';
const isInside = (p, dir) => !!dir && path.normalize(p).toLowerCase().startsWith(path.normalize(dir).toLowerCase() + path.sep);

function sizeOf(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    return fs.readdirSync(p).reduce((s, f) => s + sizeOf(path.join(p, f)), 0);
  } catch { return 0; }
}

// Développe un motif avec * et ** (segments séparés par /) en chemins existants.
function globPaths(pattern) {
  const parts = pattern.split('/').filter((s, i) => s !== '' || i === 0);
  let roots = [parts[0].endsWith(':') ? parts[0] + '\\' : parts[0] || '/'];
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i];
    const next = [];
    if (seg === '**') {
      for (const r of roots) collectDirs(r, next, 6);
    } else if (/[*?]/.test(seg)) {
      const re = new RegExp('^' + seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
      for (const r of roots) { try { for (const f of fs.readdirSync(r)) if (re.test(f)) next.push(path.join(r, f)); } catch { /* rien */ } }
    } else {
      for (const r of roots) { const p = path.join(r, seg); if (fs.existsSync(p)) next.push(p); }
    }
    roots = next;
    if (!roots.length || roots.length > 2000) return roots.length > 2000 ? [] : roots;
  }
  return roots.filter((p) => fs.existsSync(p));
}

function collectDirs(dir, out, depth) {
  out.push(dir);
  if (!depth) return;
  try { for (const f of fs.readdirSync(dir, { withFileTypes: true })) if (f.isDirectory()) collectDirs(path.join(dir, f.name), out, depth - 1); } catch { /* rien */ }
}

module.exports = { Saves };
