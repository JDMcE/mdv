package index

import (
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"
)

// Link is a reference from one note to another file.
type Link struct {
	Target string // as written, without #heading or |alias
	Start  int    // byte offsets of the target text within the note
	End    int
	Wiki   bool // [[wikilink]] (vs [text](markdown link))
	Embed  bool // ![[embed]] or ![image](...)
}

var (
	// [[target#heading|alias]] and ![[...]]; target can't contain ] | # ^
	wikiRe = regexp.MustCompile(`(!?)\[\[([^\[\]|#^\n]+)([#^][^\[\]|\n]*)?(\|[^\[\]\n]*)?\]\]`)
	// [text](target) and ![alt](target) — only local targets are kept.
	mdLinkRe = regexp.MustCompile(`(!?)\[[^\]\n]*\]\(\s*<?([^)<>\s]+)>?(?:\s+"[^"]*")?\s*\)`)
	// Fenced code and inline code, whose contents aren't links.
	codeRe = regexp.MustCompile("(?s)```.*?(```|$)|`[^`\n]*`")
)

// ParseLinks finds wikilinks and local markdown links, skipping code.
func ParseLinks(s string) []Link {
	code := codeRe.FindAllStringIndex(s, -1)
	inCode := func(i int) bool {
		for _, c := range code {
			if i >= c[0] && i < c[1] {
				return true
			}
		}
		return false
	}
	var out []Link
	for _, m := range wikiRe.FindAllStringSubmatchIndex(s, -1) {
		if inCode(m[0]) {
			continue
		}
		t := strings.TrimSpace(s[m[4]:m[5]])
		if t == "" {
			continue
		}
		out = append(out, Link{Target: t, Start: m[4], End: m[5], Wiki: true, Embed: m[3] > m[2]})
	}
	for _, m := range mdLinkRe.FindAllStringSubmatchIndex(s, -1) {
		if inCode(m[0]) {
			continue
		}
		raw := s[m[4]:m[5]]
		if strings.Contains(raw, "://") || strings.HasPrefix(raw, "#") || strings.HasPrefix(raw, "mailto:") {
			continue
		}
		t := raw
		if i := strings.IndexByte(t, '#'); i >= 0 {
			t = t[:i]
		}
		if u, err := url.PathUnescape(t); err == nil {
			t = u
		}
		if t == "" {
			continue
		}
		out = append(out, Link{Target: t, Start: m[4], End: m[4] + len(raw), Embed: m[3] > m[2]})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out
}

// Resolve maps a link target to a vault path, following Obsidian's rules:
// markdown links are relative to the note; wikilinks match an exact path or
// else a file name anywhere in the vault, preferring the same folder and then
// the shortest path. exists reports whether a vault path exists; names maps
// lowercased base names to every path with that name.
func Resolve(l Link, from string, exists func(string) bool, names map[string][]string) string {
	t := strings.TrimPrefix(l.Target, "/")
	withExt := func(p string) []string {
		if path.Ext(p) == "" || !strings.Contains(path.Base(p), ".") {
			return []string{p + ".md", p}
		}
		return []string{p, p + ".md"}
	}
	dir := path.Dir(from)
	if !l.Wiki {
		for _, c := range withExt(path.Join(dir, t)) {
			if exists(c) {
				return c
			}
		}
		// Some tools write vault-absolute markdown links.
		for _, c := range withExt(path.Clean(t)) {
			if exists(c) {
				return c
			}
		}
		return ""
	}
	// Relative to the linking note's folder first, then from the vault root.
	for _, base := range []string{path.Join(dir, t), path.Clean(t)} {
		for _, c := range withExt(base) {
			if exists(c) {
				return c
			}
		}
	}
	// Name lookup: [[name]] or a partial path [[folder/name]].
	for _, c := range withExt(t) {
		cands := names[strings.ToLower(path.Base(c))]
		if len(cands) == 0 {
			continue
		}
		var best string
		for _, p := range cands {
			if strings.Contains(t, "/") && !strings.HasSuffix(strings.ToLower(p), strings.ToLower(c)) {
				continue
			}
			if path.Dir(p) == dir {
				return p
			}
			if best == "" || len(p) < len(best) || len(p) == len(best) && p < best {
				best = p
			}
		}
		if best != "" {
			return best
		}
	}
	return ""
}

// linkView is a read-only snapshot used for resolution.
type linkView struct {
	exists func(string) bool
	names  map[string][]string
}

// view builds lookup tables over notes plus the extra (non-note) files.
// Caller must hold ix.mu.
func (ix *Index) view() linkView {
	names := map[string][]string{}
	add := func(p string) {
		k := strings.ToLower(path.Base(p))
		names[k] = append(names[k], p)
	}
	for p := range ix.files {
		add(p)
	}
	for p := range ix.other {
		add(p)
	}
	return linkView{
		exists: func(p string) bool {
			_, a := ix.files[p]
			_, b := ix.other[p]
			return a || b
		},
		names: names,
	}
}

// LinkRef describes one link for the links panel.
type LinkRef struct {
	Path    string `json:"path"`              // the other note
	Target  string `json:"target,omitempty"`  // as written (outgoing, unresolved)
	Line    int    `json:"line"`              // 1-based line in the linking note
	Context string `json:"context,omitempty"` // that line's text
}

type LinksInfo struct {
	Backlinks  []LinkRef `json:"backlinks"`
	Outgoing   []LinkRef `json:"outgoing"`
	Unresolved []LinkRef `json:"unresolved"`
}

// Links returns backlinks to and outgoing links from a note.
func (ix *Index) Links(p string) LinksInfo {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	v := ix.view()
	info := LinksInfo{Backlinks: []LinkRef{}, Outgoing: []LinkRef{}, Unresolved: []LinkRef{}}
	for from, e := range ix.files {
		for _, l := range e.links {
			to := Resolve(l, from, v.exists, v.names)
			if from == p {
				line, ctx := lineAt(e.content, l.Start)
				if to == "" {
					info.Unresolved = append(info.Unresolved, LinkRef{Target: l.Target, Line: line, Context: ctx})
				} else if to != p {
					info.Outgoing = append(info.Outgoing, LinkRef{Path: to, Line: line, Context: ctx})
				}
			} else if to == p {
				line, ctx := lineAt(e.content, l.Start)
				info.Backlinks = append(info.Backlinks, LinkRef{Path: from, Line: line, Context: ctx})
			}
		}
	}
	sort.Slice(info.Backlinks, func(i, j int) bool {
		a, b := info.Backlinks[i], info.Backlinks[j]
		return a.Path < b.Path || a.Path == b.Path && a.Line < b.Line
	})
	return info
}

func lineAt(s string, off int) (int, string) {
	start := strings.LastIndexByte(s[:off], '\n') + 1
	end := strings.IndexByte(s[off:], '\n')
	if end < 0 {
		end = len(s)
	} else {
		end += off
	}
	ctx := strings.TrimSpace(strings.TrimRight(s[start:end], "\r"))
	if len(ctx) > 240 {
		ctx = ctx[:240] + "…"
	}
	return strings.Count(s[:start], "\n") + 1, ctx
}

// Edit is a replacement to apply to one note.
type Edit struct {
	Start, End int
	Text       string
}

// RenameEdits computes the link rewrites needed when files move. moves maps
// old vault paths to new ones. It must be called before the move happens,
// while links still resolve to the old paths.
func (ix *Index) RenameEdits(moves map[string]string) map[string][]Edit {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	v := ix.view()

	// Names after the move, to decide whether a bare [[name]] stays unique.
	after := map[string]int{}
	for p := range v.names {
		after[p] = len(v.names[p])
	}
	for from, to := range moves {
		after[strings.ToLower(path.Base(from))]--
		after[strings.ToLower(path.Base(to))]++
	}

	out := map[string][]Edit{}
	for from, e := range ix.files {
		newFrom := from
		if m, ok := moves[from]; ok {
			newFrom = m
		}
		for _, l := range e.links {
			old := Resolve(l, from, v.exists, v.names)
			to, moved := moves[old]
			if !moved && newFrom == from {
				continue
			}
			if !moved {
				// The linking note itself moved: only relative markdown links break.
				if l.Wiki || old == "" {
					continue
				}
				to = old
			}
			var text string
			if l.Wiki {
				name := strings.TrimSuffix(path.Base(to), ".md")
				if !strings.HasSuffix(to, ".md") {
					name = path.Base(to)
				}
				if !strings.Contains(l.Target, "/") && after[strings.ToLower(path.Base(to))] <= 1 {
					text = name
				} else if strings.HasSuffix(to, ".md") {
					text = strings.TrimSuffix(to, ".md")
				} else {
					text = to
				}
			} else {
				text = relPath(path.Dir(newFrom), to)
				// Keep any #fragment that followed the path.
				raw := e.content[l.Start:l.End]
				if i := strings.IndexByte(raw, '#'); i >= 0 {
					text += raw[i:]
				}
			}
			if e.content[l.Start:l.End] != text {
				out[from] = append(out[from], Edit{Start: l.Start, End: l.End, Text: text})
			}
		}
	}
	return out
}

// relPath returns a URL-escaped relative path from dir to target.
func relPath(dir, target string) string {
	if dir == "." {
		dir = ""
	}
	from := strings.Split(dir, "/")
	if dir == "" {
		from = nil
	}
	to := strings.Split(target, "/")
	i := 0
	for i < len(from) && i < len(to)-1 && from[i] == to[i] {
		i++
	}
	parts := []string{}
	for range from[i:] {
		parts = append(parts, "..")
	}
	parts = append(parts, to[i:]...)
	for k, p := range parts {
		parts[k] = strings.ReplaceAll(url.PathEscape(p), "+", "%2B")
	}
	return strings.Join(parts, "/")
}

// ApplyEdits rewrites s with non-overlapping edits.
func ApplyEdits(s string, edits []Edit) string {
	sort.Slice(edits, func(i, j int) bool { return edits[i].Start < edits[j].Start })
	var b strings.Builder
	at := 0
	for _, e := range edits {
		if e.Start < at {
			continue
		}
		b.WriteString(s[at:e.Start])
		b.WriteString(e.Text)
		at = e.End
	}
	b.WriteString(s[at:])
	return b.String()
}
