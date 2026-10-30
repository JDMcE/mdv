import { api, LinkRef, LinksInfo } from "./api";
import { basename, dirname, isNote, stripMd } from "./links";
import { Tabs } from "./tabs";

/** Sidebar panel: backlinks, outgoing and unresolved links of the active note. */
export class LinksPanel {
  private el = document.getElementById("links-view")!;
  private timer = 0;
  private shownFor: string | null = null;
  visible = false;

  constructor(private tabs: Tabs) {}

  /** Refresh soon (debounced), if visible. */
  refresh(force = false) {
    clearTimeout(this.timer);
    if (!this.visible) return;
    const p = this.tabs.activePath;
    if (!force && p === this.shownFor) return;
    this.timer = window.setTimeout(() => this.load(), 120);
  }

  private async load() {
    const p = this.tabs.activePath;
    this.shownFor = p;
    if (!p || !isNote(p)) {
      this.el.replaceChildren(empty("Open a note to see its links."));
      return;
    }
    let info: LinksInfo;
    try {
      info = await api.links(p);
    } catch (e) {
      this.el.replaceChildren(empty(String((e as Error).message)));
      return;
    }
    if (p !== this.tabs.activePath) return;
    this.el.replaceChildren(
      this.section("Backlinks", info.backlinks, "No other notes link here.", true),
      this.section("Outgoing links", dedupe(info.outgoing), "This note doesn't link anywhere.", false),
      ...(info.unresolved.length ? [this.section("Unresolved", info.unresolved, "", false)] : []),
    );
  }

  private section(title: string, refs: LinkRef[], none: string, withContext: boolean): HTMLElement {
    const sec = document.createElement("section");
    sec.className = "lp-section";
    const h = document.createElement("h3");
    h.textContent = title;
    const count = document.createElement("span");
    count.className = "sr-count";
    count.textContent = String(refs.length);
    h.append(count);
    sec.append(h);
    if (!refs.length) {
      sec.append(empty(none));
      return sec;
    }
    // Group by file.
    const groups = new Map<string, LinkRef[]>();
    for (const r of refs) {
      const key = r.path || r.target || "";
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    for (const [key, list] of groups) {
      const head = document.createElement("div");
      head.className = "sr-head";
      const name = document.createElement("span");
      name.className = "sr-name";
      const dir = document.createElement("span");
      dir.className = "sr-dir";
      if (list[0].path) {
        name.textContent = isNote(key) ? stripMd(basename(key)) : basename(key);
        dir.textContent = dirname(key);
        head.title = key;
        head.onclick = (e) => this.tabs.open(key, { newTab: e.ctrlKey || e.metaKey });
      } else {
        // Unresolved: jump to where it's written in this note.
        name.textContent = key;
        name.classList.add("unresolved");
        head.onclick = () => this.tabs.goto(list[0].line, 0, 0);
      }
      head.append(name, dir);
      sec.append(head);
      if (withContext) {
        for (const r of list) {
          const row = document.createElement("div");
          row.className = "sr-line";
          const ln = document.createElement("span");
          ln.className = "sr-ln";
          ln.textContent = String(r.line);
          const text = document.createElement("span");
          text.className = "sr-text";
          text.textContent = r.context ?? "";
          row.append(ln, text);
          row.onclick = (e) => this.tabs.open(r.path, { newTab: e.ctrlKey || e.metaKey, line: r.line });
          sec.append(row);
        }
      }
    }
    return sec;
  }
}

function empty(text: string) {
  const p = document.createElement("p");
  p.className = "panel-empty";
  p.textContent = text;
  return p;
}

function dedupe(refs: LinkRef[]): LinkRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => (seen.has(r.path) ? false : (seen.add(r.path), true)));
}
