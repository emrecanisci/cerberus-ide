import * as vscode from 'vscode';
import { CerberusConfig } from './config';

/**
 * Wire format = Anthropic-compatible Messages API as exposed by the
 * Cerberus admin panel at POST /api/ai/chat.
 *
 * Tool flow follows Anthropic's spec:
 *   request: { messages, tools, ... }
 *   stream events:
 *     content_block_start { content_block: { type: 'tool_use', id, name, input } }
 *     content_block_delta { delta: { type: 'input_json_delta', partial_json } }
 *     content_block_stop
 *     message_delta   { delta: { stop_reason } }
 *   tool result: send a follow-up message with role 'user' containing
 *     content: [{ type: 'tool_result', tool_use_id, content, is_error }]
 */

export interface MessageContentText { readonly type: 'text'; readonly text: string }
export interface MessageContentToolUse { readonly type: 'tool_use'; readonly id: string; readonly name: string; readonly input: any }
export interface MessageContentToolResult { readonly type: 'tool_result'; readonly tool_use_id: string; readonly content: string; readonly is_error?: boolean }
export type MessageContent = MessageContentText | MessageContentToolUse | MessageContentToolResult;

export interface ChatMessage {
	readonly role: 'system' | 'user' | 'assistant';
	readonly content: string | MessageContent[];
}

export interface ChatTool {
	readonly name: string;
	readonly description: string;
	readonly input_schema: Record<string, unknown>;
}

export interface ChatRequest {
	readonly model: string;
	readonly messages: ReadonlyArray<ChatMessage>;
	readonly mode?: string;
	readonly maxTokens?: number;
	readonly temperature?: number;
	readonly tools?: ReadonlyArray<ChatTool>;
}

export type StreamEvent =
	| { kind: 'text'; delta: string }
	| { kind: 'tool_use_start'; id: string; name: string }
	| { kind: 'tool_use_input_delta'; id: string; partialJson: string }
	| { kind: 'tool_use_complete'; id: string; name: string; input: any }
	| { kind: 'message_done'; stopReason?: string };

export class CerberusAuthError extends Error {
	constructor(message = 'Cerberus IDE oturum açık değil. Önce giriş yap.') {
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
		const r = await fetch(`${this.config.apiBaseUrl}/api/models`, { headers: { 'Authorization': `Bearer ${token}` } });
		if (r.status === 401 || r.status === 403) throw new CerberusAuthError();
		if (!r.ok) throw new CerberusHttpError(r.status, await safeText(r));
		const json = await r.json() as any;
		const list = Array.isArray(json) ? json : json.models ?? json.data ?? [];
		return list.map((m: any) => ({
			id: String(m.name ?? m.id ?? ''),
			label: String(m.display_name ?? m.label ?? m.name ?? m.id ?? ''),
			family: m.provider ?? 'cerberus',
			maxInputTokens: m.context_window ?? undefined,
			maxOutputTokens: undefined,
		})).filter((m: any) => m.id);
	}

	async *streamChat(req: ChatRequest, token: vscode.CancellationToken): AsyncIterable<StreamEvent> {
		const apiKey = await this.config.getApiKey();
		if (!apiKey) throw new CerberusAuthError();

		const messages: ChatMessage[] = [];
		let system = '';
		for (const m of req.messages) {
			if (m.role === 'system') {
				const text = typeof m.content === 'string' ? m.content : extractText(m.content);
				system = system ? `${system}\n\n${text}` : text;
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
					tools: req.tools,
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

function extractText(content: MessageContent[]): string {
	return content.map(c => {
		if (c.type === 'text') return c.text;
		if (c.type === 'tool_result') return c.content;
		return '';
	}).join('\n');
}

async function safeText(response: Response): Promise<string> {
	try { return await response.text(); } catch { return ''; }
}

interface ToolUseInProgress {
	id: string;
	name: string;
	jsonBuf: string;
}

async function* parseAnthropicStream(body: ReadableStream<Uint8Array>): AsyncIterable<StreamEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder('utf-8');
	let buffer = '';
	const tools = new Map<number, ToolUseInProgress>();   // index → in-progress tool_use
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			let sep: number;
			while ((sep = buffer.indexOf('\n\n')) !== -1) {
				const event = buffer.slice(0, sep);
				buffer = buffer.slice(sep + 2);
				yield* handleEvent(event, tools);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

function* handleEvent(raw: string, tools: Map<number, ToolUseInProgress>): IterableIterator<StreamEvent> {
	let dataLine = '';
	for (const line of raw.split('\n')) {
		if (line.startsWith('data:')) dataLine = line.slice(5).trimStart();
	}
	if (!dataLine || dataLine === '[DONE]') {
		if (dataLine === '[DONE]') {
			yield { kind: 'message_done' };
		}
		return;
	}
	let json: any;
	try { json = JSON.parse(dataLine); } catch { return; }

	switch (json.type) {
		case 'content_block_start': {
			const idx = json.index ?? 0;
			const block = json.content_block;
			if (block?.type === 'tool_use') {
				tools.set(idx, { id: block.id, name: block.name, jsonBuf: '' });
				yield { kind: 'tool_use_start', id: block.id, name: block.name };
			}
			return;
		}
		case 'content_block_delta': {
			const idx = json.index ?? 0;
			const delta = json.delta;
			if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
				yield { kind: 'text', delta: delta.text };
				return;
			}
			if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
				const tool = tools.get(idx);
				if (tool) {
					tool.jsonBuf += delta.partial_json;
					yield { kind: 'tool_use_input_delta', id: tool.id, partialJson: delta.partial_json };
				}
				return;
			}
			return;
		}
		case 'content_block_stop': {
			const idx = json.index ?? 0;
			const tool = tools.get(idx);
			if (tool) {
				let parsed: any = {};
				try { parsed = tool.jsonBuf ? JSON.parse(tool.jsonBuf) : {}; }
				catch { parsed = { __raw: tool.jsonBuf }; }
				yield { kind: 'tool_use_complete', id: tool.id, name: tool.name, input: parsed };
				tools.delete(idx);
			}
			return;
		}
		case 'message_delta': {
			const stop = json.delta?.stop_reason;
			if (stop) yield { kind: 'message_done', stopReason: stop };
			return;
		}
		case 'message_stop': {
			yield { kind: 'message_done', stopReason: 'stop' };
			return;
		}
		case 'error': {
			throw new CerberusHttpError(500, json?.error?.message ?? 'upstream error');
		}
	}

	// Fallback for OpenAI-style streams (panel can pass through OpenAI native)
	if (Array.isArray(json.choices)) {
		const choice = json.choices[0];
		if (choice?.delta?.content) {
			yield { kind: 'text', delta: String(choice.delta.content) };
		}
		if (choice?.finish_reason) {
			yield { kind: 'message_done', stopReason: choice.finish_reason };
		}
	}
}
