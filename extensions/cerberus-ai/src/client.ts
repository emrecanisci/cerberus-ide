import * as vscode from 'vscode';
import { CerberusConfig } from './config';

/**
 * Wire format = Anthropic-compatible Messages API as exposed by the
 * Cerberus admin panel at POST /api/ai/chat.
 *
 * Request:
 *   {
 *     model: "claude-sonnet-4-6",
 *     messages: [{ role: 'user'|'assistant', content: string }],
 *     system: string,                // optional, prepended to master_prompt server-side
 *     stream: true,
 *     max_tokens: 4096,
 *     _cerberus_mode: "agent" | "ask" | ...   // optional
 *   }
 */

export interface ChatMessage {
	readonly role: 'system' | 'user' | 'assistant';
	readonly content: string;
}

export interface ChatRequest {
	readonly model: string;
	readonly messages: ReadonlyArray<ChatMessage>;
	readonly mode?: string;
	readonly maxTokens?: number;
	readonly temperature?: number;
}

export interface ChatChunk {
	readonly delta: string;
	readonly finishReason?: string;
}

export class CerberusAuthError extends Error {
	constructor(message = 'Cerberus IDE oturum açık değil. "Cerberus AI: Sign In" çalıştır.') {
		super(message);
		this.name = 'CerberusAuthError';
	}
}

export class CerberusHttpError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message);
		this.name = 'CerberusHttpError';
	}
}

export class CerberusClient {
	constructor(private readonly config: CerberusConfig) { }

	async listModels(): Promise<Array<{ id: string; label: string; family?: string; maxInputTokens?: number; maxOutputTokens?: number }>> {
		const token = await this.config.getApiKey();
		if (!token) throw new CerberusAuthError();
		const url = `${this.config.apiBaseUrl}/api/models`;
		const r = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${token}` } });
		if (r.status === 401 || r.status === 403) throw new CerberusAuthError();
		if (!r.ok) throw new CerberusHttpError(r.status, await safeText(r));
		const json = await r.json() as Array<{
			name: string;
			display_name?: string;
			provider?: string;
			context_window?: number;
		}> | { models?: unknown[]; data?: unknown[] };
		const list = Array.isArray(json) ? json
			: Array.isArray((json as any).models) ? (json as any).models
			: Array.isArray((json as any).data) ? (json as any).data
			: [];
		return list.map((m: any) => ({
			id: String(m.name ?? m.id ?? ''),
			label: String(m.display_name ?? m.label ?? m.name ?? m.id ?? ''),
			family: String(m.provider ?? 'cerberus'),
			maxInputTokens: m.context_window ?? undefined,
			maxOutputTokens: undefined,
		})).filter((m: any) => m.id);
	}

	async *streamChat(req: ChatRequest, token: vscode.CancellationToken): AsyncIterable<ChatChunk> {
		const apiKey = await this.config.getApiKey();
		if (!apiKey) throw new CerberusAuthError();

		const messages: ChatMessage[] = [];
		let system = '';
		for (const m of req.messages) {
			if (m.role === 'system') {
				system = system ? `${system}\n\n${m.content}` : m.content;
			} else {
				messages.push(m);
			}
		}

		const url = `${this.config.apiBaseUrl}/api/ai/chat`;
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
				},
				body: JSON.stringify({
					model: req.model,
					messages,
					system: system || undefined,
					stream: true,
					max_tokens: req.maxTokens ?? 4096,
					temperature: req.temperature,
					_cerberus_mode: req.mode,
				}),
				signal: controller.signal,
			});

			if (response.status === 401 || response.status === 403) {
				throw new CerberusAuthError(`Cerberus IDE anahtarı reddedildi (HTTP ${response.status}).`);
			}
			if (!response.ok || !response.body) {
				throw new CerberusHttpError(response.status, `Cerberus IDE isteği başarısız: ${response.status}. ${await safeText(response)}`);
			}

			yield* parseAnthropicStream(response.body);
		} finally {
			clearTimeout(timeout);
			cancelSub.dispose();
		}
	}

	async countTokens(text: string): Promise<number> {
		if (!text) return 0;
		return Math.ceil(text.length / 4);
	}
}

async function safeText(response: Response): Promise<string> {
	try { return await response.text(); } catch { return ''; }
}

/**
 * Parse Anthropic-flavoured SSE: each event has `event: <type>` and a
 * `data: { ... }` line. We care about `content_block_delta` (text deltas)
 * and `message_stop` (terminal event).
 */
async function* parseAnthropicStream(body: ReadableStream<Uint8Array>): AsyncIterable<ChatChunk> {
	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8');
	let buffer = '';
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let sep: number;
			while ((sep = buffer.indexOf('\n\n')) !== -1) {
				const event = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				const chunk = parseEvent(event);
				if (chunk) yield chunk;
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function parseEvent(raw: string): ChatChunk | undefined {
	let dataLine = '';
	for (const line of raw.split('\n')) {
		if (line.startsWith('data:')) dataLine = line.slice(5).trimStart();
	}
	if (!dataLine) return undefined;
	if (dataLine === '[DONE]') return { delta: '', finishReason: 'stop' };
	try {
		const json = JSON.parse(dataLine) as {
			type?: string;
			delta?: { text?: string; type?: string; stop_reason?: string };
			content_block?: { text?: string };
			message?: { stop_reason?: string };
			error?: { message?: string };
		};

		// Anthropic streaming events
		if (json.type === 'content_block_delta' && json.delta?.text) {
			return { delta: json.delta.text };
		}
		if (json.type === 'message_delta' && json.delta?.stop_reason) {
			return { delta: '', finishReason: json.delta.stop_reason };
		}
		if (json.type === 'message_stop') {
			return { delta: '', finishReason: 'stop' };
		}
		if (json.type === 'error') {
			throw new CerberusHttpError(500, json.error?.message ?? 'upstream error');
		}

		// OpenAI fallback (panel can stream OpenAI when upstream is OpenAI-native)
		const choice = (json as any).choices?.[0];
		if (choice?.delta?.content) {
			return { delta: String(choice.delta.content), finishReason: choice.finish_reason ?? undefined };
		}
		return undefined;
	} catch (err) {
		if (err instanceof CerberusHttpError) throw err;
		return undefined;
	}
}
