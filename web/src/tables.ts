// Markdown table editing: parse a table into cells, change its shape, and
// write it back with the pipes lined up.

import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, Line } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export type Align = "" | "left" | "center" | "right";

export interface Table {
  /** Document range: start of the first line to end of the last. */
  from: number;
  to: number;
  /** Blockquote / indent prefix repeated on every line (e.g. "> "). */
  prefix: string;
  /** Row 0 is the header; the delimiter line isn't a row. */
  rows: string[][];
  aligns: Align[];
}

/** A cell in a table: row 0 is the header, then body rows. */
export interface CellRef {
  row: number;
  col: number;
}

const PREFIX_RE = /^[ \t]*(?:>[ \t]?)*[ \t]*/;
const DELIM_CELL = /^:?-+:?$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let start = 0;
  for (let i = 0; i <= s.length; i++) {
    if (i === s.length || (s[i] === "|" && s[i - 1] !== "\\")) {
      cells.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  return cells;
}

function parseAlign(cell: string): Align {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  return l && r ? "center" : r ? "right" : l ? "left" : "";
}

function isDelimiter(cells: string[]) {
  return cells.length > 0 && cells.every((c) => DELIM_CELL.test(c));
}

/** The table whose lines include `pos`, if any. */
export function tableAt(state: EditorState, pos: number): Table | null {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  let found: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter: (n) => {
      if (found) return false;
      if (n.name === "FencedCode" || n.name === "CodeBlock") return false;
      if (n.name === "Table") {
        found = { from: n.from, to: n.to };
        return false;
      }
    },
  });
  if (!found) return null;
  const { from, to } = found as { from: number; to: number };
  const first = doc.lineAt(from);
  const last = doc.lineAt(to);
  const prefix = PREFIX_RE.exec(first.text)![0];
  const lines: string[] = [];
  for (let n = first.number; n <= last.number; n++) lines.push(doc.line(n).text.slice(prefix.length));
  const delim = splitRow(lines[1] ?? "");
  if (!isDelimiter(delim)) return null;
  const rows = [splitRow(lines[0]), ...lines.slice(2).map(splitRow)];
  const cols = Math.max(delim.length, ...rows.map((r) => r.length));
  for (const r of rows) while (r.length < cols) r.push("");
  const aligns = Array.from({ length: cols }, (_, i) => parseAlign(delim[i] ?? ""));
  return { from: first.from, to: last.to, prefix, rows, aligns };
}

/** Which cell of `t` the document position `pos` is in. */
export function cellAt(state: EditorState, t: Table, pos: number): CellRef & { offset: number } {
  const doc = state.doc;
  const line = doc.lineAt(pos);
  const li = line.number - doc.lineAt(t.from).number;
  // The "| --- |" line counts as the header.
  const row = li < 2 ? 0 : li - 1;
  const text = line.text;
  // Count unescaped pipes before the cursor, skipping a leading one.
  let i = t.prefix.length;
  while (i < text.length && /[ \t]/.test(text[i])) i++;
  let col = 0;
  let cellStart = text[i] === "|" ? i + 1 : i;
  for (let j = cellStart; j < pos - line.from; j++) {
    if (text[j] === "|" && text[j - 1] !== "\\") {
      col++;
      cellStart = j + 1;
    }
  }
  const offset = li === 1 ? 0 : text.slice(cellStart, pos - line.from).trimStart().length;
  return { row, col: Math.min(col, t.aligns.length - 1), offset };
}

function width(s: string) {
  return [...s].length;
}

/** Serialise with aligned pipes; also returns where each cell's text starts. */
export function formatTable(t: Table): { text: string; cellFrom: (row: number, col: number) => number } {
  const cols = t.aligns.length;
  const w = Array.from({ length: cols }, (_, c) => Math.max(3, ...t.rows.map((r) => width(r[c] ?? ""))));
  const starts: number[][] = [];
  const out: string[] = [];
  let pos = 0;
  const pad = (s: string, c: number) => {
    const extra = w[c] - width(s);
    if (t.aligns[c] === "right") return " ".repeat(extra) + s;
    if (t.aligns[c] === "center") return " ".repeat(extra >> 1) + s + " ".repeat(extra - (extra >> 1));
    return s + " ".repeat(extra);
  };
  const emit = (cells: string[], record: boolean) => {
    let line = t.prefix + "|";
    const rowStarts: number[] = [];
    for (let c = 0; c < cols; c++) {
      const s = cells[c] ?? "";
      const padded = record ? pad(s, c) : s;
      rowStarts.push(pos + line.length + 1 + (s ? padded.length - padded.trimStart().length : 0));
      line += " " + padded + " |";
    }
    if (record) starts.push(rowStarts);
    out.push(line);
    pos += line.length + 1;
  };
  emit(t.rows[0], true);
  emit(
    t.aligns.map((a, c) => {
      const dashes = "-".repeat(w[c] - (a === "center" ? 2 : a ? 1 : 0));
      return a === "center" ? ":" + dashes + ":" : a === "left" ? ":" + dashes : a === "right" ? dashes + ":" : dashes;
    }),
    false,
  );
  for (const r of t.rows.slice(1)) emit(r, true);
  return {
    text: out.join("\n"),
    cellFrom: (row, col) => {
      const r = starts[Math.max(0, Math.min(row, starts.length - 1))];
      return r[Math.max(0, Math.min(col, r.length - 1))];
    },
  };
}

/** Replace the table in the document and put the cursor in a cell (or leave it alone). */
export function writeTable(view: EditorView, t: Table, cursor?: CellRef & { offset?: number }) {
  const { text, cellFrom } = formatTable(t);
  let selection: EditorSelection | undefined;
  if (cursor) {
    const at = t.from + cellFrom(cursor.row, cursor.col);
    const len = (t.rows[cursor.row]?.[cursor.col] ?? "").length;
    selection = EditorSelection.single(at + Math.min(cursor.offset ?? len, len));
  }
  view.dispatch({
    changes: { from: t.from, to: t.to, insert: text },
    selection,
    scrollIntoView: !!cursor,
    userEvent: "input.table",
  });
}

// ---------- shape changes ----------

export function insertRow(t: Table, at: number) {
  t.rows.splice(Math.max(1, at), 0, t.aligns.map(() => ""));
}

export function insertCol(t: Table, at: number) {
  for (const r of t.rows) r.splice(at, 0, "");
  t.aligns.splice(at, 0, "");
}

export function deleteRow(t: Table, row: number) {
  if (row > 0) t.rows.splice(row, 1);
}

export function deleteCol(t: Table, col: number) {
  if (t.aligns.length < 2) return;
  for (const r of t.rows) r.splice(col, 1);
  t.aligns.splice(col, 1);
}

export function moveRow(t: Table, row: number, by: number) {
  const to = row + by;
  if (row < 1 || to < 1 || to >= t.rows.length) return false;
  [t.rows[row], t.rows[to]] = [t.rows[to], t.rows[row]];
  return true;
}

export function moveCol(t: Table, col: number, by: number) {
  const to = col + by;
  if (to < 0 || to >= t.aligns.length) return false;
  for (const r of t.rows) [r[col], r[to]] = [r[to], r[col]];
  [t.aligns[col], t.aligns[to]] = [t.aligns[to], t.aligns[col]];
  return true;
}

// ---------- keyboard (when editing a table's source) ----------

function current(view: EditorView) {
  const sel = view.state.selection;
  if (sel.ranges.length > 1 || !sel.main.empty) return null;
  const t = tableAt(view.state, sel.main.head);
  return t ? { t, cell: cellAt(view.state, t, sel.main.head) } : null;
}

/** Tab: next cell, adding a row after the last one. Tidies the table too. */
export function nextCell(view: EditorView): boolean {
  const c = current(view);
  if (!c) return false;
  let { row, col } = c.cell;
  const cols = c.t.aligns.length;
  if (++col >= cols) {
    col = 0;
    if (++row >= c.t.rows.length) insertRow(c.t, row);
  }
  writeTable(view, c.t, { row, col });
  return true;
}

/** Shift-Tab: previous cell. */
export function prevCell(view: EditorView): boolean {
  const c = current(view);
  if (!c) return false;
  let { row, col } = c.cell;
  if (--col < 0) {
    if (row === 0) col = 0;
    else (row--, (col = c.t.aligns.length - 1));
  }
  writeTable(view, c.t, { row, col });
  return true;
}

/**
 * Enter in a table: same column on the next row, adding one at the end. On an
 * empty last row, drop it and leave the table (like ending a list).
 */
export function tableEnter(view: EditorView): boolean {
  const c = current(view);
  if (!c) return startTable(view);
  const { t } = c;
  const { row, col } = c.cell;
  const last = t.rows.length - 1;
  if (row === last && row > 0 && t.rows[row].every((s) => !s)) {
    t.rows.pop();
    const { text } = formatTable(t);
    const after = t.prefix;
    view.dispatch({
      changes: { from: t.from, to: t.to, insert: text + "\n" + after },
      selection: { anchor: t.from + text.length + 1 + after.length },
      scrollIntoView: true,
      userEvent: "input.table",
    });
    return true;
  }
  if (row === last) insertRow(t, row + 1);
  writeTable(view, t, { row: row + 1, col, offset: 0 });
  return true;
}

const HEADER_RE = /^\|(.*[^\s|].*)\|\s*$/;

/**
 * Enter at the end of a lone "| a | b |" line turns it into a table: adds
 * the "| --- |" line and an empty row to type into.
 */
function startTable(view: EditorView): boolean {
  const { state } = view;
  const sel = state.selection;
  if (sel.ranges.length > 1 || !sel.main.empty) return false;
  const line: Line = state.doc.lineAt(sel.main.head);
  if (sel.main.head !== line.to) return false;
  const prefix = PREFIX_RE.exec(line.text)![0];
  const body = line.text.slice(prefix.length);
  if (!HEADER_RE.test(body)) return false;
  const name = syntaxTree(state).resolveInner(line.from + prefix.length, 1).name;
  if (/Code|Frontmatter/.test(name)) return false;
  const header = splitRow(body);
  const t: Table = {
    from: line.from,
    to: line.to,
    prefix,
    rows: [header, header.map(() => "")],
    aligns: header.map(() => "" as Align),
  };
  writeTable(view, t, { row: 1, col: 0 });
  return true;
}
