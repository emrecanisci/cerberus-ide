import * as vscode from 'vscode';

/**
 * One-shot tool the agent can invoke during a chat run. Each tool
 * exposes an Anthropic-compatible JSON schema so the panel can pass it
 * through to the upstream model without any glue.
 */
export interface CerberusTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
	execute(input: any, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
	readonly token: vscode.CancellationToken;
	readonly progress?: (message: string) => void;
	readonly approveWrite?: (params: ApproveWriteParams) => Promise<boolean>;
}

export interface ApproveWriteParams {
	readonly path: string;
	readonly oldContent: string | null;
	readonly newContent: string;
}

export type ToolResult =
	| { ok: true; output: string; meta?: Record<string, unknown> }
	| { ok: false; error: string };

export class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ToolError';
	}
}
