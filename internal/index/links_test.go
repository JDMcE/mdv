package index

import (
	"path"
	"reflect"
	"strings"
	"testing"
)

func TestParseLinks(t *testing.T) {
	s := "See [[Note A]] and [[folder/B#Head|alias]], ![[img.png|300]].\n" +
		"Also [md](sub/C.md#x), ![pic](assets/p%20q.png) and [web](https://x.y).\n" +
		"`[[not a link]]`\n```\n[[nor this]]\n```\n"
	var got []string
	for _, l := range ParseLinks(s) {
		kind := "md"
		if l.Wiki {
			kind = "wiki"
		}
		if l.Embed {
			kind += "!"
		}
		got = append(got, kind+":"+l.Target+"@"+s[l.Start:l.End])
	}
	want := []string{
		"wiki:Note A@Note A",
		"wiki:folder/B@folder/B",
		"wiki!:img.png@img.png",
		"md:sub/C.md@sub/C.md#x",
		"md!:assets/p q.png@assets/p%20q.png",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %q\nwant %q", got, want)
	}
}

func TestResolve(t *testing.T) {
	files := []string{"a.md", "x/a.md", "x/y/b.md", "img.png", "x/img.png", "z/c.md"}
	exists := func(p string) bool {
		for _, f := range files {
			if f == p {
				return true
			}
		}
		return false
	}
	names := map[string][]string{}
	for _, f := range files {
		k := lowerBase(f)
		names[k] = append(names[k], f)
	}
	cases := []struct {
		link Link
		from string
		want string
	}{
		{Link{Target: "a", Wiki: true}, "z/c.md", "a.md"},       // shortest path wins
		{Link{Target: "a", Wiki: true}, "x/y/b.md", "a.md"},     // still shortest
		{Link{Target: "a", Wiki: true}, "x/other.md", "x/a.md"}, // same folder preferred
		{Link{Target: "b", Wiki: true}, "a.md", "x/y/b.md"},
		{Link{Target: "y/b", Wiki: true}, "a.md", "x/y/b.md"}, // partial path
		{Link{Target: "x/a", Wiki: true}, "z/c.md", "x/a.md"},
		{Link{Target: "img.png", Wiki: true}, "z/c.md", "img.png"},
		{Link{Target: "img.png", Wiki: true}, "x/a.md", "x/img.png"},
		{Link{Target: "missing", Wiki: true}, "a.md", ""},
		{Link{Target: "y/b.md"}, "x/a.md", "x/y/b.md"}, // markdown link, relative
		{Link{Target: "../a.md"}, "x/a.md", "a.md"},
		{Link{Target: "z/c.md"}, "x/y/b.md", "z/c.md"}, // vault-absolute fallback
	}
	for _, c := range cases {
		if got := Resolve(c.link, c.from, exists, names); got != c.want {
			t.Errorf("Resolve(%q from %s) = %q, want %q", c.link.Target, c.from, got, c.want)
		}
	}
}

func TestRenameEdits(t *testing.T) {
	ix := testIndex(t, map[string]string{
		"old.md":       "# old",
		"dup/other.md": "x",
		"other.md":     "x",
		"ref.md":       "[[old]] [[old|Alias]] [[old#H]] [md](old.md) ![[pic.png]]",
		"sub/rel.md":   "[up](../old.md) [[other]]",
		"pic.png":      "png",
	})
	edits := ix.RenameEdits(map[string]string{"old.md": "new/renamed.md", "pic.png": "img/pic.png"})
	got := ApplyEdits(ix.files["ref.md"].content, edits["ref.md"])
	want := "[[renamed]] [[renamed|Alias]] [[renamed#H]] [md](new/renamed.md) ![[pic.png]]"
	if got != want {
		t.Errorf("ref.md:\n got %q\nwant %q", got, want)
	}
	got = ApplyEdits(ix.files["sub/rel.md"].content, edits["sub/rel.md"])
	if want := "[up](../new/renamed.md) [[other]]"; got != want {
		t.Errorf("sub/rel.md: got %q want %q", got, want)
	}

	// A note that moves keeps working relative links.
	ix2 := testIndex(t, map[string]string{"a.md": "[b](b.md)", "b.md": ""})
	e2 := ix2.RenameEdits(map[string]string{"a.md": "deep/a.md"})
	if got := ApplyEdits(ix2.files["a.md"].content, e2["a.md"]); got != "[b](../b.md)" {
		t.Errorf("moved note: %q", got)
	}

	// Renaming to a name that already exists elsewhere must use a full path.
	ix3 := testIndex(t, map[string]string{"a.md": "[[b]]", "b.md": "", "x/c.md": ""})
	e3 := ix3.RenameEdits(map[string]string{"b.md": "y/c.md"})
	if got := ApplyEdits(ix3.files["a.md"].content, e3["a.md"]); got != "[[y/c]]" {
		t.Errorf("ambiguous rename: %q", got)
	}
}

func TestLinksInfo(t *testing.T) {
	ix := testIndex(t, map[string]string{
		"a.md": "line one\nlinks to [[b]] and [[nowhere]]",
		"b.md": "back to [[a]]",
		"c.md": "also [[b]]",
	})
	info := ix.Links("b.md")
	if len(info.Backlinks) != 2 || info.Backlinks[0].Path != "a.md" || info.Backlinks[0].Line != 2 {
		t.Errorf("backlinks %+v", info.Backlinks)
	}
	if len(info.Outgoing) != 1 || info.Outgoing[0].Path != "a.md" {
		t.Errorf("outgoing %+v", info.Outgoing)
	}
	if u := ix.Links("a.md").Unresolved; len(u) != 1 || u[0].Target != "nowhere" {
		t.Errorf("unresolved %+v", u)
	}
}

func lowerBase(p string) string {
	return strings.ToLower(path.Base(p))
}
