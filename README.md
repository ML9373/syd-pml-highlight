# PML Syntax Highlighting for Obsidian

Colors AVEVA PML/PML2 code blocks (` ```pml `) in Obsidian: Reading mode and Live Preview.

## Coverage (v0.1)

- Comments (`$* ...`)
- Strings (`'...'`, `|...|`)
- Local variables (`!var`) and global variables (`!!var`)
- UDA/attribute references (`:attribute`)
- Keywords (`define`, `method`, `endmethod`, `if/then/endif`, `do/enddo`, `handle any/endhandle`, …)
- Built-in types (`STRING`, `ARRAY`, `REAL`, `DBREF`, …)
- Numbers

Not a language server: no autocompletion, no error diagnostics, no folding awareness of PML blocks. Purely visual coloring.

## Install (local/manual, not published)

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json`, `styles.css` into `<vault>/.obsidian/plugins/syd-pml-highlight/`, then enable "PML Syntax Highlighting" in Obsidian's Community Plugins settings (with Safe Mode allowing local plugins, or via Community Plugins > Installed).

## Dev

```bash
npm install
npm run dev   # esbuild watch mode
```
