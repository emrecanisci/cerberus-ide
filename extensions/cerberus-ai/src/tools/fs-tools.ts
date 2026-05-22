import * as vscode from 'vscode';
import * as path from 'path';
import { CerberusTool, ToolContext, ToolError, ToolResult } from './types';

const TEXT_DECODER = new TextDecoder('utf-8');
const TEXT_ENCODER = new TextEncoder();

const MAX_OUTPUT_BYTES = 256_000;            // 256 KB
const MAX_FILE_BYTES = 2_000_000;            // 2 MB sane upper bound

function workspaceRoot(): vscode.Uri {
	const ws = vscode.workspace.workspaceFolders?.[0];
	if (!ws) throw new ToolError('Açık bir workspace yok. Önce bir klasör aç.');
	return ws.uri;
}

function resolveWorkspacePath(input: string): vscode.Uri {
	if (!input) throw new ToolError('path parametresi zorunlu');
	const root = workspaceRoot();
	// allow absolute uri only if inside workspace; otherwise treat as relative
	const trimmed = input.replace(/^[\\/]+/, '');
	const target = vscode.Uri.joinPath(root, trimmed);
	const normalized = path.normalize(target.fsPath);
	if (!normalized.startsWith(path.normalize(root.fsPath))) {
		throw new ToolError(`Path workspace dışına çıkamaz: ${input}`);
	}
	return target;
}

function truncate(text: string): string {
	const bytes = TEXT_ENCODER.encode(text);
	if (bytes.length <= MAX_OUTPUT_BYTES) return text;
	const cut = TEXT_DECODER.decode(bytes.slice(0, MAX_OUTPUT_BYTES));
	return `${cut}\n\n…[truncated ${bytes.length - MAX_OUTPUT_BYTES} bytes]`;
}

export const readFileTool: CerberusTool = {
	name: 'read_file',
	description: 'Read a UTF-8 text file from the workspace. Optional start_line / end_line (1-indexed, inclusive) restrict the slice. Use this before editing or before answering questions about files.',
	inputSchema: {
		type: 'object',
		required: ['path'],
		properties: {
			path: { type: 'string', description: 'Workspace-relative path (e.g. src/index.ts)' },
			start_line: { type: 'number' },
			end_line: { type: 'number' },
		},
	},
	async execute(input, _ctx): Promise<ToolResult> {
		try {
			const uri = resolveWorkspacePath(input.path);
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > MAX_FILE_BYTES) {
				return { ok: false, error: `Dosya çok büyük (${stat.size} byte). 2 MB sınırı.` };
			}
			const buffer = await vscode.workspace.fs.readFile(uri);
			let text = TEXT_DECODER.decode(buffer);
			if (typeof input.start_line === 'number' || typeof input.end_line === 'number') {
				const lines = text.split(/\r?\n/);
				const start = Math.max(1, Number(input.start_line) || 1) - 1;
				const end = Math.min(lines.length, Number(input.end_line) || lines.length);
				text = lines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n');
			}
			return { ok: true, output: truncate(text) };
		} catch (err: any) {
			return { ok: false, error: err.message ?? String(err) };
		}
	},
};

export const writeFileTool: CerberusTool = {
	name: 'write_file',
	description: 'Create or overwrite a workspace text file. Always read first if the file exists. The user must approve the diff before it lands on disk.',
	inputSchema: {
		type: 'object',
		required: ['path', 'content'],
		properties: {
			path: { type: 'string' },
			content: { type: 'string' },
			overwrite: { type: 'boolean', description: 'Allow overwrite of existing file. Defaults to true.' },
		},
	},
	async execute(input, ctx): Promise<ToolResult> {
		try {
			const uri = resolveWorkspacePath(input.path);
			let oldContent: string | null = null;
			let exists = false;
			try {
				const buf = await vscode.workspace.fs.readFile(uri);
				oldContent = TEXT_DECODER.decode(buf);
				exists = true;
			} catch { /* not found */ }

			if (exists && input.overwrite === false) {
				return { ok: false, error: 'Dosya var ve overwrite=false' };
			}

			if (ctx.approveWrite) {
				const ok = await ctx.approveWrite({
					path: input.path,
					oldContent,
					newContent: input.content,
				});
				if (!ok) return { ok: false, error: 'Kullanıcı değişikliği reddetti' };
			}

			// Make sure parent dir exists
			const dir = vscode.Uri.joinPath(uri, '..');
			try { await vscode.workspace.fs.createDirectory(dir); } catch { /* ok */ }
			await vscode.workspace.fs.writeFile(uri, TEXT_ENCODER.encode(input.content));
			return { ok: true, output: `Wrote ${input.content.length} chars to ${input.path}` };
		} catch (err: any) {
			return { ok: false, error: err.message ?? String(err) };
		}
	},
};

export const editFileTool: CerberusTool = {
	name: 'edit_file',
	description: 'Replace exactly one occurrence of `old_str` in a workspace file with `new_str`. Use full surrounding context so the match is unique. Must read the file first.',
	inputSchema: {
		type: 'object',
		required: ['path', 'old_str', 'new_str'],
		properties: {
			path: { type: 'string' },
			old_str: { type: 'string' },
			new_str: { type: 'string' },
		},
	},
	async execute(input, ctx): Promise<ToolResult> {
		try {
			const uri = resolveWorkspacePath(input.path);
			const buf = await vscode.workspace.fs.readFile(uri);
			const original = TEXT_DECODER.decode(buf);
			const occurrences = original.split(input.old_str).length - 1;
			if (occurrences === 0) return { ok: false, error: 'old_str bulunamadı' };
			if (occurrences > 1) return { ok: false, error: `old_str ${occurrences} kez geçti, daha fazla bağlam ver` };
			const next = original.replace(input.old_str, input.new_str);
			if (ctx.approveWrite) {
				const ok = await ctx.approveWrite({ path: input.path, oldContent: original, newContent: next });
				if (!ok) return { ok: false, error: 'Kullanıcı değişikliği reddetti' };
			}
			await vscode.workspace.fs.writeFile(uri, TEXT_ENCODER.encode(next));
			return { ok: true, output: `Replaced 1 block in ${input.path}` };
		} catch (err: any) {
			return { ok: false, error: err.message ?? String(err) };
		}
	},
};

export const listDirectoryTool: CerberusTool = {
	name: 'list_directory',
	description: 'List files and folders inside a workspace directory (non-recursive). Use to explore project structure.',
	inputSchema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'Workspace-relative path. Defaults to project root.' },
		},
	},
	async execute(input, _ctx): Promise<ToolResult> {
		try {
			const uri = input.path ? resolveWorkspacePath(input.path) : workspaceRoot();
			const entries = await vscode.workspace.fs.readDirectory(uri);
			const lines = entries
				.sort((a, b) => a[0].localeCompare(b[0]))
				.map(([name, type]) => {
					const tag = type === vscode.FileType.Directory ? 'd' : type === vscode.FileType.SymbolicLink ? 'l' : '-';
					return `${tag} ${name}`;
				});
			return { ok: true, output: truncate(lines.join('\n') || '(empty)') };
		} catch (err: any) {
			return { ok: false, error: err.message ?? String(err) };
		}
	},
};

export const searchFilesTool: CerberusTool = {
	name: 'search_files',
	description: 'Full-text search across the workspace using ripgrep-like semantics. Returns up to 100 matches with file:line context.',
	inputSchema: {
		type: 'object',
		required: ['query'],
		properties: {
			query: { type: 'string' },
			include: { type: 'string', description: 'Glob, e.g. **/*.ts' },
		},
	},
	async execute(input, _ctx): Promise<ToolResult> {
		try {
			const include = input.include ?? '**/*';
			const exclude = '**/node_modules/**';
			const files = await vscode.workspace.findFiles(include, exclude, 500);
			const needle = String(input.query);
			const matches: string[] = [];
			for (const file of files) {
				if (matches.length >= 100) break;
				try {
					const buf = await vscode.workspace.fs.readFile(file);
					const text = TEXT_DECODER.decode(buf);
					const lines = text.split(/\r?\n/);
					for (let i = 0; i < lines.length; i++) {
						if (lines[i].includes(needle)) {
							const rel = vscode.workspace.asRelativePath(file);
							matches.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
							if (matches.length >= 100) break;
						}
					}
				} catch { /* skip binary */ }
			}
			return { ok: true, output: truncate(matches.join('\n') || '(no matches)') };
		} catch (err: any) {
			return { ok: false, error: err.message ?? String(err) };
		}
	},
};
