export interface TreeNode {
  name: string;
  path: string;
  dir?: boolean;
  mtime?: number;
  children?: TreeNode[];
}

export interface SearchMatch {
  line: number;
  col: number;
  text: string;
  ranges: [number, number][];
}

export interface SearchResult {
  path: string;
  mtime: number;
  count: number;
  matches?: SearchMatch[];
}

export interface SearchResults {
  files: SearchResult[] | null;
  total: number;
  truncated: boolean;
  error?: string;
}

export interface SearchOptions {
  case?: boolean;
  word?: boolean;
  regex?: boolean;
}

export interface VaultEvent {
  type: "change" | "remove" | "tree";
  path?: string;
  mtime?: number;
}

export interface FileData {
  path: string;
  content: string;
  mtime: number;
}

export class ConflictError extends Error {}

const q = (path: string) => "?path=" + encodeURIComponent(path);

async function check(res: Response): Promise<Response> {
  if (res.status === 409) throw new ConflictError(await res.text());
  if (!res.ok) throw new Error(`${res.status}: ${(await res.text()).trim()}`);
  return res;
}

export const api = {
  async tree(): Promise<TreeNode> {
    return (await check(await fetch("/api/tree"))).json();
  },
  async read(path: string): Promise<FileData> {
    return (await check(await fetch("/api/file" + q(path)))).json();
  },
  async write(path: string, content: string, mtime: number): Promise<number> {
    const res = await fetch("/api/file" + q(path), {
      method: "PUT",
      headers: { "X-Mtime": String(mtime) },
      body: content,
    });
    return (await (await check(res)).json()).mtime;
  },
  async create(path: string): Promise<void> {
    await check(await fetch("/api/file" + q(path), { method: "POST" }));
  },
  async mkdir(path: string): Promise<void> {
    await check(await fetch("/api/folder" + q(path), { method: "POST" }));
  },
  async remove(path: string): Promise<void> {
    await check(await fetch("/api/file" + q(path), { method: "DELETE" }));
  },
  async search(q: string, opts: SearchOptions, signal?: AbortSignal): Promise<SearchResults> {
    const p = new URLSearchParams({ q });
    if (opts.case) p.set("case", "1");
    if (opts.word) p.set("word", "1");
    if (opts.regex) p.set("regex", "1");
    return (await check(await fetch("/api/search?" + p, { signal }))).json();
  },
  /** Rename/move; returns how many notes had links rewritten. */
  async move(from: string, to: string): Promise<number> {
    const res = await check(
      await fetch("/api/move", { method: "POST", body: JSON.stringify({ from, to }) }),
    );
    return (await res.json()).updated ?? 0;
  },
  /** Store a pasted/dropped file for a note; returns its vault path. */
  async upload(note: string, file: Blob, name: string): Promise<string> {
    const p = new URLSearchParams({ note, name });
    const res = await check(await fetch("/api/upload?" + p, { method: "POST", body: file }));
    return (await res.json()).path;
  },
  async links(path: string): Promise<LinksInfo> {
    return (await check(await fetch("/api/links" + q(path)))).json();
  },
  async config(): Promise<{ auth: boolean }> {
    return (await check(await fetch("/api/config"))).json();
  },
  git: {
    async status(): Promise<GitStatus> {
      return (await check(await fetch("/api/git/status"))).json();
    },
    async run(op: "init" | "commit" | "pull" | "push" | "sync", message = ""): Promise<GitResult> {
      const res = await fetch("/api/git/" + op, { method: "POST", body: JSON.stringify({ message }) });
      return (await check(res)).json();
    },
    async remote(url: string): Promise<GitResult> {
      const res = await fetch("/api/git/remote", { method: "POST", body: JSON.stringify({ url }) });
      return (await check(res)).json();
    },
    async log(path = ""): Promise<GitCommit[]> {
      return (await check(await fetch("/api/git/log" + q(path)))).json();
    },
    async show(rev: string, path: string): Promise<string> {
      const p = new URLSearchParams({ rev, path });
      return (await check(await fetch("/api/git/show?" + p))).text();
    },
  },
};

/** URL for a vault file's raw bytes (images etc.). */
export const rawUrl = (path: string) => "/api/raw" + q(path);

export interface LinkRef {
  path: string;
  target?: string;
  line: number;
  context?: string;
}

export interface LinksInfo {
  backlinks: LinkRef[];
  outgoing: LinkRef[];
  unresolved: LinkRef[];
}

export interface GitStatus {
  repo: boolean;
  branch?: string;
  upstream?: string;
  remote?: string;
  ahead: number;
  behind: number;
  files: { path: string; status: string }[];
  merging?: boolean;
  auto: GitAuto;
}

export interface GitAuto {
  enabled: boolean;
  every?: string; // Go duration, e.g. "10m0s"
  push: boolean;
  lastRun?: number; // unix seconds
  nextRun?: number;
  lastResult?: string;
  lastError?: string;
}

export interface GitResult {
  message: string;
  error?: string;
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  time: number;
  subject: string;
}
