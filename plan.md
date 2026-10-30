# mdv — plan

A small, fast, self-hosted web markdown editor inspired by Obsidian. Runs in Docker,
serves a web UI over a folder of `.md` files (e.g. an Obsidian vault), with git sync.

## Goals

- First-class markdown editor with "live" rendering (syntax hidden away from the cursor)
- `[[wikilinks]]` between notes
- Open any folder of `.md` files
- Version control via git / GitHub
- Runs in Docker, web interface
- Dark-mode first, themable
- File tree on the **left**, main editor on the right
- Tabs
- Search across all files and within the open file
- Basic keyboard shortcuts

Non-goals (for now): plugins, canvas, graph view, sync other than git, mobile-native apps.

## Stack

| Layer | Choice |
|---|---|
| Backend | Go, single static binary, frontend embedded via `embed` |
| Editor | CodeMirror 6 |
| Frontend | TypeScript + Vite, plain DOM (no framework) |
| Markdown | Lezer markdown (editor), markdown-it (reading view) |
| Git | `git` CLI invoked from Go |
| Live updates | `fsnotify` → WebSocket |
| Image | Multi-stage Docker build → Alpine + git + binary |

## Architecture

```
Browser (SPA) ──HTTP/WS──► Go server ──► /vault (mounted volume)
                                   └──► git CLI
```

### API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/tree` | Folder tree |
| GET | `/api/file?path=` | Read file (returns content + mtime) |
| PUT | `/api/file?path=` | Write file (optimistic concurrency via `X-Mtime` header → 409 on conflict) |
| DELETE | `/api/file?path=` | Delete file |
| POST | `/api/move` | Rename / move |
| POST | `/api/folder` | Create folder |
| GET | `/api/search?q=&case=&word=&regex=` | Vault-wide search (terms ANDed, `"phrases"`, `path:` filter) |
| GET | `/api/links?path=` | Backlinks, outgoing and unresolved links of a note |
| GET | `/api/raw?path=` | Any vault file (images, PDFs), sandboxed |
| POST | `/api/upload?note=&name=` | Store a pasted/dropped file in the attachment folder |
| GET | `/api/config` | UI flags (whether login is enabled) |
| GET | `/api/git/status` | Changed files, branch, ahead/behind |
| POST | `/api/git/commit` `/pull` `/push` | Git ops |
| GET | `/api/git/log?path=` | History; `/api/git/show?rev=&path=` for old versions |
| GET | `/api/events` | Server-sent events: `change` / `remove` / `tree` |

### Server internals

- **vault**: path sandboxing (reject anything escaping the root), atomic writes
  (temp file + rename), ignores `.git`, `.obsidian`, `.trash`, `node_modules`.
- **index**: in-memory map of files → content, names, outgoing links. Built on startup,
  kept fresh by fsnotify. Search is a linear scan (fast enough for tens of thousands of notes).
- **link resolution**: Obsidian rules — exact path, else basename match, shortest path wins;
  supports `[[a|alias]]`, `[[a#heading]]`, `[[a.md]]`.
- **auth**: optional — if `MDV_PASSWORD` is set, a login page issues a signed session cookie.

## UI

```
┌──────────────┬──────────────────────────────────────────────┐
│  🔍 filter   │ [tab1.md] [tab2.md ●] [tab3.md]              │
│  ▾ Projects  ├──────────────────────────────────────────────┤
│    note.md   │                                              │
│  ▾ Journal   │   Editor (live preview) / reading view       │
│    ...       │                                              │
├──────────────┤                                              │
│ Git: 3 ∆  ⟳  │                                              │
├──────────────┴──────────────────────────────────────────────┤
│ status: words · line:col · branch · saved ✓                 │
└─────────────────────────────────────────────────────────────┘
```

- File tree on the left; collapsible, resizable.
- Tabs keep per-tab cursor/scroll/undo history; open tabs restored on reload.
- Modes: Live preview (default), Source, Reading.
- `[[` autocompletes note names; click opens, Ctrl+click opens in new tab;
  unresolved links render dimmed and create the note on click.

### Themes (CSS variables)

Midnight (default), Catppuccin Mocha, Tokyo Night, Nord, Gruvbox Dark, Rosé Pine,
Catppuccin Latte (light).

### Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+P` / `Ctrl+O` | Quick open |
| `Ctrl+Shift+F` | Vault search (seeds with the selection) |
| `Ctrl+Shift+E` | Focus file tree |
| `Ctrl+Alt+F` | Filter file tree |
| `Alt+←` / `Alt+→` | Back / forward within a tab |
| `Ctrl+F` / `Ctrl+H` | Find / replace in file |
| `Ctrl+S` | Save (autosave also on idle) |
| `Alt+N` (`Ctrl+N` in PWA) | New note |
| `Alt+W` (`Ctrl+W` in PWA) | Close tab |
| `Ctrl+Alt+←/→`, `Alt+1..9` | Switch tabs |
| `Ctrl+E` | Toggle edit / reading |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+K` | Bold / italic / link |
| `Ctrl+\` | Toggle sidebar |
| `Ctrl+Shift+G` | Git panel |

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `MDV_VAULT` | `/vault` | Vault root |
| `MDV_ADDR` | `:8080` | Listen address |
| `MDV_PASSWORD` | _(unset)_ | Enables login when set |
| `MDV_AUTO_COMMIT` | _(unset)_ | e.g. `10m` — auto-commit interval (off by default) |
| `MDV_AUTO_PUSH` | `false` | Push after auto-commit |
| `MDV_GIT_NAME` / `MDV_GIT_EMAIL` | `mdv` / `mdv@localhost` | Commit identity |

## Phases

The file tree and search are the primary way of finding notes, so they were
pulled ahead of editor polish.

1. ✅ **Skeleton** — Go server, tree, open/save file, CodeMirror editor, tabs,
   autosave + conflict detection, Docker build.
2. ✅ **Navigation: tree + search**
   - Tree: flat keyboard-navigable list (arrows, Home/End, PgUp/PgDn, type-ahead,
     Enter/Space, F2 inline rename, Del), filter box, sort (name / modified),
     collapse all, reveal active, indent guides, drag & drop with hover-to-open,
     context menus, persisted open folders + scroll.
   - Opening a note replaces the current tab (Obsidian-style) with per-tab
     back/forward; Ctrl/middle-click opens a new tab.
   - Quick switcher (Ctrl+P): fuzzy, word-start aware, recent-first, create on Shift+Enter.
   - Vault search panel (Ctrl+Shift+F): in-memory index, case / word / regex,
     `path:` filter, name matches ranked first, jump to match.
   - Live updates: fsnotify → SSE; tree, open tabs and search refresh on external change.
3. ✅ **Editor + images**
   - Live preview: syntax hidden except on the cursor's lines; headings, emphasis,
     inline/fenced code, quotes, callout labels, bullets, clickable checkboxes,
     rules, links, `==highlights==`, `#tags`, YAML frontmatter.
   - Decorations cover the whole note (not just the viewport) so heights stay
     stable while scrolling; image sizes are cached for the same reason.
   - Source mode and reading view (markdown-it + DOMPurify, callouts, task
     toggling, highlighted code), `Ctrl+E` to toggle, mode per tab.
   - Images: paste/drop to upload (Obsidian's attachment-folder setting honoured),
     `![[img.png|300]]` and `![alt|300](path)` embeds, image/PDF viewer tabs,
     attachments shown in the tree.
4. ✅ **Links** — Obsidian-style resolution (note's folder, root, then shortest
   name match) on client and server, `[[` autocomplete, click to follow
   (`#heading` jumps, unresolved links create the note), Links panel with
   backlinks/outgoing/unresolved, renames and moves rewrite links in other notes.
5. ✅ **Git** — panel with branch/ahead/behind, remote setup, commit / sync / pull /
   push, changed files, per-note history with a rendered old version and undoable
   restore; `MDV_AUTO_COMMIT` / `MDV_AUTO_PUSH`; status-bar indicator.
6. ✅ **Polish** — 7 themes, settings (theme, size, width, font, default mode,
   attachments, spellcheck), optional password login (signed cookie, throttling),
   cross-origin write protection, installable PWA, tab reordering.

7. ✅ **Round 2** — file map (heading outline + scroll strip, `Alt+M`), code
   highlighting with language aliases (ps1, pwsh, console…) and labels, distinct
   heading colours per level in every theme, wider "Wide" line width, auto-commit
   status in the Git panel and status bar, Obsidian-style line breaks in reading view.

8. ✅ **Line numbers** (toggle) and **vault settings** stored in `.mdv/settings.json`
   (`GET/PUT /api/settings`), cached per browser, migrated from old browser settings.

Later ideas: bookmarks/pinned notes, note transclusion (`![[note]]`), tables in
live preview, graph view, diff view in history, virtualised tree
for very large vaults, search history, mobile layout, specify default attachment location in settings.

## Repo layout

```
mdv/
  cmd/mdv/main.go
  internal/{vault,index,gitops,server,auth}/
  web/                 # Vite + TS frontend; built into internal/server/dist
    src/               # main, tabs, tree, editor, livepreview, reader, links,
                       # search, switcher, linkspanel, gitpanel, settings, themes
  Dockerfile
  docker-compose.yml
```

## Notes

- On Docker Desktop for Windows, prefer a named volume for the vault — files then live
  inside the WSL2 VHDX, out of reach of most host AV scanning. Push to a private GitHub
  repo for an off-machine copy.
