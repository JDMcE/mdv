// Fuzzy path matching for the quick switcher. Query characters must appear in
// order; the score rewards hits in the file name, at word starts, and in runs.

export interface FuzzyHit {
  score: number;
  positions: number[]; // indices into the candidate string
}

const isBoundary = (s: string, i: number) => {
  if (i === 0) return true;
  const p = s[i - 1];
  if ("/\\-_ .".includes(p)) return true;
  // camelCase hump
  return p === p.toLowerCase() && s[i] !== s[i].toLowerCase();
};

/** Score one alignment of a token's characters within the candidate. */
function scorePositions(cand: string, positions: number[], nameStart: number): number {
  let score = 0;
  for (let k = 0; k < positions.length; k++) {
    const p = positions[k];
    const run = k > 0 && positions[k - 1] === p - 1;
    score += 1;
    if (isBoundary(cand, p)) score += k === 0 ? 14 : 10; // word starts / acronyms
    else if (run) score += 7; // continuing a run
    else if (k > 0) score -= Math.min(5, p - positions[k - 1] - 1); // gap inside a word
    if (p >= nameStart) score += 5; // in the file name rather than the folder
  }
  if (positions[0] === nameStart) score += 12; // file name prefix
  return score;
}

/** Candidate alignments: every substring hit, plus two subsequence strategies. */
function alignments(token: string, cand: string, lower: string): number[][] {
  const out: number[][] = [];
  for (let i = lower.indexOf(token); i >= 0; i = lower.indexOf(token, i + 1)) {
    out.push(Array.from({ length: token.length }, (_, k) => i + k));
  }
  // Greedy left-to-right, preferring word-start characters (finds acronyms).
  for (const preferBoundary of [true, false]) {
    const pos: number[] = [];
    let ci = 0;
    for (const ch of token) {
      let found = -1;
      if (preferBoundary) {
        for (let j = ci; j < lower.length; j++) {
          if (lower[j] === ch && isBoundary(cand, j)) {
            found = j;
            break;
          }
        }
        // Not at a boundary: continue the current word instead.
        if (found < 0 || (pos.length && lower[ci] === ch)) {
          const j = lower.indexOf(ch, ci);
          if (j >= 0 && (found < 0 || j === ci)) found = j;
        }
      } else {
        found = lower.indexOf(ch, ci);
      }
      if (found < 0) break;
      pos.push(found);
      ci = found + 1;
    }
    if (pos.length === token.length) out.push(pos);
  }
  return out;
}

/** Match one token against a candidate. Returns null if it doesn't match. */
function matchToken(token: string, cand: string, lower: string, nameStart: number): FuzzyHit | null {
  let best: FuzzyHit | null = null;
  for (const positions of alignments(token, cand, lower)) {
    const score = scorePositions(cand, positions, nameStart);
    if (!best || score > best.score) best = { score, positions };
  }
  return best;
}

/** Space-separated tokens must all match. */
export function fuzzy(query: string, cand: string): FuzzyHit | null {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return { score: 0, positions: [] };
  const lower = cand.toLowerCase();
  const nameStart = cand.lastIndexOf("/") + 1;
  let score = 0;
  const pos = new Set<number>();
  for (const t of tokens) {
    const h = matchToken(t, cand, lower, nameStart);
    if (!h) return null;
    score += h.score;
    h.positions.forEach((p) => pos.add(p));
  }
  // Shorter paths are usually what you meant.
  score -= cand.length * 0.2;
  return { score, positions: [...pos].sort((a, b) => a - b) };
}

/** Render text with the given character positions wrapped in <mark>. */
export function highlight(text: string, positions: number[], offset = 0): DocumentFragment {
  const frag = document.createDocumentFragment();
  const set = new Set(positions);
  let run = "";
  let inMark = false;
  const flush = () => {
    if (!run) return;
    if (inMark) {
      const m = document.createElement("mark");
      m.textContent = run;
      frag.append(m);
    } else frag.append(run);
    run = "";
  };
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i + offset);
    if (hit !== inMark) {
      flush();
      inMark = hit;
    }
    run += text[i];
  }
  flush();
  return frag;
}

/** Wrap [start, end) ranges in <mark>. */
export function highlightRanges(text: string, ranges: [number, number][]): DocumentFragment {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const [a, b] of ranges) {
    if (a < at) continue;
    frag.append(text.slice(at, a));
    const m = document.createElement("mark");
    m.textContent = text.slice(a, b);
    frag.append(m);
    at = b;
  }
  frag.append(text.slice(at));
  return frag;
}
