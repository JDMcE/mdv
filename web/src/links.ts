// Client-side view of every file in the vault, and link resolution that
// mirrors the server's (internal/index/links.go) Obsidian-style rules.

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)$/i;
const NOTE_EXT = /\.md$/i;

export const isImage = (p: string) => IMAGE_EXT.test(p);
export const isNote = (p: string) => NOTE_EXT.test(p);
export const isPdf = (p: string) => /\.pdf$/i.test(p);

export const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
export const dirname = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
export const stripMd = (p: string) => p.replace(NOTE_EXT, "");

/** Normalise "a/./b/../c" style paths; returns null if it climbs above the root. */
export function normalize(p: string): string | null {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  return out.join("/");
}

class VaultFiles {
  private all = new Set<string>();
  private byName = new Map<string, string[]>();
  /** Bumped on every change, so caches (e.g. decorations) can invalidate. */
  version = 0;

  update(paths: string[]) {
    this.all = new Set(paths);
    this.byName.clear();
    for (const p of paths) {
      const k = basename(p).toLowerCase();
      const list = this.byName.get(k);
      list ? list.push(p) : this.byName.set(k, [p]);
    }
    this.version++;
  }

  has(p: string) {
    return this.all.has(p);
  }

  get paths(): string[] {
    return [...this.all];
  }

  /** How many files share this base name (to decide if [[name]] is unambiguous). */
  nameCount(p: string) {
    return this.byName.get(basename(p).toLowerCase())?.length ?? 0;
  }

  /**
   * Resolve a link target written in note `from`. Wikilinks try the note's
   * folder, then the vault root, then a name match anywhere (same folder
   * first, then shortest path). Markdown links are relative to the note.
   */
  resolve(target: string, from: string, wiki = true): string | null {
    let t = target.trim().replace(/^\/+/, "");
    if (!wiki) {
      try {
        t = decodeURIComponent(t);
      } catch {}
    }
    if (!t) return null;
    const dir = dirname(from);
    const variants = (p: string) => (/\.[^/.]+$/.test(basename(p)) ? [p, p + ".md"] : [p + ".md", p]);
    const tryPaths = (base: string | null) => {
      if (base === null) return null;
      for (const c of variants(base)) if (this.all.has(c)) return c;
      return null;
    };
    const rel = tryPaths(normalize(dir ? dir + "/" + t : t));
    if (rel) return rel;
    const abs = tryPaths(normalize(t));
    if (abs) return abs;
    if (!wiki) return null;

    for (const c of variants(t)) {
      const cands = this.byName.get(basename(c).toLowerCase());
      if (!cands) continue;
      let best: string | null = null;
      for (const p of cands) {
        if (t.includes("/") && !p.toLowerCase().endsWith(c.toLowerCase())) continue;
        if (dirname(p) === dir) return p;
        if (best === null || p.length < best.length || (p.length === best.length && p < best)) best = p;
      }
      if (best) return best;
    }
    return null;
  }

  /** Shortest link text that resolves to `path` from anywhere. */
  linkText(path: string): string {
    const name = isNote(path) ? stripMd(basename(path)) : basename(path);
    return this.nameCount(path) <= 1 ? name : isNote(path) ? stripMd(path) : path;
  }
}

export const vaultFiles = new VaultFiles();

export interface WikiLink {
  embed: boolean;
  target: string; // path or name, no #/|
  subpath: string; // "#heading" or "#^block", including the #
  alias: string; // display text after |, or ""
}

/** Matches [[...]] and ![[...]] (non-greedy, single line). */
export const WIKI_RE = /(!?)\[\[([^\[\]\n]+?)\]\]/g;

export function parseWiki(inner: string, embed = false): WikiLink {
  let target = inner;
  let alias = "";
  const pipe = target.indexOf("|");
  if (pipe >= 0) {
    alias = target.slice(pipe + 1);
    target = target.slice(0, pipe);
  }
  let subpath = "";
  const hash = target.search(/[#^]/);
  if (hash >= 0) {
    subpath = target[hash] === "^" ? "#" + target.slice(hash) : target.slice(hash);
    target = target.slice(0, hash);
  }
  return { embed, target: target.trim(), subpath, alias: alias.trim() };
}

/** Parse an image size hint: "300" or "300x200". */
export function parseSize(s: string): { width?: number; height?: number } | null {
  const m = /^\s*(\d+)(?:\s*x\s*(\d+))?\s*$/.exec(s);
  if (!m) return null;
  return { width: Number(m[1]), height: m[2] ? Number(m[2]) : undefined };
}
