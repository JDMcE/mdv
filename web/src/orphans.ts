// "Unused attachments": files no note links to or embeds (e.g. a pasted image
// whose note was deleted), listed so they can be reviewed and removed.

import { api, Orphan, rawUrl } from "./api";
import { confirmBox, toast } from "./ui";

const IMAGE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

function size(n: number): string {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

export async function openOrphans() {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const box = document.createElement("div");
  box.className = "dialog orphans";
  const h = document.createElement("h2");
  h.textContent = "Unused attachments";
  const summary = document.createElement("p");
  summary.className = "orphans-summary";
  summary.textContent = "Scanning…";
  const list = document.createElement("div");
  list.className = "orphans-list";
  const foot = document.createElement("div");
  foot.className = "dialog-buttons";
  const all = document.createElement("label");
  all.className = "orphans-all";
  const allBox = document.createElement("input");
  allBox.type = "checkbox";
  all.append(allBox, " Select all");
  const close = document.createElement("button");
  close.textContent = "Close";
  const del = document.createElement("button");
  del.className = "danger";
  del.disabled = true;
  foot.append(all, close, del);
  box.append(h, summary, list, foot);
  overlay.append(box);
  document.body.append(overlay);
  close.focus();

  const done = () => {
    overlay.remove();
    document.removeEventListener("keydown", key, true);
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !document.querySelector(".overlay:not(:has(.orphans))")) done();
  };
  document.addEventListener("keydown", key, true);
  close.onclick = done;
  overlay.onmousedown = (e) => {
    if (e.target === overlay) done();
  };

  let items: { o: Orphan; box: HTMLInputElement; row: HTMLElement }[] = [];

  const update = () => {
    const sel = items.filter((i) => i.box.checked);
    const bytes = sel.reduce((n, i) => n + i.o.size, 0);
    del.disabled = !sel.length;
    del.textContent = sel.length ? `Delete ${sel.length} (${size(bytes)})` : "Delete";
    allBox.checked = !!items.length && sel.length === items.length;
    allBox.indeterminate = !!sel.length && sel.length < items.length;
  };
  allBox.onchange = () => {
    items.forEach((i) => (i.box.checked = allBox.checked));
    list.querySelectorAll<HTMLInputElement>(".orphans-folder input").forEach((b) => {
      b.checked = allBox.checked;
      b.indeterminate = false;
    });
    update();
  };

  const render = (orphans: Orphan[]) => {
    list.replaceChildren();
    items = [];
    const total = orphans.reduce((n, o) => n + o.size, 0);
    summary.textContent = orphans.length
      ? `${orphans.length} file${orphans.length === 1 ? "" : "s"} (${size(total)}) not linked or embedded by any note. ` +
        "Files whose name appears anywhere in a note are kept off this list."
      : "Every attachment is used by at least one note.";
    all.hidden = !orphans.length;
    const folders = new Map<string, Orphan[]>();
    for (const o of orphans) {
      const dir = o.path.includes("/") ? o.path.slice(0, o.path.lastIndexOf("/")) : "";
      if (!folders.has(dir)) folders.set(dir, []);
      folders.get(dir)!.push(o);
    }
    for (const [dir, group] of folders) {
      const head = document.createElement("label");
      head.className = "orphans-folder";
      const fb = document.createElement("input");
      fb.type = "checkbox";
      head.append(fb, (dir || "(vault root)") + "/");
      list.append(head);
      const mine: HTMLInputElement[] = [];
      for (const o of group) {
        const row = document.createElement("label");
        row.className = "orphans-item";
        const b = document.createElement("input");
        b.type = "checkbox";
        const thumb = document.createElement("span");
        thumb.className = "orphans-thumb";
        if (IMAGE.test(o.path)) {
          const img = document.createElement("img");
          img.loading = "lazy";
          img.src = rawUrl(o.path);
          img.alt = "";
          thumb.append(img);
        } else {
          thumb.textContent = (o.path.split(".").pop() || "").slice(0, 4).toUpperCase();
        }
        const name = document.createElement("a");
        name.className = "orphans-name";
        name.textContent = o.path.slice(dir ? dir.length + 1 : 0);
        name.href = rawUrl(o.path);
        name.target = "_blank";
        name.rel = "noopener";
        name.title = "Open in a new tab";
        const meta = document.createElement("small");
        meta.textContent = `${size(o.size)} · ${new Date(o.mtime).toLocaleDateString()}`;
        row.append(b, thumb, name, meta);
        list.append(row);
        mine.push(b);
        items.push({ o, box: b, row });
        b.onchange = () => {
          const n = mine.filter((m) => m.checked).length;
          fb.checked = n === mine.length;
          fb.indeterminate = n > 0 && n < mine.length;
          update();
        };
      }
      fb.onchange = () => {
        mine.forEach((m) => (m.checked = fb.checked));
        update();
      };
    }
    update();
  };

  const load = async () => {
    try {
      render(await api.orphans());
    } catch (e) {
      summary.textContent = "Couldn't scan: " + (e as Error).message;
    }
  };

  del.onclick = async () => {
    const sel = items.filter((i) => i.box.checked).map((i) => i.o.path);
    if (!sel.length) return;
    const what = sel.length === 1 ? sel[0] : `${sel.length} files`;
    if (!(await confirmBox(`Permanently delete ${what}? This can't be undone (except from git history).`))) return;
    del.disabled = true;
    try {
      const res = await api.deleteOrphans(sel);
      toast(
        `Deleted ${res.deleted.length} file${res.deleted.length === 1 ? "" : "s"}` +
          (res.skipped.length ? `; ${res.skipped.length} skipped (now in use or failed)` : ""),
      );
    } catch (e) {
      toast(e);
    }
    await load();
  };

  await load();
}
