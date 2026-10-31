import { api, GitAuto, GitCommit, GitStatus } from "./api";
import { diffLines, renderDiff } from "./diff";
import { basename, isNote, stripMd, vaultFiles } from "./links";
import { Tabs } from "./tabs";
import { promptBox, toast } from "./ui";

const STATUS_LABEL: Record<string, string> = {
  M: "Modified",
  A: "Added",
  D: "Deleted",
  R: "Renamed",
  "?": "New",
  U: "Conflict",
};

const ago = (secs: number) => {
  const d = Date.now() / 1000 - secs;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)} min ago`;
  if (d < 86400) return `${Math.floor(d / 3600)} h ago`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} d ago`;
  return new Date(secs * 1000).toLocaleDateString();
};

/** "1h30m0s" → "1h 30m", "10m0s" → "10m". */
const prettyDuration = (d = "") =>
  d.replace(/(\d+[hms])/g, "$1 ").replace(/(^|\s)0[hms]/g, "").replace(/\b0s\b/, "").trim();

const until = (secs: number) => {
  const d = Math.round(secs - Date.now() / 1000);
  if (d <= 60) return "in under a minute";
  if (d < 3600) return `in ${Math.round(d / 60)} min`;
  return `in ${Math.round(d / 3600)} h`;
};

function autoRow(a: GitAuto | undefined): HTMLElement {
  const row = el("div", "git-auto" + (a?.enabled ? " on" : ""));
  if (!a?.enabled) {
    row.append(el("span", "git-auto-state", "Auto-commit off"));
    const hint = el("div", "git-dim", "Set MDV_AUTO_COMMIT (e.g. 10m) to enable");
    row.append(hint);
    return row;
  }
  const what = a.push ? "commit, pull & push" : "commit";
  row.append(el("span", "git-auto-state", `⟳ Auto ${what} every ${prettyDuration(a.every)}`));
  const detail = el("div", "git-dim");
  if (a.lastRun) {
    detail.textContent = `Last ${ago(a.lastRun)}: ${a.lastResult || "ok"}`;
  } else {
    detail.textContent = "Hasn't run yet";
  }
  if (a.nextRun) detail.textContent += ` · next ${until(a.nextRun)}`;
  row.append(detail);
  if (a.lastError) {
    row.classList.add("error");
    row.append(el("div", "git-auto-error", a.lastError));
  }
  return row;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** Sidebar Git panel plus the status-bar indicator. */
export class GitPanel {
  private root = document.getElementById("git-view")!;
  private indicator = document.getElementById("status-git")!;
  private status: GitStatus | null = null;
  private busy = false;
  private timer = 0;
  private message = "";
  visible = false;
  /** Called after operations that may change files (pull, sync). */
  onPulled: () => void = () => {};
  /** Called when the indicator is clicked. */
  onShow: () => void = () => {};

  constructor(private tabs: Tabs) {
    this.indicator.onclick = () => this.onShow();
    setInterval(() => this.refresh(), 30_000);
  }

  /** Re-read status soon (debounced). */
  refresh(delay = 800) {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.load(), delay);
  }

  private async load() {
    try {
      this.status = await api.git.status();
    } catch {
      this.status = null;
    }
    this.renderIndicator();
    if (this.visible) this.render();
  }

  private renderIndicator() {
    const st = this.status;
    if (!st?.repo) {
      this.indicator.textContent = st?.auto?.enabled ? "⟳ no repo" : "";
      return;
    }
    const parts = [`⎇ ${st.branch ?? "?"}`];
    if (st.files.length) parts.push(`${st.files.length} changed`);
    if (st.ahead) parts.push(`↑${st.ahead}`);
    if (st.behind) parts.push(`↓${st.behind}`);
    if (st.auto?.enabled) parts.push(st.auto.lastError ? "⟳ failed" : "⟳");
    this.indicator.textContent = parts.join("  ");
    this.indicator.title = st.auto?.enabled
      ? `Git (Ctrl+Shift+G) · auto ${st.auto.push ? "sync" : "commit"} every ${prettyDuration(st.auto.every)}`
      : "Git (Ctrl+Shift+G)";
    this.indicator.classList.toggle(
      "warn",
      !!st.merging || st.files.some((f) => f.status === "U") || !!st.auto?.lastError,
    );
  }

  private async run(op: "init" | "commit" | "pull" | "push" | "sync", message = "") {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      const res = await api.git.run(op, message);
      if (res.error) toast(new Error(res.error));
      else toast(res.message || "Done");
      if (!res.error && (op === "commit" || op === "sync")) this.message = "";
      if (op === "pull" || op === "sync") this.onPulled();
    } catch (e) {
      toast(e);
    }
    this.busy = false;
    await this.load();
  }

  render() {
    const st = this.status;
    const root = this.root;
    root.replaceChildren();
    if (!st) {
      root.append(el("p", "panel-empty", "Loading…"));
      this.load();
      return;
    }
    if (!st.repo) {
      root.append(autoRow(st.auto));
      root.append(el("p", "panel-empty", "This vault isn't a git repository yet."));
      const b = el("button", "btn primary", "Initialize repository");
      b.onclick = () => this.run("init");
      root.append(el("div", "git-actions"));
      root.lastElementChild!.append(b);
      return;
    }

    // Branch & remote.
    const head = el("div", "git-head");
    const br = el("div", "git-branch", `⎇ ${st.branch}`);
    if (st.upstream) br.append(el("span", "git-dim", `  → ${st.upstream}`));
    if (st.ahead || st.behind) br.append(el("span", "git-dim", `  ↑${st.ahead} ↓${st.behind}`));
    const remote = el("div", "git-remote");
    remote.append(el("span", "git-dim", st.remote || "No remote"));
    const setRemote = el("button", "link-btn", st.remote ? "change" : "set remote…");
    setRemote.onclick = async () => {
      const url = await promptBox(
        "Remote URL (e.g. https://<user>:<token>@github.com/<user>/notes.git or git@github.com:<user>/notes.git)",
        "",
      );
      if (!url) return;
      const res = await api.git.remote(url);
      res.error ? toast(new Error(res.error)) : toast("Remote set");
      this.load();
    };
    remote.append(" ", setRemote);
    head.append(br, remote);
    root.append(head, autoRow(st.auto));

    if (st.merging) {
      root.append(
        el("p", "git-warn", "Merge in progress: fix the conflicting notes (look for <<<<<<<), then commit."),
      );
    }

    // Commit box.
    const box = el("div", "git-commit");
    const msg = el("textarea");
    msg.placeholder = "Commit message (optional)";
    msg.rows = 2;
    msg.value = this.message;
    msg.oninput = () => (this.message = msg.value);
    msg.onkeydown = (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.run("commit", msg.value);
      }
    };
    const actions = el("div", "git-actions");
    const btn = (label: string, title: string, fn: () => void, primary = false) => {
      const b = el("button", "btn" + (primary ? " primary" : ""), label);
      b.title = title;
      b.disabled = this.busy;
      b.onclick = fn;
      actions.append(b);
    };
    btn("Commit", "Commit all changes (Ctrl+Enter)", () => this.run("commit", msg.value), true);
    btn("Sync", "Commit, pull, then push", () => this.run("sync", msg.value));
    btn("Pull", "Pull from the remote", () => this.run("pull"));
    btn("Push", "Push to the remote", () => this.run("push"));
    box.append(msg, actions);
    root.append(box);

    // Changes.
    const changes = el("section", "lp-section");
    const h = el("h3", "", "Changes");
    h.append(el("span", "sr-count", String(st.files.length)));
    changes.append(h);
    if (!st.files.length) changes.append(el("p", "panel-empty", "Everything is committed."));
    for (const f of st.files) {
      const row = el("div", "sr-head git-file");
      const badge = el("span", `git-badge s-${f.status === "?" ? "new" : f.status}`, f.status === "?" ? "+" : f.status);
      badge.title = STATUS_LABEL[f.status] ?? f.status;
      row.append(badge, el("span", "sr-name", isNote(f.path) ? stripMd(basename(f.path)) : basename(f.path)));
      row.append(el("span", "sr-dir", f.path.includes("/") ? f.path.slice(0, f.path.lastIndexOf("/")) : ""));
      row.title = f.path;
      if (f.status !== "D" && vaultFiles.has(f.path)) row.onclick = () => this.tabs.open(f.path);
      changes.append(row);
    }
    root.append(changes);

    // History of the active note.
    const p = this.tabs.activePath;
    if (p) {
      const hist = el("section", "lp-section");
      hist.append(el("h3", "", `History of ${isNote(p) ? stripMd(basename(p)) : basename(p)}`));
      const list = el("div");
      list.append(el("p", "panel-empty", "Loading…"));
      hist.append(list);
      root.append(hist);
      api.git.log(p).then(
        (commits) => this.renderHistory(list, p, commits),
        () => list.replaceChildren(el("p", "panel-empty", "No history.")),
      );
    }
  }

  private renderHistory(list: HTMLElement, path: string, commits: GitCommit[]) {
    list.replaceChildren();
    if (!commits.length) list.append(el("p", "panel-empty", "Not committed yet."));
    for (const c of commits) {
      const row = el("div", "sr-line git-commit-row");
      row.append(el("span", "sr-ln", c.short));
      const text = el("span", "sr-text");
      text.append(el("span", "", c.subject), el("span", "git-dim", ` · ${ago(c.time)}`));
      row.append(text);
      row.title = `${c.author}, ${new Date(c.time * 1000).toLocaleString()}`;
      row.onclick = () => this.showVersion(path, commits, commits.indexOf(c));
      list.append(row);
    }
  }

  /**
   * Show an old version of a note: what that commit changed, how it differs
   * from the note now, or the version itself, with the option to restore it.
   */
  private async showVersion(path: string, commits: GitCommit[], i: number) {
    const c = commits[i];
    let content: string;
    try {
      content = await api.git.show(c.hash, path);
    } catch (e) {
      toast(e);
      return;
    }
    // The version before this one in the note's own history (follows renames).
    const older = commits[i + 1];
    let parent: Promise<string> | null = null;
    const parentText = () =>
      (parent ??= older ? api.git.show(older.hash, path).catch(() => "") : Promise.resolve(""));
    const currentText = async () => this.tabs.textOf(path) ?? (await api.read(path)).content;

    const overlay = el("div", "overlay");
    const box = el("div", "version");
    const bar = el("div", "version-bar");
    const title = el("div", "version-title");
    title.append(el("strong", "", c.subject), el("span", "git-dim", `  ${c.short} · ${new Date(c.time * 1000).toLocaleString()}`));
    const restore = el("button", "btn primary", "Restore this version");
    restore.disabled = !isNote(path);
    restore.onclick = async () => {
      overlay.remove();
      await this.tabs.open(path);
      this.tabs.replaceContent(content);
      toast("Restored. Undo with Ctrl+Z if that was a mistake.");
    };
    const close = el("button", "btn", "Close");
    close.onclick = () => overlay.remove();

    type ViewKind = "changes" | "current" | "version";
    const views: [ViewKind, string, string][] = [
      ["changes", "Changes", "What this commit changed in the note"],
      ["current", "Compare with now", "Differences between this version and the note as it is now"],
      ["version", "Version", "The note as it was in this commit"],
    ];
    const seg = el("div", "seg");
    const body = el("div", "version-body");
    let shown: ViewKind = "changes";
    try {
      const v = localStorage.getItem("mdv.versionView") as ViewKind | null;
      if (v && views.some(([k]) => k === v)) shown = v;
    } catch {}
    const show = async (kind: ViewKind) => {
      shown = kind;
      try {
        localStorage.setItem("mdv.versionView", kind);
      } catch {}
      seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.kind === kind));
      body.className = "version-body" + (kind === "version" ? " reader" : "");
      body.replaceChildren(el("p", "panel-empty", "Loading…"));
      let node: HTMLElement;
      try {
        if (kind === "version") {
          node = el("div");
          if (isNote(path)) (await import("./reader")).render(node, content, path);
          else node.append(el("pre", "", content));
          if (shown !== kind) return;
          body.replaceChildren(...node.childNodes);
          return;
        }
        const [from, to] = kind === "changes" ? [await parentText(), content] : [content, await currentText()];
        node = renderDiff(diffLines(from, to));
        if (kind === "changes" && !older) node.prepend(el("p", "git-dim diff-note", "First version of this note in history."));
        if (kind === "current") node.prepend(el("p", "git-dim diff-note", "− this version   + now"));
      } catch (e) {
        node = el("p", "panel-empty", String((e as Error).message));
      }
      if (shown === kind) body.replaceChildren(node);
    };
    for (const [kind, label, tip] of views) {
      const b = el("button", "", label);
      b.dataset.kind = kind;
      b.title = tip;
      b.onclick = () => show(kind);
      seg.append(b);
    }

    bar.append(title, seg, restore, close);
    box.append(bar, body);
    overlay.append(box);
    overlay.onmousedown = (e) => {
      if (e.target === overlay) overlay.remove();
    };
    overlay.tabIndex = -1;
    overlay.onkeydown = (e) => {
      if (e.key === "Escape") overlay.remove();
    };
    document.body.append(overlay);
    overlay.focus();
    show(shown);
  }
}
