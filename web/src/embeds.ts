// Note transclusion (![[note]], ![[note#Heading]], ![[note#^block]]): fetching
// and caching embedded notes, and cutting out the embedded section.

import { api } from "./api";

const cache = new Map<string, Promise<string>>();

/** Bumped when any cached note changes, so embed widgets know to re-render. */
export let embedVersion = 0;

/** Text of a note open in a tab (unsaved edits included), set by the app. */
let liveText: (path: string) => string | null = () => null;
export function setLiveText(f: (path: string) => string | null) {
  liveText = f;
}

export function noteText(path: string): Promise<string> {
  const live = liveText(path);
  if (live !== null) return Promise.resolve(live);
  let p = cache.get(path);
  if (!p) {
    p = api.read(path).then((f) => f.content);
    p.catch(() => cache.delete(path));
    cache.set(path, p);
  }
  return p;
}

/** A note changed on disk (or was saved); returns whether anything cached it. */
export function invalidate(path?: string): boolean {
  const had = path === undefined ? cache.size > 0 : cache.has(path);
  if (path === undefined) cache.clear();
  else cache.delete(path);
  embedVersion++;
  return had;
}

const FM = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/;
const FENCE = /^\s*(```|~~~)/;

/** The part of a note an embed shows: all of it (minus frontmatter), a heading's section, or a block. */
export function section(text: string, subpath: string): string | null {
  const body = text.replace(FM, "");
  if (!subpath) return body;
  const lines = body.split(/\r?\n/);
  if (subpath.startsWith("#^")) {
    const id = subpath.slice(2).toLowerCase();
    const re = /\s\^([\w-]+)\s*$/;
    const i = lines.findIndex((l) => re.exec(l)?.[1].toLowerCase() === id);
    if (i < 0) return null;
    // The block is the paragraph (or list item) the id ends.
    let a = i;
    while (a > 0 && lines[a - 1].trim() && !/^\s*([-*+]|\d+[.)])\s/.test(lines[a])) a--;
    return lines.slice(a, i + 1).join("\n").replace(re, "");
  }
  const want = subpath.slice(1).trim().toLowerCase();
  let inFence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) inFence = !inFence;
    if (inFence) continue;
    const m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!m) continue;
    if (start >= 0 && m[1].length <= level) return lines.slice(start, i).join("\n").trimEnd();
    if (start < 0 && m[2].toLowerCase() === want) {
      start = i;
      level = m[1].length;
    }
  }
  return start >= 0 ? lines.slice(start).join("\n").trimEnd() : null;
}

/** How deep embeds may nest (also stops cycles quickly). */
export const MAX_EMBED_DEPTH = 4;
