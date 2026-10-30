// Small in-page dialogs and menus (avoids blocking browser prompt/confirm).

function overlay(): HTMLDivElement {
  const o = document.createElement("div");
  o.className = "overlay";
  document.body.append(o);
  return o;
}

/** Ask for a line of text. `select` is the initially selected [from, to] range. */
export function promptBox(title: string, value = "", select?: [number, number]): Promise<string | null> {
  return new Promise((resolve) => {
    const o = overlay();
    const box = document.createElement("form");
    box.className = "dialog";
    const label = document.createElement("label");
    label.textContent = title;
    const input = document.createElement("input");
    input.value = value;
    box.append(label, input);
    o.append(box);
    input.focus();
    input.spellcheck = false;
    input.setSelectionRange(...(select ?? [0, value.length]));
    const done = (v: string | null) => {
      o.remove();
      resolve(v);
    };
    box.onsubmit = (e) => {
      e.preventDefault();
      done(input.value.trim() || null);
    };
    input.onkeydown = (e) => {
      if (e.key === "Escape") done(null);
    };
    o.onmousedown = (e) => {
      if (e.target === o) done(null);
    };
  });
}

export function confirmBox(message: string, okLabel = "Delete"): Promise<boolean> {
  return new Promise((resolve) => {
    const o = overlay();
    const box = document.createElement("div");
    box.className = "dialog";
    const p = document.createElement("p");
    p.textContent = message;
    const row = document.createElement("div");
    row.className = "dialog-buttons";
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    const ok = document.createElement("button");
    ok.className = "danger";
    ok.textContent = okLabel;
    row.append(cancel, ok);
    box.append(p, row);
    o.append(box);
    ok.focus();
    const done = (v: boolean) => {
      o.remove();
      document.removeEventListener("keydown", key, true);
      resolve(v);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") done(false);
    };
    document.addEventListener("keydown", key, true);
    cancel.onclick = () => done(false);
    ok.onclick = () => done(true);
    o.onmousedown = (e) => {
      if (e.target === o) done(false);
    };
  });
}

export interface MenuItem {
  label: string;
  run: () => void;
  hint?: string; // shortcut shown on the right
  danger?: boolean;
}

export function contextMenu(x: number, y: number, items: MenuItem[]) {
  document.querySelector(".menu")?.remove();
  const m = document.createElement("div");
  m.className = "menu";
  for (const it of items) {
    const b = document.createElement("button");
    b.textContent = it.label;
    if (it.hint) {
      const h = document.createElement("kbd");
      h.textContent = it.hint;
      b.append(h);
    }
    if (it.danger) b.className = "danger";
    b.onclick = () => {
      m.remove();
      it.run();
    };
    m.append(b);
  }
  document.body.append(m);
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 4) + "px";
  m.style.top = Math.min(y, innerHeight - r.height - 4) + "px";
  const close = (e: Event) => {
    if (!m.contains(e.target as Node)) {
      m.remove();
      document.removeEventListener("mousedown", close, true);
    }
  };
  document.addEventListener("mousedown", close, true);
}

let toastTimer = 0;

/** Brief, non-blocking notice in the bottom-right corner. */
export function toast(msg: unknown) {
  let el = document.querySelector<HTMLElement>(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.append(el);
  }
  const isErr = msg instanceof Error;
  el.textContent = isErr ? (msg as Error).message : String(msg);
  el.classList.toggle("error", isErr);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el!.classList.remove("show"), isErr ? 5000 : 1800);
}

/**
 * Copy text to the clipboard. The async Clipboard API only exists on HTTPS
 * and localhost, so fall back to a hidden textarea when mdv is opened over
 * plain HTTP from another machine.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  const prev = document.activeElement as HTMLElement | null;
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  ta.remove();
  prev?.focus({ preventScroll: true });
  return ok;
}

/** A small "Copy" button for code blocks. */
export function copyButton(getText: () => string, className: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "copy-btn " + className;
  b.type = "button";
  b.title = "Copy to clipboard";
  b.textContent = "Copy";
  b.onmousedown = (e) => e.preventDefault(); // keep editor focus and cursor
  b.onclick = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = await copyText(getText());
    b.textContent = ok ? "Copied" : "Copy failed";
    b.classList.toggle("done", ok);
    setTimeout(() => {
      b.textContent = "Copy";
      b.classList.remove("done");
    }, 1500);
  };
  return b;
}
