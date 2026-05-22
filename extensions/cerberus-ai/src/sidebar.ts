import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CerberusClient, CerberusAuthError, ChatMessage } from './client';
import { CerberusConfig, CerberusModelDescriptor } from './config';
import { CerberusAgent, approveDiffViaQuickPick, summarizeToolInput } from './agent';
import { resolveContext } from './context-resolver';

interface ActivityItem {
	readonly icon: string;
	readonly label: string;
	readonly file?: string;
	readonly when: string;
}

const ACTIVITY_KEY = 'cerberusAi.recentActivity';

const ACTION_PROMPTS: Record<string, { label: string; icon: string; build: (code: string, language: string, file: string) => string }> = {
	explain: {
		label: 'Explained',
		icon: '📖',
		build: (code, lang, file) => `\`${file}\` dosyasındaki ${lang} kodunu açıkla. Önce 1-2 cümlelik özet, sonra adım adım inceleme.\n\n\`\`\`${lang}\n${code}\n\`\`\``,
	},
	generate: {
		label: 'Generated',
		icon: '✨',
		build: (_code, lang) => `Yeni bir ${lang} kod parçası üret. Tools'ları kullanarak gerekli dosyaları oluştur.`,
	},
	refactor: {
		label: 'Refactored',
		icon: '🔧',
		build: (code, lang, file) => `\`${file}\` dosyasındaki ${lang} kodunu daha temiz, okunaklı ve idiomatik hale getir. Önce dosyayı oku, sonra edit_file ile değişiklikleri uygula. Davranışı koru.\n\n\`\`\`${lang}\n${code}\n\`\`\``,
	},
	findBugs: {
		label: 'Bug analysis',
		icon: '🐛',
		build: (code, lang, file) => `\`${file}\` dosyasındaki ${lang} kodunda olası bug, edge case ve güvenlik açıklarını bul. Severity'sine göre listele ve düzeltme öner.\n\n\`\`\`${lang}\n${code}\n\`\`\``,
	},
	writeTests: {
		label: 'Tests written',
		icon: '🧪',
		build: (code, lang, file) => `\`${file}\` dosyasındaki ${lang} kodu için kapsamlı unit test'ler yaz. Aynı dilde standart test framework'ünü kullan, test dosyasını uygun konuma write_file ile yaz.\n\n\`\`\`${lang}\n${code}\n\`\`\``,
	},
	documentation: {
		label: 'Docs generated',
		icon: '📄',
		build: (code, lang, file) => `\`${file}\` dosyasındaki ${lang} kodu için inline doc (JSDoc/docstring) ekle. edit_file ile uygula.\n\n\`\`\`${lang}\n${code}\n\`\`\``,
	},
};

export class CerberusSidebarProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'cerberusAi.sidebar';

	private view?: vscode.WebviewView;
	private readonly client: CerberusClient;
	private readonly agent: CerberusAgent;
	private currentModel?: CerberusModelDescriptor;
	private currentMode: string;
	private currentCancel?: vscode.CancellationTokenSource;
	private readonly conversation: ChatMessage[] = [];

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly config: CerberusConfig,
	) {
		this.client = new CerberusClient(config);
		this.agent = new CerberusAgent(this.client);
		this.currentMode = vscode.workspace.getConfiguration('cerberusAi').get<string>('defaultMode', 'agent');
	}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))],
		};
		webviewView.webview.html = this.renderHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage((msg) => this.onMessage(msg));

		const editorSub = vscode.window.onDidChangeActiveTextEditor((editor) => {
			this.pushActiveFile(editor);
		});
		webviewView.onDidDispose(() => editorSub.dispose());
	}

	private async onMessage(msg: any): Promise<void> {
		if (!this.view) return;
		switch (msg.type) {
			case 'ready':
				await this.bootstrap();
				return;
			case 'send':
				await this.runChat(String(msg.text ?? '').trim());
				return;
			case 'action':
				await this.runAction(String(msg.action ?? ''));
				return;
			case 'pickModel':
				await this.pickModel();
				return;
			case 'pickMode':
				await this.pickMode();
				return;
			case 'signIn':
				await vscode.commands.executeCommand('cerberusAi.signIn');
				await this.bootstrap();
				return;
			case 'newChat':
				this.conversation.length = 0;
				this.view.webview.postMessage({ type: 'cleared' });
				return;
		}
	}

	private async bootstrap(): Promise<void> {
		if (!this.view) return;
		const apiKey = await this.config.getApiKey();
		const authState = apiKey ? 'signed-in' : 'signed-out';
		const models = apiKey ? await this.config.fetchModelsFromGateway() ?? this.config.models : this.config.models;
		this.currentModel = pickPreferred(models, this.config.defaultModelId);
		const recentActivity = this.context.globalState.get<ActivityItem[]>(ACTIVITY_KEY, []);
		const modes = await this.fetchModes();
		if (modes.length && !modes.find(m => m.slug === this.currentMode)) {
			this.currentMode = modes.find(m => m.is_default)?.slug ?? modes[0].slug;
		}
		this.view.webview.postMessage({
			type: 'init',
			model: this.currentModel,
			mode: this.currentMode,
			modes,
			activeFile: shortenFile(vscode.window.activeTextEditor),
			recentActivity,
			authState,
		});
	}

	private async fetchModes(): Promise<Array<{ slug: string; name: string; icon?: string; is_default?: boolean }>> {
		const apiKey = await this.config.getApiKey();
		if (!apiKey) return [];
		try {
			const r = await fetch(`${this.config.apiBaseUrl}/api/modes`, { headers: { 'Authorization': `Bearer ${apiKey}` } });
			if (!r.ok) return [];
			const json = await r.json() as any;
			const list = Array.isArray(json) ? json : json.modes ?? [];
			return list.map((m: any) => ({
				slug: String(m.name ?? m.slug ?? ''),
				name: String(m.display_name ?? m.name ?? ''),
				icon: m.icon ?? '⚙',
				is_default: !!m.is_default,
			})).filter((m: any) => m.slug);
		} catch { return []; }
	}

	private async pickMode(): Promise<void> {
		const modes = await this.fetchModes();
		if (!modes.length) {
			void vscode.window.showWarningMessage('Cerberus modları paneldeki Modes listesinden okunuyor.');
			return;
		}
		const choice = await vscode.window.showQuickPick(
			modes.map(m => ({ label: `${m.icon ?? ''} ${m.name}`.trim(), description: m.slug, mode: m })),
			{ title: 'Cerberus modu seç', placeHolder: this.currentMode },
		);
		if (!choice) return;
		this.currentMode = choice.mode.slug;
		this.view?.webview.postMessage({ type: 'modeChanged', mode: this.currentMode });
		await vscode.workspace.getConfiguration('cerberusAi').update('defaultMode', this.currentMode, vscode.ConfigurationTarget.Global);
	}

	private pushActiveFile(editor: vscode.TextEditor | undefined): void {
		this.view?.webview.postMessage({ type: 'activeFile', file: shortenFile(editor) });
	}

	private async pickModel(): Promise<void> {
		const apiKey = await this.config.getApiKey();
		if (!apiKey) {
			await this.notifySignedOut();
			return;
		}
		const models = await this.config.fetchModelsFromGateway() ?? this.config.models;
		const picks = models.map(m => ({ label: m.label, description: m.id, model: m }));
		const choice = await vscode.window.showQuickPick(picks, {
			title: 'Cerberus modeli seç',
			placeHolder: this.currentModel?.label,
		});
		if (!choice) return;
		this.currentModel = choice.model;
		this.view?.webview.postMessage({ type: 'modelChanged', model: this.currentModel });
		await vscode.workspace.getConfiguration('cerberusAi')
			.update('defaultModel', this.currentModel.id, vscode.ConfigurationTarget.Global);
	}

	private async runAction(actionId: string): Promise<void> {
		const action = ACTION_PROMPTS[actionId];
		if (!action) return;
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			void vscode.window.showInformationMessage('Cerberus: önce bir dosya aç ve istersen kod parçası seç.');
			return;
		}
		const language = editor.document.languageId;
		const selection = editor.document.getText(editor.selection || undefined);
		const fallback = editor.document.getText().slice(0, 8000);
		const code = selection.trim() ? selection : fallback;
		const fileName = vscode.workspace.asRelativePath(editor.document.uri);
		const prompt = action.build(code, language, fileName);
		await this.runChat(prompt, {
			activityIcon: action.icon,
			activityLabel: `${action.label} ${path.basename(editor.document.fileName)}`,
			activityFile: path.basename(editor.document.fileName),
		});
	}

	private async runChat(text: string, opts?: { activityIcon?: string; activityLabel?: string; activityFile?: string }): Promise<void> {
		if (!text || !this.view) return;
		const apiKey = await this.config.getApiKey();
		if (!apiKey) {
			await this.notifySignedOut();
			return;
		}
		const model = this.currentModel ?? this.config.models[0];
		if (!model) {
			this.view.webview.postMessage({ type: 'error', message: 'Hiç model yok. Panele gir ve bir model ekle.' });
			return;
		}

		this.view.webview.postMessage({ type: 'userMessage', text });
		const resolved = await resolveContext(text);
		const userContent = resolved.contextBlock
			? `${resolved.contextBlock}\n\n${resolved.cleanedText || '(Bağlamla ne yapacağın yukarıda)'}`
			: text;
		this.conversation.push({ role: 'user', content: userContent });
		this.view.webview.postMessage({ type: 'assistantStart' });

		this.currentCancel?.cancel();
		this.currentCancel = new vscode.CancellationTokenSource();

		const approveWrite = approveDiffViaQuickPick();

		try {
			for await (const ev of this.agent.run(this.conversation, {
				model,
				mode: this.currentMode,
				approveWrite,
				maxIterations: 14,
			}, this.currentCancel.token)) {
				if (ev.kind === 'text' && ev.text) {
					this.view.webview.postMessage({ type: 'assistantDelta', delta: ev.text });
				} else if (ev.kind === 'tool_call_start' && ev.toolName) {
					this.view.webview.postMessage({
						type: 'toolStart',
						summary: summarizeToolInput(ev.toolName, ev.toolInput),
					});
				} else if (ev.kind === 'tool_call_end' && ev.toolName) {
					const ok = ev.toolResult?.ok ?? false;
					this.view.webview.postMessage({
						type: 'toolEnd',
						summary: summarizeToolInput(ev.toolName, ev.toolInput),
						ok,
						detail: ok ? undefined : ev.toolResult?.error,
					});
				} else if (ev.kind === 'turn_done') {
					this.view.webview.postMessage({ type: 'assistantDone', stopReason: ev.stopReason });
				}
			}
			const activityLabel = opts?.activityLabel ?? `Asked Cerberus`;
			this.recordActivity({
				icon: opts?.activityIcon ?? '💬',
				label: activityLabel,
				file: opts?.activityFile,
				when: 'just now',
			});
		} catch (err: any) {
			if (err instanceof CerberusAuthError) await this.notifySignedOut();
			this.view.webview.postMessage({ type: 'error', message: err?.message ?? String(err) });
		}
	}

	private async notifySignedOut(): Promise<void> {
		this.view?.webview.postMessage({ type: 'auth', state: 'signed-out' });
	}

	private recordActivity(item: ActivityItem): void {
		const list = this.context.globalState.get<ActivityItem[]>(ACTIVITY_KEY, []).slice();
		list.unshift(item);
		while (list.length > 12) list.pop();
		void this.context.globalState.update(ACTIVITY_KEY, list);
		this.view?.webview.postMessage({ type: 'activity', item });
	}

	private renderHtml(webview: vscode.Webview): string {
		const htmlPath = path.join(this.context.extensionPath, 'media', 'sidebar.html');
		const raw = fs.readFileSync(htmlPath, 'utf8');
		const nonce = makeNonce();
		return raw
			.replace(/\$\{cspSource\}/g, webview.cspSource)
			.replace(/\$\{nonce\}/g, nonce);
	}
}

function pickPreferred(models: ReadonlyArray<CerberusModelDescriptor>, preferredId: string): CerberusModelDescriptor | undefined {
	if (!models.length) return undefined;
	const exact = models.find(m => m.id === preferredId);
	return exact ?? models[0];
}

function shortenFile(editor: vscode.TextEditor | undefined): string {
	if (!editor) return 'Active file context';
	const ws = vscode.workspace.workspaceFolders?.[0];
	const fsPath = editor.document.uri.fsPath;
	if (!ws) return path.basename(fsPath);
	const rel = path.relative(ws.uri.fsPath, fsPath);
	return rel || path.basename(fsPath);
}

function makeNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let out = '';
	for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
	return out;
}
