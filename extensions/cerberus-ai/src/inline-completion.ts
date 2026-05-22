import * as vscode from 'vscode';
import { CerberusClient, ChatMessage } from './client';
import { CerberusConfig } from './config';

const SYSTEM_PROMPT = `You are Cerberus Tab — a fast inline code completion engine.
Return ONLY the missing code that fills the cursor position. No prose, no markdown fences.
Match the file's existing style, indentation and language. If the surrounding context already finishes a thought, return an empty string.`;

const DEBOUNCE_MS = 220;
const MAX_CONTEXT_BEFORE = 4000;
const MAX_CONTEXT_AFTER = 1500;
const MAX_TOKENS = 256;

/**
 * Cursor-Tab style inline completions powered by Cerberus.
 * Each request is short, single-shot, no tools. The user accepts with
 * Tab; reject with Esc or by typing.
 */
export class CerberusInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	private timer?: NodeJS.Timeout;
	private inflight?: vscode.CancellationTokenSource;

	constructor(
		private readonly client: CerberusClient,
		private readonly config: CerberusConfig,
	) { }

	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken,
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		// Disable on huge / non-source docs.
		if (document.lineCount > 5000) return undefined;
		if (!(await this.config.getApiKey())) return undefined;
		if (!this.config.inlineCompletionsEnabled) return undefined;

		// debounce: if VS Code asks again within DEBOUNCE_MS, abort previous.
		this.inflight?.cancel();
		this.inflight = new vscode.CancellationTokenSource();
		const cs = this.inflight;
		token.onCancellationRequested(() => cs.cancel());

		await delay(DEBOUNCE_MS, cs.token);
		if (cs.token.isCancellationRequested) return undefined;

		const before = sliceBefore(document, position, MAX_CONTEXT_BEFORE);
		const after = sliceAfter(document, position, MAX_CONTEXT_AFTER);
		const language = document.languageId;
		const file = vscode.workspace.asRelativePath(document.uri);

		const userPrompt =
			`File: ${file}\nLanguage: ${language}\n\n` +
			'```' + language + '\n' +
			before + '<CURSOR>' + after +
			'\n```\n\n' +
			'Complete from <CURSOR>. Reply with raw code only.';

		const messages: ChatMessage[] = [{ role: 'user', content: userPrompt }];
		const model = this.config.inlineCompletionModel ?? this.config.defaultModelId;

		let buffer = '';
		try {
			for await (const ev of this.client.streamChat({
				model,
				messages,
				maxTokens: MAX_TOKENS,
				temperature: 0.1,
				mode: 'agent',
			}, cs.token)) {
				if (cs.token.isCancellationRequested) return undefined;
				if (ev.kind === 'text') buffer += ev.delta;
				if (ev.kind === 'message_done') break;
				// ignore tool events (we don't pass tools)
			}
		} catch {
			return undefined;
		}

		const insertText = sanitize(buffer, language);
		if (!insertText.trim()) return undefined;

		return [
			new vscode.InlineCompletionItem(insertText, new vscode.Range(position, position)),
		];
	}
}

function sliceBefore(doc: vscode.TextDocument, pos: vscode.Position, max: number): string {
	const start = new vscode.Position(0, 0);
	const text = doc.getText(new vscode.Range(start, pos));
	return text.length > max ? text.slice(text.length - max) : text;
}

function sliceAfter(doc: vscode.TextDocument, pos: vscode.Position, max: number): string {
	const end = doc.lineAt(Math.min(doc.lineCount - 1, pos.line + 200)).range.end;
	const text = doc.getText(new vscode.Range(pos, end));
	return text.length > max ? text.slice(0, max) : text;
}

function sanitize(raw: string, language: string): string {
	let out = raw;
	// strip markdown code fences if model couldn't help itself
	const fence = new RegExp('^\\s*```(?:' + language + ')?\\s*\\n?', 'i');
	out = out.replace(fence, '');
	out = out.replace(/```\s*$/i, '');
	// drop a leading "<CURSOR>" if echoed
	out = out.replace(/^<CURSOR>/, '');
	return out;
}

function delay(ms: number, token: vscode.CancellationToken): Promise<void> {
	return new Promise(resolve => {
		const t = setTimeout(resolve, ms);
		token.onCancellationRequested(() => { clearTimeout(t); resolve(); });
	});
}
