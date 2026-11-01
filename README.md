<p align="center">
  <img src="branding/logo.png" alt="mdv logo" width="140">
</p>

<h1 align="center">mdv</h1>

<p align="center">
  A small, fast, self-hosted markdown notes app inspired by Obsidian.<br>
  Your notes stay plain <code>.md</code> files in a folder, edited in the browser and backed up with git.
</p>

---

mdv is a single Go binary with an embedded web UI, shipped as a Docker image. Point
it at a folder of markdown files (an existing Obsidian vault works as-is) and you
get a live-preview editor, wikilinks, search and git sync from any browser,
including your phone.

**Why it exists:** keeping notes in a Docker volume puts them out of reach of
overzealous host antivirus, and git sync to a private repo means there's always a
copy somewhere else. No proprietary format, no lock-in: stop using mdv and your
notes are still just files.

## Contents

- [Features](#features)
- [Quick start](#quick-start)
- [Using your own notes](#using-your-own-notes)
- [Syncing with GitHub](#syncing-with-github)
- [Configuration](#configuration)
- [Security](#security)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Development](#development)

## Features

**Editing**
- Live preview that hides markdown syntax away from the cursor, plus source mode and a reading view
- Syntax highlighting in fenced code blocks (bash, PowerShell, Python, SQL, YAML, …)
- Tables render in live preview; find & replace within a note
- Autosave, tabs, back/forward history

**Linking**
- `[[wikilinks]]` with autocomplete, a backlinks panel, and links updated automatically on rename
- Note embeds: `![[note]]`, `![[note#Heading]]`, `![[note#^block]]`
- Images: paste or drop to upload, `![[image.png|300]]` sizing, built-in image and PDF viewer

**Finding things**
- File tree with keyboard navigation, filtering, sorting and drag & drop
- Quick switcher (`Ctrl+P`) and full-text search across the vault (`Ctrl+Shift+F`), with recent searches
- Bookmarks for notes and folders, stored in the vault so they sync
- File map: a heading outline and scroll map beside the editor

**Version control**
- Git panel: commit, pull, push and one-click sync
- Per-note history with diffs and restore
- Optional automatic commit (and push) on a timer

**Everywhere else**
- Works on phones: the sidebar becomes a drawer
- Live updates when files change on disk
- Dark-first themes, installable as an app (PWA), optional password

## Quick start

You need Docker with Compose.

```sh
git clone https://github.com/JDMcE/mdv.git
cd mdv
cp .env.example .env        # then set MDV_PASSWORD in .env
docker compose up -d --build
```

Open <http://localhost:8080>. Notes are stored in the `vault` Docker volume.

The bundled `docker-compose.yml` turns on auto-commit every 10 minutes with
auto-push. Edit it if you'd rather commit by hand.

## Using your own notes

**An existing folder.** Swap the named volume in `docker-compose.yml` for a bind mount:

```yaml
volumes:
  - ./vault:/vault          # or D:/Notes:/vault on Windows
```

**An existing git repo.** Create a token with *Contents: read and write*, then add
the repo to `.env` before the first start:

```sh
MDV_GIT_REMOTE=https://<user>:<token>@github.com/<user>/<repo>.git
```

On first start, mdv clones the repo into the empty volume, so your notes are there
straight away.

> [!NOTE]
> On Docker Desktop for Windows, a named volume lives inside the WSL2 virtual disk,
> which keeps notes away from most host antivirus scanning. Bind mounts from
> Windows don't always forward file-change events, so edits made outside mdv may
> only show up after a reload.

## Syncing with GitHub

1. Create a **private** repository.
2. Create a fine-grained token with **Contents: read and write** on that repo only.
3. Set the remote, either in the app (**Git → set remote…**) or with
   `MDV_GIT_REMOTE=https://<user>:<token>@github.com/<user>/<repo>.git` in `.env`.
   If the vault is empty, mdv clones the repo on start, whether it's empty or
   already has notes in it.
4. In the Git panel, click **Initialize repository** if needed, then **Sync**.

SSH remotes work too: mount a key into `/home/mdv/.ssh/`. It must be readable by
uid 1000 and not group- or world-readable.

Pulls merge rather than rebase. If a merge conflicts, the affected notes get
`<<<<<<<` markers. Fix them in the editor and commit.

## Configuration

Everything is set with environment variables, either in `docker-compose.yml` or in
`.env`. Put secrets such as `MDV_PASSWORD` and tokens in `.env`: it's loaded
automatically and ignored by git.

| Variable | Default | What it does |
|---|---|---|
| `MDV_PASSWORD` | _(unset)_ | Require this password to sign in |
| `MDV_VAULT` | `/vault` | Vault folder |
| `MDV_ADDR` | `:8080` | Listen address |
| `MDV_GIT_NAME` / `MDV_GIT_EMAIL` | `mdv` / `mdv@localhost` | Author for commits made from the app |
| `MDV_GIT_REMOTE` | _(unset)_ | On start, clone this repo into an empty vault, or set it as `origin` if the vault is already a repo |
| `MDV_AUTO_COMMIT` | _(unset)_ | Commit changes on this interval, e.g. `10m` (minimum `1m`) |
| `MDV_AUTO_PUSH` | `false` | Also pull and push after each auto-commit |
| `MDV_ATTACHMENTS` | `attachments` | Folder for pasted files (Obsidian's own setting wins if present) |

**In-app settings** (`Ctrl+,`) belong to the vault. They're saved in
`.mdv/settings.json`, so they follow you to every browser and sync with git. Open
tabs, folder state and sidebar width are remembered per browser.

## Security

> [!WARNING]
> Without `MDV_PASSWORD`, anyone who can reach the port can read and edit your notes.

- Set a password, or publish the port only on localhost (`"127.0.0.1:8080:8080"`).
- If mdv is reachable from outside your network, put it behind HTTPS, for example
  with a reverse proxy such as Caddy or Traefik.
- Keep tokens in `.env`, never in `docker-compose.yml`.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+P` / `Ctrl+O` | Quick switcher (`Shift+Enter` creates a note) |
| `Ctrl+Shift+F` | Search all notes |
| `Ctrl+F` | Find / replace in the note |
| `Ctrl+Shift+E` | Focus the file tree (arrows, `Enter`, `F2` rename, `Del`) |
| `Ctrl+Alt+F` | Filter the file tree |
| `Ctrl+Shift+L` / `Ctrl+Shift+G` | Links panel / Git panel |
| `Ctrl+E` | Toggle reading view |
| `Ctrl+S` | Save (notes also autosave) |
| `Alt+N` | New note |
| `Alt+W` | Close tab |
| `Alt+←` / `Alt+→` | Back / forward |
| `Ctrl+Alt+←/→`, `Alt+1…9` | Switch tabs |
| `Ctrl+B` / `Ctrl+I` / `Ctrl+K` | Bold / italic / link |
| `Ctrl+Shift+H` | Highlight |
| `Ctrl+\` | Toggle sidebar |
| `Alt+M` | Toggle the file map |
| `Alt+B` | Bookmark / unbookmark the current note |
| `Ctrl+,` | Settings |

Clicking a note opens it in the current tab; `Ctrl`+click or middle-click opens a
new tab. In the editor, click a link to follow it (`Ctrl`+click on the line you're
editing).

## Development

Requires Go 1.24+ and Node 22+.

```sh
cd web && npm install && npm run build   # builds into internal/server/dist
cd .. && go test ./...
MDV_VAULT=./vault go run ./cmd/mdv
```

For frontend work, run `npm run dev` in `web/`. Vite proxies `/api` to `:8080`.

| Path | Contents |
|---|---|
| `cmd/mdv` | Entry point and environment config |
| `internal/server` | HTTP API, live updates (server-sent events), embedded frontend |
| `internal/vault` | Safe file access within the vault |
| `internal/index` | Link graph, backlinks and full-text search |
| `internal/gitops` | Git operations via the `git` CLI |
| `internal/auth` | Password sign-in |
| `web/src` | TypeScript frontend (CodeMirror 6, no framework) |
| `branding` | Logo and icon generation scripts |

Ideas for later live in [`plan.md`](plan.md).
