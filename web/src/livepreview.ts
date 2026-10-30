// Obsidian-style "live preview": markdown syntax is hidden and rendered on
// every line except the ones the cursor/selection is on.

import { syntaxTree } from "@codemirror/language";
import { EditorState, Range, StateEffect, StateField, Text } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { SyntaxNode } from "@lezer/common";
import { rawUrl } from "./api";
import { dirname, isImage, isNote, normalize, parseSize, parseWiki, stripMd, vaultFiles, WIKI_RE } from "./links";
import { settings } from "./settings";
import { copyButton } from "./ui";

export interface LinkHost {
  /** Path of the note being edited. */
  path: () => string;
  /** Follow a link target; newTab for Ctrl/Cmd-click. */
  follow: (target: string, wiki: boolean, newTab: boolean) => void;
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
  update: (v, tr) => v || tr.docChanged || !!tr.selection,
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

  return [touched, plugin, frontmatterField, EditorView.editorAttributes.of({ class: "cm-live" })];
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
