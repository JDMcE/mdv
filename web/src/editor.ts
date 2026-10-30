import { Compartment, EditorSelection, EditorState, Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  highlightActiveLine,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
  highlightSpecialChars,
  highlightActiveLineGutter,
  lineNumbers,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  Completion,
  CompletionContext,
  completionKeymap,
} from "@codemirror/autocomplete";
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from "@codemirror/language";
import { markdown, markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { classHighlighter, tags as t } from "@lezer/highlight";
import { api } from "./api";
import { findLanguage } from "./codelang";
import { basename, dirname, isImage, isNote, stripMd, vaultFiles } from "./links";
import { LinkHost, linkHandlers, livePreview } from "./livepreview";
import { settings } from "./settings";
import { toast } from "./ui";

// Colours come from CSS variables so themes are pure CSS.
const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, class: "md-h md-h1" },
  { tag: t.heading2, class: "md-h md-h2" },
  { tag: t.heading3, class: "md-h md-h3" },
  { tag: t.heading4, class: "md-h md-h4" },
  { tag: t.heading5, class: "md-h md-h5" },
  { tag: t.heading6, class: "md-h md-h6" },
  { tag: t.strong, class: "md-strong" },
  { tag: t.emphasis, class: "md-em" },
  { tag: t.strikethrough, class: "md-strike" },
  { tag: t.link, class: "md-link" },
  { tag: t.url, class: "md-url" },
  { tag: t.monospace, class: "md-code" },
  { tag: t.quote, class: "md-quote" },
  { tag: t.processingInstruction, class: "md-mark" },
  { tag: t.contentSeparator, class: "md-mark" },
  { tag: t.meta, class: "md-meta" },
  // Function names; everything else in code blocks comes from classHighlighter.
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: "tok-fn" },
]);

export type EditMode = "live" | "source";

export interface EditorHooks {
  onChange: () => void;
  onSave: () => void;
}

/** Per-state slot holding the live-preview extension (empty in source mode). */
export const modeSlot = new Compartment();

export function modeExtension(mode: EditMode, host: LinkHost): Extension {
  return mode === "live" ? livePreview(host) : EditorView.editorAttributes.of({ class: "cm-source" });
}

// ---------- [[ autocomplete ----------

function wikiCompletions(host: LinkHost) {
  return (ctx: CompletionContext) => {
    const m = ctx.matchBefore(/!?\[\[[^\[\]|#\n]*$/);
    if (!m) return null;
    const embed = m.text.startsWith("!");
    const from = m.from + (embed ? 3 : 2);
    const closed = ctx.state.sliceDoc(ctx.pos, ctx.pos + 2) === "]]";
    const current = host.path();
    const options: Completion[] = [];
    for (const p of vaultFiles.paths) {
      if (p === current) continue;
      const note = isNote(p);
      const text = vaultFiles.linkText(p);
      options.push({
        label: note ? stripMd(basename(p)) : basename(p),
        detail: dirname(p),
        // Notes first for links; images first for embeds.
        boost: note === !embed ? 1 : isImage(p) && embed ? 2 : -1,
        apply: (view, _c, a, b) => {
          view.dispatch({
            changes: { from: a, to: closed ? b + 2 : b, insert: text + "]]" },
            selection: { anchor: a + text.length + 2 },
          });
        },
      });
    }
    return { from, options, validFor: /^[^\[\]|#\n]*$/ };
  };
}

// ---------- pasting & dropping files ----------

function timestamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function insertFiles(view: EditorView, files: File[], pos: number, note: string) {
  const parts: string[] = [];
  for (const f of files) {
    // Clipboard images arrive as "image.png"; name them like Obsidian does.
    let name = f.name;
    if (!name || /^image\.\w+$/i.test(name)) {
      const ext = (f.type.split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
      name = `Pasted image ${timestamp()}.${ext}`;
    }
    try {
      const path = await api.upload(note, f, name);
      vaultFiles.update([...vaultFiles.paths, path]); // resolve now, before the tree refreshes
      const link = vaultFiles.linkText(path);
      const embed = isImage(path) || /\.(pdf|mp4|webm|mp3|wav|ogg)$/i.test(path);
      parts.push(embed ? `![[${link}]]` : `[[${link}]]`);
    } catch (e) {
      toast(e);
    }
  }
  if (!parts.length) return;
  const text = parts.join("\n");
  view.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
    userEvent: "input.paste",
  });
}

function fileHandlers(host: LinkHost) {
  return EditorView.domEventHandlers({
    paste(e, view) {
      const files = [...(e.clipboardData?.files ?? [])];
      if (!files.length) return false;
      e.preventDefault();
      insertFiles(view, files, view.state.selection.main.from, host.path());
      return true;
    },
    drop(e, view) {
      const files = [...(e.dataTransfer?.files ?? [])];
      if (!files.length) return false; // text (incl. drags from the tree) uses the default
      e.preventDefault();
      const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
      insertFiles(view, files, pos, host.path());
      return true;
    },
  });
}

// ---------- formatting commands ----------

/** Wrap each selection in `mark`, or unwrap if already wrapped. */
function toggleWrap(mark: string) {
  return (view: EditorView) => {
    const { state } = view;
    const n = mark.length;
    view.dispatch(
      state.changeByRange((r) => {
        const before = state.sliceDoc(r.from - n, r.from);
        const after = state.sliceDoc(r.to, r.to + n);
        if (before === mark && after === mark) {
          return {
            changes: [
              { from: r.from - n, to: r.from },
              { from: r.to, to: r.to + n },
            ],
            range: EditorSelection.range(r.from - n, r.to - n),
          };
        }
        return {
          changes: [
            { from: r.from, insert: mark },
            { from: r.to, insert: mark },
          ],
          range: EditorSelection.range(r.from + n, r.to + n),
        };
      }),
    );
    return true;
  };
}

function insertLink(view: EditorView) {
  view.dispatch(
    view.state.changeByRange((r) => {
      const text = view.state.sliceDoc(r.from, r.to);
      if (/^https?:\/\//.test(text)) {
        return {
          changes: { from: r.from, to: r.to, insert: `[](${text})` },
          range: EditorSelection.cursor(r.from + 1),
        };
      }
      return {
        changes: { from: r.from, to: r.to, insert: `[[${text}]]` },
        range: EditorSelection.cursor(text ? r.from + text.length + 4 : r.from + 2),
      };
    }),
  );
  return true;
}

export function editorExtensions(hooks: EditorHooks, host: LinkHost, mode: EditMode): Extension[] {
  return [
    lineNumbers(), // hidden via CSS when the setting is off
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    EditorView.lineWrapping,
    EditorView.theme({}, { dark: true }),
    // A function, so a settings change applies on the next editor update.
    EditorView.contentAttributes.of(() => {
      const on = settings.get().spellcheck;
      return { spellcheck: on ? "true" : "false", autocorrect: on ? "on" : "off", autocapitalize: "sentences" };
    }),
    // YAML frontmatter is parsed as such, with markdown for the rest.
    yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: findLanguage, addKeymap: false }) }),
    syntaxHighlighting(mdHighlight),
    syntaxHighlighting(classHighlighter),
    modeSlot.of(modeExtension(mode, host)),
    linkHandlers(host),
    fileHandlers(host),
    autocompletion({ override: [wikiCompletions(host)], icons: false }),
    keymap.of([
      { key: "Mod-s", run: () => (hooks.onSave(), true), preventDefault: true },
      { key: "Mod-b", run: toggleWrap("**") },
      { key: "Mod-i", run: toggleWrap("*") },
      { key: "Mod-Shift-x", run: toggleWrap("~~") },
      { key: "Mod-Shift-h", run: toggleWrap("==") },
      { key: "Mod-`", run: toggleWrap("`") },
      { key: "Mod-k", run: insertLink },
      ...completionKeymap,
      ...closeBracketsKeymap,
      ...markdownKeymap, // Enter continues lists, Backspace removes list marks
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) hooks.onChange();
    }),
  ];
}
