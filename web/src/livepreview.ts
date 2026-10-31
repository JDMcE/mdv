// Obsidian-style "live preview": markdown syntax is hidden and rendered on
// every line except the ones the cursor/selection is on.

import { syntaxTree } from "@codemirror/language";
import { EditorState, Range, StateEffect, StateField, Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { SyntaxNode } from "@lezer/common";
import { rawUrl } from "./api";
import { embedVersion } from "./embeds";
import { dirname, isImage, isNote, normalize, parseSize, parseWiki, stripMd, vaultFiles, WIKI_RE } from "./links";
import { settings } from "./settings";
import * as tables from "./tables";
import { contextMenu, copyButton, MenuItem } from "./ui";

export interface LinkHost {
  /** Path of the note being edited. */
  path: () => string;
  /** Follow a link target; newTab for Ctrl/Cmd-click. `from`: the note the link is written in, if not this one. */
  follow: (target: string, wiki: boolean, newTab: boolean, from?: string) => void;
  /** Open an image in the viewer. */
  openFile: (path: string, newTab: boolean) => void;
}

/** Dispatch this to force decorations to rebuild (e.g. after files change). */
export const refreshDecorations = StateEffect.define<null>();

// ---------- widgets ----------

/** Natural and last-rendered sizes of images seen so far, by URL. */
const imageSizes = new Map<string, { w: number; h: number; shown: number }>();

class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly path: string | null,
    readonly width?: number,
    readonly height?: number,
  ) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src && o.width === this.width && o.height === this.height && o.alt === this.alt;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-image";
    const img = document.createElement("img");
    img.alt = this.alt;
    img.draggable = false;
    if (this.width) img.style.width = this.width + "px";
    if (this.height) img.style.height = this.height + "px";
    if (this.path) img.dataset.path = this.path;
    // Widgets are re-created as they scroll in and out of view. Reserving the
    // image's known size up front keeps line heights stable; otherwise each
    // re-creation starts at 0px, grows on load, and the editor's scroll
    // correction fights the user's scrolling.
    const known = imageSizes.get(this.src);
    if (known) {
      img.width = known.w;
      img.height = known.h;
    }
    img.onload = () => {
      const first = !imageSizes.has(this.src);
      imageSizes.set(this.src, { w: img.naturalWidth, h: img.naturalHeight, shown: img.offsetHeight });
      if (first) view.requestMeasure();
    };
    img.onerror = () => {
      wrap.classList.add("broken");
      wrap.textContent = "⚠ image not found: " + this.alt;
      view.requestMeasure();
    };
    img.src = this.src;
    wrap.append(img);
    return wrap;
  }
  get estimatedHeight() {
    return imageSizes.get(this.src)?.shown || this.height || 200;
  }
  ignoreEvent(e: Event) {
    // Let Ctrl/Cmd-click through to our handler; plain clicks place the cursor.
    return e.type === "mousedown" && ((e as MouseEvent).ctrlKey || (e as MouseEvent).metaKey);
  }
}

/** "Copy" button shown on a code block's (hidden) opening fence line. */
class CopyWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(o: CopyWidget) {
    return o.text === this.text;
  }
  toDOM() {
    return copyButton(() => this.text, "cm-lp-copy");
  }
  ignoreEvent() {
    return true; // the button handles its own clicks; don't move the cursor
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked;
  }
  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.className = "cm-lp-task";
    box.checked = this.checked;
    box.tabIndex = -1;
    return box;
  }
  ignoreEvent() {
    return false;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-bullet";
    s.textContent = "•";
    return s;
  }
}

class RuleWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement("span");
    s.className = "cm-lp-hr";
    return s;
  }
}

// ---------- foldable callouts ("> [!note]-" starts folded, "+" open) ----------

/** Flip a foldable callout, identified by the start of its title line. */
const toggleCallout = StateEffect.define<number>();

/** Title lines of callouts the user has flipped away from their default state. */
const calloutToggles = StateField.define<Set<number>>({
  create: () => new Set(),
  update(value, tr) {
    let next = value;
    if (tr.docChanged && value.size) next = new Set([...value].map((p) => tr.changes.mapPos(p)));
    for (const e of tr.effects) {
      if (!e.is(toggleCallout)) continue;
      next = new Set(next);
      next.has(e.value) ? next.delete(e.value) : next.add(e.value);
    }
    return next;
  },
});

const CALLOUT_RE = /^(\s*>\s*)\[!([\w-]+)\]([+-]?)/;

function calloutFolded(state: EditorState, titleFrom: number, marker: string) {
  return (marker === "-") !== !!state.field(calloutToggles, false)?.has(titleFrom);
}

class FoldToggleWidget extends WidgetType {
  constructor(readonly folded: boolean) {
    super();
  }
  eq(o: FoldToggleWidget) {
    return o.folded === this.folded;
  }
  toDOM(view: EditorView) {
    const b = document.createElement("button");
    b.className = "cm-lp-fold" + (this.folded ? " folded" : "");
    b.title = this.folded ? "Expand" : "Collapse";
    b.tabIndex = -1;
    b.onmousedown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const line = view.state.doc.lineAt(view.posAtDOM(b));
      view.dispatch({ effects: [toggleCallout.of(line.from), refreshDecorations.of(null)] });
    };
    return b;
  }
  ignoreEvent() {
    return true;
  }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const line = (cls: string) => Decoration.line({ class: cls });

// ---------- building decorations ----------

/** Lines touched by any selection range: syntax stays visible there. */
/**
 * Becomes true once the user moves the cursor or edits. Until then nothing is
 * "active", so a freshly opened note shows fully rendered (no "#" on line 1).
 */
const touched = StateField.define<boolean>({
  create: () => false,
  // Table edits from the rendered widget's buttons don't count.
  update: (v, tr) => v || !!tr.selection || (tr.docChanged && !tr.isUserEvent("input.table")),
});

function activeLines(state: EditorState): Set<number> {
  const set = new Set<number>();
  if (!state.field(touched, false)) return set;
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let n = a; n <= b; n++) set.add(n);
  }
  return set;
}

function imageSrc(target: string, from: string, wiki: boolean): { src: string; path: string | null } {
  if (/^(https?:|data:)/i.test(target)) return { src: target, path: null };
  const p = vaultFiles.resolve(target, from, wiki);
  if (p) return { src: rawUrl(p), path: p };
  // Unknown to the tree (e.g. just uploaded): try the literal relative path.
  const guess = normalize((dirname(from) ? dirname(from) + "/" : "") + target);
  return { src: rawUrl(guess ?? target), path: guess };
}

// ---------- frontmatter ----------

// The closing "---" must start a line; the YAML between may be empty.
const FM_RE = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?=\r?\n|$)/;

/** The YAML frontmatter block at the top of a note: [0, to) covers both "---" lines. */
export function frontmatterRange(doc: Text): { to: number; yaml: string } | null {
  if (!doc.length || doc.sliceString(0, 3) !== "---") return null;
  const m = FM_RE.exec(doc.sliceString(0, Math.min(doc.length, 50_000)));
  return m ? { to: m[0].length, yaml: m[1] ?? "" } : null;
}

/** Where the note body starts (after the frontmatter and its line break). */
export function bodyStart(doc: Text): number {
  const fm = frontmatterRange(doc);
  if (!fm) return 0;
  return fm.to < doc.length ? doc.lineAt(fm.to).to + 1 : fm.to;
}

function inFrontmatter(state: EditorState, pos: number) {
  const fm = frontmatterRange(state.doc);
  return !!fm && pos <= fm.to;
}

/** Minimal YAML reading for display: "key: value" and "- item" lists. */
function parseProps(yaml: string): [string, string[]][] {
  const out: [string, string[]][] = [];
  for (const raw of yaml.split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(raw);
    if (item && out.length) {
      out[out.length - 1][1].push(item[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    const kv = /^([^\s:#][^:]*):\s*(.*)$/.exec(raw);
    if (!kv) continue;
    let v = kv[2].trim();
    const values =
      v.startsWith("[") && v.endsWith("]")
        ? v.slice(1, -1).split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean)
        : v
          ? [v.replace(/^["']|["']$/g, "")]
          : [];
    out.push([kv[1].trim(), values]);
  }
  return out;
}

/** Render frontmatter as a compact properties box (shared with the reading view). */
export function propertiesElement(yaml: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "props";
  for (const [key, values] of parseProps(yaml)) {
    const row = document.createElement("div");
    row.className = "props-row";
    const k = document.createElement("span");
    k.className = "props-key";
    k.textContent = key;
    const v = document.createElement("span");
    v.className = "props-values";
    for (const val of values) {
      const chip = document.createElement("span");
      chip.className = "props-chip";
      chip.textContent = val;
      v.append(chip);
    }
    row.append(k, v);
    box.append(row);
  }
  return box;
}

class FrontmatterWidget extends WidgetType {
  constructor(
    readonly yaml: string,
    readonly mode: "hidden" | "properties",
  ) {
    super();
  }
  eq(o: FrontmatterWidget) {
    return o.yaml === this.yaml && o.mode === this.mode;
  }
  toDOM(view: EditorView) {
    if (this.mode === "hidden") {
      const d = document.createElement("div");
      d.className = "cm-lp-fm-hidden";
      return d;
    }
    const box = propertiesElement(this.yaml);
    box.classList.add("cm-lp-props");
    box.title = "Click to edit properties";
    // Clicking reveals the raw YAML by moving the cursor into it.
    box.onmousedown = (e) => {
      e.preventDefault();
      view.dispatch({ selection: { anchor: Math.min(4, view.state.doc.length) } });
      view.focus();
    };
    return box;
  }
  get estimatedHeight() {
    return this.mode === "hidden" ? 0 : 24 * Math.max(1, parseProps(this.yaml).length) + 16;
  }
  ignoreEvent() {
    return false;
  }
}

/**
 * Collapses the frontmatter unless the cursor is in it. This replaces whole
 * lines, which CodeMirror only allows from a state field (not a view plugin).
 */
const frontmatterField = StateField.define<DecorationSet>({
  create: (state) => collapseFrontmatter(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(refreshDecorations))) {
      return collapseFrontmatter(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function collapseFrontmatter(state: EditorState): DecorationSet {
  const mode = settings.get().frontmatter;
  if (mode === "raw") return Decoration.none;
  const fm = frontmatterRange(state.doc);
  if (!fm) return Decoration.none;
  // Editing: any selection touching the block shows the raw YAML.
  if (state.selection.ranges.some((r) => r.from <= fm.to)) return Decoration.none;
  return Decoration.set(
    Decoration.replace({ widget: new FrontmatterWidget(fm.yaml, mode), block: true }).range(0, fm.to),
  );
}

function inCode(state: EditorState, pos: number) {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "InlineCode" || n.name === "CodeBlock") return true;
  }
  return false;
}

/**
 * Decorations change line heights (images, headings), so they must not depend
 * on the scroll position: if they did, scrolling would decorate new lines,
 * shift heights, move the viewport, re-decorate… and never settle. Notes are
 * decorated whole; only very large documents fall back to the viewport.
 */
const WHOLE_DOC_LIMIT = 300_000;

function decoratedRanges(view: EditorView): readonly { from: number; to: number }[] {
  const len = view.state.doc.length;
  return len <= WHOLE_DOC_LIMIT ? [{ from: 0, to: len }] : [view.viewport];
}

function build(view: EditorView, host: LinkHost): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const active = activeLines(state);
  const from = host.path();
  const out: Range<Decoration>[] = [];
  const isActive = (pos: number) => active.has(doc.lineAt(pos).number);
  const hideRange = (a: number, b: number) => {
    if (b > a) out.push(hide.range(a, b));
  };

  // Raw frontmatter lines (when shown) get a muted monospace style. The range
  // ends at the closing "---" itself, so the first body line isn't included.
  const fm = frontmatterRange(doc);
  if (fm) {
    for (let n = 1; n <= doc.lineAt(fm.to).number; n++) {
      out.push(line("cm-lp-frontmatter").range(doc.line(n).from));
    }
  }

  for (const { from: vFrom, to: vTo } of decoratedRanges(view)) {
    syntaxTree(state).iterate({
      from: vFrom,
      to: vTo,
      enter: (node) => {
        const name = node.name;
        const nActive = isActive(node.from);

        if (/^ATXHeading(\d)$/.test(name)) {
          const level = name.slice(-1);
          out.push(line(`cm-lp-h cm-lp-h${level}`).range(doc.lineAt(node.from).from));
          return;
        }
        if (/^SetextHeading(\d)$/.test(name)) {
          out.push(line(`cm-lp-h cm-lp-h${name.slice(-1)}`).range(doc.lineAt(node.from).from));
          return;
        }
        switch (name) {
          case "Frontmatter":
            return false; // styled below; nothing inside is markdown
          case "HeaderMark": {
            if (nActive || node.node.parent?.name.startsWith("Setext")) return;
            // Hide "## " including the space after it.
            const after = doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
            hideRange(node.from, node.to + after);
            return;
          }
          case "EmphasisMark":
          case "StrikethroughMark":
            if (!nActive) hideRange(node.from, node.to);
            return;
          case "InlineCode":
            out.push(Decoration.mark({ class: "cm-lp-inline-code" }).range(node.from, node.to));
            if (!nActive) {
              const n = node.node;
              const first = n.firstChild;
              const last = n.lastChild;
              if (first?.name === "CodeMark") hideRange(first.from, first.to);
              if (last?.name === "CodeMark" && last !== first) hideRange(last.from, last.to);
            }
            return false;
          case "FencedCode": {
            const a = doc.lineAt(node.from).number;
            const b = doc.lineAt(node.to).number;
            for (let n = a; n <= b; n++) {
              const cls = n === a ? "cm-lp-code cm-lp-code-first" : n === b ? "cm-lp-code cm-lp-code-last" : "cm-lp-code";
              out.push(line(cls).range(doc.line(n).from));
            }
            // Fences: unless being edited, hide "```lang" / "```" entirely and
            // put a copy button where the opening fence was.
            const first = doc.line(a);
            const last = node.node.lastChild;
            const closed = last?.name === "CodeMark" && doc.lineAt(last.from).number > a;
            const bodyFrom = Math.min(first.to + 1, node.to);
            const bodyTo = closed ? Math.max(bodyFrom, doc.lineAt(last!.from).from - 1) : node.to;
            if (!isActive(first.from)) {
              const fenceStart = node.from;
              hideRange(fenceStart, first.to);
              out.push(
                Decoration.widget({ widget: new CopyWidget(doc.sliceString(bodyFrom, bodyTo)), side: 1 }).range(first.to),
              );
            }
            if (closed && !isActive(last!.from)) hideRange(last!.from, last!.to);
            return false; // nothing inside a code block is markdown
          }
          case "Blockquote": {
            const a = doc.lineAt(node.from).number;
            const b = doc.lineAt(node.to).number;
            for (let n = a; n <= b; n++) out.push(line("cm-lp-quote").range(doc.line(n).from));
            return;
          }
          case "QuoteMark":
            if (!nActive) {
              const after = doc.sliceString(node.to, node.to + 1) === " " ? 1 : 0;
              hideRange(node.from, node.to + after);
            }
            return;
          case "HorizontalRule":
            if (!nActive) out.push(rule.range(node.from, node.to));
            return;
          case "ListMark": {
            if (nActive) return;
            const item = node.node.parent;
            const task = item?.getChild("Task");
            const marker = task?.getChild("TaskMarker");
            if (marker) {
              const checked = /x/i.test(doc.sliceString(marker.from, marker.to));
              out.push(
                Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, marker.to),
              );
              if (checked) out.push(line("cm-lp-task-done").range(doc.lineAt(node.from).from));
              return;
            }
            const text = doc.sliceString(node.from, node.to);
            if (text === "-" || text === "*" || text === "+") out.push(bullet.range(node.from, node.to));
            return;
          }
          case "Image": {
            if (nActive) return false;
            const n = node.node;
            const url = n.getChild("URL");
            if (!url) return false;
            const raw = doc.sliceString(node.from, node.to);
            const altM = /^!\[([^\]]*)\]/.exec(raw);
            let alt = altM?.[1] ?? "";
            let size: ReturnType<typeof parseSize> = null;
            const pipe = alt.lastIndexOf("|");
            if (pipe >= 0 && (size = parseSize(alt.slice(pipe + 1)))) alt = alt.slice(0, pipe);
            const { src, path } = imageSrc(doc.sliceString(url.from, url.to), from, false);
            out.push(
              Decoration.replace({ widget: new ImageWidget(src, alt, path, size?.width, size?.height) }).range(
                node.from,
                node.to,
              ),
            );
            return false;
          }
          case "Link": {
            // "> [!note] Title" is a callout marker, not a link (styled below).
            if (/^\[![\w-]+\]/.test(doc.sliceString(node.from, node.to))) return false;
            const n = node.node;
            const marks = n.getChildren("LinkMark");
            const url = n.getChild("URL");
            if (marks.length < 2) return;
            const labelFrom = marks[0].to;
            const labelTo = marks[1].from;
            const href = url ? doc.sliceString(url.from, url.to) : "";
            out.push(
              Decoration.mark({
                class: "cm-lp-link",
                attributes: { "data-href": href },
              }).range(labelFrom, labelTo),
            );
            if (!nActive && labelTo > labelFrom) {
              hideRange(node.from, labelFrom);
              hideRange(labelTo, node.to);
            }
            return false;
          }
          case "URL": {
            // Bare autolinked URLs (GFM).
            if (node.node.parent?.name === "Link" || node.node.parent?.name === "Image") return;
            const href = doc.sliceString(node.from, node.to);
            out.push(
              Decoration.mark({ class: "cm-lp-link cm-lp-url", attributes: { "data-href": href } }).range(
                node.from,
                node.to,
              ),
            );
            return;
          }
        }
      },
    });

    // Things lezer-markdown doesn't know: [[wikilinks]], ![[embeds]], ==highlights==, #tags.
    const startLine = doc.lineAt(vFrom).number;
    const endLine = doc.lineAt(vTo).number;
    for (let ln = startLine; ln <= endLine; ln++) {
      const l = doc.line(ln);
      const text = l.text;
      const lActive = active.has(ln);
      if (inFrontmatter(state, l.from)) continue;

      WIKI_RE.lastIndex = 0;
      for (let m; (m = WIKI_RE.exec(text)); ) {
        const a = l.from + m.index;
        const b = a + m[0].length;
        if (inCode(state, a)) continue;
        const w = parseWiki(m[2], m[1] === "!");
        const resolved = w.target ? vaultFiles.resolve(w.target, from) : from;
        const cls = "cm-lp-wikilink" + (resolved ? "" : " cm-lp-unresolved");
        const attrs = { "data-target": w.target + w.subpath };

        if (w.embed && (isImage(w.target) || (resolved && isImage(resolved)))) {
          if (lActive) {
            out.push(Decoration.mark({ class: cls, attributes: attrs }).range(a, b));
            continue;
          }
          const size = parseSize(w.alias);
          const { src, path } = imageSrc(w.target, from, true);
          out.push(
            Decoration.replace({
              widget: new ImageWidget(src, size ? w.target : w.alias || w.target, path, size?.width, size?.height),
            }).range(a, b),
          );
          continue;
        }
        if (lActive) {
          out.push(Decoration.mark({ class: cls + " cm-lp-raw", attributes: attrs }).range(a, b));
          continue;
        }
        // Show only the label: alias, else the target (without .md) and heading.
        const inner0 = a + m[1].length + 2; // after "[[" / "![["
        const innerEnd = b - 2;
        if (w.alias) {
          const aliasFrom = a + m[1].length + 2 + m[2].lastIndexOf("|") + 1;
          hideRange(a, aliasFrom);
          out.push(Decoration.mark({ class: cls, attributes: attrs }).range(aliasFrom, innerEnd));
        } else {
          hideRange(a, inner0);
          out.push(Decoration.mark({ class: cls, attributes: attrs }).range(inner0, innerEnd));
          // Hide a trailing ".md" in the label.
          const label = m[2];
          if (/\.md$/i.test(label) && isNote(label)) hideRange(innerEnd - 3, innerEnd);
        }
        hideRange(innerEnd, b);
        if (w.embed) out.push(Decoration.mark({ class: "cm-lp-embed" }).range(a, b));
      }

      const callout = /^(\s*>\s*)\[!([\w-]+)\]([+-]?)/.exec(text);
      if (callout) {
        const a = l.from + callout[1].length;
        const b = l.from + callout[0].length;
        const close = b - 1 - callout[3].length; // position of "]"
        const mark = Decoration.mark({
          class: "cm-lp-callout-type",
          attributes: { "data-callout": callout[2].toLowerCase() },
        });
        out.push(mark.range(lActive ? a : a + 2, lActive ? b : close));
        if (!lActive) {
          hideRange(a, a + 2);
          hideRange(close, b);
        }
        // Foldable callout with a body: a chevron at the end of the title.
        if (callout[3] && ln < doc.lines && /^\s*>/.test(doc.line(ln + 1).text)) {
          const folded = calloutFolded(state, l.from, callout[3]);
          out.push(Decoration.widget({ widget: new FoldToggleWidget(folded), side: -1 }).range(l.to));
        }
      }

      const hl = /==([^=\n]+)==/g;
      for (let m; (m = hl.exec(text)); ) {
        const a = l.from + m.index;
        if (inCode(state, a)) continue;
        out.push(Decoration.mark({ class: "cm-lp-highlight" }).range(a + 2, a + m[0].length - 2));
        if (!lActive) {
          hideRange(a, a + 2);
          hideRange(a + m[0].length - 2, a + m[0].length);
        }
      }

      const tag = /(^|\s)(#[\p{L}\p{N}_\/-]*[\p{L}_\/-][\p{L}\p{N}_\/-]*)/gu;
      for (let m; (m = tag.exec(text)); ) {
        const a = l.from + m.index + m[1].length;
        if (inCode(state, a) || /^ATXHeading/.test(syntaxTree(state).resolveInner(a, 1).name)) continue;
        out.push(Decoration.mark({ class: "cm-lp-tag" }).range(a, a + m[2].length));
      }
    }
  }
  return Decoration.set(out, true);
}

// ---------- tables and note embeds (block widgets) ----------

// Both render through the reading view's markdown renderer, loaded on demand.
let readerMod: typeof import("./reader") | null = null;
let readerLoading: Promise<typeof import("./reader")> | null = null;
function withReader(f: (r: typeof import("./reader")) => void) {
  if (readerMod) return f(readerMod);
  (readerLoading ??= import("./reader").then((r) => (readerMod = r))).then(f);
}

/** Last rendered height of block widgets, so re-created ones don't jump. */
const blockHeights = new Map<string, number>();

function rememberHeight(key: string, el: HTMLElement, view: EditorView) {
  const ro = new ResizeObserver(() => {
    if (!el.isConnected) return ro.disconnect();
    const h = el.offsetHeight;
    if (h && h !== blockHeights.get(key)) {
      blockHeights.set(key, h);
      view.requestMeasure();
    }
  });
  ro.observe(el);
}

/** Follow a link clicked inside a rendered block (table or embed). */
function followInBlock(e: MouseEvent, host: LinkHost, from?: string): boolean {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a");
  if (!a) return false;
  e.preventDefault();
  const mod = e.ctrlKey || e.metaKey;
  if (a.dataset.target !== undefined) host.follow(a.dataset.target, true, mod, from);
  else if (a.dataset.href) host.follow(a.dataset.href, false, mod, from);
  else if (a.href && a.target === "_blank") window.open(a.href, "_blank", "noopener,noreferrer");
  return true;
}

/** Offsets of the cells' content in a table row's source line. */
function cellStarts(line: string): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < line.length && /\s/.test(line[i])) i++;
  if (line[i] === "|") i++;
  let start = i;
  for (; i <= line.length; i++) {
    if (i === line.length || (line[i] === "|" && line[i - 1] !== "\\")) {
      let a = start;
      while (a < i && line[a] === " ") a++;
      if (i < line.length || a < i) out.push(a);
      start = i + 1;
    }
  }
  return out;
}

class TableWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly path: string,
    readonly host: LinkHost,
  ) {
    super();
  }
  eq(o: TableWidget) {
    return o.src === this.src && o.path === this.path;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-table reader";
    const key = "t:" + this.src;
    const h = blockHeights.get(key);
    if (h) wrap.style.minHeight = h + "px";
    withReader((r) => {
      r.render(wrap, this.src, this.path, 1);
      addTableButtons(wrap, view);
      wrap.style.minHeight = "";
      view.requestMeasure();
    });
    rememberHeight(key, wrap, view);
    wrap.oncontextmenu = (e) => {
      const cell = cellOf(e.target as HTMLElement);
      if (!cell) return;
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, tableMenu(view, wrap, cell));
    };
    wrap.onmousedown = (e) => {
      if (e.button === 2) e.preventDefault(); // the context menu shouldn't move the cursor
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest(".cm-lp-table-add")) return;
      if (followInBlock(e, this.host)) return;
      // Clicking a cell puts the cursor in that cell's source.
      e.preventDefault();
      const cell = (e.target as HTMLElement).closest("td, th");
      const tr = cell?.parentElement as HTMLTableRowElement | null;
      const start = view.posAtDOM(wrap);
      const doc = view.state.doc;
      let pos = start;
      if (cell && tr) {
        const inBody = tr.parentElement?.tagName === "TBODY";
        const rowIdx = inBody ? tr.sectionRowIndex + 2 : 0; // skip the "|---|" line
        const lineNo = Math.min(doc.lineAt(start).number + rowIdx, doc.lines);
        const line = doc.line(lineNo);
        const starts = cellStarts(line.text);
        const col = [...tr.children].indexOf(cell);
        pos = line.from + (starts[col] ?? 0);
      }
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    };
    return wrap;
  }
  get estimatedHeight() {
    return blockHeights.get("t:" + this.src) ?? 40 + 30 * this.src.split("\n").length;
  }
  ignoreEvent() {
    return true;
  }
}

/** Row (0 = header) and column of a rendered table cell. */
function cellOf(el: HTMLElement): tables.CellRef | null {
  const cell = el.closest("td, th");
  const tr = cell?.parentElement as HTMLTableRowElement | null;
  if (!cell || !tr) return null;
  const inBody = tr.parentElement?.tagName === "TBODY";
  return { row: inBody ? tr.sectionRowIndex + 1 : 0, col: [...tr.children].indexOf(cell) };
}

/** Apply a change to the table a widget shows; it stays rendered. */
function editTable(view: EditorView, wrap: HTMLElement, f: (t: tables.Table) => unknown) {
  const t = tables.tableAt(view.state, view.posAtDOM(wrap));
  if (!t || f(t) === false) return;
  tables.writeTable(view, t);
}

/** "+" buttons to add a column (right edge) and a row (bottom edge). */
function addTableButtons(wrap: HTMLElement, view: EditorView) {
  const table = wrap.querySelector("table");
  if (!table) return;
  const box = document.createElement("div");
  box.className = "cm-lp-table-box";
  table.replaceWith(box);
  box.append(table);
  const button = (cls: string, title: string, run: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-lp-table-add " + cls;
    b.title = title;
    b.tabIndex = -1;
    b.textContent = "+";
    b.onmousedown = (e) => e.preventDefault(); // keep the cursor where it is
    b.onclick = (e) => {
      e.preventDefault();
      run();
    };
    box.append(b);
  };
  button("col", "Add column", () => editTable(view, wrap, (t) => tables.insertCol(t, t.aligns.length)));
  button("row", "Add row", () => editTable(view, wrap, (t) => tables.insertRow(t, t.rows.length)));
}

function tableMenu(view: EditorView, wrap: HTMLElement, { row, col }: tables.CellRef): MenuItem[] {
  const t = tables.tableAt(view.state, view.posAtDOM(wrap));
  if (!t) return [];
  const edit = (f: (t: tables.Table) => unknown) => () => editTable(view, wrap, f);
  const items: MenuItem[] = [];
  if (row > 0) items.push({ label: "Insert row above", run: edit((t) => tables.insertRow(t, row)) });
  items.push(
    { label: "Insert row below", run: edit((t) => tables.insertRow(t, row + 1)) },
    { label: "Insert column left", run: edit((t) => tables.insertCol(t, col)) },
    { label: "Insert column right", run: edit((t) => tables.insertCol(t, col + 1)) },
  );
  if (row > 1) items.push({ label: "Move row up", run: edit((t) => tables.moveRow(t, row, -1)) });
  if (row > 0 && row < t.rows.length - 1) items.push({ label: "Move row down", run: edit((t) => tables.moveRow(t, row, 1)) });
  if (col > 0) items.push({ label: "Move column left", run: edit((t) => tables.moveCol(t, col, -1)) });
  if (col < t.aligns.length - 1) items.push({ label: "Move column right", run: edit((t) => tables.moveCol(t, col, 1)) });
  for (const a of ["left", "center", "right"] as const) {
    if (t.aligns[col] === a) continue;
    items.push({ label: "Align column " + a, run: edit((t) => (t.aligns[col] = a)) });
  }
  if (row > 0) items.push({ label: "Delete row", danger: true, run: edit((t) => tables.deleteRow(t, row)) });
  if (t.aligns.length > 1) items.push({ label: "Delete column", danger: true, run: edit((t) => tables.deleteCol(t, col)) });
  return items;
}

class NoteEmbedWidget extends WidgetType {
  constructor(
    readonly path: string,
    readonly sub: string,
    readonly from: string,
    readonly version: number,
    readonly host: LinkHost,
  ) {
    super();
  }
  eq(o: NoteEmbedWidget) {
    return o.path === this.path && o.sub === this.sub && o.version === this.version && o.from === this.from;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-embed-note reader";
    const key = "e:" + this.path + this.sub;
    const h = blockHeights.get(key);
    if (h) wrap.style.minHeight = h + "px";
    withReader((r) => {
      const box = r.embedBox(this.path, this.sub);
      wrap.replaceChildren(box);
      r.fillEmbed(box.querySelector(".embed-body")!, this.path, this.sub, 1, [this.from]).then(() => {
        wrap.style.minHeight = "";
        view.requestMeasure();
      });
    });
    rememberHeight(key, wrap, view);
    wrap.onmousedown = (e) => {
      if (e.button !== 0) return;
      const inner = (e.target as HTMLElement).closest<HTMLElement>("[data-embed-from]")?.dataset.embedFrom;
      if (followInBlock(e, this.host, inner)) return;
      if ((e.target as HTMLElement).closest("input, button, summary")) return;
      // Anywhere else: edit the embed line.
      e.preventDefault();
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) } });
      view.focus();
    };
    return wrap;
  }
  get estimatedHeight() {
    return blockHeights.get("e:" + this.path + this.sub) ?? 120;
  }
  ignoreEvent() {
    return true;
  }
}

const EMBED_LINE = /^\s*!\[\[([^\[\]\n]+?)\]\]\s*$/;

/**
 * Tables and lines holding just a note embed are shown rendered unless the
 * cursor is in them. They replace whole lines, so they come from a state field.
 */
function blockWidgets(host: LinkHost) {
  const make = (state: EditorState): DecorationSet => {
    const doc = state.doc;
    const active = activeLines(state);
    const from = host.path();
    const out: Range<Decoration>[] = [];
    const anyActive = (a: number, b: number) => {
      for (let n = a; n <= b; n++) if (active.has(n)) return true;
      return false;
    };
    syntaxTree(state).iterate({
      enter: (node) => {
        if (node.name === "FencedCode" || node.name === "CodeBlock" || node.name === "Frontmatter") return false;
        if (node.name !== "Table") return;
        const a = doc.lineAt(node.from);
        const b = doc.lineAt(node.to);
        if (!anyActive(a.number, b.number)) {
          const src = doc.sliceString(a.from, b.to);
          out.push(Decoration.replace({ widget: new TableWidget(src, from, host), block: true }).range(a.from, b.to));
        } else {
          // Being edited: monospace, so the aligned pipes line up.
          for (let n = a.number; n <= b.number; n++) out.push(line("cm-lp-table-src").range(doc.line(n).from));
        }
        return false;
      },
    });
    const fmEnd = frontmatterRange(doc)?.to ?? -1;

    // Folded callouts: hide everything after the title line.
    const folds: [number, number][] = [];
    for (let n = 1; n <= doc.lines; n++) {
      const l = doc.line(n);
      if (l.from <= fmEnd || !l.text.includes("[!")) continue;
      const m = CALLOUT_RE.exec(l.text);
      if (!m || !m[3] || inCode(state, l.from + m[1].length)) continue;
      let last = n;
      while (last < doc.lines && /^\s*>/.test(doc.line(last + 1).text)) last++;
      if (last === n) continue;
      const end = doc.line(last).to;
      // Keep it open while a selection is inside (e.g. after a search jump).
      const inside = state.selection.ranges.some((r) => r.to > l.to && r.from <= end);
      if (calloutFolded(state, l.from, m[3]) && !inside) {
        out.push(Decoration.replace({}).range(l.to, end));
        folds.push([l.to, end]);
      }
      n = last;
    }
    const folded = (pos: number) => folds.some(([a, b]) => pos >= a && pos <= b);
    for (let i = out.length - folds.length - 1; i >= 0; i--) {
      if (folded(out[i].from)) out.splice(i, 1); // tables inside a folded callout
    }

    for (let n = 1; n <= doc.lines; n++) {
      const l = doc.line(n);
      if (l.length < 5 || l.from <= fmEnd || active.has(n) || !l.text.includes("![[")) continue;
      const m = EMBED_LINE.exec(l.text);
      if (!m || folded(l.from) || inCode(state, l.from + l.text.indexOf("!"))) continue;
      const w = parseWiki(m[1], true);
      if (isImage(w.target)) continue;
      const path = w.target ? vaultFiles.resolve(w.target, from) : from;
      if (!path || !isNote(path)) continue;
      out.push(
        Decoration.replace({
          widget: new NoteEmbedWidget(path, w.subpath, from, embedVersion, host),
          block: true,
        }).range(l.from, l.to),
      );
    }
    return Decoration.set(out, true);
  };
  return StateField.define<DecorationSet>({
    create: make,
    update(value, tr) {
      if (
        tr.docChanged ||
        tr.selection ||
        tr.effects.some((e) => e.is(refreshDecorations)) ||
        syntaxTree(tr.startState) !== syntaxTree(tr.state)
      ) {
        return make(tr.state);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}

// ---------- the extension ----------

export function livePreview(host: LinkHost) {
  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      version = vaultFiles.version;
      constructor(view: EditorView) {
        this.decorations = build(view, host);
      }
      update(u: ViewUpdate) {
        const forced = u.transactions.some((t) => t.effects.some((e) => e.is(refreshDecorations)));
        if (
          forced ||
          u.docChanged ||
          (u.viewportChanged && u.state.doc.length > WHOLE_DOC_LIMIT) ||
          u.selectionSet ||
          syntaxTree(u.startState) !== syntaxTree(u.state) ||
          this.version !== vaultFiles.version
        ) {
          this.version = vaultFiles.version;
          this.decorations = build(u.view, host);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );

  return [touched, calloutToggles, plugin, frontmatterField, blockWidgets(host), EditorView.editorAttributes.of({ class: "cm-live" })];
}

/** Link clicking and checkbox toggling. Active in every mode. */
export function linkHandlers(host: LinkHost) {
  return EditorView.domEventHandlers({
    mousedown(e, view) {
      const t = e.target as HTMLElement;
      const mod = e.ctrlKey || e.metaKey;

      if (t instanceof HTMLInputElement && t.classList.contains("cm-lp-task")) {
        const pos = view.posAtDOM(t);
        const lineText = view.state.doc.lineAt(pos);
        const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/.exec(lineText.text);
        if (m) {
          const at = lineText.from + m[1].length;
          view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === " " ? "x" : " " } });
        }
        e.preventDefault();
        return true;
      }

      const img = t.closest<HTMLElement>(".cm-lp-image img");
      if (img && mod && img.dataset.path) {
        host.openFile(img.dataset.path, e.shiftKey);
        e.preventDefault();
        return true;
      }

      const link = t.closest<HTMLElement>(".cm-lp-wikilink, .cm-lp-link");
      if (!link || e.button !== 0) return false;
      // Rendered links follow on a plain click. On the line being edited (or
      // in source mode) a plain click just places the cursor; Ctrl/Cmd follows.
      const l = view.state.doc.lineAt(view.posAtDOM(link));
      const editing =
        !view.dom.classList.contains("cm-live") ||
        view.state.selection.ranges.some((r) => r.to >= l.from && r.from <= l.to);
      if (editing && !mod) return false;

      e.preventDefault();
      if (link.dataset.target !== undefined) host.follow(link.dataset.target, true, mod);
      else if (link.dataset.href) host.follow(link.dataset.href, false, mod);
      return true;
    },
  });
}

/** For "Copy wikilink" etc. */
export const linkFor = (path: string) => `[[${vaultFiles.linkText(path)}]]`;
export const embedFor = (path: string) => `![[${vaultFiles.linkText(path)}]]`;
export { stripMd };
