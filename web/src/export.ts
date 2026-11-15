// Export a note: the raw markdown, or a standalone HTML page that renders the
// same as the reading view (theme colours, diagrams and images included).

import { rawUrl } from "./api";
import { noteText } from "./embeds";
import { basename, isNote, stripMd } from "./links";
import { MenuItem, toast } from "./ui";

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Context-menu entries for a file. */
export function exportItems(path: string): MenuItem[] {
  if (!isNote(path)) return [{ label: "Download", run: () => downloadFile(path) }];
  return [
    { label: "Export as HTML", run: () => exportHtml(path) },
    { label: "Download markdown", run: () => downloadFile(path) },
  ];
}

/** Download a file as it is. Notes include edits not yet saved. */
export async function downloadFile(path: string) {
  try {
    const blob = isNote(path)
      ? new Blob([await noteText(path)], { type: "text/markdown;charset=utf-8" })
      : await (await fetch(rawUrl(path))).blob();
    save(blob, basename(path));
  } catch (e) {
    toast(e);
  }
}

/** Download a note as a self-contained HTML file. */
export async function exportHtml(path: string) {
  try {
    const [{ render }, text] = await Promise.all([import("./reader"), noteText(path)]);
    const root = document.createElement("article");
    root.className = "reader";
    await render(root, text, path);
    await standalone(root);
    const title = stripMd(basename(path));
    save(new Blob([page(title, root.innerHTML)], { type: "text/html;charset=utf-8" }), title + ".html");
  } catch (e) {
    toast(e);
  }
}

/** Strip app-only bits and inline vault images so the HTML works on its own. */
async function standalone(root: HTMLElement) {
  root.querySelectorAll(".reader-copy").forEach((b) => b.remove());
  root.querySelectorAll<HTMLInputElement>("input.task").forEach((b) => {
    b.toggleAttribute("checked", b.checked);
    b.setAttribute("disabled", "");
  });
  // Links into the vault go nowhere outside mdv: keep their text and look.
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a.wikilink, a.internal, a.embed-title")) {
    const span = document.createElement("span");
    span.className = a.className;
    span.append(...a.childNodes);
    a.replaceWith(span);
  }
  const raw = new URL(rawUrl(""), location.href).pathname;
  await Promise.all(
    [...root.querySelectorAll("img")].map(async (img) => {
      if (new URL(img.src, location.href).pathname !== raw) return;
      try {
        const blob = await (await fetch(img.src)).blob();
        img.src = await dataUrl(blob);
      } catch {
        // Leave it pointing at the server.
      }
    }),
  );
  for (const el of root.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) if (attr.name.startsWith("data-")) el.removeAttribute(attr.name);
  }
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Whether a stylesheet rule styles rendered notes. */
const READER_RULE = /\.reader\b|\.tok-|\.props|\.embed-note/;

/** Split a selector list on its top-level commas. */
function selectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out;
}

/** The app's reading-view rules, plus the current theme's variables. */
function readerCss(): string {
  const rules: string[] = [];
  const vars = new Set<string>();
  const walk = (list: CSSRuleList, out: string[]) => {
    for (const rule of list) {
      for (const m of rule.cssText.matchAll(/var\((--[\w-]+)/g)) vars.add(m[1]);
      if (rule instanceof CSSStyleRule) {
        const keep = selectors(rule.selectorText).filter((s) => READER_RULE.test(s) && !/\.pane-|\.cm-/.test(s));
        if (keep.length) out.push(`${keep.join(", ")} { ${rule.style.cssText} }`);
      } else if (rule instanceof CSSMediaRule) {
        const inner: string[] = [];
        walk(rule.cssRules, inner);
        if (inner.length) out.push(`@media ${rule.conditionText} {\n${inner.join("\n")}\n}`);
      }
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      walk(sheet.cssRules, rules);
    } catch {
      // Cross-origin sheet: skip.
    }
  }
  const css = getComputedStyle(document.documentElement);
  const decls = [...vars]
    .map((v) => [v, css.getPropertyValue(v).trim()])
    .filter(([, val]) => val)
    .map(([v, val]) => `  ${v}: ${val};`);
  return `:root {\n${decls.join("\n")}\n}\n${rules.join("\n")}`;
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
${readerCss()}
*, *::before, *::after { box-sizing: border-box; }
html { background: var(--bg); color: var(--text); -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { margin: 0; }
.reader { padding: 32px 24px 64px; overflow: visible; }
@media (max-width: 700px) { .reader { padding: 16px 14px 40px; } }
</style>
</head>
<body>
<article class="reader">
${body}
</article>
</body>
</html>
`;
}
