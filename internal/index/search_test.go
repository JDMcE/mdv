package index

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"mdv/internal/vault"
)

func testIndex(t *testing.T, files map[string]string) *Index {
	t.Helper()
	dir := t.TempDir()
	for p, c := range files {
		abs := filepath.Join(dir, filepath.FromSlash(p))
		os.MkdirAll(filepath.Dir(abs), 0o755)
		if err := os.WriteFile(abs, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	v, err := vault.New(dir)
	if err != nil {
		t.Fatal(err)
	}
	return New(v)
}

func paths(r Results) []string {
	var out []string
	for _, f := range r.Files {
		out = append(out, f.Path)
	}
	sort.Strings(out)
	return out
}

func TestSearch(t *testing.T) {
	ix := testIndex(t, map[string]string{
		"a.md":           "Meeting with Bob\nabout the budget",
		"work/b.md":      "meeting notes\nnothing else",
		"work/c.md":      "Bob's birthday",
		"personal/d.md":  "the cat sat on the mat\ncatalogue",
		".obsidian/x.md": "meeting",
		"notes.txt":      "meeting",
		"unicode/e.md":   "😀 café meeting",
	})

	cases := []struct {
		name string
		q    Query
		want []string
	}{
		{"single term, case-insensitive", Query{Text: "meeting"}, []string{"a.md", "unicode/e.md", "work/b.md"}},
		{"all terms must appear", Query{Text: "meeting bob"}, []string{"a.md"}},
		{"case-sensitive", Query{Text: "Meeting", Case: true}, []string{"a.md"}},
		{"quoted phrase", Query{Text: `"with bob"`}, []string{"a.md"}},
		{"path filter", Query{Text: "path:work bob"}, []string{"work/c.md"}},
		{"path filter only", Query{Text: "path:personal"}, []string{"personal/d.md"}},
		{"whole word", Query{Text: "cat", Word: true}, []string{"personal/d.md"}},
		{"regex", Query{Text: `b.dget`, Regex: true}, []string{"a.md"}},
		{"regex with path", Query{Text: `path:work ^meet`, Regex: true}, []string{"work/b.md"}},
		{"no match", Query{Text: "zebra"}, nil},
		{"empty", Query{Text: "  "}, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := paths(ix.Search(c.q))
			if !reflect.DeepEqual(got, c.want) {
				t.Errorf("got %v, want %v", got, c.want)
			}
		})
	}
}

func TestSearchBadRegex(t *testing.T) {
	ix := testIndex(t, map[string]string{"a.md": "x"})
	if r := ix.Search(Query{Text: "(", Regex: true}); r.Error == "" {
		t.Error("expected error for invalid regex")
	}
}

func TestSearchMatchDetails(t *testing.T) {
	ix := testIndex(t, map[string]string{"e.md": "intro\n😀 café cat and cat"})
	r := ix.Search(Query{Text: "cat"})
	if len(r.Files) != 1 || r.Files[0].Count != 2 {
		t.Fatalf("unexpected result %+v", r)
	}
	m := r.Files[0].Matches[0]
	if m.Line != 2 {
		t.Errorf("line = %d, want 2", m.Line)
	}
	// "😀 café " is 2 + 1 + 4 + 1 = 8 UTF-16 code units.
	if m.Col != 8 || m.Ranges[0] != [2]int{8, 11} || m.Ranges[1] != [2]int{16, 19} {
		t.Errorf("col=%d ranges=%v", m.Col, m.Ranges)
	}
}

func TestRefresh(t *testing.T) {
	ix := testIndex(t, map[string]string{"a.md": "old"})
	os.WriteFile(filepath.Join(ix.v.Root, "a.md"), []byte("brand new"), 0o644)
	// Force a different mtime so load() doesn't treat it as unchanged.
	future := filepath.Join(ix.v.Root, "a.md")
	os.Chtimes(future, nowPlus(), nowPlus())
	ix.Refresh("a.md")
	if got := paths(ix.Search(Query{Text: "brand"})); len(got) != 1 {
		t.Errorf("refresh not picked up: %v", got)
	}
	os.Remove(future)
	ix.Refresh("a.md")
	if got := ix.Paths(); len(got) != 0 {
		t.Errorf("removed file still indexed: %v", got)
	}
}

func nowPlus() time.Time { return time.Now().Add(time.Hour) }

func TestSearchNamesAndRanking(t *testing.T) {
	ix := testIndex(t, map[string]string{
		"Kitchen reno/plan.md": "tiles and paint",
		"other.md":             "kitchen kitchen kitchen",
		"kitchen.md":           "nothing here",
	})
	r := ix.Search(Query{Text: "kitchen"})
	got := []string{}
	for _, f := range r.Files {
		got = append(got, f.Path)
	}
	// Both name matches come before the content-only match.
	if len(got) != 3 || got[2] != "other.md" {
		t.Errorf("ranking = %v", got)
	}
	if got := paths(ix.Search(Query{Text: "kitchen tiles"})); !reflect.DeepEqual(got, []string{"Kitchen reno/plan.md"}) {
		t.Errorf("folder + content terms: %v", got)
	}
}

func TestSearchLineNumbers(t *testing.T) {
	ix := testIndex(t, map[string]string{"a.md": "x\r\nfoo foo\r\ny\r\nz foo"})
	f := ix.Search(Query{Text: "foo"}).Files[0]
	if f.Count != 3 || len(f.Matches) != 2 {
		t.Fatalf("count=%d lines=%d", f.Count, len(f.Matches))
	}
	if f.Matches[0].Line != 2 || len(f.Matches[0].Ranges) != 2 || f.Matches[0].Text != "foo foo" {
		t.Errorf("first match %+v", f.Matches[0])
	}
	if f.Matches[1].Line != 4 || f.Matches[1].Col != 2 {
		t.Errorf("second match %+v", f.Matches[1])
	}
}

func TestSearchBudget(t *testing.T) {
	files := map[string]string{}
	body := strings.Repeat("e\n", 100)
	for i := 0; i < 200; i++ {
		files[fmt.Sprintf("n%03d.md", i)] = body
	}
	ix := testIndex(t, files)
	r := ix.Search(Query{Text: "e"})
	lines := 0
	for _, f := range r.Files {
		lines += len(f.Matches)
	}
	if lines > maxLinesTotal || r.Total != 200*100 {
		t.Errorf("lines=%d total=%d", lines, r.Total)
	}
}
