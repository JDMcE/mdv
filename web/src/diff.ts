// Line diff (Myers' O(ND) algorithm) and a unified-diff view for note history.

export type DiffOp = { kind: "same" | "add" | "del"; text: string; a?: number; b?: number };

const splitLines = (s: string) => {
  const l = s.replace(/\r\n?/g, "\n").split("\n");
  if (l.length > 1 && l[l.length - 1] === "") l.pop(); // trailing newline isn't a line
  return l;
};

/** Diff two texts line by line. Line numbers (a: old, b: new) are 1-based. */
export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  // Common prefix and suffix are cheap to strip and usually most of a note.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);

  const out: DiffOp[] = [];
  for (let i = 0; i < pre; i++) out.push({ kind: "same", text: a[i], a: i + 1, b: i + 1 });
  for (const op of myers(am, bm)) {
    out.push({
      ...op,
      a: op.a === undefined ? undefined : op.a + pre + 1,
      b: op.b === undefined ? undefined : op.b + pre + 1,
    });
  }
  for (let i = suf; i > 0; i--) {
    out.push({ kind: "same", text: a[a.length - i], a: a.length - i + 1, b: b.length - i + 1 });
  }
  return out;
}

/** Myers' algorithm with a saved trace for backtracking. a/b in ops are 0-based. */
function myers(a: string[], b: string[]): DiffOp[] {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((text, j) => ({ kind: "add", text, b: j }));
  if (!m) return a.map((text, i) => ({ kind: "del", text, a: i }));
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 4);
  const trace: Int32Array[] = [];
  let done = false;
  for (let d = 0; d <= max && !done; d++) {
    // Only diagonals -d..d matter in round d; keeps memory at O(D²).
    trace.push(v.slice(off - d - 1, off + d + 2));
    if (d > 4000) return [...a.map((text, i): DiffOp => ({ kind: "del", text, a: i })), ...b.map((text, j): DiffOp => ({ kind: "add", text, b: j }))];
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        done = true;
        break;
      }
    }
  }
  // Walk back through the trace.
  const ops: DiffOp[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const vd = trace[d];
    const at = (k: number) => vd[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: "same", text: a[x], a: x, b: y });
    }
    if (d === 0) break;
    if (x === prevX) {
      y--;
      ops.push({ kind: "add", text: b[y], b: y });
    } else {
      x--;
      ops.push({ kind: "del", text: a[x], a: x });
    }
  }
  return ops.reverse();
}

const CONTEXT = 3;

/**
 * Render a unified diff: changed lines with a few lines of context, and
 * collapsed runs of unchanged lines that expand on click.
 */
export function renderDiff(ops: DiffOp[]): HTMLElement {
  const root = document.createElement("div");
  root.className = "diff";
  const adds = ops.filter((o) => o.kind === "add").length;
  const dels = ops.filter((o) => o.kind === "del").length;
  const sum = document.createElement("div");
  sum.className = "diff-summary";
  if (!adds && !dels) {
    sum.textContent = "No differences.";
    root.append(sum);
    return root;
  }
  const plus = document.createElement("span");
  plus.className = "diff-plus";
  plus.textContent = `+${adds}`;
  const minus = document.createElement("span");
  minus.className = "diff-minus";
  minus.textContent = `−${dels}`;
  sum.append(plus, " ", minus, ` line${adds + dels === 1 ? "" : "s"}`);
  root.append(sum);

  const table = document.createElement("div");
  table.className = "diff-lines";
  root.append(table);

  const line = (o: DiffOp) => {
    const row = document.createElement("div");
    row.className = "diff-line diff-" + o.kind;
    const na = document.createElement("span");
    na.className = "diff-ln";
    na.textContent = o.a ? String(o.a) : "";
    const nb = document.createElement("span");
    nb.className = "diff-ln";
    nb.textContent = o.b ? String(o.b) : "";
    const sign = document.createElement("span");
    sign.className = "diff-sign";
    sign.textContent = o.kind === "add" ? "+" : o.kind === "del" ? "−" : "";
    const text = document.createElement("span");
    text.className = "diff-text";
    text.textContent = o.text || " ";
    row.append(na, nb, sign, text);
    return row;
  };

  // Which unchanged lines are near a change.
  const near = new Uint8Array(ops.length);
  ops.forEach((o, i) => {
    if (o.kind === "same") return;
    for (let k = Math.max(0, i - CONTEXT); k <= Math.min(ops.length - 1, i + CONTEXT); k++) near[k] = 1;
  });
  for (let i = 0; i < ops.length; ) {
    if (near[i]) {
      table.append(line(ops[i++]));
      continue;
    }
    let j = i;
    while (j < ops.length && !near[j]) j++;
    const hidden = ops.slice(i, j);
    const fold = document.createElement("button");
    fold.className = "diff-fold";
    fold.textContent = `⋯ ${hidden.length} unchanged line${hidden.length === 1 ? "" : "s"}`;
    fold.onclick = () => fold.replaceWith(...hidden.map(line));
    table.append(fold);
    i = j;
  }
  return root;
}
