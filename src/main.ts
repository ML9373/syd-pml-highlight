import { Plugin } from "obsidian";
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

interface Token {
	text: string;
	cls: string | null;
}

const KEYWORDS = new Set([
	"DEFINE", "METHOD", "ENDMETHOD", "OBJECT", "ENDOBJECT", "FUNCTION", "ENDFUNCTION",
	"IF", "THEN", "ELSEIF", "ELSE", "ENDIF", "DO", "ENDDO", "WHILE", "VALUES", "INDICES",
	"FROM", "TO", "HANDLE", "ANY", "ELSEHANDLE", "ENDHANDLE", "SKIP", "BREAK", "EXIT",
	"GOLABEL", "LABEL", "RETURN", "MEMBER", "VAR", "NEW", "IMPORT", "USING", "NAMESPACE",
	"SETUP", "ENDSETUP", "COLLECT", "WITH", "FOR", "ALL", "NOT", "AND", "OR", "IS",
	"LOCAL", "GLOBAL", "DELETE", "CALL", "CALLBACK",
]);

const TYPES = new Set([
	"STRING", "ARRAY", "REAL", "BOOLEAN", "DBREF", "FILE", "COLLECTION", "GADGET",
	"REF", "TEXT", "UDA", "DBWALK", "PMLOBJECT",
]);

// Order matters: strings, then !!global / !local, then :uda, then numbers, then words, then whitespace/other.
const TOKEN_RE = /'[^']*'|\|[^|]*\||!!\w+|!\w+|:\w+|\b\d+(?:\.\d+)?\b|[A-Za-z_]\w*|\s+|./g;

/**
 * PML has no multi-line strings or block comments (per pml-customization-guide):
 * `$*` starts a line comment, `'...'` / `|...|` are single-line string literals.
 * A per-line tokenizer is therefore sufficient — no cross-line state needed.
 */
export function tokenizePmlLine(line: string): Token[] {
	const commentIdx = line.indexOf("$*");
	const code = commentIdx >= 0 ? line.slice(0, commentIdx) : line;
	const comment = commentIdx >= 0 ? line.slice(commentIdx) : "";

	const tokens: Token[] = [];
	let m: RegExpExecArray | null;
	TOKEN_RE.lastIndex = 0;
	while ((m = TOKEN_RE.exec(code))) {
		const t = m[0];
		if (/^\s+$/.test(t)) {
			tokens.push({ text: t, cls: null });
			continue;
		}
		if (t.startsWith("'") || t.startsWith("|")) {
			tokens.push({ text: t, cls: "pml-string" });
			continue;
		}
		if (t.startsWith("!!")) {
			tokens.push({ text: t, cls: "pml-var-global" });
			continue;
		}
		if (t.startsWith("!")) {
			tokens.push({ text: t, cls: "pml-var-local" });
			continue;
		}
		if (t.startsWith(":")) {
			tokens.push({ text: t, cls: "pml-uda" });
			continue;
		}
		if (/^\d/.test(t)) {
			tokens.push({ text: t, cls: "pml-number" });
			continue;
		}
		if (/^[A-Za-z_]/.test(t)) {
			const upper = t.toUpperCase();
			if (KEYWORDS.has(upper)) {
				tokens.push({ text: t, cls: "pml-keyword" });
			} else if (TYPES.has(upper)) {
				tokens.push({ text: t, cls: "pml-type" });
			} else {
				tokens.push({ text: t, cls: null });
			}
			continue;
		}
		tokens.push({ text: t, cls: "pml-operator" });
	}
	if (comment) tokens.push({ text: comment, cls: "pml-comment" });
	return tokens;
}

/** Reading mode: ```pml fenced code block processor. */
export function renderPmlBlock(source: string, el: HTMLElement) {
	const pre = el.createEl("pre", { cls: "pml-code-block" });
	const code = pre.createEl("code");
	const lines = source.replace(/\n$/, "").split("\n");
	lines.forEach((line, i) => {
		for (const tok of tokenizePmlLine(line)) {
			if (tok.cls) {
				code.createSpan({ cls: tok.cls, text: tok.text });
			} else {
				code.appendText(tok.text);
			}
		}
		if (i < lines.length - 1) code.appendText("\n");
	});
}

/**
 * Live Preview: line-scanning decorator for ```pml fenced blocks.
 * Deliberately not a full CodeMirror language/Lezer grammar — Obsidian's live
 * preview only auto-colors fenced languages present in @codemirror/language-data,
 * which PML isn't. Scanning fence markers directly is simpler and predictable,
 * at the cost of code-block-aware folding/indent (acceptable for v0.1 coloring).
 */
function buildPmlDecorations(view: EditorView): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const doc = view.state.doc;
	let inBlock = false;

	for (let i = 1; i <= doc.lines; i++) {
		const line = doc.line(i);
		const trimmed = line.text.trim();

		if (!inBlock) {
			if (/^```+\s*pml\s*$/i.test(trimmed)) inBlock = true;
			continue;
		}
		if (/^```+\s*$/.test(trimmed)) {
			inBlock = false;
			continue;
		}

		let pos = line.from;
		for (const tok of tokenizePmlLine(line.text)) {
			if (tok.cls) {
				builder.add(pos, pos + tok.text.length, Decoration.mark({ class: tok.cls }));
			}
			pos += tok.text.length;
		}
	}
	return builder.finish();
}

const pmlViewPlugin = ViewPlugin.fromClass(
	class {
		decorations: DecorationSet;
		constructor(view: EditorView) {
			this.decorations = buildPmlDecorations(view);
		}
		update(update: ViewUpdate) {
			if (update.docChanged || update.viewportChanged) {
				this.decorations = buildPmlDecorations(update.view);
			}
		}
	},
	{ decorations: (v) => v.decorations }
);

export default class PmlHighlightPlugin extends Plugin {
	async onload() {
		this.registerMarkdownCodeBlockProcessor("pml", (source, el) => {
			renderPmlBlock(source, el);
		});
		this.registerEditorExtension(pmlViewPlugin);
	}
}
