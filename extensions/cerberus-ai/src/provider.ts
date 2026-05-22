import * as vscode from 'vscode';
import { CerberusClient, CerberusAuthError, ChatMessage } from './client';
import { CerberusConfig, CerberusModelDescriptor } from './config';

/**
 * Adapter from VS Code's LanguageModelChatProvider proposed API to the
 * Cerberus chat-completions stream.
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
			vendor: 'cerberus',
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
		options: { mode?: string } | unknown,
		_extensionId: string,
		progress: vscode.Progress<unknown>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const normalized = messages.map(toChatMessage).filter((m): m is ChatMessage => !!m);
		const mode = typeof options === 'object' && options && 'mode' in options
			? String((options as any).mode ?? '') || undefined
			: undefined;

		try {
			for await (const chunk of this.client.streamChat(
				{ model: this.model.id, messages: normalized, mode },
				token,
			)) {
				if (token.isCancellationRequested) return;
				if (chunk.delta) progress.report({ index: 0, part: { value: chunk.delta } } as unknown);
			}
		} catch (err) {
			if (err instanceof CerberusAuthError) void promptForSignIn();
			throw err;
		}
	}

	async provideTokenCount(text: string | unknown): Promise<number> {
		const value = typeof text === 'string' ? text : extractTextFromMessage(text);
		return this.client.countTokens(value);
	}
}

function toChatMessage(raw: unknown): ChatMessage | undefined {
	if (!raw || typeof raw !== 'object') return undefined;
	const m = raw as { role?: unknown; content?: unknown };
	const role = mapRole(m.role);
	if (!role) return undefined;
	return { role, content: extractTextFromMessage(m) };
}

function mapRole(role: unknown): ChatMessage['role'] | undefined {
	if (typeof role === 'string') {
		const lower = role.toLowerCase();
		if (lower === 'system' || lower === 'user' || lower === 'assistant') return lower;
	}
	if (typeof role === 'number') {
		switch (role) {
			case 1: return 'user';
			case 2: return 'assistant';
			case 3: return 'system';
		}
	}
	return undefined;
}

function extractTextFromMessage(message: unknown): string {
	if (!message || typeof message !== 'object') return '';
	const content = (message as { content?: unknown }).content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content.map(part => {
			if (typeof part === 'string') return part;
			if (part && typeof part === 'object' && 'value' in part) {
				const value = (part as { value: unknown }).value;
				return typeof value === 'string' ? value : '';
			}
			return '';
		}).join('');
	}
	return '';
}

async function promptForSignIn(): Promise<void> {
	const action = await vscode.window.showWarningMessage(
		'Cerberus IDE oturumu yok.', 'Giriş yap',
	);
	if (action === 'Giriş yap') {
		await vscode.commands.executeCommand('cerberusAi.signIn');
	}
}
