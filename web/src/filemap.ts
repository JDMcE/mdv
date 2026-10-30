// Right-hand file map: an outline of the note's headings plus a scroll strip
// showing where headings and code blocks sit and which part is in view.

export interface Heading {
  level: number;
  text: string;
  line: number; // 1-based
}

interface Outline {
  headings: Heading[];
  code: { from: number; to: number }[]; // 1-based line ranges of fenced code
  lines: number;
}

/** What the file map needs from the active note's view. */
export interface MapView {
  text: string;
  scroller: HTMLElement;
  /** Height of the whole document in px, in the scroller's coordinates. */
  height: number;
  /** Document-relative top (px) of a 1-based line. */
  lineTop(line: number): number;
  /** Document-relative tops of headings, in order (reading view), if line-based tops don't apply. */
  headingTops?: number[];
  /** Scroll a heading to the top of the view. */
  reveal(h: Heading, index: number): void;
}

const STORAGE_KEY = "mdv.filemap";

/** Headings and code blocks, skipping frontmatter and fenced code. */
export function outline(text: string): Outline {
  const lines = text.split("\n");
  const headings: Heading[] = [];
  const code: { from: number; to: number }[] = [];
  let i = 0;
  if (/^---\s*$/.test(lines[0] ?? "")) {
    const end = lines.findIndex((l, k) => k > 0 && /^---\s*$/.test(l));
    if (end > 0) i = end + 1;
  }
  let fence: { marker: string; start: number } | null = null;
  for (; i < lines.length; i++) {
    const l = lines[i];
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
    if (fence) {
      if (f && f[1][0] === fence.marker[0] && f[1].length >= fence.marker.length && !l.slice(f[0].length).trim()) {
        code.push({ from: fence.start + 1, to: i + 1 });
        fence = null;
      }
      continue;
    }
    if (f) {
      fence = { marker: f[1], start: i };
      continue;
    }
    const h = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(l);
    if (h && h[2]) headings.push({ level: h[1].length, text: h[2].replace(/[*_`=~]/g, ""), line: i + 1 });
  }
  if (fence) code.push({ from: fence.start + 1, to: lines.length });
  return { headings, code, lines: lines.length };
}

export class FileMap {
  private root = document.getElementById("filemap")!;
  private list = document.getElementById("outline")!;
  private strip = document.getElementById("scrollmap")!;
  private box = document.createElement("div");
  private marks = document.createElement("div");
  private items: HTMLElement[] = [];
  private data: Outline = { headings: [], code: [], lines: 0 };
  private signature = "";
  private frame = 0;
  private current = -1;
  private dragging = false;

  constructor(private getView: () => MapView | null) {
    this.box.className = "sm-view";
    this.marks.className = "sm-marks";
    this.strip.append(this.marks, this.box);
    this.bindStrip();
    try {
      if (localStorage.getItem(STORAGE_KEY) === "off") document.body.classList.add("no-filemap");
    } catch {}
    document.getElementById("toggle-map")!.onclick = () => this.toggle();
  }

  toggle() {
    const off = document.body.classList.toggle("no-filemap");
    try {
      localStorage.setItem(STORAGE_KEY, off ? "off" : "on");
    } catch {}
    if (!off) this.update(true);
  }

  /** Schedule a refresh; content=true re-reads the note text. */
  update(content = false) {
    if (content) this.signature = "";
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.render());
  }

  private render() {
    const v = this.getView();
    this.root.classList.toggle("empty", !v);
    if (!v || document.body.classList.contains("no-filemap")) return;

    if (this.signature !== v.text) {
      this.signature = v.text;
      this.data = outline(v.text);
      this.renderList();
      this.renderMarks(v);
    } else {
      this.renderMarks(v); // heights may have changed (images loading, resizing)
    }
    this.renderViewport(v);
  }

  private renderList() {
    const hs = this.data.headings;
    this.list.replaceChildren();
    this.items = [];
    this.current = -1;
    if (!hs.length) {
      const p = document.createElement("p");
      p.className = "panel-empty";
      p.textContent = "No headings";
      this.list.append(p);
      return;
    }
    const minLevel = Math.min(...hs.map((h) => h.level));
    hs.forEach((h, i) => {
      const item = document.createElement("div");
      item.className = `ol-item ol-h${h.level}`;
      item.style.paddingLeft = 8 + (h.level - minLevel) * 12 + "px";
      item.textContent = h.text;
      item.title = h.text;
      item.onclick = () => this.getView()?.reveal(h, i);
      this.list.append(item);
      this.items.push(item);
    });
  }

  private tops(v: MapView): number[] {
    return v.headingTops ?? this.data.headings.map((h) => v.lineTop(h.line));
  }

  private renderMarks(v: MapView) {
    const H = Math.max(1, v.height);
    const frag = document.createDocumentFragment();
    const tops = this.tops(v);
    if (!v.headingTops) {
      for (const c of this.data.code) {
        const a = v.lineTop(c.from);
        const b = c.to < this.data.lines ? v.lineTop(c.to + 1) : H;
        const m = document.createElement("div");
        m.className = "sm-code";
        m.style.top = (a / H) * 100 + "%";
        m.style.height = Math.max(0.4, ((b - a) / H) * 100) + "%";
        frag.append(m);
      }
    }
    this.data.headings.forEach((h, i) => {
      if (tops[i] === undefined) return;
      const m = document.createElement("div");
      m.className = `sm-h sm-h${h.level}`;
      m.style.top = (tops[i] / H) * 100 + "%";
      m.title = h.text;
      frag.append(m);
    });
    this.marks.replaceChildren(frag);
  }

  private renderViewport(v: MapView) {
    const s = v.scroller;
    const total = Math.max(1, s.scrollHeight);
    this.box.style.top = (s.scrollTop / total) * 100 + "%";
    this.box.style.height = Math.min(100, (s.clientHeight / total) * 100) + "%";
    this.box.style.display = s.scrollHeight > s.clientHeight + 2 ? "" : "none";

    // Current section: the last heading at or above the top of the view.
    const tops = this.tops(v);
    let cur = -1;
    const y = s.scrollTop + 48;
    for (let i = 0; i < tops.length; i++) if (tops[i] <= y) cur = i;
    if (cur !== this.current) {
      this.items[this.current]?.classList.remove("current");
      this.items[cur]?.classList.add("current");
      this.items[cur]?.scrollIntoView({ block: "nearest" });
      this.current = cur;
    }
  }

  /** Click or drag on the strip to scroll there. */
  private bindStrip() {
    const go = (e: PointerEvent) => {
      const v = this.getView();
      if (!v) return;
      const r = this.strip.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      const s = v.scroller;
      s.scrollTop = f * s.scrollHeight - s.clientHeight / 2;
    };
    this.strip.onpointerdown = (e) => {
      this.dragging = true;
      this.strip.setPointerCapture(e.pointerId);
      go(e);
    };
    this.strip.onpointermove = (e) => {
      if (this.dragging) go(e);
    };
    this.strip.onpointerup = () => (this.dragging = false);
  }
}
