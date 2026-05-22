import * as vscode from 'vscode';

const TEXT_DECODER = new TextDecoder('utf-8');
const MAX_FILE_BYTES = 200_000;
const MAX_FOLDER_FILES = 25;
const MAX_WEB_BYTES = 100_000;

/**
 * Resolve @file:..., @folder:..., @web:URL mentions inside a chat input.
 * Returns the input with mentions stripped + a context block to prepend.
 *
 * Example input:
 *   "@file:src/index.ts şu fonksiyonu refactor et"
 * → user prompt becomes:
 *   "[Context]
 *      <file path=\"src/index.ts\">…contents…</file>
 *    [/Context]
 *    şu fonksiyonu refactor et"
 */
export interface ResolvedContext {
	readonly cleanedText: string;
	readonly contextBlock: string | undefined;
	readonly resolvedRefs: ReadonlyArray<{ kind: string; value: string }>;
}

export async function resolveContext(text: string): Promise<ResolvedContext> {
	const re = /@(file|folder|web):(\S+)/g;
	const matches: { kind: string; value: string }[] = [];
	let cleaned = '';
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) {
		cleaned += text.slice(last, m.index);
		matches.push({ kind: m[1], value: m[2] });
		last = m.index + m[0].length;
	}
	cleaned += text.slice(last);
	cleaned = cleaned.trim();

	if (matches.length === 0) {
		return { cleanedText: cleaned, contextBlock: undefined, resolvedRefs: [] };
	}

	const blocks: string[] = [];
	for (const ref of matches) {
		try {
			if (ref.kind === 'file') blocks.push(await resolveFile(ref.value));
			else if (ref.kind === 'folder') blocks.push(await resolveFolder(ref.value));
			else if (ref.kind === 'web') blocks.push(await resolveWeb(ref.value));
		} catch (err: any) {
			blocks.push(`<error ref="${ref.kind}:${ref.value}">${err.message ?? err}</error>`);
		}
	}

	const block = `[Context]\n${blocks.join('\n\n')}\n[/Context]`;
	return { cleanedText: cleaned, contextBlock: block, resolvedRefs: matches };
}

async function resolveFile(relPath: string): Promise<string> {
	const ws = vscode.workspace.workspaceFolders?.[0];
	if (!ws) throw new Error('Workspace yok');
	const uri = vscode.Uri.joinPath(ws.uri, relPath);
	const stat = await vscode.workspace.fs.stat(uri);
	if (stat.size > MAX_FILE_BYTES) {
		return `<file path="${relPath}" truncated="${stat.size}">[file too large; use read_file with start_line/end_line]</file>`;
	}
	const buf = await vscode.workspace.fs.readFile(uri);
	const text = TEXT_DECODER.decode(buf);
	return `<file path="${relPath}">\n${text}\n</file>`;
}

async function resolveFolder(relPath: string): Promise<string> {
	const ws = vscode.workspace.workspaceFolders?.[0];
	if (!ws) throw new Error('Workspace yok');
	const dirUri = vscode.Uri.joinPath(ws.uri, relPath);
	const entries = await vscode.workspace.fs.readDirectory(dirUri);
	const files = entries.filter(([_, type]) => type === vscode.FileType.File).slice(0, MAX_FOLDER_FILES);
	const list = entries
		.sort((a, b) => a[0].localeCompare(b[0]))
		.map(([name, type]) => `${type === vscode.FileType.Directory ? 'd' : '-'} ${name}`)
		.join('\n');
	const headers: string[] = [`<folder path="${relPath}">`, list];
	for (const [name] of files) {
		try {
			const uri = vscode.Uri.joinPath(dirUri, name);
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > MAX_FILE_BYTES) continue;
			const buf = await vscode.workspace.fs.readFile(uri);
			const text = TEXT_DECODER.decode(buf);
			headers.push(`\n<file path="${relPath}/${name}">\n${text}\n</file>`);
		} catch { /* skip */ }
	}
	headers.push('</folder>');
	return headers.join('\n');
}

async function resolveWeb(url: string): Promise<string> {
	if (!/^https?:\/\//i.test(url)) throw new Error('https/http URL bekleniyor');
	const r = await fetch(url, { headers: { 'User-Agent': 'Cerberus IDE Context Fetcher' } });
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	let text = await r.text();
	// crude HTML strip; do not pretend to be a full parser
	text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
		.replace(/<style[\s\S]*?<\/style>/gi, '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (text.length > MAX_WEB_BYTES) text = text.slice(0, MAX_WEB_BYTES) + '…[truncated]';
	return `<web url="${url}">\n${text}\n</web>`;
}
