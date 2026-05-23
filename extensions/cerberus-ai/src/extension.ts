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
		vscode.commands.registerCommand('cerberusAi.openSidebar', async () => {
			// Force aux bar visible, then focus our view (it lives in auxiliarybar).
			await vscode.commands.executeCommand('workbench.action.openAuxiliaryBar')
				.then(undefined, () => undefined);
			await vscode.commands.executeCommand('cerberusAi.sidebar.focus')
				.then(undefined, () => undefined);
		}),
	);
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
