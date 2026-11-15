import { EditorState, StateEffect, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { api, ConflictError, rawUrl } from "./api";
import { EditMode, editorExtensions, modeExtension, modeSlot } from "./editor";
import { basename, dirname, isImage, isNote, isPdf, normalize, stripMd, vaultFiles } from "./links";
import type { MapView } from "./filemap";
import { bodyStart, LinkHost, refreshDecorations } from "./livepreview";
import { confirmBox, contextMenu, MenuItem, toast } from "./ui";

export type Mode = EditMode | "read";

interface Tab {
  path: string;
  kind: "note" | "file"; // notes are edited; other files (images, PDFs…) are viewed
  mode: Mode;
  lastEdit: EditMode; // mode to return to from reading view
  state: EditorState;
  saved: Text; // doc as last written to / read from disk
  mtime: number;
  timer?: number;
  conflict?: boolean;
  back: string[]; // navigation history within this tab
  fwd: string[];
  /** Where each note shown in this tab was scrolled to, for switching back. */
  scrolls: Map<string, { edit?: StateEffect<unknown>; read: number }>;
}

export interface OpenOptions {
  newTab?: boolean; // open in a new tab instead of replacing the current one
  background?: boolean; // new tab, without switching to it
  side?: boolean; // open in the other pane, splitting the view if needed
  focus?: boolean; // move keyboard focus to the editor (default true)
  line?: number; // 1-based line to jump to
  col?: number;
  len?: number; // characters to select from col
  heading?: string; // scroll to this heading
}

type FileContent = { content: string; mtime: number } | null;

interface SavedPane {
  tabs: { path: string; mode: Mode }[];
  active: string | null;
}

const AUTOSAVE_MS = 1000;
const STORAGE_KEY = "mdv.tabs";
const TAB_MIME = "text/mdv-tab"; // "<pane>:<tab>" while dragging a tab
const PATH_MIME = "text/mdv-path"; // a file dragged from the tree

const $ = (id: string) => document.getElementById(id)!;
const label = (p: string) => (isNote(p) ? stripMd(basename(p)) : basename(p));
const div = (cls: string, tag = "div") => {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
};

let reader: typeof import("./reader") | null = null;
const loadReader = async () => (reader ??= await import("./reader"));

/**
 * One side of the workspace: a tab strip plus the editor, reading view and
 * file viewer that show its active tab. The workspace holds one or two panes.
 */
class Pane {
  tabs: Tab[] = [];
  active = -1;
  readonly el = div("pane", "section");
  readonly bar = div("pane-tabbar");
  readonly strip = div("pane-tabs");
  readonly content = div("pane-content");
  readonly editorEl = div("pane-editor");
  readonly readerEl = div("pane-reader reader", "article");
  readonly viewerEl = div("pane-viewer");
  readonly emptyEl = div("pane-empty");
  readonly view: EditorView;
  private readerPath = ""; // note currently rendered in the reading view

  constructor(private ws: Tabs) {
    this.bar.append(this.strip);
    this.viewerEl.tabIndex = -1;
    const logo = document.createElement("img");
    logo.className = "empty-logo";
    logo.alt = "";
    logo.width = logo.height = 128;
    logo.src = document.documentElement.dataset.theme === "latte" ? "/logo-mark-light.png" : "/logo-mark.png";
    const p = document.createElement("p");
    p.textContent = "No file open";
    const hint = div("hint", "p");
    hint.innerHTML = "Pick a note from the tree, or press <kbd>Alt</kbd>+<kbd>N</kbd>";
    this.emptyEl.append(logo, p, hint);
    this.content.append(this.editorEl, this.readerEl, this.viewerEl, this.emptyEl);
    this.el.append(this.bar, this.content);

    this.view = new EditorView({ parent: this.editorEl });
    const scrolled = () => this.ws.paneScrolled(this);
    this.view.scrollDOM.addEventListener("scroll", scrolled, { passive: true });
    this.readerEl.addEventListener("scroll", scrolled, { passive: true });
    // Clicking or tabbing into a pane makes it the one the rest of the app follows.
    this.el.addEventListener("pointerdown", () => this.ws.focusPane(this), true);
    this.el.addEventListener("focusin", () => this.ws.focusPane(this));
    this.bindReader();
    this.bindDrop();
  }

  destroy() {
    this.view.destroy();
    this.el.remove();
  }

  cur(): Tab | undefined {
    return this.tabs[this.active];
  }

  get isFocused() {
    return this.ws.focused === this;
  }

  /** Live editor state of a tab in this pane (the view holds the active one's). */
  stateOf(t: Tab): EditorState {
    return t === this.cur() ? this.view.state : t.state;
  }

  // ---------- switching ----------

  activate(i: number, focus = true) {
    if (i < 0 || i >= this.tabs.length) return;
    if (i !== this.active) {
      this.stash();
      this.active = i;
      this.show(this.tabs[i]);
    }
    this.render();
    if (focus) this.focus();
  }

  focus() {
    const t = this.cur();
    if (!t) return;
    if (t.kind === "note" && t.mode !== "read") this.view.focus();
    else (t.kind === "note" ? this.readerEl : this.viewerEl).focus();
  }

  /** Select a range on a 1-based line and scroll it to the middle. */
  goto(line: number, col: number, len: number) {
    const t = this.cur();
    if (t?.mode === "read") this.setMode(t.lastEdit);
    const doc = this.view.state.doc;
    const l = doc.line(Math.min(Math.max(1, line), doc.lines));
    const from = Math.min(l.from + col, l.to);
    const to = Math.min(from + len, l.to);
    this.view.dispatch({
      selection: { anchor: from, head: to },
      effects: EditorView.scrollIntoView(from, { y: "center" }),
    });
  }

  gotoHeading(heading: string) {
    const t = this.cur();
    if (!t || t.kind !== "note") return;
    const want = heading.trim().toLowerCase();
    if (t.mode === "read") {
      const h = [...this.readerEl.querySelectorAll("h1,h2,h3,h4,h5,h6")].find(
        (h) => h.textContent?.trim().toLowerCase() === want,
      );
      h?.scrollIntoView({ block: "start" });
      return;
    }
    const doc = this.view.state.doc;
    for (let n = 1; n <= doc.lines; n++) {
      const m = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(doc.line(n).text);
      if (m && m[1].toLowerCase() === want) {
        const pos = doc.line(n).from;
        this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start" }) });
        return;
      }
    }
  }

  // ---------- modes ----------

  setMode(mode: Mode) {
    const t = this.cur();
    if (!t || t.kind !== "note" || t.mode === mode) return;
    this.stash();
    if (mode !== "read") {
      t.lastEdit = mode;
      t.state = t.state.update({ effects: modeSlot.reconfigure(modeExtension(mode, this.ws.host(t))) }).state;
      this.show(t);
    }
    t.mode = mode;
    this.render();
    this.focus();
    this.ws.persist();
  }

  /** Files were added/removed: link styling and embeds may change. */
  linksChanged() {
    if (this.cur()?.mode === "read") this.renderReader();
    else this.view.dispatch({ effects: refreshDecorations.of(null) });
  }

  // ---------- reading view ----------

  async renderReader() {
    const t = this.cur();
    if (!t || t.mode !== "read") return;
    const r = await loadReader();
    if (t !== this.cur()) return;
    // Re-rendering the same note keeps its position; another note starts where
    // it was left in this tab, or at the top.
    const scroll = this.readerPath === t.path ? this.readerEl.scrollTop : (t.scrolls.get(t.path)?.read ?? 0);
    r.render(this.readerEl, this.view.state.doc.toString(), t.path);
    this.readerEl.scrollTop = scroll;
    this.readerPath = t.path;
    if (this.isFocused) this.ws.onViewChange(true);
  }

  private bindReader() {
    this.readerEl.tabIndex = -1;
    this.readerEl.addEventListener("click", (e) => {
      const t = this.cur();
      if (!t) return;
      const el = e.target as HTMLElement;
      const mod = e.ctrlKey || e.metaKey;
      if (el instanceof HTMLInputElement && el.classList.contains("task")) {
        const line = Number(el.dataset.line);
        const doc = this.view.state.doc;
        if (line >= 0 && line < doc.lines) {
          const l = doc.line(line + 1);
          const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])\]/.exec(l.text);
          if (m) {
            const at = l.from + m[1].length;
            this.view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === " " ? "x" : " " } });
            this.stash();
          }
        }
        return;
      }
      const a = el.closest<HTMLAnchorElement>("a");
      // Links inside an embedded note are relative to that note.
      const from = el.closest<HTMLElement>("[data-embed-from]")?.dataset.embedFrom ?? t.path;
      const where = mod && e.shiftKey ? "side" : mod;
      if (a?.dataset.target !== undefined) {
        e.preventDefault();
        this.ws.follow(t, a.dataset.target, true, where, from);
      } else if (a?.dataset.href) {
        e.preventDefault();
        this.ws.follow(t, a.dataset.href, false, where, from);
      } else if (el instanceof HTMLImageElement && el.dataset.path && mod) {
        this.ws.open(el.dataset.path, { newTab: e.shiftKey });
      }
    });
    this.readerEl.addEventListener("dblclick", (e) => {
      // Double-click a spot to start editing there.
      if ((e.target as HTMLElement).closest("a, input")) return;
      const t = this.cur();
      if (t) this.setMode(t.lastEdit);
    });
  }

  // ---------- file viewer (images, PDFs, other) ----------

  renderViewer(t: Tab) {
    const url = rawUrl(t.path) + (t.mtime ? "&t=" + t.mtime : "");
    this.viewerEl.replaceChildren();
    if (isImage(t.path)) {
      const img = document.createElement("img");
      img.src = url;
      img.alt = t.path;
      img.title = "Click to toggle actual size";
      img.onclick = () => this.viewerEl.classList.toggle("actual");
      this.viewerEl.append(img);
    } else if (isPdf(t.path)) {
      const frame = document.createElement("iframe");
      frame.src = url;
      frame.title = t.path;
      this.viewerEl.append(frame);
    } else {
      const box = div("viewer-other");
      const p = document.createElement("p");
      p.textContent = basename(t.path);
      const a = document.createElement("a");
      a.href = rawUrl(t.path);
      a.download = basename(t.path);
      a.textContent = "Download";
      box.append(p, a);
      this.viewerEl.append(box);
    }
  }

  // ---------- state handling ----------

  /** Copy the live view state (and scroll position) back into the active tab before switching away. */
  stash() {
    const t = this.cur();
    if (t?.kind !== "note") return;
    t.state = this.view.state;
    const prev = t.scrolls.get(t.path);
    t.scrolls.set(t.path, {
      edit: t.mode === "read" ? prev?.edit : this.view.scrollSnapshot(),
      read: t.mode === "read" ? this.readerEl.scrollTop : (prev?.read ?? 0),
    });
  }

  /**
   * Put a tab's note in the editor. The editor component is shared by all
   * tabs of the pane, so its scroll position has to be set explicitly: back to
   * where this note was, or the top for a note not seen in this tab yet.
   */
  show(t: Tab) {
    this.view.setState(t.state);
    // Setting scrollTop directly doesn't stick (the editor re-anchors after
    // a state swap), so scroll through the editor itself.
    // The first line sits below the content's top padding; margin = padding puts it at scrollTop 0.
    const pad = parseFloat(getComputedStyle(this.view.contentDOM).paddingTop) || 0;
    const top = EditorView.scrollIntoView(0, { y: "start", yMargin: pad });
    let snap = t.scrolls.get(t.path)?.edit ?? top;
    try {
      this.view.dispatch({ effects: snap });
    } catch {
      this.view.dispatch({ effects: (snap = top) }); // snapshot no longer fits the document
    }
    // Embedded notes may have changed while this tab was in the background.
    this.view.dispatch({ effects: refreshDecorations.of(null) });
    this.readerPath = ""; // the reading view restores its own position on next render
  }

  /** Insert a tab at index i (default: next to the active one), optionally making it active. */
  insert(t: Tab, i = this.active < 0 ? this.tabs.length : this.active + 1, activate = true) {
    i = Math.max(0, Math.min(i, this.tabs.length));
    this.tabs.splice(i, 0, t);
    if (activate) {
      this.stash();
      this.active = i;
      this.show(t);
    } else if (this.active >= i) this.active++;
  }

  /** Take a tab out of the pane (state stashed, nothing saved or rendered). */
  detach(i: number): Tab {
    const wasActive = i === this.active;
    if (wasActive) this.stash();
    const [t] = this.tabs.splice(i, 1);
    if (!this.tabs.length) this.active = -1;
    else if (i < this.active || this.active >= this.tabs.length) this.active--;
    // The active tab went: its right-hand neighbour (or the new last tab) takes over.
    if (wasActive && this.active >= 0) this.show(this.tabs[this.active]);
    return t;
  }

  // ---------- rendering ----------

  render() {
    const t = this.cur();
    const show = (el: HTMLElement, on: boolean) => (el.style.display = on ? "" : "none");
    show(this.editorEl, t?.kind === "note" && t.mode !== "read");
    show(this.readerEl, t?.kind === "note" && t.mode === "read");
    show(this.viewerEl, t?.kind === "file");
    show(this.emptyEl, !t);
    if (t?.kind === "note" && t.mode === "read") this.renderReader();
    if (t?.kind === "file") this.renderViewer(t);
    this.renderTabs();
    if (this.isFocused) this.ws.focusedChanged();
  }

  renderTabs() {
    const pi = this.ws.indexOf(this);
    this.strip.replaceChildren(
      ...this.tabs.map((t, i) => {
        const el = div("tab" + (i === this.active ? " active" : "") + (this.ws.dirty(t) ? " dirty" : ""));
        el.title = t.path;
        el.draggable = true;
        const name = div("tab-name", "span");
        name.textContent = label(t.path);
        const x = div("tab-close", "button");
        x.textContent = "×";
        x.title = "Close (Alt+W)";
        x.onclick = (e) => {
          e.stopPropagation();
          this.ws.closeTab(this, i);
        };
        el.append(name, x);
        el.onclick = () => {
          this.ws.focusPane(this);
          this.activate(i);
          this.ws.persist();
        };
        el.onauxclick = (e) => {
          if (e.button === 1) this.ws.closeTab(this, i);
        };
        el.oncontextmenu = (e) => {
          e.preventDefault();
          this.ws.tabMenu(this, i, e.clientX, e.clientY);
        };
        el.ondragstart = (e) => {
          e.dataTransfer!.setData(TAB_MIME, `${pi}:${i}`);
          e.dataTransfer!.effectAllowed = "move";
        };
        el.ondragover = (e) => {
          if (this.ws.dragKind(e)) e.preventDefault();
        };
        el.ondrop = (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.ws.dropOn(this, i, e);
        };
        return el;
      }),
    );
    this.strip.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** Dropping tabs (or tree files) on the strip or the content area. */
  private bindDrop() {
    this.strip.addEventListener("dragover", (e) => {
      if (this.ws.dragKind(e)) e.preventDefault();
    });
    this.strip.addEventListener("drop", (e) => {
      e.preventDefault();
      this.ws.dropOn(this, this.tabs.length, e);
    });
    // Tabs dropped on a note: the right half of a lone pane splits the view.
    const zone = (e: DragEvent): "all" | "right" | null => {
      if (this.ws.dragKind(e) !== "tab") return null;
      if (this.ws.panes.length > 1) return "all";
      const r = this.content.getBoundingClientRect();
      return e.clientX > r.left + r.width / 2 ? "right" : null;
    };
    const clear = () => this.content.classList.remove("drop-all", "drop-right");
    this.content.addEventListener(
      "dragover",
      (e) => {
        const z = zone(e);
        this.content.classList.toggle("drop-all", z === "all");
        this.content.classList.toggle("drop-right", z === "right");
        if (z) {
          e.preventDefault();
          e.stopPropagation(); // not an editor drop (that would insert text)
        }
      },
      true,
    );
    this.content.addEventListener("dragleave", (e) => {
      if (!this.content.contains(e.relatedTarget as Node)) clear();
    });
    this.content.addEventListener(
      "drop",
      (e) => {
        const z = zone(e);
        clear();
        if (!z) return;
        e.preventDefault();
        e.stopPropagation();
        if (z === "right") this.ws.dropToSide(e);
        else this.ws.dropOn(this, this.active + 1, e);
      },
      true,
    );
    document.addEventListener("dragend", clear);
  }
}

/**
 * The open files: one pane, or two side by side. Each file is open in at most
 * one tab across both panes. Everything else in the app talks to the focused
 * pane through this class.
 */
export class Tabs {
  panes: Pane[] = [];
  focused: Pane;
  private panesEl = $("panes");
  private ratio = 0.5; // share of the width taken by the left pane
  private divider = div("pane-divider");
  // Window buttons, moved into the outer tab bars. Held directly: they may sit
  // in a pane that's being removed, outside the document.
  private buttons = {
    sidebar: $("toggle-sidebar"),
    split: $("toggle-split"),
    right: [$("toggle-split"), $("toggle-map"), $("open-settings")],
  };
  /** Mode for newly opened notes. */
  defaultMode: Mode = "live";
  /** Called whenever the active file changes (for tree highlighting). */
  onActiveChange: (path: string | null) => void = () => {};
  /** Called after a successful save. */
  onSaved: (path: string, mtime: number) => void = () => {};
  /** Called after the tabs created a note (e.g. by following an unresolved link). */
  onCreated: (path: string) => void = () => {};
  /** Called when the visible note scrolls, resizes (false) or changes content (true). */
  onViewChange: (content: boolean) => void = () => {};

  constructor() {
    this.focused = this.addPane();
    this.bindDivider();
    this.layout();
    this.focused.render();
  }

  // ---------- panes ----------

  indexOf(p: Pane) {
    return this.panes.indexOf(p);
  }

  get split() {
    return this.panes.length > 1;
  }

  private addPane(): Pane {
    const p = new Pane(this);
    this.panes.push(p);
    return p;
  }

  private paneOf(t: Tab): Pane | undefined {
    return this.panes.find((p) => p.tabs.includes(t));
  }

  private find(path: string): { pane: Pane; i: number } | null {
    for (const pane of this.panes) {
      const i = pane.tabs.findIndex((t) => t.path === path);
      if (i >= 0) return { pane, i };
    }
    return null;
  }

  private all(): Tab[] {
    return this.panes.flatMap((p) => p.tabs);
  }

  /** Lay the panes out in the DOM. The window buttons live in the outer tab bars. */
  private layout() {
    const [a, b] = this.panes;
    this.panesEl.replaceChildren(...(b ? [a.el, this.divider, b.el] : [a.el]));
    this.panesEl.classList.toggle("split", !!b);
    a.el.style.flex = b ? `${this.ratio} 1 0` : "";
    if (b) b.el.style.flex = `${1 - this.ratio} 1 0`;
    a.bar.prepend(this.buttons.sidebar);
    (b ?? a).bar.append(...this.buttons.right);
    const btn = this.buttons.split;
    btn.title = b ? "Close split, keeping all tabs (Alt+\\)" : "Split right (Alt+\\)";
    btn.classList.toggle("on", !!b);
    for (const p of this.panes) p.el.classList.toggle("focused", !!b && p === this.focused);
  }

  focusPane(p: Pane) {
    if (p === this.focused || !this.panes.includes(p)) return;
    this.focused.stash();
    this.focused = p;
    for (const x of this.panes) x.el.classList.toggle("focused", this.split && x === p);
    this.focusedChanged();
    this.persist();
  }

  /** The focused pane's active file changed (or the focus moved to another pane). */
  focusedChanged() {
    this.renderStatus();
    this.onActiveChange(this.activePath);
    this.onViewChange(true);
  }

  paneScrolled(p: Pane) {
    if (p === this.focused) this.onViewChange(false);
  }

  /**
   * Alt+\ and the split button: split the view, or put it back to one pane.
   * Splitting moves the current note to a new right pane when there's another
   * tab to leave behind; otherwise the new pane starts empty, ready for the
   * next note picked from the tree.
   */
  toggleSplit() {
    if (this.split) this.unsplit();
    else {
      const from = this.panes[0];
      const right = this.addPane();
      if (from.tabs.length > 1) right.insert(from.detach(from.active));
      this.focused = right;
      this.layout();
      from.render();
      right.render();
      right.focus();
      this.persist();
    }
  }

  /** Back to one pane: the other pane's tabs join the remaining one. */
  private unsplit() {
    const keep = this.focused.cur();
    const [a, b] = this.panes;
    a.stash();
    b.stash();
    for (const t of b.tabs) a.tabs.push(t);
    b.tabs = [];
    this.removePane(b);
    if (keep) {
      a.active = a.tabs.indexOf(keep);
      a.show(keep);
    }
    a.render();
    a.focus();
    this.persist();
  }

  private removePane(p: Pane) {
    if (!this.split) return;
    this.panes.splice(this.indexOf(p), 1);
    // Keep the window buttons: layout() moves them into the remaining pane.
    this.focused = this.panes[0];
    this.layout();
    p.destroy();
  }

  /** Alt+Shift+\: move keyboard focus to the other pane. */
  focusOther() {
    if (!this.split) return;
    const p = this.panes[1 - this.indexOf(this.focused)];
    this.focusPane(p);
    p.focus();
  }

  /** Move tab i of pane `from` into pane `to` at index `at`, making it active there. */
  private moveTab(from: Pane, i: number, to: Pane, at: number) {
    const t = from.tabs[i];
    if (!t) return;
    if (from === to) {
      // Reorder within the pane.
      const activeTab = from.cur();
      from.tabs.splice(i, 1);
      from.tabs.splice(at > i ? at - 1 : at, 0, t);
      from.active = activeTab ? from.tabs.indexOf(activeTab) : -1;
      from.renderTabs();
      this.persist();
      return;
    }
    from.detach(i);
    to.insert(t, at);
    this.focused = to;
    if (!from.tabs.length) this.removePane(from);
    else {
      this.layout();
      from.render();
    }
    to.render();
    to.focus();
    this.persist();
  }

  /** Tab context menu. */
  tabMenu(p: Pane, i: number, x: number, y: number) {
    const t = p.tabs[i];
    const other = this.panes.find((o) => o !== p);
    const side = this.indexOf(p) === 0 ? "right" : "left";
    const items: MenuItem[] = [
      { label: "Close", hint: "Alt+W", run: () => this.closeTab(p, i) },
      {
        label: "Close others",
        run: async () => {
          for (const o of [...p.tabs]) if (o !== t) await this.closeTab(p, p.tabs.indexOf(o));
        },
      },
    ];
    if (other) items.push({ label: `Move to ${side} pane`, run: () => this.moveTab(p, i, other, other.active + 1) });
    else if (p.tabs.length > 1) items.push({ label: "Move to the side", hint: "Alt+\\", run: () => this.toSide(p, i) });
    items.push({ label: "Copy path", run: () => navigator.clipboard?.writeText(t.path).catch(() => {}) });
    contextMenu(x, y, items);
  }

  /** Split the view with tab i of pane p on the right. */
  private toSide(p: Pane, i: number) {
    if (this.split || p.tabs.length < 2) return;
    const right = this.addPane();
    this.layout();
    this.moveTab(p, i, right, 0);
  }

  // ---------- drag and drop ----------

  dragKind(e: DragEvent): "tab" | "path" | null {
    const types = e.dataTransfer?.types ?? [];
    return types.includes(TAB_MIME) ? "tab" : types.includes(PATH_MIME) ? "path" : null;
  }

  private dragged(e: DragEvent): { pane: Pane; i: number } | null {
    const [pi, ti] = (e.dataTransfer?.getData(TAB_MIME) ?? "").split(":").map(Number);
    const pane = this.panes[pi];
    return pane && pane.tabs[ti] ? { pane, i: ti } : null;
  }

  /** Something dropped on pane p's tab strip (at tab index `at`) or content. */
  dropOn(p: Pane, at: number, e: DragEvent) {
    const src = this.dragged(e);
    if (src) {
      this.moveTab(src.pane, src.i, p, at);
      return;
    }
    const path = e.dataTransfer?.getData(PATH_MIME);
    if (path && vaultFiles.has(path)) {
      this.focusPane(p);
      this.open(path, { newTab: true });
    }
  }

  dropToSide(e: DragEvent) {
    const src = this.dragged(e);
    if (src) this.toSide(src.pane, src.i);
  }

  private bindDivider() {
    const d = this.divider;
    d.title = "Drag to resize, double-click to reset";
    d.onpointerdown = (e) => {
      d.setPointerCapture(e.pointerId);
      document.body.classList.add("resizing");
      d.classList.add("dragging");
      const vertical = getComputedStyle(this.panesEl).flexDirection === "column";
      d.onpointermove = (m) => {
        const r = this.panesEl.getBoundingClientRect();
        const f = vertical ? (m.clientY - r.top) / r.height : (m.clientX - r.left) / r.width;
        this.ratio = Math.max(0.15, Math.min(0.85, f));
        this.layout();
        this.onViewChange(false);
      };
      d.onpointerup = () => {
        d.onpointermove = null;
        document.body.classList.remove("resizing");
        d.classList.remove("dragging");
        this.persist();
      };
    };
    d.ondblclick = () => {
      this.ratio = 0.5;
      this.layout();
      this.persist();
    };
  }

  // ---------- the focused pane, for the rest of the app ----------

  private cur(): Tab | undefined {
    return this.focused.cur();
  }

  /** Geometry of the active note for the file map, or null if none is shown. */
  mapView(): MapView | null {
    const p = this.focused;
    const t = p.cur();
    if (!t || t.kind !== "note") return null;
    const text = p.view.state.doc.toString();
    if (t.mode === "read") {
      const r = p.readerEl;
      const hs = [...r.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")];
      return {
        text,
        scroller: r,
        height: r.scrollHeight,
        lineTop: () => 0,
        headingTops: hs.map((h) => h.offsetTop),
        reveal: (_h, i) => hs[i]?.scrollIntoView({ block: "start" }),
      };
    }
    const v = p.view;
    const pad = v.documentPadding.top;
    return {
      text,
      scroller: v.scrollDOM,
      height: v.scrollDOM.scrollHeight,
      lineTop: (n) => {
        const doc = v.state.doc;
        return pad + v.lineBlockAt(doc.line(Math.min(Math.max(1, n), doc.lines)).from).top;
      },
      // Scroll only: clicking the outline shouldn't move the cursor.
      reveal: (h) => {
        const doc = v.state.doc;
        const pos = doc.line(Math.min(h.line, doc.lines)).from;
        v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "start", yMargin: 16 }) });
      },
    };
  }

  get activePath(): string | null {
    return this.cur()?.path ?? null;
  }

  get activeMode(): Mode | null {
    return this.cur()?.mode ?? null;
  }

  get paths(): string[] {
    return this.all().map((t) => t.path);
  }

  host(t: Tab): LinkHost {
    return {
      path: () => t.path,
      follow: (target, wiki, newTab, from) => this.follow(t, target, wiki, newTab, from),
      openFile: (path, newTab) => this.open(path, { newTab }),
    };
  }

  private newState(t: Tab, doc: string) {
    // Start below any frontmatter, so it stays collapsed until wanted.
    const anchor = bodyStart(Text.of(doc.split(/\r\n?|\n/)));
    return EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        editorExtensions(
          {
            onChange: () => this.scheduleSave(t),
            onSave: () => this.save(t),
          },
          this.host(t),
          t.mode === "read" ? t.lastEdit : t.mode,
        ),
        EditorView.updateListener.of((u) => {
          // Tabs can move between panes, so look up where this one lives now.
          if (this.cur() !== t) return;
          if (u.docChanged || u.selectionSet) this.renderStatus();
          if (u.docChanged) this.onViewChange(true);
          else if (u.geometryChanged || u.viewportChanged) this.onViewChange(false);
        }),
      ],
    });
  }

  // ---------- opening & navigation ----------

  /**
   * Open a file. Like Obsidian, this replaces the current tab's file (keeping
   * back/forward history) unless a new tab is asked for or the file is
   * already open in a tab (in either pane), in which case that tab is shown.
   */
  async open(path: string, opts: OpenOptions = {}) {
    let found = this.find(path);
    let pane = found?.pane ?? this.focused;
    if (!found) {
      const content = await this.fetch(path);
      if (opts.side) {
        if (!this.split) {
          this.addPane();
          this.layout();
        }
        pane = this.panes[1 - this.indexOf(this.focused)];
      }
      const cur = pane.cur();
      if (!opts.side && !opts.newTab && !opts.background && cur && (await this.release(cur))) {
        this.assign(cur, path, content, true);
      } else {
        const t: Tab = {
          path,
          kind: "note",
          mode: this.defaultMode,
          lastEdit: this.defaultMode === "read" ? "live" : this.defaultMode,
          state: EditorState.create(),
          saved: Text.empty,
          mtime: 0,
          back: [],
          fwd: [],
          scrolls: new Map(),
        };
        this.assign(t, path, content, false);
        pane.insert(t, undefined, !opts.background);
      }
      found = this.find(path);
    }
    if (!found) return;
    if (!opts.background) {
      this.focusPane(pane);
      pane.activate(found.i, opts.focus ?? true);
      if (opts.line) pane.goto(opts.line, opts.col ?? 0, opts.len ?? 0);
      else if (opts.heading) pane.gotoHeading(opts.heading);
    } else pane.render();
    this.persist();
  }

  /** Note content, or null for non-note files (which are only viewed). */
  private async fetch(path: string): Promise<FileContent> {
    if (!isNote(path)) {
      if (!vaultFiles.has(path)) throw new Error(`Not found: ${path}`);
      return null;
    }
    const f = await api.read(path);
    return { content: f.content, mtime: f.mtime };
  }

  /** Save a tab before navigating away from its note. False if it can't be left. */
  private async release(t: Tab): Promise<boolean> {
    const p = this.paneOf(t);
    if (p && t === p.cur()) p.stash();
    if (this.dirty(t)) await this.save(t);
    return !t.conflict; // keep conflicting edits visible rather than drop them
  }

  /** Point a tab at a file. */
  private assign(t: Tab, path: string, f: FileContent, navigate: boolean) {
    if (navigate && t.path !== path) {
      t.back.push(t.path);
      if (t.back.length > 100) t.back.shift();
      t.fwd = [];
    }
    clearTimeout(t.timer);
    t.path = path;
    t.kind = f ? "note" : "file";
    t.mtime = f?.mtime ?? 0;
    t.conflict = false;
    t.state = this.newState(t, f?.content ?? "");
    t.saved = t.state.doc;
    const p = this.paneOf(t);
    if (p && t === p.cur()) p.show(t);
  }

  /** Alt+Left / Alt+Right within the current tab. */
  async history(dir: -1 | 1) {
    const p = this.focused;
    const t = p.cur();
    if (!t) return;
    const from = dir < 0 ? t.back : t.fwd;
    const to = dir < 0 ? t.fwd : t.back;
    while (from.length) {
      const path = from.pop()!;
      const other = this.find(path);
      if (other && other.pane.tabs[other.i] !== t) continue; // open elsewhere; skip
      let f;
      try {
        f = await this.fetch(path);
      } catch {
        continue; // deleted since
      }
      if (!(await this.release(t))) return;
      to.push(t.path);
      this.assign(t, path, f, false);
      p.render();
      this.persist();
      return;
    }
  }

  /** Follow a link written in tab t's note (or in a note embedded in it, `from`). */
  async follow(t: Tab, target: string, wiki: boolean, where: boolean | "side", from = t.path) {
    if (!wiki && /^[a-z][a-z0-9+.-]*:/i.test(target)) {
      window.open(target, "_blank", "noopener,noreferrer");
      return;
    }
    let name = target;
    let heading = "";
    const hash = name.indexOf("#");
    if (hash >= 0) {
      heading = name.slice(hash + 1);
      name = name.slice(0, hash);
    }
    if (!wiki) {
      try {
        heading = decodeURIComponent(heading);
      } catch {}
    }
    const pane = this.paneOf(t);
    if (pane) this.focusPane(pane);
    if (!name && from !== t.path) name = from; // [[#Heading]] inside an embedded note
    if (!name) {
      // [[#Heading]] within the same note.
      if (heading) pane?.gotoHeading(heading);
      return;
    }
    let path = vaultFiles.resolve(name, from, wiki);
    if (!path) {
      if (!wiki) {
        toast(new Error(`No such file: ${name}`));
        return;
      }
      // Unresolved wikilink: create the note next to the current one.
      const rel = name.includes("/") ? name : (dirname(from) ? dirname(from) + "/" : "") + name;
      const p = normalize(/\.[^/.]+$/.test(basename(rel)) ? rel : rel + ".md");
      if (!p) return;
      if (!(await confirmBox(`“${stripMd(p)}” doesn't exist yet. Create ${p}?`, "Create", false))) return;
      try {
        await api.create(p);
      } catch (e) {
        toast(e);
        return;
      }
      vaultFiles.update([...vaultFiles.paths, p]);
      this.onCreated(p);
      path = p;
    }
    if (path === t.path && heading) {
      pane?.gotoHeading(heading);
      return;
    }
    await this.open(path, { newTab: where === true, side: where === "side", heading: heading || undefined });
  }

  /** Alt+1…9: a tab of the focused pane. */
  activate(i: number, focus = true) {
    this.focused.activate(i, focus);
    this.persist();
  }

  focus() {
    this.focused.focus();
  }

  goto(line: number, col: number, len: number) {
    this.focused.goto(line, col, len);
  }

  gotoHeading(heading: string) {
    this.focused.gotoHeading(heading);
  }

  // ---------- modes ----------

  setMode(mode: Mode) {
    this.focused.setMode(mode);
  }

  /** Ctrl+E: reading view ↔ editing. */
  toggleRead() {
    const t = this.cur();
    if (t) this.setMode(t.mode === "read" ? t.lastEdit : "read");
  }

  /** Cycle live → source → read (status bar button). */
  cycleMode() {
    const t = this.cur();
    if (!t) return;
    this.setMode(t.mode === "live" ? "source" : t.mode === "source" ? "read" : "live");
  }

  /** Files were added/removed: link styling and embeds may change. */
  linksChanged() {
    for (const p of this.panes) p.linksChanged();
  }

  // ---------- closing ----------

  /** Alt+W: close the focused pane's active tab. */
  close() {
    return this.closeTab(this.focused, this.focused.active);
  }

  /** Close a tab. A split pane that loses its last tab closes too. */
  async closeTab(p: Pane, i: number) {
    const t = p.tabs[i];
    if (!t) return;
    if (i === p.active) p.stash();
    if (this.dirty(t)) await this.save(t);
    i = p.tabs.indexOf(t); // saving is async; the list may have changed
    if (i < 0) return;
    p.detach(i);
    if (!p.tabs.length && this.split) {
      this.removePane(p);
      this.focused.render();
    } else p.render();
    this.persist();
  }

  next(dir: 1 | -1) {
    const p = this.focused;
    if (p.tabs.length) this.activate((p.active + dir + p.tabs.length) % p.tabs.length);
  }

  // ---------- saving ----------

  dirty(t: Tab) {
    if (t.kind !== "note") return false;
    const p = this.paneOf(t);
    return !(p ? p.stateOf(t) : t.state).doc.eq(t.saved);
  }

  private scheduleSave(t: Tab) {
    clearTimeout(t.timer);
    t.timer = window.setTimeout(() => this.save(t), AUTOSAVE_MS);
    const p = this.paneOf(t);
    p?.renderTabs();
    this.renderStatus();
    if (p && t === p.cur() && t.mode === "read") p.renderReader(); // e.g. a ticked checkbox
  }

  async save(t: Tab, force = false) {
    clearTimeout(t.timer);
    if (t.kind !== "note" || (t.conflict && !force)) return;
    const p = this.paneOf(t);
    const doc = (p ? p.stateOf(t) : t.state).doc;
    if (!force && doc.eq(t.saved)) return;
    try {
      t.mtime = await api.write(t.path, doc.toString(), force ? 0 : t.mtime);
      t.saved = doc;
      t.conflict = false;
      this.onSaved(t.path, t.mtime);
    } catch (e) {
      if (e instanceof ConflictError) t.conflict = true;
      else toast(e);
    }
    this.paneOf(t)?.renderTabs();
    this.renderStatus();
  }

  /** Current text of a note open in a tab (including unsaved edits), else null. */
  textOf(path: string): string | null {
    const f = this.find(path);
    if (!f) return null;
    const t = f.pane.tabs[f.i];
    if (t.kind !== "note") return null;
    return f.pane.stateOf(t).doc.toString();
  }

  /** Replace the active note's text as an undoable edit (e.g. restoring a version). */
  replaceContent(content: string) {
    const p = this.focused;
    const t = p.cur();
    if (!t || t.kind !== "note") return;
    p.view.dispatch({ changes: { from: 0, to: p.view.state.doc.length, insert: content } });
    p.stash();
  }

  /** Discard local edits and load what's on disk. */
  async reload(t: Tab) {
    const f = await this.fetch(t.path);
    this.assign(t, t.path, f, false);
    this.paneOf(t)?.render();
  }

  // ---------- keeping in sync with the vault ----------

  /** Keep tabs in sync after a rename/move in the tree. */
  renamed(from: string, to: string) {
    const move = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    for (const t of this.all()) {
      t.path = move(t.path);
      t.back = t.back.map(move);
      t.fwd = t.fwd.map(move);
    }
    for (const p of this.panes) p.render();
    this.persist();
  }

  removed(path: string) {
    for (const p of [...this.panes]) {
      for (let i = p.tabs.length - 1; i >= 0; i--) {
        const t = p.tabs[i];
        if (t.path === path || t.path.startsWith(path + "/")) {
          t.saved = t.state.doc; // don't resurrect it on close
          clearTimeout(t.timer);
          p.detach(i);
        }
      }
      if (!p.tabs.length && this.split) this.removePane(p);
    }
    for (const p of this.panes) p.render();
    this.persist();
  }

  /** A file changed on disk (another device, git pull, an external editor). */
  async externalChange(path: string, mtime?: number) {
    const found = this.find(path);
    if (!found) return;
    const t = found.pane.tabs[found.i];
    if (t.kind === "file") {
      t.mtime = mtime ?? Date.now();
      const p = this.paneOf(t);
      if (p && t === p.cur()) p.renderViewer(t);
      return;
    }
    let f;
    try {
      f = await api.read(path);
    } catch {
      return;
    }
    if (f.content === t.saved.toString()) {
      t.mtime = f.mtime; // our own save echoing back
      return;
    }
    if (this.dirty(t)) {
      t.conflict = true;
      this.renderStatus();
      return;
    }
    // Clean tab: take the new content but keep cursor/undo history.
    const p = this.paneOf(t);
    if (!p) return;
    const isCur = t === p.cur();
    const state = p.stateOf(t);
    const head = Math.min(state.selection.main.head, f.content.length);
    const tr = state.update({
      changes: { from: 0, to: state.doc.length, insert: f.content },
      selection: { anchor: head },
    });
    if (isCur) p.view.dispatch(tr);
    else t.state = tr.state;
    t.saved = tr.state.doc;
    t.mtime = f.mtime;
    clearTimeout(t.timer);
    if (isCur && t.mode === "read") p.renderReader();
    p.renderTabs();
    this.renderStatus();
  }

  /** A file vanished on disk; close it if it's still gone and has no edits. */
  async externalRemove(path: string) {
    const affected = this.all().filter((t) => t.path === path || t.path.startsWith(path + "/"));
    for (const t of affected) {
      if (t.kind === "note") {
        try {
          await api.read(t.path); // replaced rather than deleted (atomic save)
          continue;
        } catch {}
      } else if (vaultFiles.has(t.path)) continue;
      if (!this.dirty(t)) this.removed(t.path);
      else {
        t.conflict = true;
        this.renderStatus();
      }
    }
  }

  // ---------- persistence ----------

  async restore() {
    let saved: {
      panes?: SavedPane[];
      focused?: number;
      ratio?: number;
      tabs?: SavedPane["tabs"]; // the format before split view
      active?: string | null;
    } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch {}
    const specs = saved?.panes ?? (saved?.tabs ? [{ tabs: saved.tabs, active: saved.active ?? null }] : []);
    if (!specs.length) return;
    if (typeof saved?.ratio === "number") this.ratio = Math.max(0.15, Math.min(0.85, saved.ratio));
    for (const [n, spec] of specs.slice(0, 2).entries()) {
      if (n > 0) {
        this.addPane();
        this.layout();
      }
      const pane = this.panes[n];
      this.focused = pane; // so background opens land here
      for (const { path, mode } of spec.tabs ?? []) {
        try {
          if (this.find(path)) continue;
          await this.open(path, { background: true });
          const f = this.find(path);
          const t = f?.pane.tabs[f.i];
          if (t && mode && t.kind === "note") {
            t.mode = mode;
            if (mode !== "read" && mode !== this.defaultMode) {
              t.lastEdit = mode;
              t.state = t.state.update({ effects: modeSlot.reconfigure(modeExtension(mode, this.host(t))) }).state;
            }
          }
        } catch {}
      }
      const i = pane.tabs.findIndex((t) => t.path === spec.active);
      if (pane.tabs.length) {
        pane.active = -1; // force a fresh show
        pane.activate(i >= 0 ? i : 0, false);
      }
    }
    // A pane whose files have all gone doesn't come back.
    for (const p of [...this.panes]) if (!p.tabs.length && this.split) this.removePane(p);
    this.focused = this.panes[Math.min(saved?.focused ?? 0, this.panes.length - 1)];
    this.layout();
    for (const p of this.panes) p.render();
    this.focused.focus();
    this.persist();
  }

  persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          panes: this.panes.map(
            (p): SavedPane => ({ tabs: p.tabs.map((t) => ({ path: t.path, mode: t.mode })), active: p.cur()?.path ?? null }),
          ),
          focused: this.indexOf(this.focused),
          ratio: this.ratio,
        }),
      );
    } catch {}
  }

  // ---------- status bar ----------

  private renderStatus() {
    const p = this.focused;
    const t = p.cur();
    const save = $("status-save");
    const modeBtn = $("status-mode");
    save.replaceChildren();
    if (!t) {
      $("status-path").textContent = "";
      $("status-words").textContent = "";
      $("status-pos").textContent = "";
      modeBtn.textContent = "";
      document.title = "mdv";
      return;
    }
    $("status-path").textContent = t.path;
    document.title = label(t.path) + " · mdv";
    if (t.kind !== "note") {
      $("status-words").textContent = "";
      $("status-pos").textContent = "";
      modeBtn.textContent = "";
      return;
    }
    const st = p.view.state;
    const head = st.selection.main.head;
    const line = st.doc.lineAt(head);
    let words = 0;
    for (const l of st.doc.iterLines()) words += l.match(/\S+/g)?.length ?? 0;
    $("status-words").textContent = `${words} words`;
    $("status-pos").textContent = t.mode === "read" ? "" : `Ln ${line.number}, Col ${head - line.from + 1}`;
    modeBtn.textContent = { live: "Live preview", source: "Source", read: "Reading" }[t.mode];

    if (t.conflict) {
      const msg = div("conflict", "span");
      msg.textContent = "Changed on disk: ";
      const keep = document.createElement("button");
      keep.textContent = "keep mine";
      keep.onclick = () => this.save(t, true);
      const reload = document.createElement("button");
      reload.textContent = "reload";
      reload.onclick = () => this.reload(t);
      save.append(msg, keep, " ", reload);
    } else {
      save.textContent = this.dirty(t) ? "● unsaved" : "✓ saved";
    }
  }

  /** Flush pending saves (on page hide). */
  flush() {
    for (const p of this.panes) p.stash();
    for (const t of this.all()) if (this.dirty(t) && !t.conflict) this.save(t);
  }
}
