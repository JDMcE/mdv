// Mermaid diagrams for ```mermaid code blocks. The library is large, so it
// loads on first use; diagrams take their colours from the current theme.

type Mermaid = typeof import("mermaid").default;

let loading: Promise<Mermaid> | null = null;
const load = () => (loading ??= import("mermaid").then((m) => m.default));

/** Rendered SVG by theme + source, so re-created widgets don't re-render. */
const cache = new Map<string, string>();
let seq = 0;

function themeVariables() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  const bg = v("--bg");
  return {
    key: [bg, v("--text"), v("--accent"), v("--font-text")].join("|"),
    dark: luminance(bg) < 0.5,
    vars: {
      background: bg,
      fontFamily: v("--font-text"),
      textColor: v("--text"),
      primaryColor: v("--code-bg"),
      primaryTextColor: v("--text"),
      primaryBorderColor: v("--accent"),
      secondaryColor: v("--bg-alt"),
      secondaryTextColor: v("--text"),
      secondaryBorderColor: v("--border"),
      tertiaryColor: v("--bg-hover"),
      tertiaryTextColor: v("--text"),
      tertiaryBorderColor: v("--border"),
      mainBkg: v("--code-bg"),
      lineColor: v("--text-muted"),
      edgeLabelBackground: bg,
      clusterBkg: v("--bg-alt"),
      clusterBorder: v("--border"),
      noteBkgColor: v("--bg-hover"),
      noteTextColor: v("--text"),
      noteBorderColor: v("--border"),
      actorBkg: v("--code-bg"),
      actorBorder: v("--accent"),
      actorTextColor: v("--text"),
      signalColor: v("--text"),
      signalTextColor: v("--text"),
      labelBoxBkgColor: v("--code-bg"),
      labelTextColor: v("--text"),
    },
  };
}

/** Rough perceived lightness (0..1) of a #rgb / #rrggbb colour. */
function luminance(hex: string): number {
  let h = hex.replace("#", "");
  if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map((c) => c + c).join("");
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return 0;
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

let configured = "";

/** Render diagram source to an SVG string; throws with mermaid's message on bad syntax. */
export async function mermaidSvg(src: string): Promise<string> {
  const theme = themeVariables();
  const key = theme.key + "\n" + src;
  const hit = cache.get(key);
  if (hit) return hit;
  const mermaid = await load();
  if (configured !== theme.key) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: "base",
      darkMode: theme.dark,
      themeVariables: theme.vars,
    });
    configured = theme.key;
  }
  const id = `mdv-mermaid-${++seq}`;
  try {
    const { svg } = await mermaid.render(id, src);
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
    cache.set(key, svg);
    return svg;
  } finally {
    document.getElementById(id)?.remove();
    document.getElementById("d" + id)?.remove();
  }
}

/** Fill `el` with the diagram, or with the error if it doesn't parse. */
export async function renderMermaid(el: HTMLElement, src: string): Promise<void> {
  el.classList.add("mermaid-diagram");
  try {
    el.innerHTML = await mermaidSvg(src);
    el.classList.remove("mermaid-error");
  } catch (e) {
    el.classList.add("mermaid-error");
    const pre = document.createElement("pre");
    const msg = e instanceof Error ? e.message : String(e);
    pre.textContent = "Mermaid: " + msg.trim();
    el.replaceChildren(pre);
  }
}
