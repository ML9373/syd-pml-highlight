# PML Syntax Highlighting for Obsidian

Colors AVEVA PML/PML2 code blocks (` ```pml `) in Obsidian: Reading mode and Live Preview.

## Coverage

- Comments (`$* ...`)
- Strings (`'...'`, `|...|`)
- Local variables (`!var`) and global variables (`!!var`)
- UDA/attribute references (`:attribute`)
- Keywords (`define`, `method`, `endmethod`, `if/then/endif`, `do/enddo`, `handle any/endhandle`, …)
- Built-in types (`STRING`, `ARRAY`, `REAL`, `DBREF`, …), plus user-defined extra type words (module-specific DB elements)
- Numbers
- Settings tab: toggle Reading mode / Live Preview independently, per-category color overrides

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
