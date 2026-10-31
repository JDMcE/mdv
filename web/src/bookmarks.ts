// Bookmarked notes and folders. They're part of the vault's settings, so they
// follow the vault across browsers and git sync.

import { basename, dirname, isNote, stripMd, vaultFiles } from "./links";
import { settings } from "./settings";
import { Tabs } from "./tabs";
import type { Tree } from "./tree";
import { contextMenu, toast } from "./ui";

const COLLAPSED_KEY = "mdv.bookmarksCollapsed";

const under = (p: string, root: string) => p === root || p.startsWith(root + "/");

export const bookmarks = {
  list(): string[] {
    return settings.get().bookmarks ?? [];
  },
  has(path: string) {
    return this.list().includes(path);
  },
  toggle(path: string) {
    const l = this.list();
    const on = !l.includes(path);
    settings.set({ bookmarks: on ? [...l, path] : l.filter((p) => p !== path) });
    toast(on ? "Bookmarked" : "Bookmark removed");
  },
  /** Keep bookmarks pointing at a renamed/moved file or folder. */
  moved(from: string, to: string) {
    const l = this.list();
    const next = l.map((p) => (under(p, from) ? to + p.slice(from.length) : p));
    if (next.some((p, i) => p !== l[i])) settings.set({ bookmarks: next });
  },
  removed(path: string) {
    const l = this.list();
    const next = l.filter((p) => !under(p, path));
    if (next.length !== l.length) settings.set({ bookmarks: next });
  },
  /** Move the bookmark at index `from` to sit before index `to`. */
  reorder(from: number, to: number) {
    const l = [...this.list()];
    const [b] = l.splice(from, 1);
    l.splice(to > from ? to - 1 : to, 0, b);
    settings.set({ bookmarks: l });
  },
};

/** The "Bookmarks" section at the top of the Files view. */
export class BookmarksPanel {
  private el = document.getElementById("bookmarks")!;
  private collapsed = false;

  constructor(
    private tree: Tree,
    private tabs: Tabs,
  ) {
    try {
      this.collapsed = localStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {}
    settings.subscribe(() => this.render());
    this.bindDrop();
  }

  render() {
    const list = bookmarks.list();
    this.el.hidden = !list.length;
    this.el.classList.toggle("collapsed", this.collapsed);
    const head = document.createElement("div");
    head.className = "bm-head";
    const caret = document.createElement("span");
    caret.className = "caret" + (this.collapsed ? "" : " open");
    const count = document.createElement("span");
    count.className = "sr-count";
    count.textContent = String(list.length);
    head.append(caret, "Bookmarks", count);
    head.onclick = () => {
      this.collapsed = !this.collapsed;
      try {
        localStorage.setItem(COLLAPSED_KEY, this.collapsed ? "1" : "0");
      } catch {}
      this.render();
    };
    const items = document.createElement("div");
    items.className = "bm-list";
    list.forEach((p, i) => items.append(this.row(p, i)));
    this.el.replaceChildren(head, items);
    this.markActive();
  }

  /** Highlight the bookmark of the active note. */
  markActive() {
    const active = this.tabs.activePath;
    this.el.querySelectorAll<HTMLElement>(".bm-row").forEach((r) => r.classList.toggle("active", r.dataset.path === active));
  }

  private row(path: string, i: number): HTMLElement {
    const folder = this.tree.isDir(path);
    const exists = folder || vaultFiles.has(path);
    const row = document.createElement("div");
    row.className = "bm-row" + (folder ? " folder" : "") + (exists ? "" : " missing");
    row.dataset.path = path;
    row.title = exists ? path : `${path} (not found)`;
    row.draggable = true;
    const icon = document.createElement("span");
    icon.className = "bm-icon";
    icon.textContent = folder ? "▸" : "★";
    const name = document.createElement("span");
    name.className = "sr-name";
    name.textContent = isNote(path) ? stripMd(basename(path)) : basename(path);
    const dir = document.createElement("span");
    dir.className = "sr-dir";
    dir.textContent = dirname(path);
    row.append(icon, name, dir);

    row.onclick = (e) => this.openBookmark(path, e.ctrlKey || e.metaKey);
    row.onauxclick = (e) => {
      if (e.button === 1 && !folder) this.tabs.open(path, { background: true });
    };
    row.oncontextmenu = (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        ...(folder || !exists ? [] : [{ label: "Open in new tab", run: () => this.tabs.open(path, { background: true }) }]),
        { label: "Reveal in tree", run: () => this.tree.reveal(path, true) },
        { label: "Remove bookmark", danger: true, run: () => bookmarks.toggle(path) },
      ]);
    };
    row.ondragstart = (e) => {
      e.dataTransfer!.setData("text/mdv-bookmark", String(i));
      e.dataTransfer!.effectAllowed = "move";
    };
    row.ondragover = (e) => {
      if (!e.dataTransfer?.types.includes("text/mdv-bookmark")) return;
      e.preventDefault();
      e.stopPropagation();
      const r = row.getBoundingClientRect();
      const after = e.clientY > r.top + r.height / 2;
      this.clearDrop();
      row.classList.add(after ? "drop-after" : "drop-before");
    };
    row.ondrop = (e) => {
      const from = Number(e.dataTransfer!.getData("text/mdv-bookmark"));
      if (!e.dataTransfer?.types.includes("text/mdv-bookmark") || Number.isNaN(from)) return;
      e.preventDefault();
      e.stopPropagation();
      const after = row.classList.contains("drop-after");
      this.clearDrop();
      const to = i + (after ? 1 : 0);
      if (to !== from && to !== from + 1) bookmarks.reorder(from, to);
    };
    row.ondragend = () => this.clearDrop();
    return row;
  }

  private async openBookmark(path: string, background: boolean) {
    if (this.tree.isDir(path)) {
      this.tree.expand(path);
      this.tree.reveal(path, true);
    } else if (vaultFiles.has(path)) {
      await this.tabs.open(path, { background, focus: !background });
    } else toast(new Error(`Not found: ${path}`));
  }

  private clearDrop() {
    this.el.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
  }

  /** Dropping a file or folder from the tree bookmarks it. */
  private bindDrop() {
    // The panel is hidden while empty, so the tree's own toolbar area also accepts drops.
    for (const target of [this.el, document.querySelector<HTMLElement>("#files-view .toolbar")!]) {
      target.addEventListener("dragover", (e) => {
        if (!e.dataTransfer?.types.includes("text/mdv-path")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "link";
        target.classList.add("bm-drop");
      });
      target.addEventListener("dragleave", (e) => {
        if (!target.contains(e.relatedTarget as Node)) target.classList.remove("bm-drop");
      });
      target.addEventListener("drop", (e) => {
        target.classList.remove("bm-drop");
        const p = e.dataTransfer?.getData("text/mdv-path");
        if (!p) return;
        e.preventDefault();
        if (!bookmarks.has(p)) bookmarks.toggle(p);
      });
    }
  }
}
