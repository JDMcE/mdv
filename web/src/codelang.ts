// Maps a fenced code block's info string (```bash, ```ps1 …) to a language.

import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";

// Common names that @codemirror/language-data doesn't know as aliases.
const ALIASES: Record<string, string> = {
  ps1: "PowerShell",
  psm1: "PowerShell",
  pwsh: "PowerShell",
  ps: "PowerShell",
  console: "Shell",
  shellsession: "Shell",
  terminal: "Shell",
  fish: "Shell",
  ksh: "Shell",
  py3: "Python",
  python3: "Python",
  ipython: "Python",
  js: "JavaScript",
  ts: "TypeScript",
  yml: "YAML",
  dockerfile: "Dockerfile",
  docker: "Dockerfile",
  conf: "Properties files",
  ini: "Properties files",
  cfg: "Properties files",
  cs: "C#",
  csharp: "C#",
  "c++": "C++",
  golang: "Go",
  rs: "Rust",
  kt: "Kotlin",
  rb: "Ruby",
  md: "Markdown",
};

const cache = new Map<string, LanguageDescription | null>();

export function findLanguage(info: string): LanguageDescription | null {
  const name = info.trim().split(/[\s{,]/)[0].toLowerCase();
  if (!name) return null;
  if (cache.has(name)) return cache.get(name)!;
  const alias = ALIASES[name];
  const found =
    (alias && languages.find((l) => l.name === alias)) ||
    LanguageDescription.matchLanguageName(languages, name, false) ||
    languages.find((l) => l.extensions.includes(name)) ||
    null;
  cache.set(name, found);
  return found;
}
