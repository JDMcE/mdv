package index

import (
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

type Query struct {
	Text  string
	Case  bool // case-sensitive
	Regex bool
	Word  bool // whole word
}

type Match struct {
	Line   int      `json:"line"`   // 1-based
	Col    int      `json:"col"`    // UTF-16 offset of the first hit in the full line
	Text   string   `json:"text"`   // the line (trimmed to a window around the hits)
	Ranges [][2]int `json:"ranges"` // byte ranges within Text to highlight
}

type Result struct {
	Path    string  `json:"path"`
	Mtime   int64   `json:"mtime"`
	Count   int     `json:"count"` // total hits in the file
	Matches []Match `json:"matches"`
}

type Results struct {
	Files     []Result `json:"files"`
	Total     int      `json:"total"`
	Truncated bool     `json:"truncated"`
	Error     string   `json:"error,omitempty"`
}

const (
	maxFiles        = 500
	maxLinesPerFile = 30
	maxLinesTotal   = 1500
	snippetWidth    = 160
)

// parse splits the query into path filters and content terms. Terms are
// space-separated (all must appear in a file); "quoted phrases" stay together;
// path:foo restricts to paths containing foo.
func parse(q string) (terms, paths []string) {
	var cur strings.Builder
	inQuote := false
	flush := func() {
		t := cur.String()
		cur.Reset()
		if t == "" {
			return
		}
		if strings.HasPrefix(t, "path:") && len(t) > 5 {
			paths = append(paths, strings.ToLower(t[5:]))
		} else {
			terms = append(terms, t)
		}
	}
	for _, r := range q {
		switch {
		case r == '"':
			inQuote = !inQuote
		case r == ' ' && !inQuote:
			flush()
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return
}

func (ix *Index) Search(q Query) Results {
	var res Results
	var terms, paths []string
	if q.Regex {
		// Allow path: filters before a regex, but keep the regex itself intact.
		rest := q.Text
		for strings.HasPrefix(rest, "path:") {
			sp := strings.IndexByte(rest, ' ')
			if sp < 0 {
				paths = append(paths, strings.ToLower(rest[5:]))
				rest = ""
				break
			}
			paths = append(paths, strings.ToLower(rest[5:sp]))
			rest = strings.TrimLeft(rest[sp:], " ")
		}
		if rest != "" {
			terms = []string{rest}
		}
	} else {
		terms, paths = parse(q.Text)
	}
	if len(terms) == 0 && len(paths) == 0 {
		return res
	}

	// One regexp per term, plus a combined one for highlighting. (?m) makes
	// ^ and $ match at line boundaries, as people expect in a note search.
	flags := "(?m)"
	if !q.Case {
		flags = "(?mi)"
	}
	termRes := make([]*regexp.Regexp, len(terms))
	parts := make([]string, len(terms))
	for i, t := range terms {
		p := t
		if !q.Regex {
			p = regexp.QuoteMeta(t)
		}
		if q.Word {
			p = `\b(?:` + p + `)\b`
		}
		re, err := regexp.Compile(flags + p)
		if err != nil {
			res.Error = strings.TrimPrefix(err.Error(), "error parsing regexp: ")
			return res
		}
		termRes[i] = re
		parts[i] = "(?:" + p + ")"
	}
	var all *regexp.Regexp
	if len(terms) > 0 {
		all = regexp.MustCompile(flags + strings.Join(parts, "|"))
	}
	lowerTerms := make([]string, len(terms))
	for i, t := range terms {
		lowerTerms[i] = strings.ToLower(t)
	}

	type cand struct {
		Result
		name bool    // every term matches the file path
		locs [][]int // hit offsets in the content
		e    *entry
	}
	var cands []cand

	ix.mu.RLock()
	defer ix.mu.RUnlock()

	for path, e := range ix.files {
		lp := strings.ToLower(path)
		ok := true
		for _, pf := range paths {
			if !strings.Contains(lp, pf) {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		c := cand{Result: Result{Path: path, Mtime: e.mtime}, e: e}
		if len(terms) == 0 {
			cands = append(cands, c)
			continue
		}
		stem := strings.TrimSuffix(path, filepath.Ext(path))
		// Every term must appear in the content or the path.
		c.name = true
		for i, t := range terms {
			var inBody, inName bool
			if !q.Regex && !q.Word {
				// Plain substring: no regexp needed.
				if q.Case {
					inBody, inName = strings.Contains(e.content, t), strings.Contains(stem, t)
				} else {
					inBody, inName = strings.Contains(e.lower, lowerTerms[i]), strings.Contains(strings.ToLower(stem), lowerTerms[i])
				}
			} else {
				if !q.Regex && !q.Case && !strings.Contains(e.lower, lowerTerms[i]) {
					inBody = false // cheap reject before the regexp
				} else {
					inBody = termRes[i].MatchString(e.content)
				}
				inName = termRes[i].MatchString(stem)
			}
			if !inName {
				c.name = false
			}
			if !inBody && !inName {
				ok = false
				break
			}
		}
		if !ok {
			continue
		}
		c.locs = all.FindAllStringIndex(e.content, -1)
		c.Count = len(c.locs)
		res.Total += c.Count
		cands = append(cands, c)
	}

	// Name matches first, then most hits, then most recently modified.
	sort.Slice(cands, func(i, j int) bool {
		a, b := cands[i], cands[j]
		if a.name != b.name {
			return a.name
		}
		if a.Count != b.Count {
			return a.Count > b.Count
		}
		if a.Mtime != b.Mtime {
			return a.Mtime > b.Mtime
		}
		return a.Path < b.Path
	})
	if len(cands) > maxFiles {
		cands = cands[:maxFiles]
		res.Truncated = true
	}

	// Build snippets in result order, within an overall budget so a query
	// like "e" doesn't produce megabytes of JSON.
	budget := maxLinesTotal
	res.Files = make([]Result, len(cands))
	for i, c := range cands {
		if budget > 0 && len(c.locs) > 0 {
			c.Matches = lineSnippets(c.e.content, c.locs, min(maxLinesPerFile, budget))
			budget -= len(c.Matches)
		}
		res.Files[i] = c.Result
	}
	return res
}

// lineSnippets groups hit offsets by line and returns up to limit lines.
func lineSnippets(content string, locs [][]int, limit int) []Match {
	var out []Match
	lineNo, lineStart := 1, 0
	for i := 0; i < len(locs) && len(out) < limit; {
		at := locs[i][0]
		lineNo += strings.Count(content[lineStart:at], "\n")
		if nl := strings.LastIndexByte(content[:at], '\n'); nl >= 0 {
			lineStart = nl + 1
		} else {
			lineStart = 0
		}
		lineEnd := len(content)
		if nl := strings.IndexByte(content[at:], '\n'); nl >= 0 {
			lineEnd = at + nl
		}
		// Collect every hit that starts on this line, clamped to it.
		var onLine [][]int
		for ; i < len(locs) && locs[i][0] <= lineEnd; i++ {
			l := []int{locs[i][0] - lineStart, min(locs[i][1], lineEnd) - lineStart}
			if l[1] > l[0] || len(onLine) == 0 {
				onLine = append(onLine, l)
			}
		}
		line := strings.TrimRight(content[lineStart:lineEnd], "\r")
		for _, l := range onLine {
			l[1] = min(l[1], len(line))
			l[0] = min(l[0], l[1])
		}
		out = append(out, snippet(lineNo, line, onLine))
	}
	return out
}

// snippet trims long lines to a window around the first hit.
func snippet(lineNo int, line string, locs [][]int) Match {
	start, end := 0, len(line)
	if len(line) > snippetWidth {
		start = max(0, locs[0][0]-snippetWidth/3)
		end = min(len(line), start+snippetWidth)
		for start > 0 && !utf8.RuneStart(line[start]) {
			start--
		}
		for end < len(line) && !utf8.RuneStart(line[end]) {
			end++
		}
	}
	m := Match{Line: lineNo, Text: line[start:end], Ranges: [][2]int{}}
	for _, l := range locs {
		if l[0] >= start && l[1] <= end && l[1] <= len(line) {
			m.Ranges = append(m.Ranges, [2]int{l[0] - start, l[1] - start})
		}
	}
	if start > 0 {
		m.Text = "…" + m.Text
		for i := range m.Ranges {
			m.Ranges[i][0] += len("…")
			m.Ranges[i][1] += len("…")
		}
	}
	if end < len(line) {
		m.Text += "…"
	}
	// JS strings index by UTF-16 code unit, not byte.
	for i, r := range m.Ranges {
		m.Ranges[i] = [2]int{utf16Len(m.Text[:r[0]]), utf16Len(m.Text[:r[1]])}
	}
	m.Col = utf16Len(line[:locs[0][0]])
	return m
}

func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r >= 0x10000 {
			n += 2
		} else {
			n++
		}
	}
	return n
}
