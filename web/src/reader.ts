// Reading view: renders a note to sanitised HTML. Loaded on demand.

import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";
import { highlightCode, classHighlighter } from "@lezer/highlight";
import { findLanguage } from "./codelang";
import { rawUrl } from "./api";
import { MAX_EMBED_DEPTH, noteText, section } from "./embeds";
import { basename, dirname, isImage, isNote, normalize, parseSize, parseWiki, stripMd, vaultFiles } from "./links";
import { propertiesElement } from "./livepreview";
import { settings } from "./settings";
import { copyButton } from "./ui";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type StateInline = Parameters<Parameters<MarkdownIt["inline"]["ruler"]["before"]>[2]>[0];

let currentPath = "";

function wikilinkRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  let pos = state.pos;
  const embed = src.charCodeAt(pos) === 0x21; /* ! */
  if (embed) pos++;
  if (!src.startsWith("[[", pos)) return false;
  const end = src.indexOf("]]", pos + 2);
  if (end < 0) return false;
  const inner = src.slice(pos + 2, end);
  if (!inner || inner.includes("\n") || inner.includes("[")) return false;
  if (!silent) {
    const w = parseWiki(inner, embed);
    const resolved = w.target ? vaultFiles.resolve(w.target, currentPath) : currentPath;
    const tok = state.push("html_inline", "", 0);
    if (embed && (isImage(w.target) || (resolved && isImage(resolved)))) {
      const size = parseSize(w.alias);
      const style = size ? ` style="width:${size.width}px${size.height ? `;height:${size.height}px` : ""}"` : "";
      const alt = size ? w.target : w.alias || w.target;
      tok.content = resolved
        ? `<img src="${esc(rawUrl(resolved))}" alt="${esc(alt)}"${style} data-path="${esc(resolved)}">`
        : `<span class="broken-embed">⚠ ${esc(w.target)}</span>`;
    } else if (embed && resolved && isNote(resolved)) {
      // Note transclusion; filled in after rendering (see transclude()).
      tok.content = `<span class="transclude" data-path="${esc(resolved)}" data-sub="${esc(w.subpath)}"></span>`;
    } else {
      const label = w.alias || (w.target ? stripMd(w.target) : "") + (w.subpath ? (w.target ? " › " : "") + w.subpath.slice(1) : "");
      const cls = "wikilink" + (resolved ? "" : " unresolved") + (embed ? " embed" : "");
      tok.content = `<a class="${cls}" data-target="${esc(w.target + w.subpath)}" href="#">${esc(label)}</a>`;
    }
  }
  state.pos = end + 2;
  return true;
}

function highlightRule(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  if (!src.startsWith("==", state.pos)) return false;
  const end = src.indexOf("==", state.pos + 2);
  if (end < 0 || end === state.pos + 2) return false;
  if (!silent) {
    state.push("mark_open", "mark", 1);
    const oldPos = state.pos;
    const oldMax = state.posMax;
    state.pos = oldPos + 2;
    state.posMax = end;
    state.md.inline.tokenize(state);
    state.pos = oldPos;
    state.posMax = oldMax;
    state.push("mark_close", "mark", -1);
  }
  state.pos = end + 2;
  return true;
}

// breaks: single newlines are line breaks, as in Obsidian (its default).
const md = new MarkdownIt({ html: true, linkify: true, breaks: true });
md.inline.ruler.before("link", "wikilink", wikilinkRule);
md.inline.ruler.before("emphasis", "highlight", highlightRule);

// Images: resolve vault-relative paths and support ![alt|300](src).
md.renderer.rules.image = (tokens, idx) => {
  const tok = tokens[idx];
  let src = tok.attrGet("src") ?? "";
  let alt = tok.content;
  let style = "";
  const pipe = alt.lastIndexOf("|");
  const size = pipe >= 0 ? parseSize(alt.slice(pipe + 1)) : null;
  if (size) {
    alt = alt.slice(0, pipe);
    style = ` style="width:${size.width}px${size.height ? `;height:${size.height}px` : ""}"`;
  }
  let path = "";
  if (!/^(https?:|data:)/i.test(src)) {
    const p = vaultFiles.resolve(src, currentPath, false) ?? normalize((dirname(currentPath) ? dirname(currentPath) + "/" : "") + decodeURIComponent(src));
    if (p) {
      path = p;
      src = rawUrl(p);
    }
  }
  return `<img src="${esc(src)}" alt="${esc(alt)}"${style}${path ? ` data-path="${esc(path)}"` : ""}>`;
};

// Links: internal ones become note links; external open in a new tab.
const defaultLinkOpen = md.renderer.rules.link_open ?? ((t, i, o, _e, self) => self.renderToken(t, i, o));
md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
  const tok = tokens[idx];
  const href = tok.attrGet("href") ?? "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    tok.attrSet("target", "_blank");
    tok.attrSet("rel", "noopener noreferrer");
  } else if (!href.startsWith("#")) {
    tok.attrSet("data-href", href);
    tok.attrSet("href", "#");
    tok.attrJoin("class", "internal");
  }
  return defaultLinkOpen(tokens, idx, opts, env, self);
};

// Task list items: "- [ ] x" → checkbox carrying its source line.
md.core.ruler.after("inline", "tasks", (state) => {
  const toks = state.tokens;
  for (let i = 2; i < toks.length; i++) {
    const inline = toks[i];
    if (inline.type !== "inline" || toks[i - 1].type !== "paragraph_open" || toks[i - 2].type !== "list_item_open") continue;
    const m = /^\[([ xX])\]\s/.exec(inline.content);
    if (!m || !inline.children?.length) continue;
    const first = inline.children[0];
    if (first.type !== "text") continue;
    first.content = first.content.slice(4);
    const box = new state.Token("html_inline", "", 0);
    const line = inline.map ? inline.map[0] : -1;
    box.content = `<input type="checkbox" class="task" data-line="${line}"${m[1] === " " ? "" : " checked"}>`;
    inline.children.unshift(box);
    toks[i - 2].attrJoin("class", "task-item" + (m[1] === " " ? "" : " done"));
  }
});

// #tags in text become styled spans (never inside links or code).
const TAG_RE = /(^|\s)(#[\p{L}\p{N}_\/-]*[\p{L}_\/-][\p{L}\p{N}_\/-]*)/gu;
md.core.ruler.push("tags", (state) => {
  for (const block of state.tokens) {
    if (block.type !== "inline" || !block.children) continue;
    const out = [];
    let inLink = 0;
    for (const tok of block.children) {
      if (tok.type === "link_open") inLink++;
      if (tok.type === "link_close") inLink--;
      TAG_RE.lastIndex = 0;
      if (tok.type !== "text" || inLink || !TAG_RE.test(tok.content)) {
        out.push(tok);
        continue;
      }
      TAG_RE.lastIndex = 0;
      let at = 0;
      for (let m; (m = TAG_RE.exec(tok.content)); ) {
        const start = m.index + m[1].length;
        const before = new state.Token("text", "", 0);
        before.content = tok.content.slice(at, start);
        const tag = new state.Token("html_inline", "", 0);
        tag.content = `<span class="tag">${esc(m[2])}</span>`;
        out.push(before, tag);
        at = start + m[2].length;
      }
      const rest = new state.Token("text", "", 0);
      rest.content = tok.content.slice(at);
      out.push(rest);
    }
    block.children = out;
  }
});

/** Split YAML frontmatter from the body. */
function frontmatter(src: string): { meta: string; body: string; lines: number } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: "", body: src, lines: 0 };
  return { meta: m[1], body: src.slice(m[0].length), lines: m[0].split("\n").length - 1 };
}

/** Turn "> [!note] Title" blockquotes into callouts. */
function callouts(root: HTMLElement) {
  for (const bq of root.querySelectorAll("blockquote")) {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== "P") continue;
    const m = /^\[!(\w+)\]([+-]?)\s*([^\n]*)/.exec(p.textContent ?? "");
    if (!m) continue;
    const type = m[1].toLowerCase();
    const box = document.createElement(m[2] ? "details" : "div");
    box.className = `callout callout-${type}`;
    if (m[2] === "+") box.setAttribute("open", "");
    const title = document.createElement(m[2] ? "summary" : "div");
    title.className = "callout-title";
    title.textContent = m[3] || type[0].toUpperCase() + type.slice(1);
    // Remove the marker line from the first paragraph.
    const first = p.firstChild;
    if (first?.nodeType === Node.TEXT_NODE) {
      const nl = first.textContent!.indexOf("\n");
      first.textContent = nl >= 0 ? first.textContent!.slice(nl + 1) : "";
    }
    if (!p.textContent?.trim() && p.children.length === 0) p.remove();
    box.append(title, ...bq.childNodes);
    bq.replaceWith(box);
  }
}

/** Syntax-highlight fenced code blocks (languages load on demand). */
async function highlight(root: HTMLElement) {
  for (const code of root.querySelectorAll<HTMLElement>("pre > code[class*=language-]")) {
    const lang = /language-([\w+#.-]+)/.exec(code.className)?.[1];
    if (!lang) continue;
    const desc = findLanguage(lang);
    if (!desc) continue;
    const support = desc.support ?? (await desc.load());
    const text = code.textContent ?? "";
    const tree = support.language.parser.parse(text);
    const frag = document.createDocumentFragment();
    highlightCode(
      text,
      tree,
      classHighlighter,
      (s, cls) => {
        if (!cls) return frag.append(s);
        const span = document.createElement("span");
        span.className = cls;
        span.textContent = s;
        frag.append(span);
      },
      () => frag.append("\n"),
    );
    code.replaceChildren(frag);
  }
}

/** Title of an embed: note name, plus the heading or block it shows. */
export function embedTitle(path: string, sub: string) {
  const name = stripMd(basename(path));
  return sub ? `${name} › ${sub.replace(/^#\^?/, "")}` : name;
}

/** Fill in note embeds rendered by wikilinkRule. */
function transclude(root: HTMLElement, depth: number, chain: string[]) {
  for (const span of root.querySelectorAll<HTMLElement>("span.transclude")) {
    const path = span.dataset.path ?? "";
    const sub = span.dataset.sub ?? "";
    const box = embedBox(path, sub);
    // An embed alone in its paragraph replaces the paragraph.
    const p = span.parentElement;
    const alone =
      p?.tagName === "P" &&
      [...p.childNodes].every((n) => n === span || n.nodeName === "BR" || (n.nodeType === Node.TEXT_NODE && !n.textContent!.trim()));
    (alone ? p! : span).replaceWith(box);
    fillEmbed(box.querySelector(".embed-body")!, path, sub, depth + 1, chain);
  }
}

/** The frame of an embedded note: a title linking to it, and a body. */
export function embedBox(path: string, sub: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "embed-note";
  box.dataset.embedFrom = path;
  const title = document.createElement("a");
  title.className = "embed-title";
  title.href = "#";
  title.dataset.target = path + sub;
  title.textContent = embedTitle(path, sub);
  title.title = "Open " + path;
  const body = document.createElement("div");
  body.className = "embed-body";
  box.append(title, body);
  return box;
}

/** Render (part of) the note at `path` into an embed body. */
export async function fillEmbed(body: HTMLElement, path: string, sub: string, depth: number, chain: string[]) {
  const note = (msg: string) => {
    body.replaceChildren();
    const p = document.createElement("p");
    p.className = "broken-embed";
    p.textContent = msg;
    body.append(p);
  };
  if (chain.includes(path) && !sub) return note("⚠ This embed would include itself.");
  if (depth > MAX_EMBED_DEPTH) return note("⚠ Embeds nested too deeply.");
  let text: string;
  try {
    text = await noteText(path);
  } catch {
    return note(`⚠ Couldn't load ${path}`);
  }
  const part = section(text, sub);
  if (part === null) return note(`⚠ "${sub.replace(/^#\^?/, "")}" not found in ${stripMd(basename(path))}`);
  render(body, part, path, depth, [...chain, path]);
}

/** Render `src` (the note at `path`) into `root`. `depth` > 0 inside embeds. */
export function render(root: HTMLElement, src: string, path: string, depth = 0, chain: string[] = []) {
  currentPath = path;
  const { meta, body, lines } = frontmatter(src);
  const env = {};
  // Keep source line numbers right for task toggling despite stripped frontmatter.
  let html = md.render(body, env);
  if (lines) html = html.replace(/data-line="(\d+)"/g, (_, n) => `data-line="${Number(n) + lines}"`);
  const clean = DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "data-target", "data-href", "data-path", "data-line", "data-sub", "checked"],
    ADD_TAGS: ["mark"],
  });
  root.innerHTML = clean;
  const fmMode = settings.get().frontmatter;
  if (meta.trim() && fmMode === "properties") {
    root.prepend(propertiesElement(meta));
  } else if (meta.trim() && fmMode === "raw") {
    const pre = document.createElement("pre");
    pre.className = "frontmatter";
    pre.textContent = meta;
    root.prepend(pre);
  }
  callouts(root);
  for (const pre of root.querySelectorAll("pre:not(.frontmatter)")) {
    const code = pre.querySelector("code");
    // markdown-it ends code with a newline; copy just the code.
    pre.append(copyButton(() => ((code ?? pre).textContent ?? "").replace(/\n$/, ""), "reader-copy"));
  }
  highlight(root);
  // Checkboxes in an embed carry the embedded note's line numbers.
  if (depth > 0) root.querySelectorAll<HTMLInputElement>("input.task").forEach((b) => (b.disabled = true));
  transclude(root, depth, chain.length ? chain : [path]);
}
