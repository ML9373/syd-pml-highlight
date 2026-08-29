import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

interface Token {
	text: string;
	cls: string | null;
}

type TokenKey =
	| "keyword"
	| "type"
	| "string"
	| "comment"
	| "varLocal"
	| "varGlobal"
	| "uda"
	| "number"
	| "operator";

interface TokenColorSetting {
	enabled: boolean;
	color: string;
}

interface PmlSettings {
	enableLivePreview: boolean;
	enableReadingMode: boolean;
	/** Comma/newline-separated extra words to color as PML types (DB element types vary by module: 3D Design vs Unified Engineering). */
	extraTypes: string;
	colors: Record<TokenKey, TokenColorSetting>;
}

/** cls = CSS class already styled (theme-aware) in styles.css; defaultColor = starting swatch value for the picker, not a claim about the live theme's resolved color. */
const TOKEN_META: { key: TokenKey; cls: string; label: string; defaultColor: string }[] = [
	{ key: "keyword", cls: "pml-keyword", label: "Keywords (define, if, do...)", defaultColor: "#a626a4" },
	{ key: "type", cls: "pml-type", label: "Types (STRING, ARRAY, PIPE...)", defaultColor: "#4078f2" },
	{ key: "string", cls: "pml-string", label: "Strings ('...', |...|)", defaultColor: "#50a14f" },
	{ key: "comment", cls: "pml-comment", label: "Comments ($* ...)", defaultColor: "#a0a0a0" },
	{ key: "varLocal", cls: "pml-var-local", label: "Local variables (!var)", defaultColor: "#c18401" },
	{ key: "varGlobal", cls: "pml-var-global", label: "Global variables (!!var)", defaultColor: "#e45649" },
	{ key: "uda", cls: "pml-uda", label: "UDA (:attribute)", defaultColor: "#0184bc" },
	{ key: "number", cls: "pml-number", label: "Numbers", defaultColor: "#c18401" },
	{ key: "operator", cls: "pml-operator", label: "Operators", defaultColor: "#888888" },
];

function defaultColors(): Record<TokenKey, TokenColorSetting> {
	const colors = {} as Record<TokenKey, TokenColorSetting>;
	for (const t of TOKEN_META) colors[t.key] = { enabled: false, color: t.defaultColor };
	return colors;
}

const CLS_TO_KEY: Record<string, TokenKey> = Object.fromEntries(
	TOKEN_META.map((t) => [t.cls, t.key])
) as Record<string, TokenKey>;

/** Inline color for a token's class when the user enabled an override, applied directly on the element/decoration (no injected stylesheet — see Obsidian plugin guidelines). */
function colorOverride(settings: PmlSettings, cls: string | null): string | null {
	if (!cls) return null;
	const key = CLS_TO_KEY[cls];
	if (!key) return null;
	const setting = settings.colors[key];
	return setting.enabled ? setting.color : null;
}

const DEFAULT_SETTINGS: PmlSettings = {
	enableLivePreview: true,
	enableReadingMode: true,
	extraTypes: "PIPE, EQUI, STRU, ZONE, SITE, FUNITE, ENGITE, PBSWLD, COLREL, ATTCOL, EXPCOL, SRCELE, DBVIEW, CRERUL",
	colors: defaultColors(),
};

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

function parseExtraTypes(raw: string): Set<string> {
	return new Set(
		raw.split(/[,\n]/).map((s) => s.trim().toUpperCase()).filter(Boolean)
	);
}

// Order matters: strings, then !!global / !local, then :uda, then numbers, then words, then whitespace/other.
const TOKEN_RE = /'[^']*'|\|[^|]*\||!!\w+|!\w+|:\w+|\b\d+(?:\.\d+)?\b|[A-Za-z_]\w*|\s+|./g;

/**
 * PML has no multi-line strings or block comments (per pml-customization-guide):
 * `$*` starts a line comment, `'...'` / `|...|` are single-line string literals.
 * A per-line tokenizer is therefore sufficient — no cross-line state needed.
 */
export function tokenizePmlLine(line: string, extraTypes: Set<string> = new Set()): Token[] {
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
			} else if (TYPES.has(upper) || extraTypes.has(upper)) {
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
export function renderPmlBlock(source: string, el: HTMLElement, settings: PmlSettings) {
	const pre = el.createEl("pre", { cls: "pml-code-block" });
	const code = pre.createEl("code");
	const lines = source.replace(/\n$/, "").split("\n");
	const extraTypes = settings.enableReadingMode ? parseExtraTypes(settings.extraTypes) : new Set<string>();
	lines.forEach((line, i) => {
		if (!settings.enableReadingMode) {
			code.appendText(line);
		} else {
			for (const tok of tokenizePmlLine(line, extraTypes)) {
				if (tok.cls) {
					const color = colorOverride(settings, tok.cls);
					code.createSpan({
						cls: tok.cls,
						text: tok.text,
						attr: color ? { style: `color: ${color};` } : undefined,
					});
				} else {
					code.appendText(tok.text);
				}
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
function buildPmlDecorations(view: EditorView, settings: PmlSettings): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	if (!settings.enableLivePreview) return builder.finish();

	const extraTypes = parseExtraTypes(settings.extraTypes);
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
		for (const tok of tokenizePmlLine(line.text, extraTypes)) {
			if (tok.cls) {
				const color = colorOverride(settings, tok.cls);
				builder.add(
					pos,
					pos + tok.text.length,
					Decoration.mark({
						class: tok.cls,
						attributes: color ? { style: `color: ${color};` } : undefined,
					})
				);
			}
			pos += tok.text.length;
		}
	}
	return builder.finish();
}

function createPmlViewPlugin(plugin: PmlHighlightPlugin) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = buildPmlDecorations(view, plugin.settings);
			}
			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = buildPmlDecorations(update.view, plugin.settings);
				}
			}
		},
		{ decorations: (v) => v.decorations }
	);
}

class PmlSettingTab extends PluginSettingTab {
	plugin: PmlHighlightPlugin;

	constructor(app: App, plugin: PmlHighlightPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Live Preview highlighting")
			.setDesc("Highlight ```pml blocks while editing (Live Preview).")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableLivePreview).onChange(async (value) => {
					this.plugin.settings.enableLivePreview = value;
					await this.plugin.saveSettings();
					this.app.workspace.updateOptions();
				})
			);

		new Setting(containerEl)
			.setName("Reading mode highlighting")
			.setDesc(
				"Highlight ```pml blocks in Reading mode. A note already open needs to be reopened (or toggled between Reading/Editing) to reflect the change."
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.enableReadingMode).onChange(async (value) => {
					this.plugin.settings.enableReadingMode = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Extra types")
			.setDesc(
				"Words to color as PML types — useful for DB element types specific to your module (3D Design vs Unified Engineering). Comma or newline separated."
			)
			.addTextArea((text) =>
				text
					.setPlaceholder("PIPE, EQUI, STRU, ZONE, SITE, FUNITE, ENGITE...")
					.setValue(this.plugin.settings.extraTypes)
					.onChange(async (value) => {
						this.plugin.settings.extraTypes = value;
						await this.plugin.saveSettings();
						this.app.workspace.updateOptions();
					})
			);

		new Setting(containerEl)
			.setName("Colors")
			.setDesc(
				"Disabled = theme color (default, adapts to light/dark). Enable a color to lock it — Live Preview updates instantly, Reading mode needs the note reopened."
			)
			.setHeading();

		for (const t of TOKEN_META) {
			const setting = new Setting(containerEl).setName(t.label);

			setting.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.colors[t.key].enabled).onChange(async (value) => {
					this.plugin.settings.colors[t.key].enabled = value;
					await this.plugin.saveSettings();
					this.app.workspace.updateOptions();
				})
			);

			setting.addColorPicker((picker) =>
				picker.setValue(this.plugin.settings.colors[t.key].color).onChange(async (value) => {
					this.plugin.settings.colors[t.key].color = value;
					await this.plugin.saveSettings();
					this.app.workspace.updateOptions();
				})
			);
		}

		new Setting(containerEl)
			.setName("Reset colors")
			.setDesc("Revert to theme colors for all categories.")
			.addButton((button) =>
				button.setButtonText("Reset").onClick(async () => {
					this.plugin.settings.colors = defaultColors();
					await this.plugin.saveSettings();
					this.app.workspace.updateOptions();
					this.display();
				})
			);
	}
}

export default class PmlHighlightPlugin extends Plugin {
	settings: PmlSettings;

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new PmlSettingTab(this.app, this));

		this.registerMarkdownCodeBlockProcessor("pml", (source, el) => {
			renderPmlBlock(source, el, this.settings);
		});
		this.registerEditorExtension(createPmlViewPlugin(this));
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<PmlSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		this.settings.colors = Object.assign({}, defaultColors(), loaded?.colors);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
