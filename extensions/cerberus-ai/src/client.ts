import * as vscode from 'vscode';
import { CerberusConfig } from './config';

export interface ChatMessage {
	readonly role: 'system' | 'user' | 'assistant' | 'tool';
	readonly content: string;
	readonly name?: string;
	readonly toolCallId?: string;
}

export interface ChatRequest {
	readonly model: string;
	readonly messages: ReadonlyArray<ChatMessage>;
	readonly temperature?: number;
	readonly topP?: number;
	readonly maxTokens?: number;
	readonly stop?: ReadonlyArray<string>;
}

export interface ChatChunk {
	readonly delta: string;
	readonly finishReason?: string;
}

export class CerberusAuthError extends Error {
	constructor(message = 'Cerberus AI is not signed in. Run "Cerberus AI: Sign In".') {
		super(message);
		this.name = 'CerberusAuthError';
	}
}

export class CerberusHttpError extends Error {
	constructor(
		public readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'CerberusHttpError';
	}
}

/**
 * Thin OpenAI-compatible streaming client. The Cerberus gateway exposes a
 * `/chat/completions` endpoint that mirrors OpenAI's wire format so that
 * any tool already wired for OpenAI works without bespoke glue.
 */
export class CerberusClient {
	constructor(private readonly config: CerberusConfig) { }

	async *streamChat(
		request: ChatRequest,
		token: vscode.CancellationToken,
	): AsyncIterable<ChatChunk> {
		const apiKey = await this.config.getApiKey();
		if (!apiKey) {
			throw new CerberusAuthError();
		}

		const url = `${this.config.apiBaseUrl}/chat/completions`;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
		const cancelSub = token.onCancellationRequested(() => controller.abort());

		try {
			const response = await fetch(url, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/json',
					'Authorization': `Bearer ${apiKey}`,
					'Accept': 'text/event-stream',
					'X-Cerberus-Client': `cerberus-ai-extension/${vscode.version}`,
				},
				body: JSON.stringify({
					model: request.model,
					messages: request.messages.map(m => ({
						role: m.role,
						content: m.content,
						...(m.name ? { name: m.name } : {}),
						...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
					})),
					stream: true,
					temperature: request.temperature,
					top_p: request.topP,
					max_tokens: request.maxTokens,
					stop: request.stop,
				}),
				signal: controller.signal,
			});

			if (response.status === 401 || response.status === 403) {
				throw new CerberusAuthError(`Cerberus AI rejected the API key (HTTP ${response.status}).`);
			}
			if (!response.ok || !response.body) {
				const text = await safeReadText(response);
				throw new CerberusHttpError(response.status, `Cerberus AI request failed: ${response.status} ${response.statusText}. ${text}`);
			}

			yield* parseSseStream(response.body);
		} finally {
			clearTimeout(timeout);
			cancelSub.dispose();
		}
	}

	async countTokens(text: string): Promise<number> {
		// Heuristic until we expose `/tokenize`. Mirrors OpenAI's ~4 chars/token rule.
		// The chat client uses this to warn when the user is approaching context limits.
		if (!text) {
			return 0;
		}
		return Math.ceil(text.length / 4);
	}
}

async function safeReadText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return '';
	}
}

async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<ChatChunk> {
	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8');
	let buffer = '';

	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });

			let separatorIndex: number;
			while ((separatorIndex = buffer.indexOf('\n\n')) !== -1) {
				const rawEvent = buffer.slice(0, separatorIndex);
				buffer = buffer.slice(separatorIndex + 2);
				const chunk = parseSseEvent(rawEvent);
				if (chunk) {
					yield chunk;
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function parseSseEvent(rawEvent: string): ChatChunk | undefined {
	const dataLines = rawEvent
		.split('\n')
		.filter(line => line.startsWith('data:'))
		.map(line => line.slice(5).trimStart());

	if (dataLines.length === 0) {
		return undefined;
	}

	const payload = dataLines.join('\n');
	if (payload === '[DONE]') {
		return { delta: '', finishReason: 'stop' };
	}

	try {
		const json = JSON.parse(payload) as {
			choices?: Array<{
				delta?: { content?: string };
				finish_reason?: string | null;
			}>;
		};
		const choice = json.choices?.[0];
		const delta = choice?.delta?.content ?? '';
		const finishReason = choice?.finish_reason ?? undefined;
		if (!delta && !finishReason) {
			return undefined;
		}
		return { delta, finishReason: finishReason ?? undefined };
	} catch {
		return undefined;
	}
}
