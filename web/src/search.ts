import { api, SearchOptions, SearchResults } from "./api";
import { highlightRanges } from "./fuzzy";
import { Tabs } from "./tabs";

const STATE_KEY = "mdv.search";
const HISTORY_KEY = "mdv.searchHistory";
const HISTORY_MAX = 20;
const DEBOUNCE_MS = 180;

interface Hit {
  el: HTMLElement;
  path: string;
  query?: string; // a recent search (shown while the box is empty)
  line?: number; // undefined for the file header row
  col?: number;
  len?: number;
}

/** Vault-wide search panel in the sidebar. */
export class Search {
  private input = document.getElementById("search-input") as HTMLInputElement;
  private results = document.getElementById("search-results")!;
  private summary = document.getElementById("search-summary")!;
  private opts: SearchOptions = {};
  private collapsed = new Set<string>();
  private timer = 0;
  private ctrl: AbortController | null = null;
  private hits: Hit[] = [];
  private sel = -1;
  private lastQuery = "";
  private history: string[] = [];

  constructor(private tabs: Tabs) {
    try {
      const s = JSON.parse(localStorage.getItem(STATE_KEY) || "{}");
      this.input.value = s.q ?? "";
      this.opts = s.opts ?? {};
    } catch {}
    try {
      const h = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      if (Array.isArray(h)) this.history = h.filter((x) => typeof x === "string");
    } catch {}
    document.querySelectorAll<HTMLButtonElement>(".search-opts .opt").forEach((b) => {
      const k = b.dataset.opt as keyof SearchOptions;
      b.classList.toggle("on", !!this.opts[k]);
      b.onclick = () => {
        this.opts[k] = !this.opts[k];
        b.classList.toggle("on", !!this.opts[k]);
        this.run(true);
        this.input.focus();
      };
    });
    this.input.addEventListener("input", () => this.schedule());
    this.input.addEventListener("keydown", (e) => this.onInputKey(e));
    this.results.addEventListener("keydown", (e) => this.onResultsKey(e));
    if (!this.input.value.trim()) this.renderHistory();
  }

  /** Show the panel; seed with the editor selection if there is one. */
  focus(seed?: string) {
    if (seed && !seed.includes("\n")) {
      this.input.value = seed;
      this.run(true);
    }
    this.input.focus();
    this.input.select();
    if (this.input.value && !this.hits.length) this.run(true);
    else if (!this.input.value) this.renderHistory();
  }

  // ---------- history ----------

  /** Remember a query that was actually used (Enter, or a result opened). */
  private remember(q = this.input.value.trim()) {
    if (!q) return;
    this.history = [q, ...this.history.filter((h) => h !== q)].slice(0, HISTORY_MAX);
    this.saveHistory();
  }

  private saveHistory() {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(this.history));
    } catch {}
  }

  /** With an empty box, the results area lists recent searches. */
  private renderHistory() {
    this.hits = [];
    this.sel = -1;
    this.summary.classList.remove("error");
    if (!this.history.length) {
      this.summary.textContent = "";
      this.results.replaceChildren();
      return;
    }
    this.summary.textContent = "";
    const head = document.createElement("div");
    head.className = "sh-head";
    head.append("Recent searches");
    const clear = document.createElement("button");
    clear.className = "link-btn";
    clear.textContent = "clear";
    clear.onclick = () => {
      this.history = [];
      this.saveHistory();
      this.renderHistory();
      this.input.focus();
    };
    head.append(clear);
    const frag = document.createDocumentFragment();
    frag.append(head);
    for (const q of this.history) {
      const row = document.createElement("div");
      row.className = "sr-head sh-item";
      row.title = "Search again";
      const text = document.createElement("span");
      text.className = "sh-text";
      text.textContent = q;
      const x = document.createElement("button");
      x.className = "sh-remove";
      x.textContent = "×";
      x.title = "Remove from history";
      x.onclick = (e) => {
        e.stopPropagation();
        this.history = this.history.filter((h) => h !== q);
        this.saveHistory();
        this.renderHistory();
      };
      row.append(text, x);
      const hit: Hit = { el: row, path: "", query: q };
      row.onclick = () => this.useQuery(q);
      this.hits.push(hit);
      frag.append(row);
    }
    this.results.replaceChildren(frag);
  }

  private useQuery(q: string) {
    this.input.value = q;
    this.input.focus();
    this.run(true);
  }

  /** Re-run after the vault changed, if there's an active query. */
  refresh() {
    if (this.input.value.trim()) this.schedule();
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.run(), DEBOUNCE_MS);
  }

  private async run(force = false) {
    const q = this.input.value;
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify({ q, opts: this.opts }));
    } catch {}
    const key = q + JSON.stringify(this.opts);
    if (!force && key === this.lastQuery) return;
    this.lastQuery = key;
    this.ctrl?.abort();
    if (!q.trim()) {
      this.renderHistory();
      return;
    }
    const ctrl = (this.ctrl = new AbortController());
    let res: SearchResults;
    try {
      res = await api.search(q, this.opts, ctrl.signal);
    } catch (e) {
      if ((e as Error).name !== "AbortError") this.summary.textContent = String((e as Error).message);
      return;
    }
    this.render(res);
  }

  private render(res: SearchResults) {
    const files = res.files ?? [];
    this.summary.classList.toggle("error", !!res.error);
    if (res.error) {
      this.summary.textContent = res.error;
    } else if (!files.length) {
      this.summary.textContent = "No results";
    } else {
      const n = res.total;
      this.summary.textContent =
        (n ? `${n} result${n === 1 ? "" : "s"} in ` : "") +
        `${files.length}${res.truncated ? "+" : ""} note${files.length === 1 ? "" : "s"}`;
    }

    this.hits = [];
    const frag = document.createDocumentFragment();
    for (const f of files) {
      const group = document.createElement("div");
      group.className = "sr-file";
      const collapsed = this.collapsed.has(f.path);
      group.classList.toggle("collapsed", collapsed);

      const head = document.createElement("div");
      head.className = "sr-head";
      const caret = document.createElement("span");
      caret.className = "caret" + (collapsed ? "" : " open");
      const label = f.path.replace(/\.md$/i, "");
      const slash = label.lastIndexOf("/");
      const name = document.createElement("span");
      name.className = "sr-name";
      name.textContent = label.slice(slash + 1);
      const dir = document.createElement("span");
      dir.className = "sr-dir";
      dir.textContent = slash > 0 ? label.slice(0, slash) : "";
      head.append(caret, name, dir);
      if (f.count) {
        const count = document.createElement("span");
        count.className = "sr-count";
        count.textContent = String(f.count);
        head.append(count);
      }
      head.title = f.path;
      group.append(head);
      this.hits.push({ el: head, path: f.path });
      head.onclick = (e) => {
        if ((e.target as HTMLElement).classList.contains("caret") && f.matches?.length) {
          this.toggle(f.path, group);
        } else this.openHit({ el: head, path: f.path }, e.ctrlKey || e.metaKey);
      };

      for (const m of f.matches ?? []) {
        const row = document.createElement("div");
        row.className = "sr-line";
        const ln = document.createElement("span");
        ln.className = "sr-ln";
        ln.textContent = String(m.line);
        const text = document.createElement("span");
        text.className = "sr-text";
        text.append(highlightRanges(m.text.replace(/\t/g, " "), m.ranges));
        row.append(ln, text);
        const r0 = m.ranges[0];
        const hit: Hit = { el: row, path: f.path, line: m.line, col: m.col, len: r0 ? r0[1] - r0[0] : 0 };
        this.hits.push(hit);
        row.onclick = (e) => this.openHit(hit, e.ctrlKey || e.metaKey);
        group.append(row);
      }
      const shown = f.matches?.length ?? 0;
      if (f.count > shown) {
        const more = document.createElement("div");
        more.className = "sr-more";
        more.textContent = `+${f.count - shown} more in this note`;
        group.append(more);
      }
      frag.append(group);
    }
    this.results.replaceChildren(frag);
    this.sel = -1;
  }

  private toggle(path: string, group: HTMLElement) {
    const c = !this.collapsed.has(path);
    c ? this.collapsed.add(path) : this.collapsed.delete(path);
    group.classList.toggle("collapsed", c);
    group.querySelector(".caret")?.classList.toggle("open", !c);
  }

  private async openHit(h: Hit, background: boolean, keepFocus = false) {
    if (h.query !== undefined) {
      this.useQuery(h.query);
      return;
    }
    this.remember();
    this.select(this.hits.indexOf(h), false);
    await this.tabs.open(h.path, {
      background,
      focus: !keepFocus,
      line: h.line,
      col: h.col,
      len: h.len,
    });
  }

  // ---------- keyboard ----------

  private visibleHits(): Hit[] {
    return this.hits.filter((h) => h.el.offsetParent !== null);
  }

  private select(i: number, scroll = true) {
    this.hits[this.sel]?.el.classList.remove("selected");
    this.sel = i;
    const h = this.hits[i];
    if (!h) return;
    h.el.classList.add("selected");
    if (scroll) h.el.scrollIntoView({ block: "nearest" });
  }

  private step(dir: 1 | -1) {
    const vis = this.visibleHits();
    if (!vis.length) return;
    const cur = vis.indexOf(this.hits[this.sel]);
    const next = vis[Math.max(0, Math.min(vis.length - 1, cur + dir))];
    this.select(this.hits.indexOf(next));
  }

  private onInputKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!this.visibleHits().length) return;
      this.results.focus();
      this.step(1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      clearTimeout(this.timer);
      this.remember();
      // Enter jumps to the first hit (running the search first if still pending).
      this.run().then(() => {
        const first = this.hits.find((h) => h.line) ?? this.hits[0];
        if (first) this.openHit(first, false, true);
      });
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (this.input.value) {
        this.input.value = "";
        this.run(true);
      } else this.tabs.focus();
    }
  }

  private onResultsKey(e: KeyboardEvent) {
    const h = this.hits[this.sel];
    switch (e.key) {
      case "ArrowDown":
        this.step(1);
        break;
      case "ArrowUp":
        if (this.visibleHits()[0] === h) this.input.focus();
        else this.step(-1);
        break;
      case "ArrowLeft":
      case "ArrowRight": {
        if (!h || h.query !== undefined) return;
        const group = h.el.closest<HTMLElement>(".sr-file")!;
        const collapsed = this.collapsed.has(h.path);
        if ((e.key === "ArrowLeft") !== collapsed) this.toggle(h.path, group);
        if (e.key === "ArrowLeft") this.select(this.hits.findIndex((x) => x.path === h.path && !x.line));
        break;
      }
      case "Enter":
        if (h) this.openHit(h, e.ctrlKey || e.metaKey, e.shiftKey);
        break;
      case " ":
        if (h) this.openHit(h, false, true); // preview, keep focus in results
        break;
      case "Delete":
        if (h?.query === undefined) return;
        this.history = this.history.filter((q) => q !== h.query);
        this.saveHistory();
        this.renderHistory();
        this.results.focus();
        this.step(1);
        break;
      case "Escape":
        this.input.focus();
        break;
      default:
        return;
    }
    e.preventDefault();
  }
}
