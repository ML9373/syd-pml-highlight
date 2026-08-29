# PML Syntax Highlighting for Obsidian

Colors AVEVA PML/PML2 code: ` ```pml ` fenced blocks in notes (Reading mode and Live Preview), and raw `.pml`, `.pmlobj`, `.pmlfnc`, `.pmlfrm`, `.pmlmac`, `.pmlcmd` files opened directly.

## Coverage

- Comments (`$* ...`)
- Strings (`'...'`, `|...|`)
- Local variables (`!var`) and global variables (`!!var`)
- UDA/attribute references (`:attribute`)
- Keywords (`define`, `method`, `endmethod`, `if/then/endif`, `do/enddo`, `handle any/endhandle`, …)
- Built-in types (`STRING`, `ARRAY`, `REAL`, `DBREF`, …), plus user-defined extra type words (module-specific DB elements)
- Numbers
- Raw `.pml`-family files open in their own editable view (line numbers, undo/redo, same highlighting) — no more plain-text fallback for these extensions
- Settings tab: toggle Reading mode / Live Preview / raw-file highlighting independently, per-category color overrides

Not a language server: no autocompletion, no error diagnostics, no folding awareness of PML blocks. Purely visual coloring.

## Install

**From Obsidian** (once approved in the community plugin directory): Settings → Community plugins → Browse → search "PML Syntax Highlighting" → Install → Enable.

**Manual install**:

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/syd-pml-highlight/`, then enable "PML Syntax Highlighting" in Obsidian's Community Plugins settings.

## Dev

```bash
npm install
npm run dev   # esbuild watch mode
```

### Rendering preview

`preview.html` renders the shipped `styles.css` against a JS port of the tokenizer, using Obsidian's documented default theme colors (light + dark), without needing Obsidian open. Useful to catch coloring issues before a real in-app check.

```bash
npm run preview   # serves the repo at http://localhost:4321/preview.html
```

Open the URL, and (optionally) screenshot both panels. The tokenizer in `preview.html` is a manual port of `tokenizePmlLine`/`KEYWORDS`/`TYPES`/`TOKEN_RE` in `src/main.ts` — if you change any of those, update `preview.html` to match, and add new coverage to its `BLOCKS` array. This is a close approximation of Obsidian's real rendering, not a substitute for actually checking inside Obsidian.
