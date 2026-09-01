import { App, Plugin, PluginSettingTab, Setting, SettingDefinitionItem, TextFileView, WorkspaceLeaf } from "obsidian";
import {
	EditorView,
	Decoration,
	DecorationSet,
	ViewPlugin,
	ViewUpdate,
	keymap,
	lineNumbers,
	highlightActiveLine,
} from "@codemirror/view";
import { Compartment, EditorState, RangeSetBuilder, Text } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { foldService, foldGutter, foldKeymap } from "@codemirror/language";

const PML_FILE_VIEW_TYPE = "pml-file-view";
const PML_FILE_EXTENSIONS = ["pml", "pmlobj", "pmlfnc", "pmlfrm", "pmlmac", "pmlcmd"];

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
	/** Highlighting for raw .pml/.pmlobj/.pmlfnc/.pmlfrm/.pmlmac/.pmlcmd files opened directly (not fenced blocks). */
	enableFileHighlighting: boolean;
	/** Code folding for if/do/define/setup form/handle blocks, in fenced blocks and raw files alike. */
	enableFolding: boolean;
	/** Gutter line numbers when editing raw .pml-family files directly (fenced blocks use Obsidian's own editor gutter). */
	showLineNumbers: boolean;
	/** Size (em multiplier) and optional color override for the line-number gutter, raw files only. */
	lineNumberSize: number;
	lineNumberColor: TokenColorSetting;
	/** Size (em multiplier) and optional color override for the fold-arrow gutter, raw files only. */
	foldArrowSize: number;
	foldArrowColor: TokenColorSetting;
	/** Background color override for the gutter band (line numbers + fold arrows). Default blends with the Obsidian theme, overriding CodeMirror's own hardcoded light/dark gutter background. */
	gutterBackgroundColor: TokenColorSetting;
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

const CLS_TO_KEY: Record<string, TokenKey> = {};
for (const t of TOKEN_META) {
	CLS_TO_KEY[t.cls] = t.key;
}

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
	enableFileHighlighting: true,
	enableFolding: true,
	showLineNumbers: true,
	lineNumberSize: 1,
	lineNumberColor: { enabled: false, color: "#888888" },
	foldArrowSize: 1.25,
	foldArrowColor: { enabled: false, color: "#888888" },
	gutterBackgroundColor: { enabled: false, color: "#888888" },
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
 * Live Preview: line-scanning decorator for ```pml fenced blocks (`wholeFile: false`)
 * or for an entire raw .pml-family file opened in its own view (`wholeFile: true`,
 * every line is PML, there's no fence to detect).
 *
 * Deliberately not a full CodeMirror language/Lezer grammar — Obsidian's live
 * preview only auto-colors fenced languages present in @codemirror/language-data,
 * which PML isn't. Scanning fence markers directly is simpler and predictable,
 * at the cost of code-block-aware folding/indent (acceptable for v0.1 coloring).
 */
function buildPmlDecorations(view: EditorView, settings: PmlSettings, wholeFile = false): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	if (!wholeFile && !settings.enableLivePreview) return builder.finish();
	if (wholeFile && !settings.enableFileHighlighting) return builder.finish();

	const extraTypes = parseExtraTypes(settings.extraTypes);
	const doc = view.state.doc;
	let inBlock = wholeFile;

	for (let i = 1; i <= doc.lines; i++) {
		const line = doc.line(i);

		if (!wholeFile) {
			const trimmed = line.text.trim();
			if (!inBlock) {
				if (/^```+\s*pml\s*$/i.test(trimmed)) inBlock = true;
				continue;
			}
			if (/^```+\s*$/.test(trimmed)) {
				inBlock = false;
				continue;
			}
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

function createPmlViewPlugin(plugin: PmlHighlightPlugin, wholeFile = false) {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			constructor(view: EditorView) {
				this.decorations = buildPmlDecorations(view, plugin.settings, wholeFile);
			}
			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = buildPmlDecorations(update.view, plugin.settings, wholeFile);
				}
			}
		},
		{ decorations: (v) => v.decorations }
	);
}

/**
 * Block pairs deliberately scoped to the unambiguous ones: `if/endif`, `do/enddo`,
 * `define method|function|object/end...`, `setup form/endsetup`, `handle/endhandle`.
 * `elseif`/`else`/`elsehandle` are continuations, not openers or closers (excluded by
 * the leading-anchor `^` — they never start with "if"/"handle").
 *
 * `setup command ... exit` and gadget blocks (`view ... exit`, `frame ... exit`) are
 * deliberately NOT folded here: `exit` is a generic terminator shared by several
 * different openers, so matching it correctly would need full construct-tracking —
 * out of scope for this pass, and a wrong fold range is worse than no fold.
 *
 * In practice this also limits `setup form` folding: a form with nested gadget
 * containers (view/frame/container) commonly closes the outer `setup form` with
 * `exit` too, not `endsetup` (confirmed in this repo's own TestHighlighting.pmlfrm
 * fixture) — only `endsetup`-terminated forms fold. `define method`/`function`/`object`
 * inside such a file are unaffected and still fold normally.
 */
const FOLD_OPEN_RE = /^(if|do|define\s+(method|function|object)|setup\s+form|handle)\b/i;
const FOLD_CLOSE_RE = /^(endif|enddo|endmethod|endfunction|endobject|endsetup|endhandle)\b/i;
const FOLD_CLOSE_ANYWHERE_RE = /\b(endif|enddo|endmethod|endfunction|endobject|endsetup|endhandle)\b/i;

function isPmlFenceStart(text: string): boolean {
	return /^```+\s*pml\s*$/i.test(text.trim());
}
function isPmlFenceEnd(text: string): boolean {
	return /^```+\s*$/.test(text.trim());
}

/** Whether `lineNumber` sits inside a ```pml fence, by scanning from the top — mirrors buildPmlDecorations's fence tracking. */
function isInsidePmlFence(doc: Text, lineNumber: number): boolean {
	let inBlock = false;
	for (let i = 1; i < lineNumber; i++) {
		const text = doc.line(i).text;
		if (!inBlock) {
			if (isPmlFenceStart(text)) inBlock = true;
		} else if (isPmlFenceEnd(text)) {
			inBlock = false;
		}
	}
	return inBlock;
}

function createPmlFoldService(plugin: PmlHighlightPlugin, wholeFile: boolean) {
	return foldService.of((state, lineStart) => {
		if (!plugin.settings.enableFolding) return null;
		const startLine = state.doc.lineAt(lineStart);
		if (!wholeFile && !isInsidePmlFence(state.doc, startLine.number)) return null;

		const trimmed = startLine.text.trim();
		if (!FOLD_OPEN_RE.test(trimmed)) return null;
		if (FOLD_CLOSE_ANYWHERE_RE.test(trimmed)) return null; // opener and closer on the same line — nothing to fold

		let depth = 1;
		let line = startLine;
		while (line.number < state.doc.lines) {
			line = state.doc.line(line.number + 1);
			const t = line.text.trim();
			if (!wholeFile && isPmlFenceEnd(t)) return null; // fence ended before a matching closer — malformed, don't fold
			if (FOLD_OPEN_RE.test(t) && !FOLD_CLOSE_ANYWHERE_RE.test(t)) {
				depth++;
			} else if (FOLD_CLOSE_RE.test(t)) {
				depth--;
				if (depth === 0) {
					if (line.number <= startLine.number + 1) return null;
					const prevLine = state.doc.line(line.number - 1);
					return { from: startLine.to, to: prevLine.to };
				}
			}
		}
		return null;
	});
}

/**
 * Editable view for raw .pml/.pmlobj/.pmlfnc/.pmlfrm/.pmlmac/.pmlcmd files opened directly
 * (not embedded in a Markdown note). A minimal CodeMirror 6 editor — history, default
 * keybindings, line numbers — plus the same highlighting decorator used for fenced blocks,
 * run in whole-file mode.
 */
class PmlFileView extends TextFileView {
	private editorView: EditorView | null = null;
	private plugin: PmlHighlightPlugin;
	private lineNumbersCompartment = new Compartment();
	private foldGutterCompartment = new Compartment();

	constructor(leaf: WorkspaceLeaf, plugin: PmlHighlightPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return PML_FILE_VIEW_TYPE;
	}

	getIcon(): string {
		return "file-code";
	}

	/** Sets gutter size/color as CSS custom properties on contentEl — no injected stylesheet, per Obsidian plugin guidelines. */
	private applyGutterStyleVars() {
		const s = this.plugin.settings;
		this.contentEl.style.setProperty("--pml-line-number-size", `${s.lineNumberSize}em`);
		if (s.lineNumberColor.enabled) {
			this.contentEl.style.setProperty("--pml-line-number-color", s.lineNumberColor.color);
		} else {
			this.contentEl.style.removeProperty("--pml-line-number-color");
		}
		this.contentEl.style.setProperty("--pml-fold-arrow-size", `${s.foldArrowSize}em`);
		if (s.foldArrowColor.enabled) {
			this.contentEl.style.setProperty("--pml-fold-arrow-color", s.foldArrowColor.color);
		} else {
			this.contentEl.style.removeProperty("--pml-fold-arrow-color");
		}
		if (s.gutterBackgroundColor.enabled) {
			this.contentEl.style.setProperty("--pml-gutter-background", s.gutterBackgroundColor.color);
		} else {
			this.contentEl.style.removeProperty("--pml-gutter-background");
		}
	}

	/** Re-applies gutter size/color vars and reconfigures the line-number/fold-arrow gutters live, without reopening the file. */
	reconfigureGutters() {
		if (!this.editorView) return;
		this.applyGutterStyleVars();
		this.editorView.dispatch({
			effects: [
				this.lineNumbersCompartment.reconfigure(this.plugin.settings.showLineNumbers ? [lineNumbers()] : []),
				this.foldGutterCompartment.reconfigure(this.plugin.settings.enableFolding ? [foldGutter()] : []),
			],
		});
	}

	async onOpen() {
		this.contentEl.addClass("pml-file-view");
		this.applyGutterStyleVars();
		this.editorView = new EditorView({
			parent: this.contentEl,
			state: EditorState.create({
				doc: this.data,
				extensions: [
					this.lineNumbersCompartment.of(this.plugin.settings.showLineNumbers ? [lineNumbers()] : []),
					this.foldGutterCompartment.of(this.plugin.settings.enableFolding ? [foldGutter()] : []),
					highlightActiveLine(),
					history(),
					keymap.of([...defaultKeymap, ...historyKeymap, ...foldKeymap]),
					createPmlViewPlugin(this.plugin, true),
					createPmlFoldService(this.plugin, true),
					EditorView.lineWrapping,
					EditorView.updateListener.of((update) => {
						if (update.docChanged) this.requestSave();
					}),
					EditorView.theme({
						"&": { height: "100%" },
						".cm-content": { fontFamily: "var(--font-monospace)", fontSize: "var(--font-text-size)" },
						".cm-scroller": { overflow: "auto" },
					}),
				],
			}),
		});
	}

	async onClose() {
		this.editorView?.destroy();
		this.editorView = null;
	}

	getViewData(): string {
		return this.editorView ? this.editorView.state.doc.toString() : this.data;
	}

	setViewData(data: string, _clear: boolean): void {
		if (!this.editorView) return;
		this.editorView.dispatch({
			changes: { from: 0, to: this.editorView.state.doc.length, insert: data },
		});
	}

	clear(): void {
		if (!this.editorView) return;
		this.editorView.dispatch({
			changes: { from: 0, to: this.editorView.state.doc.length, insert: "" },
		});
	}
}

class PmlSettingTab extends PluginSettingTab {
	plugin: PmlHighlightPlugin;

	constructor(app: App, plugin: PmlHighlightPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Live Preview highlighting",
				desc: "Highlight ```pml blocks while editing (Live Preview).",
				render: (setting: Setting) => {
					setting.addToggle((toggle) =>
						toggle.setValue(this.plugin.settings.enableLivePreview).onChange(async (value) => {
							this.plugin.settings.enableLivePreview = value;
							await this.plugin.saveSettings();
							this.app.workspace.updateOptions();
						})
					);
				},
			},
			{
				name: "Reading mode highlighting",
				desc: "Highlight ```pml blocks in Reading mode. A note already open needs to be reopened (or toggled between Reading/Editing) to reflect the change.",
				control: { type: "toggle", key: "enableReadingMode" },
			},
			{
				name: "Raw PML file highlighting",
				desc: "Highlight .pml, .pmlobj, .pmlfnc, .pmlfrm, .pmlmac and .pmlcmd files opened directly (not just fenced blocks in notes). Requires reopening any already-open file to apply.",
				control: { type: "toggle", key: "enableFileHighlighting" },
			},
			{
				name: "Code folding",
				desc: "Fold if/endif, do/enddo, define method|function|object, setup form, and handle/endhandle blocks. Not covered: setup command and gadget blocks, which close with a generic 'exit' shared by several constructs.",
				render: (setting: Setting) => {
					setting.addToggle((toggle) =>
						toggle.setValue(this.plugin.settings.enableFolding).onChange(async (value) => {
							this.plugin.settings.enableFolding = value;
							await this.plugin.saveSettings();
							this.app.workspace.updateOptions();
							this.plugin.refreshFileViews();
						})
					);
				},
			},
			{
				name: "Line numbers (raw PML files)",
				desc: "Show gutter line numbers when editing .pml, .pmlobj, .pmlfnc, .pmlfrm, .pmlmac and .pmlcmd files directly.",
				render: (setting: Setting) => {
					setting.addToggle((toggle) =>
						toggle.setValue(this.plugin.settings.showLineNumbers).onChange(async (value) => {
							this.plugin.settings.showLineNumbers = value;
							await this.plugin.saveSettings();
							this.plugin.refreshFileViews();
						})
					);
				},
			},
			{
				type: "group",
				heading: "Gutter appearance (raw PML files)",
				items: [
					{
						name: "About these settings",
						desc: "Size and color for the line-number and fold-arrow gutter when editing raw .pml-family files.",
					},
					{
						name: "Line number size",
						render: (setting: Setting) => {
							setting.addSlider((slider) =>
								slider
									.setLimits(0.75, 2, 0.05)
									.setValue(this.plugin.settings.lineNumberSize)
									.setDynamicTooltip()
									.onChange(async (value) => {
										this.plugin.settings.lineNumberSize = value;
										await this.plugin.saveSettings();
										this.plugin.refreshFileViews();
									})
							);
						},
					},
					{
						name: "Line number color",
						desc: "Disabled = theme color.",
						render: (setting: Setting) => {
							setting.addToggle((toggle) =>
								toggle.setValue(this.plugin.settings.lineNumberColor.enabled).onChange(async (value) => {
									this.plugin.settings.lineNumberColor.enabled = value;
									await this.plugin.saveSettings();
									this.plugin.refreshFileViews();
								})
							);
							setting.addColorPicker((picker) =>
								picker.setValue(this.plugin.settings.lineNumberColor.color).onChange(async (value) => {
									this.plugin.settings.lineNumberColor.color = value;
									await this.plugin.saveSettings();
									this.plugin.refreshFileViews();
								})
							);
						},
					},
					{
						name: "Fold arrow size",
						render: (setting: Setting) => {
							setting.addSlider((slider) =>
								slider
									.setLimits(0.75, 2, 0.05)
									.setValue(this.plugin.settings.foldArrowSize)
									.setDynamicTooltip()
									.onChange(async (value) => {
										this.plugin.settings.foldArrowSize = value;
										await this.plugin.saveSettings();
										this.plugin.refreshFileViews();
									})
							);
						},
					},
					{
						name: "Fold arrow color",
						desc: "Disabled = theme color.",
						render: (setting: Setting) => {
							setting.addToggle((toggle) =>
								toggle.setValue(this.plugin.settings.foldArrowColor.enabled).onChange(async (value) => {
									this.plugin.settings.foldArrowColor.enabled = value;
									await this.plugin.saveSettings();
									this.plugin.refreshFileViews();
								})
							);
							setting.addColorPicker((picker) =>
								picker.setValue(this.plugin.settings.foldArrowColor.color).onChange(async (value) => {
									this.plugin.settings.foldArrowColor.color = value;
									await this.plugin.saveSettings();
									this.plugin.refreshFileViews();
								})
							);
						},
					},
					{
						name: "Gutter background color",
						desc: "Disabled = blends with the Obsidian theme (default). CodeMirror otherwise hardcodes a light-grey/dark-grey band regardless of your theme.",
						render: (setting: Setting) => {
							setting.addToggle((toggle) =>
								toggle.setValue(this.plugin.settings.gutterBackgroundColor.enabled).onChange(async (value) => {
									this.plugin.settings.gutterBackgroundColor.enabled = value;
									await this.plugin.saveSettings();
									this.plugin.refreshFileViews();
								})
							);
							setting.addColorPicker((picker) =>
								picker.setValue(this.plugin.settings.gutterBackgroundColor.color).onChange(async (value) => {
									this.plugin.settings.gutterBackgroundColor.color = value;
									await this.plugin.saveSettings();
									this.plugin.refreshFileViews();
								})
							);
						},
					},
					{
						name: "Reset gutter appearance",
						desc: "Revert size and color settings above to their defaults.",
						render: (setting: Setting) => {
							setting.addButton((button) =>
								button.setButtonText("Reset").onClick(async () => {
									this.plugin.settings.lineNumberSize = DEFAULT_SETTINGS.lineNumberSize;
									this.plugin.settings.lineNumberColor = { ...DEFAULT_SETTINGS.lineNumberColor };
									this.plugin.settings.foldArrowSize = DEFAULT_SETTINGS.foldArrowSize;
									this.plugin.settings.foldArrowColor = { ...DEFAULT_SETTINGS.foldArrowColor };
									this.plugin.settings.gutterBackgroundColor = { ...DEFAULT_SETTINGS.gutterBackgroundColor };
									await this.plugin.saveSettings();
									this.plugin.refreshFileViews();
									this.update();
								})
							);
						},
					},
				],
			},
			{
				type: "group",
				heading: "Colors",
				items: [
					{
						name: "Theme vs custom colors",
						desc: "Disabled = theme color (default, adapts to light/dark). Enable a color to lock it — Live Preview updates instantly, Reading mode needs the note reopened.",
					},
					...TOKEN_META.map((t) => ({
						name: t.label,
						render: (setting: Setting) => {
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
						},
					})),
					{
						name: "Reset colors",
						desc: "Revert to theme colors for all categories.",
						render: (setting: Setting) => {
							setting.addButton((button) =>
								button.setButtonText("Reset").onClick(async () => {
									this.plugin.settings.colors = defaultColors();
									await this.plugin.saveSettings();
									this.app.workspace.updateOptions();
									this.update();
								})
							);
						},
					},
				],
			},
			{
				name: "Extra types",
				desc: "Words to color as PML types — useful for DB element types specific to your module (3D Design vs Unified Engineering). Comma or newline separated.",
				render: (setting: Setting) => {
					setting.addTextArea((text) =>
						text
							.setPlaceholder("PIPE, EQUI, STRU, ZONE, SITE, FUNITE, ENGITE...")
							.setValue(this.plugin.settings.extraTypes)
							.onChange(async (value) => {
								this.plugin.settings.extraTypes = value;
								await this.plugin.saveSettings();
								this.app.workspace.updateOptions();
							})
					);
				},
			},
		];
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
		this.registerEditorExtension([createPmlViewPlugin(this), createPmlFoldService(this, false)]);

		this.registerView(PML_FILE_VIEW_TYPE, (leaf) => new PmlFileView(leaf, this));
		try {
			this.registerExtensions(PML_FILE_EXTENSIONS, PML_FILE_VIEW_TYPE);
		} catch {
			// Another plugin may already own one of these extensions — the core editor still opens the file.
		}
	}

	async loadSettings() {
		const loaded = (await this.loadData()) as Partial<PmlSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
		this.settings.colors = Object.assign({}, defaultColors(), loaded?.colors);
	}

	/** Applies gutter setting changes to every already-open raw PML file view, no reopen needed. */
	refreshFileViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(PML_FILE_VIEW_TYPE)) {
			if (leaf.view instanceof PmlFileView) leaf.view.reconfigureGutters();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}
