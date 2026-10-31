import { EditorState, StateEffect, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { api, ConflictError, rawUrl } from "./api";
import { EditMode, editorExtensions, modeExtension, modeSlot } from "./editor";
import { basename, dirname, isImage, isNote, isPdf, normalize, stripMd, vaultFiles } from "./links";
import type { MapView } from "./filemap";
import { bodyStart, LinkHost, refreshDecorations } from "./livepreview";
import { toast } from "./ui";

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
  focus?: boolean; // move keyboard focus to the editor (default true)
  line?: number; // 1-based line to jump to
  col?: number;
  len?: number; // characters to select from col
  heading?: string; // scroll to this heading
}

const AUTOSAVE_MS = 1000;
const STORAGE_KEY = "mdv.tabs";

const $ = (id: string) => document.getElementById(id)!;
const label = (p: string) => (isNote(p) ? stripMd(basename(p)) : basename(p));

let reader: typeof import("./reader") | null = null;
const loadReader = async () => (reader ??= await import("./reader"));

export class Tabs {
  private tabs: Tab[] = [];
  private active = -1;
  private view: EditorView;
  private readerEl = $("reader");
  private viewerEl = $("viewer");
  private readerPath = ""; // note currently rendered in the reading view
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
    this.view = new EditorView({ parent: $("editor") });
    this.view.scrollDOM.addEventListener("scroll", () => this.onViewChange(false), { passive: true });
    this.readerEl.addEventListener("scroll", () => this.onViewChange(false), { passive: true });
    this.bindReader();
    this.render();
  }

  /** Geometry of the active note for the file map, or null if none is shown. */
  mapView(): MapView | null {
    const t = this.cur();
    if (!t || t.kind !== "note") return null;
    const text = this.view.state.doc.toString();
    if (t.mode === "read") {
      const r = this.readerEl;
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
    const v = this.view;
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
    return this.tabs[this.active]?.path ?? null;
  }

  get activeMode(): Mode | null {
    return this.cur()?.mode ?? null;
  }

  get paths(): string[] {
    return this.tabs.map((t) => t.path);
  }

  private cur(): Tab | undefined {
    return this.tabs[this.active];
  }

  private host(t: Tab): LinkHost {
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
   * already open in another tab, in which case that tab is shown.
   */
  async open(path: string, opts: OpenOptions = {}) {
    let i = this.tabs.findIndex((t) => t.path === path);
    const cur = this.cur();
    if (i < 0) {
      const content = await this.fetch(path);
      if (!opts.newTab && !opts.background && cur && (await this.release(cur))) {
        this.assign(cur, path, content, true);
        i = this.active;
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
        // Open next to the current tab, like most editors.
        i = this.active < 0 ? this.tabs.length : this.active + 1;
        this.tabs.splice(i, 0, t);
        if (opts.background && this.active >= i) this.active++;
      }
    }
    if (!opts.background) {
      this.activate(i, opts.focus ?? true);
      if (opts.line) this.goto(opts.line, opts.col ?? 0, opts.len ?? 0);
      else if (opts.heading) this.gotoHeading(opts.heading);
    } else this.render();
    this.persist();
  }

  /** Note content, or null for non-note files (which are only viewed). */
  private async fetch(path: string): Promise<{ content: string; mtime: number } | null> {
    if (!isNote(path)) {
      if (!vaultFiles.has(path)) throw new Error(`Not found: ${path}`);
      return null;
    }
    const f = await api.read(path);
    return { content: f.content, mtime: f.mtime };
  }

  /** Save a tab before navigating away from its note. False if it can't be left. */
  private async release(t: Tab): Promise<boolean> {
    if (t === this.cur()) this.stash();
    if (this.dirty(t)) await this.save(t);
    return !t.conflict; // keep conflicting edits visible rather than drop them
  }

  /** Point a tab at a file. */
  private assign(t: Tab, path: string, f: { content: string; mtime: number } | null, navigate: boolean) {
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
    if (t === this.cur()) this.show(t);
  }

  /** Alt+Left / Alt+Right within the current tab. */
  async history(dir: -1 | 1) {
    const t = this.cur();
    if (!t) return;
    const from = dir < 0 ? t.back : t.fwd;
    const to = dir < 0 ? t.fwd : t.back;
    while (from.length) {
      const path = from.pop()!;
      const other = this.tabs.findIndex((x) => x.path === path);
      if (other >= 0 && other !== this.active) continue; // open elsewhere; skip
      let f;
      try {
        f = await this.fetch(path);
      } catch {
        continue; // deleted since
      }
      if (!(await this.release(t))) return;
      to.push(t.path);
      this.assign(t, path, f, false);
      this.render();
      this.persist();
      return;
    }
  }

  /** Follow a link written in tab t's note (or in a note embedded in it, `from`). */
  private async follow(t: Tab, target: string, wiki: boolean, newTab: boolean, from = t.path) {
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
    if (!name && from !== t.path) name = from; // [[#Heading]] inside an embedded note
    if (!name) {
      // [[#Heading]] within the same note.
      if (heading) this.gotoHeading(heading);
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
      this.gotoHeading(heading);
      return;
    }
    await this.open(path, { newTab, heading: heading || undefined });
  }

  activate(i: number, focus = true) {
    if (i < 0 || i >= this.tabs.length) return;
    if (i !== this.active) {
      this.stash();
      this.active = i;
      this.show(this.tabs[i]);
    }
    this.render();
    if (focus) this.focus();
    this.persist();
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
      t.state = t.state.update({ effects: modeSlot.reconfigure(modeExtension(mode, this.host(t))) }).state;
      this.show(t);
    }
    t.mode = mode;
    this.render();
    this.focus();
    this.persist();
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
    if (this.cur()?.mode === "read") this.renderReader();
    else this.view.dispatch({ effects: refreshDecorations.of(null) });
  }

  // ---------- reading view ----------

  private async renderReader() {
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
    this.onViewChange(true);
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
      if (a?.dataset.target !== undefined) {
        e.preventDefault();
        this.follow(t, a.dataset.target, true, mod, from);
      } else if (a?.dataset.href) {
        e.preventDefault();
        this.follow(t, a.dataset.href, false, mod, from);
      } else if (el instanceof HTMLImageElement && el.dataset.path && mod) {
        this.open(el.dataset.path, { newTab: e.shiftKey });
      }
    });
    this.readerEl.addEventListener("dblclick", (e) => {
      // Double-click a spot to start editing there.
      if ((e.target as HTMLElement).closest("a, input")) return;
      this.toggleRead();
    });
  }

  // ---------- file viewer (images, PDFs, other) ----------

  private renderViewer(t: Tab) {
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
      const box = document.createElement("div");
      box.className = "viewer-other";
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

  // ---------- closing ----------

  /** Copy the live view state (and scroll position) back into the active tab before switching away. */
  private stash() {
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
   * tabs, so its scroll position has to be set explicitly: back to where this
   * note was, or the top for a note not seen in this tab yet.
   */
  private show(t: Tab) {
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

  async close(i = this.active) {
    const t = this.tabs[i];
    if (!t) return;
    this.stash();
    if (this.dirty(t)) await this.save(t);
    this.tabs.splice(i, 1);
    if (this.tabs.length === 0) {
      this.active = -1;
    } else if (i < this.active || this.active >= this.tabs.length) {
      this.active--;
    }
    if (this.active >= 0) this.show(this.tabs[this.active]);
    this.render();
    this.persist();
  }

  next(dir: 1 | -1) {
    if (this.tabs.length) this.activate((this.active + dir + this.tabs.length) % this.tabs.length);
  }

  // ---------- saving ----------

  private dirty(t: Tab) {
    if (t.kind !== "note") return false;
    const doc = t === this.cur() ? this.view.state.doc : t.state.doc;
    return !doc.eq(t.saved);
  }

  private scheduleSave(t: Tab) {
    clearTimeout(t.timer);
    t.timer = window.setTimeout(() => this.save(t), AUTOSAVE_MS);
    this.renderTabs();
    this.renderStatus();
    if (t === this.cur() && t.mode === "read") this.renderReader(); // e.g. a ticked checkbox
  }

  async save(t: Tab, force = false) {
    clearTimeout(t.timer);
    if (t.kind !== "note" || (t.conflict && !force)) return;
    const doc = t === this.cur() ? this.view.state.doc : t.state.doc;
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
    this.renderTabs();
    this.renderStatus();
  }

  /** Current text of a note open in a tab (including unsaved edits), else null. */
  textOf(path: string): string | null {
    const t = this.tabs.find((x) => x.path === path);
    if (!t || t.kind !== "note") return null;
    return (t === this.cur() ? this.view.state.doc : t.state.doc).toString();
  }

  /** Replace the active note's text as an undoable edit (e.g. restoring a version). */
  replaceContent(content: string) {
    const t = this.cur();
    if (!t || t.kind !== "note") return;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: content } });
    this.stash();
  }

  /** Discard local edits and load what's on disk. */
  async reload(t: Tab) {
    const f = await this.fetch(t.path);
    this.assign(t, t.path, f, false);
    this.render();
  }

  // ---------- keeping in sync with the vault ----------

  /** Keep tabs in sync after a rename/move in the tree. */
  renamed(from: string, to: string) {
    const move = (p: string) => (p === from ? to : p.startsWith(from + "/") ? to + p.slice(from.length) : p);
    for (const t of this.tabs) {
      t.path = move(t.path);
      t.back = t.back.map(move);
      t.fwd = t.fwd.map(move);
    }
    this.render();
    this.persist();
  }

  removed(path: string) {
    for (let i = this.tabs.length - 1; i >= 0; i--) {
      const p = this.tabs[i].path;
      if (p === path || p.startsWith(path + "/")) {
        this.tabs[i].saved = this.tabs[i].state.doc; // don't resurrect it on close
        clearTimeout(this.tabs[i].timer);
        this.tabs.splice(i, 1);
        if (i < this.active || this.active >= this.tabs.length) this.active--;
      }
    }
    if (this.active >= 0) this.show(this.tabs[this.active]);
    this.render();
    this.persist();
  }

  /** A file changed on disk (another device, git pull, an external editor). */
  async externalChange(path: string, mtime?: number) {
    const t = this.tabs.find((t) => t.path === path);
    if (!t) return;
    if (t.kind === "file") {
      t.mtime = mtime ?? Date.now();
      if (t === this.cur()) this.renderViewer(t);
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
    const isCur = t === this.cur();
    const state = isCur ? this.view.state : t.state;
    const head = Math.min(state.selection.main.head, f.content.length);
    const tr = state.update({
      changes: { from: 0, to: state.doc.length, insert: f.content },
      selection: { anchor: head },
    });
    if (isCur) this.view.dispatch(tr);
    else t.state = tr.state;
    t.saved = tr.state.doc;
    t.mtime = f.mtime;
    clearTimeout(t.timer);
    if (isCur && t.mode === "read") this.renderReader();
    this.renderTabs();
    this.renderStatus();
  }

  /** A file vanished on disk; close it if it's still gone and has no edits. */
  async externalRemove(path: string) {
    const affected = this.tabs.filter((t) => t.path === path || t.path.startsWith(path + "/"));
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
    let saved: { tabs?: { path: string; mode: Mode }[]; active: string | null } | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch {}
    if (!saved?.tabs) return;
    for (const { path, mode } of saved.tabs) {
      try {
        await this.open(path, { background: true });
        const t = this.tabs.find((x) => x.path === path);
        if (t && mode && t.kind === "note") {
          t.mode = mode;
          if (mode !== "read" && mode !== this.defaultMode) {
            t.lastEdit = mode;
            t.state = t.state.update({ effects: modeSlot.reconfigure(modeExtension(mode, this.host(t))) }).state;
          }
        }
      } catch {}
    }
    const i = this.tabs.findIndex((t) => t.path === saved!.active);
    if (this.tabs.length) this.activate(i >= 0 ? i : 0);
  }

  private persist() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ tabs: this.tabs.map((t) => ({ path: t.path, mode: t.mode })), active: this.activePath }),
      );
    } catch {}
  }

  // ---------- rendering ----------

  private render() {
    const t = this.cur();
    const show = (el: HTMLElement, on: boolean) => (el.style.display = on ? "" : "none");
    show($("editor"), t?.kind === "note" && t.mode !== "read");
    show(this.readerEl, t?.kind === "note" && t.mode === "read");
    show(this.viewerEl, t?.kind === "file");
    show($("empty"), !t);
    if (t?.kind === "note" && t.mode === "read") this.renderReader();
    if (t?.kind === "file") this.renderViewer(t);
    this.renderTabs();
    this.renderStatus();
    this.onActiveChange(this.activePath);
    this.onViewChange(true);
  }

  private renderTabs() {
    const bar = $("tabs");
    bar.replaceChildren(
      ...this.tabs.map((t, i) => {
        const el = document.createElement("div");
        el.className = "tab" + (i === this.active ? " active" : "") + (this.dirty(t) ? " dirty" : "");
        el.title = t.path;
        el.draggable = true;
        const name = document.createElement("span");
        name.className = "tab-name";
        name.textContent = label(t.path);
        const x = document.createElement("button");
        x.className = "tab-close";
        x.textContent = "×";
        x.title = "Close (Alt+W)";
        x.onclick = (e) => {
          e.stopPropagation();
          this.close(i);
        };
        el.append(name, x);
        el.onclick = () => this.activate(i);
        el.onauxclick = (e) => {
          if (e.button === 1) this.close(i);
        };
        // Drag to reorder.
        el.ondragstart = (e) => e.dataTransfer!.setData("text/mdv-tab", String(i));
        el.ondragover = (e) => {
          if (e.dataTransfer?.types.includes("text/mdv-tab")) e.preventDefault();
        };
        el.ondrop = (e) => {
          const from = Number(e.dataTransfer!.getData("text/mdv-tab"));
          if (Number.isNaN(from) || from === i) return;
          e.preventDefault();
          const activeTab = this.cur();
          const [moved] = this.tabs.splice(from, 1);
          this.tabs.splice(i, 0, moved);
          this.active = activeTab ? this.tabs.indexOf(activeTab) : -1;
          this.renderTabs();
          this.persist();
        };
        return el;
      }),
    );
    bar.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private renderStatus() {
    const t = this.cur();
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
    const st = this.view.state;
    const head = st.selection.main.head;
    const line = st.doc.lineAt(head);
    let words = 0;
    for (const l of st.doc.iterLines()) words += l.match(/\S+/g)?.length ?? 0;
    $("status-words").textContent = `${words} words`;
    $("status-pos").textContent = t.mode === "read" ? "" : `Ln ${line.number}, Col ${head - line.from + 1}`;
    modeBtn.textContent = { live: "Live preview", source: "Source", read: "Reading" }[t.mode];

    if (t.conflict) {
      const msg = document.createElement("span");
      msg.className = "conflict";
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
    this.stash();
    for (const t of this.tabs) if (this.dirty(t) && !t.conflict) this.save(t);
  }
}
