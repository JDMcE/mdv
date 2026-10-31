# mdv

A small, fast, self-hosted markdown notes app inspired by Obsidian. It serves a
web UI over a folder of `.md` files (an Obsidian vault works as-is) and syncs
with git.

- Live-preview editor (syntax hidden away from the cursor), source mode and reading view
- `[[wikilinks]]` with autocomplete, backlinks, and link updating on rename
- Images: paste or drop to upload, `![[image.png|300]]` embeds, image/PDF viewer
- Note embeds: `![[note]]`, `![[note#Heading]]`, `![[note#^block]]`; tables render in live preview
- Bookmarks for notes and folders (synced with the vault), recent searches
- File tree with keyboard navigation, filter, sorting and drag & drop
- Quick switcher (`Ctrl+P`) and full-text vault search (`Ctrl+Shift+F`)
- File map: heading outline and scroll map beside the editor
- Syntax highlighting in ```` ```language ```` code blocks (bash, powershell/ps1, python, sql, yaml, …)
- Git panel: commit, pull, push, sync, per-note history with diffs and restore
- Works on phones: the sidebar becomes a drawer
- Live updates when files change on disk
- Dark-first themes, optional password, installable as an app

## Run it

```sh
docker compose up -d --build
```

Then open <http://localhost:8080>. Notes live in the `vault` Docker volume.

To use an existing folder instead, change the volume in `docker-compose.yml` to
a bind mount such as `./vault:/vault` or `D:/Notes:/vault`.

To use an existing git repo (create a personal token with "contents: read and write"):
```
docker compose exec mdv git clone https://<token>@github.com/<you>/<repo>.git /vault
```

On Docker Desktop for Windows a named volume is stored inside the WSL2 virtual
disk, which keeps notes out of reach of most host antivirus scanning. Note that
Docker Desktop doesn't always forward file-change events from Windows bind
mounts, so edits made outside the app may only appear after a reload.

## Configuration

All settings are environment variables (see `docker-compose.yml`).

| Variable | Default | Meaning |
|---|---|---|
| `MDV_VAULT` | `/vault` | Vault folder |
| `MDV_ADDR` | `:8080` | Listen address |
| `MDV_PASSWORD` | _(unset)_ | Require this password to sign in |
| `MDV_GIT_NAME` / `MDV_GIT_EMAIL` | `mdv` / `mdv@localhost` | Commit author |
| `MDV_GIT_REMOTE` | _(unset)_ | Set `origin` to this URL on start |
| `MDV_AUTO_COMMIT` | _(unset)_ | Commit interval, e.g. `10m` |
| `MDV_AUTO_PUSH` | `false` | Also pull and push on each auto-commit |
| `MDV_ATTACHMENTS` | `attachments` | Folder for pasted files (Obsidian's own setting wins if present) |

Without `MDV_PASSWORD`, anyone who can reach the port can read and edit your
notes. Set a password, or only publish the port on `127.0.0.1`, before exposing
it to other machines. Put it behind HTTPS (e.g. a reverse proxy) if it leaves
your network.

## Settings

Settings (`Ctrl+,`) belong to the vault: they're stored in `.mdv/settings.json`,
so they apply in every browser and sync with git. Open tabs, folder state and
the sidebar width stay per browser.

## Syncing with GitHub

1. Create a private repository.
2. Create a fine-grained token with **Contents: read and write** on that repo.
3. Set `MDV_GIT_REMOTE: https://<your-username>:<token>@github.com/<your-username>/<repo>.git`, or use
   **Git → set remote…** in the app.
4. Open the Git panel, click **Initialize repository** if needed, then **Sync**.

SSH remotes also work if you mount a key into `/home/mdv/.ssh/` (it must be
readable by uid 1000 and not group/world readable).

Pulls merge rather than rebase. If a merge conflicts, the conflicting notes get
`<<<<<<<` markers; fix them in the editor and commit.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+P` / `Ctrl+O` | Quick switcher (`Shift+Enter` creates a note) |
| `Ctrl+Shift+F` | Search all notes |
| `Ctrl+F` | Find / replace in the note |
| `Ctrl+Shift+E` | Focus the file tree (arrows, Enter, F2 rename, Del) |
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
| `Alt+M` | Toggle the file map (outline + scroll map) |
| `Alt+B` | Bookmark / unbookmark the current note |
| `Ctrl+,` | Settings |

Clicking a note opens it in the current tab; `Ctrl`+click or middle-click opens
a new tab. In the editor, links are followed with a click (or `Ctrl`+click on
the line being edited).

## Development

Requires Go 1.24+ and Node 22+.

```sh
cd web && npm install && npm run build   # builds into internal/server/dist
cd .. && go test ./...
MDV_VAULT=./vault go run ./cmd/mdv
```

For frontend work, run `npm run dev` in `web/` (proxies `/api` to `:8080`).
