import "./themes.css";
import "./style.css";
import { api, VaultEvent } from "./api";
import { FileMap } from "./filemap";
import { GitPanel } from "./gitpanel";
import { LinksPanel } from "./linkspanel";
import { Search } from "./search";
import { openSettings, settings } from "./settings";
import { Switcher } from "./switcher";
import { Tabs } from "./tabs";
import { Tree } from "./tree";

const tabs = new Tabs();
const tree = new Tree(tabs);
const search = new Search(tabs);
const switcher = new Switcher(tree, tabs);
const links = new LinksPanel(tabs);
const git = new GitPanel(tabs);
const fileMap = new FileMap(() => tabs.mapView());
tabs.onViewChange = (content) => fileMap.update(content);
addEventListener("resize", () => fileMap.update());
let authEnabled = false;

tabs.onActiveChange = (p) => {
  tree.onActive(p);
  switcher.visited(p);
  links.refresh();
  if (git.visible) git.render();
};
tabs.onSaved = (p, mtime) => {
  tree.touch(p, mtime);
  links.refresh(true);
  git.refresh(2000);
};
tabs.onCreated = () => tree.refresh();
tree.onFilesChanged = () => tabs.linksChanged();
git.onPulled = () => tree.refresh();

settings.subscribe((s) => {
  tabs.defaultMode = s.defaultMode;
  tree.setShowAttachments(s.showAttachments);
  tabs.linksChanged(); // re-applies editor attributes such as spellcheck
  fileMap.update(true);
});

// ---------- sidebar views ----------

type View = "files" | "search" | "links" | "git";
const VIEWS: View[] = ["files", "search", "links", "git"];

function showView(v: View) {
  document.body.classList.remove("no-sidebar");
  document.querySelectorAll<HTMLElement>(".sidebar-tab").forEach((t) => {
    t.classList.toggle("active", t.dataset.view === v);
    t.ariaSelected = String(t.dataset.view === v);
  });
  for (const name of VIEWS) document.getElementById(`${name}-view`)!.hidden = name !== v;
  links.visible = v === "links";
  git.visible = v === "git";
  // Notes opened while the tree was hidden couldn't be scrolled to.
  if (v === "files") tree.reveal(tabs.activePath, false);
  if (v === "links") links.refresh(true);
  if (v === "git") git.render();
  try {
    localStorage.setItem("mdv.view", v);
  } catch {}
}
git.onShow = () => showView("git");

document.querySelectorAll<HTMLElement>(".sidebar-tab").forEach((t) => {
  t.onclick = () => {
    showView(t.dataset.view as View);
    if (t.dataset.view === "search") search.focus();
  };
});
try {
  const v = localStorage.getItem("mdv.view") as View | null;
  if (v && VIEWS.includes(v)) showView(v);
} catch {}

document.getElementById("open-settings")!.onclick = () => openSettings({ auth: authEnabled });
document.getElementById("status-mode")!.onclick = () => tabs.cycleMode();

// ---------- global shortcuts ----------
// Capture phase so they work even when the editor has focus. Ctrl+N / Ctrl+W /
// Ctrl+Tab are reserved by browsers, hence the Alt variants.

document.addEventListener(
  "keydown",
  (e) => {
    if (document.querySelector(".overlay")) return; // a dialog owns the keyboard
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && !e.shiftKey && !e.altKey && (k === "p" || k === "o")) switcher.open();
    else if (mod && e.shiftKey && k === "f") {
      showView("search");
      search.focus(window.getSelection()?.toString().trim());
    } else if (mod && e.shiftKey && k === "e") {
      showView("files");
      tree.focusTree();
    } else if (mod && e.shiftKey && k === "l") showView("links");
    else if (mod && e.shiftKey && k === "g") showView("git");
    else if (mod && e.altKey && k === "f") {
      showView("files");
      tree.focusFilter();
    } else if (mod && !e.shiftKey && !e.altKey && k === "e") tabs.toggleRead();
    else if (mod && e.key === ",") openSettings({ auth: authEnabled });
    else if (e.altKey && !mod && k === "n") tree.newNote();
    else if (e.altKey && !mod && k === "w") tabs.close();
    else if (e.altKey && !mod && /^[1-9]$/.test(e.key)) tabs.activate(Number(e.key) - 1);
    else if (e.altKey && !mod && e.key === "ArrowLeft") tabs.history(-1);
    else if (e.altKey && !mod && e.key === "ArrowRight") tabs.history(1);
    else if (mod && e.altKey && e.key === "ArrowRight") tabs.next(1);
    else if (mod && e.altKey && e.key === "ArrowLeft") tabs.next(-1);
    else if (mod && e.key === "\\") document.body.classList.toggle("no-sidebar");
    else if (e.altKey && !mod && k === "m") fileMap.toggle();
    else if (mod && k === "s") {
      // Handled by the editor; just block the browser's save dialog.
      if (!(e.target as HTMLElement).closest?.(".cm-editor")) e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

// ---------- sidebar resize ----------

const resizer = document.getElementById("resizer")!;
resizer.onpointerdown = (e) => {
  resizer.setPointerCapture(e.pointerId);
  document.body.classList.add("resizing");
  resizer.onpointermove = (m) => {
    const w = Math.max(180, Math.min(640, m.clientX));
    document.documentElement.style.setProperty("--sidebar-w", w + "px");
  };
  resizer.onpointerup = () => {
    resizer.onpointermove = null;
    document.body.classList.remove("resizing");
    try {
      localStorage.setItem("mdv.sidebarW", getComputedStyle(document.documentElement).getPropertyValue("--sidebar-w"));
    } catch {}
  };
};
resizer.ondblclick = () => document.documentElement.style.removeProperty("--sidebar-w");
try {
  const w = localStorage.getItem("mdv.sidebarW");
  if (w) document.documentElement.style.setProperty("--sidebar-w", w);
} catch {}

// ---------- live updates from the server ----------

let treeTimer = 0;
const refreshTree = () => {
  clearTimeout(treeTimer);
  treeTimer = window.setTimeout(() => {
    tree.refresh();
    search.refresh();
    links.refresh(true);
    git.refresh();
  }, 100);
};

function connect() {
  const es = new EventSource("/api/events");
  let wasDown = false;
  es.onopen = () => {
    // After a disconnect we may have missed events; resync everything.
    if (wasDown) {
      refreshTree();
      tabs.paths.forEach((p) => tabs.externalChange(p));
    }
    wasDown = false;
  };
  es.onerror = () => {
    wasDown = true;
  };
  es.onmessage = (m) => {
    const ev: VaultEvent = JSON.parse(m.data);
    if (ev.type === "tree") refreshTree();
    else if (ev.type === "change" && ev.path) {
      tabs.externalChange(ev.path, ev.mtime);
      tree.touch(ev.path, ev.mtime);
      search.refresh();
      links.refresh(true);
      git.refresh();
    } else if (ev.type === "remove" && ev.path) {
      tabs.externalRemove(ev.path);
      refreshTree();
    }
  };
}

addEventListener("pagehide", () => tabs.flush());
addEventListener("visibilitychange", () => document.hidden && tabs.flush());

// Makes the app installable. Browsers only allow this on HTTPS or localhost.
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

api.config().then((c) => (authEnabled = c.auth), () => {});
settings.load();
git.refresh(0);
tree.refresh().then(async () => {
  await tabs.restore();
  connect();
});
