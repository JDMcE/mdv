import { api, TreeNode } from "./api";
import { bookmarks } from "./bookmarks";
import { isImage, isNote, isPdf, vaultFiles } from "./links";
import { embedFor, linkFor } from "./livepreview";
import { Tabs } from "./tabs";
import { confirmBox, contextMenu, copyText, MenuItem, promptBox, toast } from "./ui";

const OPEN_KEY = "mdv.openFolders";
const SORT_KEY = "mdv.sort";
const SCROLL_KEY = "mdv.treeScroll";
/** Rows rendered above and below the visible ones. */
const OVERSCAN = 12;

const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const join = (dir: string, name: string) => (dir ? dir + "/" + name : name);
const displayName = (n: TreeNode) => (n.dir ? n.name : n.name.replace(/\.md$/i, ""));

type SortMode = "name" | "name-desc" | "modified" | "modified-asc";
const SORTS: [SortMode, string][] = [
  ["name", "File name (A → Z)"],
  ["name-desc", "File name (Z → A)"],
  ["modified", "Modified (new → old)"],
  ["modified-asc", "Modified (old → new)"],
];

interface Row {
  node: TreeNode;
  depth: number;
}

function load<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export class Tree {
  private root: TreeNode | null = null;
  private byPath = new Map<string, TreeNode>();
  private openFolders = new Set<string>(load<string[]>(OPEN_KEY, []));
  private sort: SortMode = load<SortMode>(SORT_KEY, "name");
  private filter = "";
  private rows: Row[] = [];
  private rowIndex = new Map<string, number>();
  /** Only the rows near the viewport exist in the DOM (the tree is virtualised). */
  private rowEls = new Map<string, HTMLElement>();
  private sizer = document.createElement("div");
  private tokens: string[] = [];
  private painted: [number, number] = [-1, -1];
  private rowH = 26;
  private selected: string | null = null; // keyboard cursor
  private typeahead = "";
  private typeaheadTimer = 0;
  private renaming: string | null = null;
  private dragOpenTimer = 0;
  private restoredScroll = false;
  private showAll = false; // attachments (images, PDFs…) as well as notes
  /** Called after the file list changes. */
  onFilesChanged: () => void = () => {};

  private el = document.getElementById("tree")!;
  private filterEl = document.getElementById("tree-filter") as HTMLInputElement;

  constructor(private tabs: Tabs) {
    this.bindTree();
    this.bindFilter();
    document.getElementById("new-note")!.onclick = () => this.newNote();
    document.getElementById("new-folder")!.onclick = () => this.newFolder();
    document.getElementById("collapse-all")!.onclick = () => this.collapseAll();
    document.getElementById("reveal")!.onclick = () => this.reveal(this.tabs.activePath, true);
    document.getElementById("sort")!.onclick = (e) => this.sortMenu(e);
    this.sizer.className = "tree-sizer";
    let scrollTimer = 0;
    let frame = 0;
    this.el.addEventListener("scroll", () => {
      if (!frame)
        frame = requestAnimationFrame(() => {
          frame = 0;
          this.paint();
        });
      clearTimeout(scrollTimer);
      scrollTimer = window.setTimeout(() => save(SCROLL_KEY, this.el.scrollTop), 200);
    });
    // Becoming visible (sidebar shown, window resized) changes which rows fit.
    new ResizeObserver(() => this.paint()).observe(this.el);
  }

  /** Re-render rows (e.g. after bookmarks change). */
  redraw() {
    this.render();
  }

  /** Whether a path is a folder in the vault. */
  isDir(path: string) {
    return !!this.byPath.get(path)?.dir;
  }

  /** Open a folder. */
  expand(path: string) {
    if (this.isDir(path)) this.toggle(path, true);
  }

  // ---------- data ----------

  async refresh() {
    this.root = await api.tree();
    document.getElementById("vault-name")!.textContent = this.root.name;
    this.byPath.clear();
    const walk = (n: TreeNode) => {
      this.byPath.set(n.path, n);
      n.children?.forEach(walk);
    };
    walk(this.root);
    vaultFiles.update([...this.byPath.values()].filter((n) => !n.dir && n.path).map((n) => n.path));
    this.onFilesChanged();
    // Forget folders that no longer exist.
    for (const p of this.openFolders) if (!this.byPath.get(p)?.dir) this.openFolders.delete(p);
    this.render();
    if (!this.restoredScroll) {
      this.restoredScroll = true;
      this.el.scrollTop = load<number>(SCROLL_KEY, 0);
      this.paint();
    }
  }

  /** All notes, for the quick switcher. */
  notes(): { path: string; mtime: number }[] {
    const out: { path: string; mtime: number }[] = [];
    for (const n of this.byPath.values()) {
      if (!n.dir && isNote(n.name)) out.push({ path: n.path, mtime: n.mtime ?? 0 });
    }
    return out;
  }

  /** Show or hide non-note files. */
  setShowAttachments(on: boolean) {
    if (on === this.showAll) return;
    this.showAll = on;
    this.render();
  }

  private visible(n: TreeNode) {
    return n.dir || this.showAll || isNote(n.name);
  }

  /** A note's content changed: update its mtime (matters when sorted by date). */
  touch(path: string, mtime?: number) {
    const n = this.byPath.get(path);
    if (!n || !mtime) return;
    n.mtime = mtime;
    if (this.sort.startsWith("modified")) this.render();
  }

  private sorted(children: TreeNode[]): TreeNode[] {
    const byName = (a: TreeNode, b: TreeNode) =>
      a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    const folders = children.filter((c) => c.dir).sort(byName);
    const files = children.filter((c) => !c.dir && this.visible(c));
    switch (this.sort) {
      case "name":
        files.sort(byName);
        break;
      case "name-desc":
        files.sort((a, b) => byName(b, a));
        folders.reverse();
        break;
      case "modified":
        files.sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0) || byName(a, b));
        break;
      case "modified-asc":
        files.sort((a, b) => (a.mtime ?? 0) - (b.mtime ?? 0) || byName(a, b));
        break;
    }
    return [...folders, ...files];
  }

  /** Visible rows, honouring open folders or the active filter. */
  private computeRows(): Row[] {
    const rows: Row[] = [];
    if (!this.root) return rows;
    const tokens = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) {
      const walk = (n: TreeNode, depth: number) => {
        for (const c of this.sorted(n.children ?? [])) {
          rows.push({ node: c, depth });
          if (c.dir && this.openFolders.has(c.path)) walk(c, depth + 1);
        }
      };
      walk(this.root, 0);
      return rows;
    }
    // Filtering: a note is shown if every token appears in its path. Folders
    // are shown (expanded) when they contain a match.
    const matches = (p: string) => {
      const l = p.toLowerCase();
      return tokens.every((t) => l.includes(t));
    };
    const keep = new Set<string>();
    const mark = (n: TreeNode): boolean => {
      let any = false;
      for (const c of n.children ?? []) {
        if (c.dir ? mark(c) : this.visible(c) && matches(c.path.replace(/\.md$/i, ""))) {
          keep.add(c.path);
          any = true;
        }
      }
      return any;
    };
    mark(this.root);
    const walk = (n: TreeNode, depth: number) => {
      for (const c of this.sorted(n.children ?? [])) {
        if (!keep.has(c.path)) continue;
        rows.push({ node: c, depth });
        if (c.dir) walk(c, depth + 1);
      }
    };
    walk(this.root, 0);
    return rows;
  }

  // ---------- rendering ----------

  private render() {
    this.rows = this.computeRows();
    this.rowIndex = new Map(this.rows.map((r, i) => [r.node.path, i]));
    this.tokens = this.filter.toLowerCase().split(/\s+/).filter(Boolean);
    this.el.classList.toggle("filtering", !!this.tokens.length);
    if (!this.rows.length) {
      const empty = document.createElement("div");
      empty.className = "tree-empty";
      empty.textContent = this.filter ? "No matching notes" : "No notes yet";
      this.rowEls.clear();
      this.el.replaceChildren(empty);
      return;
    }
    if (this.sizer.parentNode !== this.el) this.el.replaceChildren(this.sizer);
    this.rowH = parseFloat(getComputedStyle(this.el).getPropertyValue("--row-h")) || 26;
    this.sizer.style.height = this.rows.length * this.rowH + "px";
    this.paint(true);
  }

  /** (Re)build the rows that are in or near the viewport. */
  private paint(force = false) {
    if (!this.rows.length || this.sizer.parentNode !== this.el) return;
    if (this.renaming && !force) return; // keep the rename input alive
    const h = this.rowH;
    const top = this.el.scrollTop - this.sizer.offsetTop;
    const first = Math.max(0, Math.floor(top / h) - OVERSCAN);
    const last = Math.min(this.rows.length, Math.ceil((top + this.el.clientHeight) / h) + OVERSCAN);
    if (!force && first === this.painted[0] && last === this.painted[1]) return;
    this.painted = [first, last];
    this.rowEls.clear();
    const frag = document.createDocumentFragment();
    for (let i = first; i < last; i++) {
      const row = this.renderRow(this.rows[i], this.tokens);
      row.style.top = i * h + "px";
      frag.append(row);
    }
    this.sizer.replaceChildren(frag);
    this.markActive();
    this.markSelected(false);
  }

  /** Scroll the minimum needed to show row i, and make sure it's rendered. */
  private scrollToRow(i: number) {
    if (i < 0 || i >= this.rows.length) return;
    const top = this.sizer.offsetTop + i * this.rowH;
    const view = this.el.clientHeight;
    if (top < this.el.scrollTop) this.el.scrollTop = top;
    else if (top + this.rowH > this.el.scrollTop + view) this.el.scrollTop = top + this.rowH - view;
    this.paint();
  }

  private scrollToPath(path: string | null) {
    const i = path ? this.rowIndex.get(path) : undefined;
    if (i !== undefined) this.scrollToRow(i);
  }

  private renderRow({ node, depth }: Row, tokens: string[]): HTMLElement {
    const row = document.createElement("div");
    const kind = node.dir ? "folder" : isNote(node.name) ? "file" : "file attachment";
    row.className = "row " + kind;
    row.dataset.path = node.path;
    row.role = "treeitem";
    row.ariaLevel = String(depth + 1);
    row.draggable = true;
    row.title = node.path;
    const open = node.dir && (this.filter !== "" || this.openFolders.has(node.path));
    if (node.dir) row.ariaExpanded = String(open);

    for (let i = 0; i < depth; i++) {
      const g = document.createElement("span");
      g.className = "guide";
      row.append(g);
    }
    const caret = document.createElement("span");
    caret.className = node.dir ? "caret" + (open ? " open" : "") : "caret none";
    row.append(caret);

    const name = document.createElement("span");
    name.className = "name";
    const label = displayName(node);
    name.append(tokens.length ? markTokens(label, tokens) : label);
    row.append(name);
    if (bookmarks.has(node.path)) {
      const star = document.createElement("span");
      star.className = "bm-star";
      star.textContent = "★";
      star.title = "Bookmarked";
      row.append(star);
    }
    if (!node.dir && !isNote(node.name)) {
      const ext = document.createElement("span");
      ext.className = "ext" + (isImage(node.name) ? " img" : isPdf(node.name) ? " pdf" : "");
      ext.textContent = node.name.includes(".") ? node.name.slice(node.name.lastIndexOf(".") + 1) : "file";
      row.append(ext);
    }
    this.rowEls.set(node.path, row);
    return row;
  }

  private markActive() {
    this.el.querySelectorAll(".row.active").forEach((e) => e.classList.remove("active"));
    const p = this.tabs.activePath;
    if (p) this.rowEls.get(p)?.classList.add("active");
  }

  private markSelected(scroll = true) {
    if (scroll) this.scrollToPath(this.selected);
    this.el.querySelectorAll(".row.selected").forEach((e) => e.classList.remove("selected"));
    if (this.selected) this.rowEls.get(this.selected)?.classList.add("selected");
  }

  /** Called when the active tab changes. */
  onActive(path: string | null) {
    if (path && !this.filter) this.reveal(path, false);
    else this.markActive();
  }

  /** Expand ancestors and scroll a path into view. */
  reveal(path: string | null, select: boolean) {
    if (!path) return;
    let changed = false;
    for (let d = parentOf(path); d; d = parentOf(d)) {
      if (!this.openFolders.has(d)) {
        this.openFolders.add(d);
        changed = true;
      }
    }
    if (select && this.filter) {
      this.filter = this.filterEl.value = "";
      changed = true;
    }
    if (changed) {
      save(OPEN_KEY, [...this.openFolders]);
      this.render();
    }
    this.scrollToPath(path);
    this.markActive();
    if (select) {
      this.selected = path;
      this.markSelected();
      this.el.focus();
    }
  }

  // ---------- folders ----------

  private toggle(path: string, open?: boolean) {
    if (this.filter) return;
    const isOpen = this.openFolders.has(path);
    const want = open ?? !isOpen;
    if (want === isOpen) return;
    want ? this.openFolders.add(path) : this.openFolders.delete(path);
    save(OPEN_KEY, [...this.openFolders]);
    this.render();
  }

  collapseAll() {
    this.openFolders.clear();
    save(OPEN_KEY, []);
    this.render();
  }

  private sortMenu(e: MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    contextMenu(
      r.left,
      r.bottom + 4,
      SORTS.map(([mode, label]) => ({
        label: (mode === this.sort ? "✓ " : " ") + label,
        run: () => {
          this.sort = mode;
          save(SORT_KEY, mode);
          this.render();
        },
      })),
    );
  }

  // ---------- mouse ----------

  private rowOf(e: Event): { row: HTMLElement; node: TreeNode } | null {
    const row = (e.target as HTMLElement).closest<HTMLElement>(".row");
    const node = row && this.byPath.get(row.dataset.path!);
    return row && node ? { row, node } : null;
  }

  private bindTree() {
    const el = this.el;
    el.addEventListener("click", (e) => {
      const hit = this.rowOf(e);
      if (!hit || this.renaming) return;
      this.selected = hit.node.path;
      this.markSelected(false);
      if (hit.node.dir) this.toggle(hit.node.path);
      else this.tabs.open(hit.node.path, { background: e.ctrlKey || e.metaKey });
    });
    el.addEventListener("auxclick", (e) => {
      const hit = this.rowOf(e);
      if (hit && e.button === 1 && !hit.node.dir) this.tabs.open(hit.node.path, { background: true });
    });
    el.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault(); // no autoscroll on middle click
    });
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const hit = this.rowOf(e);
      if (!hit) return this.folderMenu(e, "");
      this.selected = hit.node.path;
      this.markSelected(false);
      hit.node.dir ? this.folderMenu(e, hit.node.path) : this.fileMenu(e, hit.node.path);
    });
    el.addEventListener("keydown", (e) => this.onKey(e));

    // Drag and drop to move.
    el.addEventListener("dragstart", (e) => {
      const hit = this.rowOf(e);
      if (!hit) return;
      e.dataTransfer!.setData("text/mdv-path", hit.node.path);
      // Dropping into the editor inserts a link (CodeMirror uses text/plain).
      if (!hit.node.dir) {
        const p = hit.node.path;
        e.dataTransfer!.setData("text/plain", isImage(p) ? embedFor(p) : linkFor(p));
      }
      e.dataTransfer!.effectAllowed = "copyMove";
    });
    const targetDir = (e: DragEvent): string | null => {
      if (!e.dataTransfer?.types.includes("text/mdv-path")) return null;
      const hit = this.rowOf(e);
      if (!hit) return "";
      return hit.node.dir ? hit.node.path : parentOf(hit.node.path);
    };
    const clearDrop = () => el.querySelectorAll(".drop").forEach((x) => x.classList.remove("drop"));
    el.addEventListener("dragover", (e) => {
      const dir = targetDir(e);
      if (dir === null) return;
      e.preventDefault();
      clearDrop();
      (dir ? this.rowEls.get(dir) : el)?.classList.add("drop");
      // Hovering a closed folder opens it.
      const hit = this.rowOf(e);
      if (hit?.node.dir && !this.openFolders.has(hit.node.path)) {
        if (!this.dragOpenTimer)
          this.dragOpenTimer = window.setTimeout(() => {
            this.dragOpenTimer = 0;
            this.toggle(hit.node.path, true);
          }, 700);
      } else {
        clearTimeout(this.dragOpenTimer);
        this.dragOpenTimer = 0;
      }
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget as Node)) clearDrop();
    });
    el.addEventListener("drop", (e) => {
      const dir = targetDir(e);
      clearDrop();
      clearTimeout(this.dragOpenTimer);
      this.dragOpenTimer = 0;
      if (dir === null) return;
      e.preventDefault();
      const from = e.dataTransfer!.getData("text/mdv-path");
      const to = join(dir, from.split("/").pop()!);
      if (from && to !== from && dir !== from && !dir.startsWith(from + "/")) this.move(from, to);
    });
  }

  // ---------- keyboard ----------

  private onKey(e: KeyboardEvent) {
    if (this.renaming) return;
    const mod = e.ctrlKey || e.metaKey;
    const idx = this.rows.findIndex((r) => r.node.path === this.selected);
    const cur = this.rows[idx]?.node;
    const go = (i: number) => {
      const r = this.rows[Math.max(0, Math.min(this.rows.length - 1, i))];
      if (r) {
        this.selected = r.node.path;
        this.markSelected();
      }
    };
    const page = Math.max(1, Math.floor(this.el.clientHeight / this.rowH) - 1);

    switch (e.key) {
      case "ArrowDown":
        go(idx < 0 ? 0 : idx + 1);
        break;
      case "ArrowUp":
        go(idx < 0 ? 0 : idx - 1);
        break;
      case "PageDown":
        go(idx + page);
        break;
      case "PageUp":
        go(idx - page);
        break;
      case "Home":
        go(0);
        break;
      case "End":
        go(this.rows.length - 1);
        break;
      case "ArrowRight":
        if (cur?.dir) {
          if (this.filter || this.openFolders.has(cur.path)) go(idx + 1);
          else this.toggle(cur.path, true);
        }
        break;
      case "ArrowLeft":
        if (cur?.dir && this.openFolders.has(cur.path) && !this.filter) this.toggle(cur.path, false);
        else if (cur && parentOf(cur.path)) {
          this.selected = parentOf(cur.path);
          this.markSelected();
        }
        break;
      case "Enter":
      case " ":
        if (!cur) return;
        if (cur.dir) this.toggle(cur.path);
        else this.tabs.open(cur.path, { background: mod, focus: e.key === "Enter" && !mod });
        break;
      case "F2":
        if (cur) this.rename(cur.path);
        break;
      case "Delete":
        if (cur) this.remove(cur.path);
        break;
      case "Escape":
        this.tabs.focus();
        break;
      default:
        if (mod && e.key.toLowerCase() === "f") {
          this.filterEl.focus();
          break;
        }
        if (e.key.length === 1 && !mod && !e.altKey) {
          this.typeAhead(e.key.toLowerCase(), idx);
          break;
        }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  /** Jump to the next row whose name starts with what's been typed. */
  private typeAhead(ch: string, from: number) {
    clearTimeout(this.typeaheadTimer);
    this.typeaheadTimer = window.setTimeout(() => (this.typeahead = ""), 800);
    const repeat = this.typeahead === ch; // pressing the same key cycles
    this.typeahead = repeat ? ch : this.typeahead + ch;
    const start = this.typeahead.length === 1 ? from + 1 : Math.max(from, 0);
    const n = this.rows.length;
    for (let k = 0; k < n; k++) {
      const r = this.rows[(start + k) % n];
      if (displayName(r.node).toLowerCase().startsWith(this.typeahead)) {
        this.selected = r.node.path;
        this.markSelected();
        return;
      }
    }
  }

  // ---------- filter ----------

  private bindFilter() {
    const f = this.filterEl;
    f.addEventListener("input", () => {
      this.filter = f.value.trim();
      this.render();
      // Keep the keyboard cursor on the first matching note.
      this.selected = this.firstNote();
      this.markSelected();
    });
    f.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        if (!this.selected || !this.rowIndex.has(this.selected)) this.selected = this.rows[0]?.node.path ?? null;
        this.markSelected();
        this.el.focus();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const p = this.selected && !this.byPath.get(this.selected)?.dir ? this.selected : this.firstNote();
        if (p) this.tabs.open(p, { background: e.ctrlKey || e.metaKey, focus: !(e.ctrlKey || e.metaKey) });
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (f.value) {
          f.value = "";
          this.filter = "";
          this.render();
          this.reveal(this.tabs.activePath, false);
        } else this.tabs.focus();
      }
    });
  }

  private firstNote(): string | null {
    return this.rows.find((r) => !r.node.dir)?.node.path ?? null;
  }

  focusFilter() {
    this.filterEl.focus();
    this.filterEl.select();
  }

  focusTree() {
    if (!this.selected || !this.rowIndex.has(this.selected)) {
      this.selected = this.tabs.activePath && this.rowIndex.has(this.tabs.activePath)
        ? this.tabs.activePath
        : this.rows[0]?.node.path ?? null;
    }
    this.markSelected();
    this.el.focus();
  }

  // ---------- menus & file operations ----------

  private fileMenu(e: MouseEvent, path: string) {
    contextMenu(e.clientX, e.clientY, [
      { label: "Open in new tab", run: () => this.tabs.open(path, { background: true }) },
      { label: "Rename…", hint: "F2", run: () => this.rename(path) },
      { label: "Copy path", run: () => copy(path) },
      { label: "Copy wikilink", run: () => copy(isImage(path) ? embedFor(path) : linkFor(path)) },
      { label: bookmarks.has(path) ? "Remove bookmark" : "Bookmark", hint: "Alt+B", run: () => bookmarks.toggle(path) },
      { label: "Delete", hint: "Del", danger: true, run: () => this.remove(path) },
    ]);
  }

  private folderMenu(e: MouseEvent, path: string) {
    const items: MenuItem[] = [
      { label: "New note", run: () => this.newNote(path) },
      { label: "New folder", run: () => this.newFolder(path) },
    ];
    if (path) {
      items.push(
        { label: "Rename…", hint: "F2", run: () => this.rename(path) },
        { label: "Copy path", run: () => copy(path) },
        { label: bookmarks.has(path) ? "Remove bookmark" : "Bookmark", run: () => bookmarks.toggle(path) },
        { label: "Delete", hint: "Del", danger: true, run: () => this.remove(path) },
      );
    }
    contextMenu(e.clientX, e.clientY, items);
  }

  /** Folder that new items go into: where the tree cursor is, else the active note's folder. */
  private defaultDir() {
    const sel = this.selected && this.byPath.get(this.selected);
    if (sel) return sel.dir ? sel.path : parentOf(sel.path);
    return parentOf(this.tabs.activePath ?? "");
  }

  /** Ask for a vault path, prefilled with the folder so it's visible and editable. */
  private async askPath(title: string, dir: string, name: string): Promise<string | null> {
    const prefix = dir ? dir + "/" : "";
    const v = await promptBox(title, prefix + name, [prefix.length, prefix.length + name.length]);
    const clean = v?.replace(/^\/+|\/+$/g, "");
    return clean || null;
  }

  async newNote(dir = this.defaultDir(), name?: string) {
    let path = name ? join(dir, name) : await this.askPath("New note", dir, "Untitled");
    if (!path) return;
    if (!isNote(path)) path += ".md";
    try {
      await api.create(path);
    } catch (e) {
      toast(e);
      return;
    }
    await this.refresh();
    this.selected = path;
    await this.tabs.open(path);
  }

  async newFolder(dir = this.defaultDir()) {
    const path = await this.askPath("New folder", dir, "");
    if (!path) return;
    try {
      await api.mkdir(path);
    } catch (e) {
      toast(e);
      return;
    }
    // The path may have been edited, so open its actual ancestors.
    for (let d = path; d; d = parentOf(d)) this.openFolders.add(d);
    save(OPEN_KEY, [...this.openFolders]);
    await this.refresh();
    this.selected = path;
    this.markSelected();
  }

  /** Inline rename: the row's label becomes an input. */
  private rename(path: string) {
    const node = this.byPath.get(path);
    this.scrollToPath(path);
    const row = this.rowEls.get(path);
    if (!node || !row) return;
    const nameEl = row.querySelector(".name")!;
    const input = document.createElement("input");
    input.className = "rename";
    input.value = displayName(node);
    input.spellcheck = false;
    nameEl.replaceChildren(input);
    row.draggable = false;
    this.renaming = path;
    input.focus();
    input.select();

    let done = false;
    const finish = async (commit: boolean) => {
      if (done) return;
      done = true;
      this.renaming = null;
      let name = input.value.trim();
      if (commit && name && name !== displayName(node)) {
        if (!node.dir && isNote(node.name) && !isNote(name)) name += ".md";
        await this.move(path, join(parentOf(path), name));
      } else {
        this.render();
      }
      this.el.focus();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  private async move(from: string, to: string) {
    try {
      const updated = await api.move(from, to);
      if (updated) toast(`Updated links in ${updated} note${updated === 1 ? "" : "s"}`);
    } catch (e) {
      toast(e);
      this.render();
      return;
    }
    // Carry open-folder state and selection across the move.
    for (const p of [...this.openFolders]) {
      if (p === from || p.startsWith(from + "/")) {
        this.openFolders.delete(p);
        this.openFolders.add(to + p.slice(from.length));
      }
    }
    if (parentOf(to)) this.openFolders.add(parentOf(to));
    save(OPEN_KEY, [...this.openFolders]);
    this.selected = to;
    bookmarks.moved(from, to);
    this.tabs.renamed(from, to);
    await this.refresh();
    this.markSelected();
  }

  private async remove(path: string) {
    const node = this.byPath.get(path);
    const what = node?.dir ? `the folder "${path}" and everything in it` : `"${displayName(node!)}"`;
    if (!(await confirmBox(`Delete ${what}?`))) {
      this.el.focus();
      return;
    }
    // Move the cursor to a neighbour before the row disappears.
    const idx = this.rows.findIndex((r) => r.node.path === path);
    const next = this.rows.slice(idx + 1).find((r) => !r.node.path.startsWith(path + "/")) ?? this.rows[idx - 1];
    try {
      await api.remove(path);
    } catch (e) {
      toast(e);
      return;
    }
    this.selected = next?.node.path ?? null;
    bookmarks.removed(path);
    this.tabs.removed(path);
    await this.refresh();
    this.el.focus();
  }
}

function markTokens(text: string, tokens: string[]): DocumentFragment {
  const lower = text.toLowerCase();
  const hit = new Array(text.length).fill(false);
  for (const t of tokens) {
    for (let i = lower.indexOf(t); i >= 0; i = lower.indexOf(t, i + 1)) {
      for (let k = i; k < i + t.length; k++) hit[k] = true;
    }
  }
  const frag = document.createDocumentFragment();
  let i = 0;
  while (i < text.length) {
    let j = i;
    while (j < text.length && hit[j] === hit[i]) j++;
    if (hit[i]) {
      const m = document.createElement("mark");
      m.textContent = text.slice(i, j);
      frag.append(m);
    } else frag.append(text.slice(i, j));
    i = j;
  }
  return frag;
}

function copy(text: string) {
  copyText(text).then((ok) => toast(ok ? "Copied" : "Couldn't access the clipboard"));
}
