import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function getLogger(): vscode.LogOutputChannel {
	if (!channel) {
		channel = vscode.window.createOutputChannel('Cerberus AI', { log: true });
	}
	return channel;
}

export function logError(message: string, err: unknown): void {
	const log = getLogger();
	const detail = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ''}` : String(err);
	log.error(`${message}\n${detail}`);
}

export function logInfo(message: string): void {
	getLogger().info(message);
}
