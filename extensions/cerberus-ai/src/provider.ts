import * as vscode from 'vscode';
import { CerberusClient, CerberusAuthError, ChatMessage } from './client';
import { CerberusConfig, CerberusModelDescriptor } from './config';

/**
 * Adapter from VS Code's LanguageModelChatProvider proposed API to the
 * Cerberus chat-completions stream.
 *
 * The proposed API surface is still evolving in upstream VS Code. We type
 * against `any` for the provider hook so that the extension keeps building
 * across minor changes in the proposal — it is the responsibility of the
 * `enabledApiProposals` entry in package.json to gate availability.
 */
export class CerberusChatProvider {
	private readonly client: CerberusClient;

	constructor(
		private readonly model: CerberusModelDescriptor,
		private readonly config: CerberusConfig,
	) {
		this.client = new CerberusClient(config);
	}

	get metadata() {
		return {
			vendor: 'aiwebmodel',
			name: this.model.label,
			family: this.model.family,
			version: '1',
			id: this.model.id,
			maxInputTokens: this.model.maxInputTokens ?? 128_000,
			maxOutputTokens: this.model.maxOutputTokens ?? 8_192,
		};
	}

	async provideLanguageModelResponse(
		messages: ReadonlyArray<unknown>,
		_options: unknown,
		_extensionId: string,
		progress: vscode.Progress<unknown>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const normalized = messages.map(toChatMessage).filter((m): m is ChatMessage => !!m);

		try {
			for await (const chunk of this.client.streamChat(
				{ model: this.model.id, messages: normalized },
				token,
			)) {
				if (token.isCancellationRequested) {
					return;
				}
				if (chunk.delta) {
					// LanguageModelTextPart shape: { value: string }. We pass a
					// plain object so the renderer-side proxy can clone it.
					progress.report({ index: 0, part: { value: chunk.delta } } as unknown);
				}
			}
		} catch (err) {
			if (err instanceof CerberusAuthError) {
				void promptForSignIn();
			}
			throw err;
		}
	}

	async provideTokenCount(text: string | unknown): Promise<number> {
		const value = typeof text === 'string'
			? text
			: extractTextFromMessage(text);
		return this.client.countTokens(value);
	}
}

function toChatMessage(raw: unknown): ChatMessage | undefined {
	if (!raw || typeof raw !== 'object') {
		return undefined;
	}
	const m = raw as { role?: unknown; content?: unknown; name?: unknown };
	const role = mapRole(m.role);
	if (!role) {
		return undefined;
	}
	return {
		role,
		content: extractTextFromMessage(m),
		name: typeof m.name === 'string' ? m.name : undefined,
	};
}

function mapRole(role: unknown): ChatMessage['role'] | undefined {
	if (typeof role === 'string') {
		const lower = role.toLowerCase();
		if (lower === 'system' || lower === 'user' || lower === 'assistant' || lower === 'tool') {
			return lower;
		}
	}
	if (typeof role === 'number') {
		// LanguageModelChatMessageRole enum: User=1, Assistant=2, System=3.
		switch (role) {
			case 1: return 'user';
			case 2: return 'assistant';
			case 3: return 'system';
		}
	}
	return undefined;
}

function extractTextFromMessage(message: unknown): string {
	if (!message || typeof message !== 'object') {
		return '';
	}
	const content = (message as { content?: unknown }).content;
	if (typeof content === 'string') {
		return content;
	}
	if (Array.isArray(content)) {
		return content
			.map(part => {
				if (typeof part === 'string') {
					return part;
				}
				if (part && typeof part === 'object' && 'value' in part) {
					const value = (part as { value: unknown }).value;
					return typeof value === 'string' ? value : '';
				}
				return '';
			})
			.join('');
	}
	return '';
}

async function promptForSignIn(): Promise<void> {
	const action = await vscode.window.showWarningMessage(
		'Cerberus AI needs an API key to talk to the gateway.',
		'Sign In',
	);
	if (action === 'Sign In') {
		await vscode.commands.executeCommand('cerberusAi.signIn');
	}
}
