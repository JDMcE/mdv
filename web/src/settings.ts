// User preferences. They belong to the vault (stored server-side in
// .mdv/settings.json, so they follow it across browsers and git sync); the
// browser keeps a cached copy so the page renders without a flash of defaults.

export const THEMES = [
  ["midnight", "Midnight"],
  ["mocha", "Catppuccin Mocha"],
  ["tokyo", "Tokyo Night"],
  ["nord", "Nord"],
  ["gruvbox", "Gruvbox Dark"],
  ["rosepine", "Rosé Pine"],
  ["latte", "Catppuccin Latte (light)"],
] as const;

export interface Settings {
  theme: (typeof THEMES)[number][0];
  fontSize: number;
  lineWidth: number; // rem; 0 = full width
  font: "sans" | "serif" | "mono";
  defaultMode: "live" | "source" | "read";
  showAttachments: boolean;
  spellcheck: boolean;
  frontmatter: "hidden" | "properties" | "raw";
  lineNumbers: boolean;
}

const DEFAULTS: Settings = {
  frontmatter: "hidden",
  theme: "midnight",
  fontSize: 16,
  lineWidth: 46,
  font: "sans",
  defaultMode: "live",
  showAttachments: true,
  spellcheck: true,
  lineNumbers: true,
};

const CACHE_KEY = "mdv.settings";
let current: Settings = { ...DEFAULTS };
try {
  current = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(CACHE_KEY) || "{}") };
} catch {}

const listeners: ((s: Settings) => void)[] = [];
let saveTimer = 0;

function cache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(current));
  } catch {}
}

/** Write to the vault (debounced, since sliders/selects can fire quickly). */
function persist() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    fetch("/api/settings", { method: "PUT", body: JSON.stringify(current) }).catch(() => {});
  }, 300);
}

function changed() {
  apply();
  listeners.forEach((f) => f(current));
}

export const settings = {
  get: () => current,
  set(patch: Partial<Settings>) {
    current = { ...current, ...patch };
    cache();
    persist();
    changed();
  },
  subscribe(f: (s: Settings) => void) {
    listeners.push(f);
    f(current);
  },
  /**
   * Load the vault's settings. A vault without any yet adopts this browser's
   * cached settings (a one-time migration from per-browser settings).
   */
  async load() {
    let stored: Partial<Settings>;
    try {
      const res = await fetch("/api/settings");
      if (!res.ok) return;
      stored = await res.json();
    } catch {
      return; // offline: keep the cached copy
    }
    if (!Object.keys(stored).length) {
      persist();
      return;
    }
    const next = { ...DEFAULTS, ...stored };
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    current = next;
    cache();
    changed();
  },
};

const FONTS = {
  sans: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  serif: 'Charter, "Iowan Old Style", Georgia, Cambria, serif',
  mono: '"JetBrains Mono", "Cascadia Code", Consolas, monospace',
};

/** Push settings into the page (theme attribute, CSS variables, body classes). */
export function apply() {
  const root = document.documentElement;
  root.dataset.theme = current.theme;
  root.style.colorScheme = current.theme === "latte" ? "light" : "dark";
  root.style.setProperty("--text-size", current.fontSize + "px");
  root.style.setProperty("--line-width", current.lineWidth ? current.lineWidth + "rem" : "100%");
  root.style.setProperty("--font-text", FONTS[current.font]);
  document.body.classList.toggle("no-line-numbers", !current.lineNumbers);
  document.querySelector('meta[name="theme-color"]')?.setAttribute(
    "content",
    getComputedStyle(root).getPropertyValue("--bg-alt").trim() || "#181818",
  );
}
apply();

/** The settings dialog. */
export function openSettings(extra: { auth: boolean }) {
  document.querySelector(".settings")?.parentElement?.remove();
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const box = document.createElement("div");
  box.className = "dialog settings";
  const h = document.createElement("h2");
  h.textContent = "Settings";
  box.append(h);

  const row = (label: string, control: HTMLElement, hint = "") => {
    const r = document.createElement("label");
    r.className = "setting";
    const t = document.createElement("span");
    t.textContent = label;
    if (hint) {
      const s = document.createElement("small");
      s.textContent = hint;
      t.append(s);
    }
    r.append(t, control);
    box.append(r);
  };
  const select = <K extends keyof Settings>(key: K, options: readonly (readonly [string, string])[]) => {
    const s = document.createElement("select");
    for (const [v, l] of options) s.add(new Option(l, v, false, String(current[key]) === v));
    s.onchange = () => {
      const raw = s.value;
      const v = typeof DEFAULTS[key] === "number" ? Number(raw) : raw;
      settings.set({ [key]: v } as Partial<Settings>);
    };
    return s;
  };
  const toggle = (key: "showAttachments" | "spellcheck" | "lineNumbers") => {
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = current[key];
    c.onchange = () => settings.set({ [key]: c.checked });
    return c;
  };

  row("Theme", select("theme", THEMES));
  row("Text size", select("fontSize", [13, 14, 15, 16, 17, 18, 20, 22].map((n) => [String(n), n + " px"] as const)));
  row(
    "Line width",
    select("lineWidth", [
      ["36", "Narrow"],
      ["46", "Readable"],
      ["68", "Wide"],
      ["0", "Full width"],
    ]),
  );
  row(
    "Font",
    select("font", [
      ["sans", "Sans-serif"],
      ["serif", "Serif"],
      ["mono", "Monospace"],
    ]),
  );
  row(
    "Open notes in",
    select("defaultMode", [
      ["live", "Live preview"],
      ["source", "Source mode"],
      ["read", "Reading view"],
    ]),
    "Ctrl+E switches between editing and reading",
  );
  row(
    "Frontmatter",
    select("frontmatter", [
      ["hidden", "Hidden"],
      ["properties", "Properties box"],
      ["raw", "Raw YAML"],
    ]),
    "Live preview & reading view. Ctrl+Home shows the YAML for editing",
  );
  row("Show attachments in file tree", toggle("showAttachments"), "Images, PDFs and other files");
  row("Line numbers", toggle("lineNumbers"));
  row("Spellcheck", toggle("spellcheck"));
  const note = document.createElement("p");
  note.className = "settings-note";
  note.textContent = "Saved in this vault (.mdv/settings.json), so they apply in every browser and sync with git.";
  box.append(note);

  const foot = document.createElement("div");
  foot.className = "dialog-buttons";
  if (extra.auth) {
    const out = document.createElement("a");
    out.href = "/logout";
    out.className = "btn";
    out.textContent = "Sign out";
    foot.append(out);
  }
  const done = document.createElement("button");
  done.className = "btn primary";
  done.textContent = "Done";
  done.onclick = () => overlay.remove();
  foot.append(done);
  box.append(foot);

  overlay.append(box);
  overlay.onmousedown = (e) => {
    if (e.target === overlay) overlay.remove();
  };
  overlay.onkeydown = (e) => {
    if (e.key === "Escape") overlay.remove();
  };
  document.body.append(overlay);
  done.focus();
}
