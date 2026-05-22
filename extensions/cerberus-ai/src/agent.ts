import * as vscode from 'vscode';
import { ChatMessage, CerberusClient, MessageContent, MessageContentToolUse } from './client';
import { CerberusModelDescriptor } from './config';
import { ALL_TOOLS, findTool, toolsForGateway } from './tools';
import { ApproveWriteParams } from './tools/types';

export interface AgentEvent {
	readonly kind:
		| 'text'
		| 'tool_call_start'
		| 'tool_call_end'
		| 'turn_done';
	readonly text?: string;
	readonly toolName?: string;
	readonly toolInput?: any;
	readonly toolResult?: { ok: boolean; output?: string; error?: string };
	readonly stopReason?: string;
}

export interface AgentRunOptions {
	readonly model: CerberusModelDescriptor;
	readonly mode?: string;
	readonly maxIterations?: number;
	readonly approveWrite?: (params: ApproveWriteParams) => Promise<boolean>;
	readonly onProgress?: (message: string) => void;
}

/**
 * Cursor-style agent loop:
 * 1. send chat → stream
 * 2. while stream emits tool_use, run the tool, append tool_result
 * 3. if model says it wants more (stop_reason: tool_use), call again
 * 4. stop on stop_reason !== tool_use OR max iterations reached
 */
export class CerberusAgent {
	constructor(
		private readonly client: CerberusClient,
	) { }

	async *run(
		conversation: ChatMessage[],
		opts: AgentRunOptions,
		token: vscode.CancellationToken,
	): AsyncIterable<AgentEvent> {
		const max = opts.maxIterations ?? 12;
		const tools = toolsForGateway();

		for (let iter = 0; iter < max; iter++) {
			if (token.isCancellationRequested) return;

			const assistantBlocks: MessageContent[] = [];
			const toolCalls: { id: string; name: string; input: any }[] = [];
			let stopReason: string | undefined;
			let textBuf = '';

			for await (const ev of this.client.streamChat({
				model: opts.model.id,
				messages: conversation,
				tools,
				mode: opts.mode,
				maxTokens: 4096,
			}, token)) {
				if (ev.kind === 'text') {
					textBuf += ev.delta;
					yield { kind: 'text', text: ev.delta };
				} else if (ev.kind === 'tool_use_complete') {
					if (textBuf) {
						assistantBlocks.push({ type: 'text', text: textBuf });
						textBuf = '';
					}
					assistantBlocks.push({ type: 'tool_use', id: ev.id, name: ev.name, input: ev.input });
					toolCalls.push({ id: ev.id, name: ev.name, input: ev.input });
				} else if (ev.kind === 'message_done') {
					stopReason = ev.stopReason;
				}
			}
			if (textBuf) assistantBlocks.push({ type: 'text', text: textBuf });

			// Persist this assistant turn so the model "remembers" what it
			// produced (text + tool_use blocks) before we feed tool_results.
			conversation.push({ role: 'assistant', content: assistantBlocks });

			if (toolCalls.length === 0) {
				yield { kind: 'turn_done', stopReason };
				return;
			}

			// Execute each tool call sequentially. A real production agent
			// would parallelize side-effect-free reads; we keep it serial
			// so file writes don't race.
			const toolResults: MessageContent[] = [];
			for (const call of toolCalls) {
				yield { kind: 'tool_call_start', toolName: call.name, toolInput: call.input };
				const tool = findTool(call.name);
				if (!tool) {
					toolResults.push({
						type: 'tool_result', tool_use_id: call.id, is_error: true,
						content: `Tool "${call.name}" not registered`,
					});
					yield { kind: 'tool_call_end', toolName: call.name, toolResult: { ok: false, error: 'unknown tool' } };
					continue;
				}
				try {
					const result = await tool.execute(call.input, {
						token,
						progress: opts.onProgress,
						approveWrite: opts.approveWrite,
					});
					if (result.ok) {
						toolResults.push({
							type: 'tool_result', tool_use_id: call.id,
							content: result.output,
						});
						yield { kind: 'tool_call_end', toolName: call.name, toolResult: result };
					} else {
						toolResults.push({
							type: 'tool_result', tool_use_id: call.id, is_error: true,
							content: result.error,
						});
						yield { kind: 'tool_call_end', toolName: call.name, toolResult: result };
					}
				} catch (err: any) {
					const message = err?.message ?? String(err);
					toolResults.push({
						type: 'tool_result', tool_use_id: call.id, is_error: true, content: message,
					});
					yield { kind: 'tool_call_end', toolName: call.name, toolResult: { ok: false, error: message } };
				}
			}

			conversation.push({ role: 'user', content: toolResults });
		}

		yield { kind: 'turn_done', stopReason: 'max_iterations' };
	}
}

export function summarizeToolInput(name: string, input: any): string {
	if (!input || typeof input !== 'object') return name;
	switch (name) {
		case 'read_file':
		case 'write_file':
		case 'edit_file':
		case 'list_directory':
			return `${name}(${input.path ?? '?'})`;
		case 'run_terminal':
			return `run_terminal(${String(input.command ?? '').slice(0, 60)})`;
		case 'search_files':
			return `search_files("${String(input.query ?? '').slice(0, 40)}")`;
		default:
			return name;
	}
}

export function approveDiffViaQuickPick(): NonNullable<AgentRunOptions['approveWrite']> {
	return async (params) => {
		const old = params.oldContent ?? '';
		const next = params.newContent ?? '';
		const oldUri = vscode.Uri.parse(`untitled:${params.path}.old`);
		const newUri = vscode.Uri.parse(`untitled:${params.path}.new`);
		const oldDoc = await vscode.workspace.openTextDocument({ content: old, language: detectLanguage(params.path) });
		const newDoc = await vscode.workspace.openTextDocument({ content: next, language: detectLanguage(params.path) });
		await vscode.commands.executeCommand('vscode.diff', oldDoc.uri, newDoc.uri, `Cerberus diff: ${params.path}`);
		const choice = await vscode.window.showInformationMessage(
			`Cerberus, "${params.path}" dosyasını yazmak istiyor.`,
			{ modal: true },
			'Apply',
			'Cancel',
		);
		return choice === 'Apply';
	};
}

function detectLanguage(filename: string): string {
	const m = filename.match(/\.(\w+)$/);
	if (!m) return 'plaintext';
	const map: Record<string, string> = {
		ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact',
		json: 'json', md: 'markdown', py: 'python', go: 'go', rs: 'rust',
		java: 'java', cs: 'csharp', cpp: 'cpp', c: 'c', html: 'html', css: 'css',
		sh: 'shellscript', yaml: 'yaml', yml: 'yaml', toml: 'toml',
	};
	return map[m[1].toLowerCase()] ?? 'plaintext';
}
