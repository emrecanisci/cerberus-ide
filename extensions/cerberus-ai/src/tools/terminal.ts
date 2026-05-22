import * as vscode from 'vscode';
import { CerberusTool, ToolResult } from './types';

const MAX_OUTPUT = 16_000;
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run a shell command inside an integrated terminal. We use the
 * undocumented but widely-used `vscode.window.createTerminal({ shellArgs })`
 * combined with a temp file capture so the model gets the output back.
 *
 * NB: this captures stdout via Node's child_process to keep streaming
 * deterministic. The actual user-visible terminal still shows the
 * command for transparency.
 */
export const runTerminalTool: CerberusTool = {
	name: 'run_terminal',
	description: 'Run a shell command in the workspace folder and return its stdout/stderr. 60s timeout by default. Do NOT use for long-running watchers.',
	inputSchema: {
		type: 'object',
		required: ['command'],
		properties: {
			command: { type: 'string' },
			cwd: { type: 'string', description: 'Workspace-relative working directory.' },
			timeout_ms: { type: 'number' },
		},
	},
	async execute(input, ctx): Promise<ToolResult> {
		const cp = await import('child_process');
		const path = await import('path');

		const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!ws) return { ok: false, error: 'Açık workspace yok' };
		const cwd = input.cwd ? path.join(ws, input.cwd) : ws;

		// echo to user terminal too for transparency
		const term = (vscode.window.terminals.find(t => t.name === 'Cerberus Agent')
			?? vscode.window.createTerminal({ name: 'Cerberus Agent', cwd }));
		term.show(true);
		term.sendText(`# agent: ${input.command}`, true);

		const timeoutMs = Math.min(Number(input.timeout_ms) || DEFAULT_TIMEOUT_MS, 5 * 60_000);

		return await new Promise<ToolResult>((resolve) => {
			const child = cp.spawn(input.command, {
				cwd,
				shell: true,
				windowsHide: true,
			});
			let out = '';
			let err = '';
			let done = false;

			const finish = (result: ToolResult) => {
				if (done) return;
				done = true;
				try { child.kill(); } catch { /* noop */ }
				resolve(result);
			};

			const cancelSub = ctx.token.onCancellationRequested(() => finish({ ok: false, error: 'cancelled' }));
			const timer = setTimeout(() => finish({ ok: false, error: `timeout after ${timeoutMs}ms`, }), timeoutMs);

			child.stdout?.on('data', (d) => { out += d.toString(); if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT); });
			child.stderr?.on('data', (d) => { err += d.toString(); if (err.length > MAX_OUTPUT) err = err.slice(0, MAX_OUTPUT); });
			child.on('error', (e) => finish({ ok: false, error: e.message }));
			child.on('close', (code) => {
				clearTimeout(timer);
				cancelSub.dispose();
				const tail = [out && `[stdout]\n${out}`, err && `[stderr]\n${err}`].filter(Boolean).join('\n\n');
				const summary = `exit ${code ?? 0}\n${tail || '(no output)'}`;
				if ((code ?? 1) === 0) {
					finish({ ok: true, output: summary });
				} else {
					finish({ ok: false, error: summary });
				}
			});
		});
	},
};
