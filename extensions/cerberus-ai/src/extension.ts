import * as vscode from 'vscode';
import { CerberusConfig } from './config';
import { CerberusChatProvider } from './provider';
import { CerberusSidebarProvider } from './sidebar';
import { CerberusInlineCompletionProvider } from './inline-completion';
import { CerberusClient } from './client';
import { runInlineEdit } from './inline-edit';
import { getLogger, logInfo } from './log';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const log = getLogger();
	context.subscriptions.push(log);
	logInfo(`Cerberus AI extension activated (${context.extension.packageJSON.version}).`);

	const config = new CerberusConfig(context.secrets);
	const client = new CerberusClient(config);

	registerCommands(context, config, client);
	registerSidebar(context, config);
	registerInlineCompletions(context, config, client);
	await registerProviders(context, config);

	context.subscriptions.push(
		config.onSecretChange(() => {
			void vscode.window.showInformationMessage('Cerberus IDE oturumu güncellendi.');
		}),
	);
}

export function deactivate(): void { }

function registerSidebar(context: vscode.ExtensionContext, config: CerberusConfig): void {
	const provider = new CerberusSidebarProvider(context, config);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(CerberusSidebarProvider.viewType, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand('cerberusAi.openSidebar', () => {
			void vscode.commands.executeCommand('workbench.view.extension.cerberusAi');
		}),
	);
	void ensureRightSidebarPlacement(context);
}

/**
 * Cerberus IDE'de sidebar varsayılan olarak sağ (auxiliary) bar'da olmalı.
 * VS Code'un viewsContainer şeması auxiliarybar'ı resmi destekleme için
 * activitybar'a kayıt edip ilk açılışta programatik taşıma yapıyoruz.
 * Kullanıcı sonra istediği yere taşıyabilir.
 */
async function ensureRightSidebarPlacement(context: vscode.ExtensionContext): Promise<void> {
	const KEY = 'cerberusAi.placedOnRight';
	if (context.globalState.get<boolean>(KEY)) return;

	// Wait for workbench to finish booting + view system to register us.
	await new Promise(resolve => setTimeout(resolve, 1500));

	try {
		// Make sure the auxiliary side bar is visible so the user sees the move.
		await vscode.commands.executeCommand('workbench.action.openAuxiliaryBar')
			.then(undefined, () => undefined);

		// Try multiple known move commands across VS Code versions.
		const tries: Array<[string, any]> = [
			['vscode.moveViews', { viewIds: ['cerberusAi.sidebar'], destinationId: 'workbench.view.extension.auxiliarybar' }],
			['_workbench.moveView', { viewId: 'cerberusAi.sidebar', destinationId: 'workbench.view.extension.auxiliarybar' }],
			['workbench.action.moveView', { viewId: 'cerberusAi.sidebar', destinationId: 'workbench.view.extension.auxiliarybar' }],
		];
		for (const [cmd, arg] of tries) {
			try {
				await vscode.commands.executeCommand(cmd, arg);
				break;
			} catch { /* try next */ }
		}

		// Bring our view back to focus inside the (now right-side) container.
		await vscode.commands.executeCommand('cerberusAi.sidebar.focus')
			.then(undefined, () => undefined);
	} catch { /* user can drag manually */ }

	await context.globalState.update(KEY, true);
}

function registerInlineCompletions(
	context: vscode.ExtensionContext,
	config: CerberusConfig,
	client: CerberusClient,
): void {
	const provider = new CerberusInlineCompletionProvider(client, config);
	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider),
	);
}

function registerCommands(
	context: vscode.ExtensionContext,
	config: CerberusConfig,
	client: CerberusClient,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('cerberusAi.signIn', async () => {
			const choice = await vscode.window.showQuickPick(
				[
					{ label: 'Kullanıcı adı + parola ile giriş', value: 'password' as const },
					{ label: 'API token yapıştır', value: 'token' as const },
				],
				{ title: 'Cerberus IDE: Giriş yöntemi' },
			);
			if (!choice) return;

			if (choice.value === 'password') {
				const username = await vscode.window.showInputBox({
					title: 'Cerberus IDE: Kullanıcı adı',
					ignoreFocusOut: true,
				});
				if (!username) return;
				const password = await vscode.window.showInputBox({
					title: 'Cerberus IDE: Parola',
					password: true, ignoreFocusOut: true,
				});
				if (!password) return;
				try {
					await config.signInWithPassword(username.trim(), password);
					await vscode.window.showInformationMessage('Cerberus IDE oturumu açıldı.');
				} catch (err: any) {
					await vscode.window.showErrorMessage(`Giriş başarısız: ${err.message ?? err}`);
				}
				return;
			}

			const key = await vscode.window.showInputBox({
				title: 'Cerberus IDE: API token',
				prompt: 'Panel → Profil → "API Token" değerini yapıştır.',
				password: true, ignoreFocusOut: true,
				validateInput: v => (v && v.trim().length > 0 ? null : 'Token boş olamaz'),
			});
			if (!key) return;
			await config.setApiKey(key.trim());
			await vscode.window.showInformationMessage('Cerberus IDE token kaydedildi.');
		}),

		vscode.commands.registerCommand('cerberusAi.signOut', async () => {
			await config.clearApiKey();
			await vscode.window.showInformationMessage('Cerberus IDE oturumu kapatıldı.');
		}),

		vscode.commands.registerCommand('cerberusAi.setApiBaseUrl', async () => {
			const current = config.apiBaseUrl;
			const next = await vscode.window.showInputBox({
				title: 'Cerberus IDE: Panel adresi',
				prompt: 'Panel base URL\'i (ör. https://ide.aiwebmodel.com).',
				value: current, ignoreFocusOut: true,
				validateInput: value => {
					if (!value) return 'URL boş olamaz';
					try {
						const u = new URL(value);
						return (u.protocol === 'http:' || u.protocol === 'https:') ? null : 'http(s) olmalı';
					} catch { return 'Geçerli URL değil'; }
				},
			});
			if (!next || next === current) return;
			await vscode.workspace.getConfiguration('cerberusAi')
				.update('apiBaseUrl', next.trim().replace(/\/$/, ''), vscode.ConfigurationTarget.Global);
		}),

		vscode.commands.registerCommand('cerberusAi.refreshModels', async () => {
			const models = await config.fetchModelsFromGateway();
			if (!models) {
				await vscode.window.showWarningMessage('Cerberus IDE modelleri çekilemedi (oturum / bağlantı).');
				return;
			}
			await vscode.window.showInformationMessage(`Cerberus IDE: ${models.length} model bulundu.`);
		}),

		vscode.commands.registerCommand('cerberusAi.inlineEdit', async () => {
			await runInlineEdit(client, config);
		}),

		vscode.commands.registerCommand('cerberusAi.showLogs', () => {
			getLogger().show(true);
		}),
	);
}

async function registerProviders(
	context: vscode.ExtensionContext,
	config: CerberusConfig,
): Promise<void> {
	const lm = vscode.lm as unknown as {
		registerLanguageModelChatProvider?: (
			selector: { vendor: string; family?: string; id?: string },
			provider: CerberusChatProvider,
			metadata?: unknown,
		) => vscode.Disposable;
		registerChatModelProvider?: (
			id: string,
			provider: CerberusChatProvider,
			metadata?: unknown,
		) => vscode.Disposable;
	};

	if (!lm.registerLanguageModelChatProvider && !lm.registerChatModelProvider) {
		return;
	}

	const remote = await config.fetchModelsFromGateway();
	const models = remote && remote.length > 0 ? remote : config.models;

	for (const model of models) {
		const provider = new CerberusChatProvider(model, config);
		const disposable = lm.registerLanguageModelChatProvider
			? lm.registerLanguageModelChatProvider(
				{ vendor: 'cerberus', family: model.family, id: model.id },
				provider, provider.metadata,
			)
			: lm.registerChatModelProvider!(model.id, provider, provider.metadata);
		context.subscriptions.push(disposable);
	}
}
