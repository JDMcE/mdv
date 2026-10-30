import { fuzzy, highlight } from "./fuzzy";
import { Tabs } from "./tabs";
import { Tree } from "./tree";

const RECENT_KEY = "mdv.recent";
const MAX_RECENT = 50;
const MAX_SHOWN = 60;

interface Item {
  path: string;
  positions: number[];
  recent: boolean;
}

/** Ctrl+P: fuzzy "go to note", most-recently-used first. */
export class Switcher {
  private recent: string[];

  constructor(
    private tree: Tree,
    private tabs: Tabs,
  ) {
    try {
      this.recent = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    } catch {
      this.recent = [];
    }
  }

  /** Record a visit (called whenever the active note changes). */
  visited(path: string | null) {
    if (!path) return;
    this.recent = [path, ...this.recent.filter((p) => p !== path)].slice(0, MAX_RECENT);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(this.recent));
    } catch {}
  }

  private search(query: string): Item[] {
    const notes = this.tree.notes();
    const rank = new Map(this.recent.map((p, i) => [p, i]));
    const current = this.tabs.activePath;
    if (!query.trim()) {
      // Recent first (skipping the note you're on), then by modified time.
      return notes
        .filter((n) => n.path !== current)
        .sort((a, b) => {
          const ra = rank.get(a.path) ?? Infinity;
          const rb = rank.get(b.path) ?? Infinity;
          return ra !== rb ? ra - rb : b.mtime - a.mtime;
        })
        .slice(0, MAX_SHOWN)
        .map((n) => ({ path: n.path, positions: [], recent: rank.has(n.path) }));
    }
    const scored: (Item & { score: number })[] = [];
    for (const n of notes) {
      const label = n.path.replace(/\.md$/i, "");
      const hit = fuzzy(query, label);
      if (!hit) continue;
      // Small boost for recently used notes.
      const r = rank.get(n.path);
      const boost = r === undefined ? 0 : 20 - Math.min(r, 20);
      scored.push({ path: n.path, positions: hit.positions, recent: r !== undefined, score: hit.score + boost });
    }
    scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
    return scored.slice(0, MAX_SHOWN);
  }

  open() {
    document.querySelector(".switcher")?.parentElement?.remove();
    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const box = document.createElement("div");
    box.className = "switcher";
    const input = document.createElement("input");
    input.placeholder = "Go to note…";
    input.spellcheck = false;
    const list = document.createElement("div");
    list.className = "switcher-list";
    list.role = "listbox";
    const foot = document.createElement("div");
    foot.className = "switcher-foot";
    foot.innerHTML =
      "<span><kbd>↑↓</kbd> navigate</span><span><kbd>Enter</kbd> open</span>" +
      "<span><kbd>Ctrl+Enter</kbd> new tab</span><span><kbd>Shift+Enter</kbd> create</span><span><kbd>Esc</kbd> close</span>";
    box.append(input, list, foot);
    overlay.append(box);
    document.body.append(overlay);

    let items: Item[] = [];
    let sel = 0;
    const close = () => {
      overlay.remove();
    };
    const render = () => {
      const q = input.value;
      items = this.search(q);
      sel = 0;
      list.replaceChildren();
      items.forEach((it, i) => {
        const label = it.path.replace(/\.md$/i, "");
        const slash = label.lastIndexOf("/");
        const row = document.createElement("div");
        row.className = "switcher-item";
        row.role = "option";
        const name = document.createElement("span");
        name.className = "sw-name";
        name.append(highlight(label.slice(slash + 1), it.positions, slash + 1));
        const dir = document.createElement("span");
        dir.className = "sw-dir";
        if (slash > 0) dir.append(highlight(label.slice(0, slash), it.positions));
        row.append(name, dir);
        if (it.recent && !q.trim()) row.classList.add("recent");
        row.onmousemove = () => {
          if (sel !== i) {
            sel = i;
            mark();
          }
        };
        row.onclick = (e) => choose(e.ctrlKey || e.metaKey);
        list.append(row);
      });
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "switcher-empty";
        empty.textContent = q.trim() ? `No match — Shift+Enter creates "${q.trim()}"` : "No notes yet";
        list.append(empty);
      }
      mark();
    };
    const mark = () => {
      [...list.children].forEach((c, i) => c.classList.toggle("selected", i === sel));
      list.children[sel]?.scrollIntoView({ block: "nearest" });
    };
    const choose = (background: boolean) => {
      const it = items[sel];
      if (!it) return; // creating is explicit (Shift+Enter), never a fallback
      close();
      this.tabs.open(it.path, { background });
    };
    const create = () => {
      const name = input.value.trim();
      if (!name) return;
      close();
      // "folder/name" creates inside that folder.
      const slash = name.lastIndexOf("/");
      this.tree.newNote(slash >= 0 ? name.slice(0, slash) : "", name.slice(slash + 1));
    };

    input.addEventListener("input", render);
    input.addEventListener("keydown", (e) => {
      const n = items.length;
      if (e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")) sel = n ? (sel + 1) % n : 0;
      else if (e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")) sel = n ? (sel - 1 + n) % n : 0;
      else if (e.key === "PageDown") sel = Math.min(n - 1, sel + 10);
      else if (e.key === "PageUp") sel = Math.max(0, sel - 10);
      else if (e.key === "Enter" && e.shiftKey) create();
      else if (e.key === "Enter") choose(e.ctrlKey || e.metaKey);
      else if (e.key === "Escape") {
        close();
        this.tabs.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
      mark();
    });
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) close();
    });
    render();
    input.focus();
  }
}
