import * as vscode from 'vscode';
import { CerberusConfig } from './config';
import { CerberusChatProvider } from './provider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const config = new CerberusConfig(context.secrets);

	registerCommands(context, config);
	await registerProviders(context, config);

	context.subscriptions.push(
		config.onSecretChange(() => {
			void vscode.window.showInformationMessage('Cerberus AI credentials updated.');
		}),
	);
}

export function deactivate(): void {
	// Disposables on `context.subscriptions` are cleaned up by VS Code.
}

function registerCommands(
	context: vscode.ExtensionContext,
	config: CerberusConfig,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('cerberusAi.signIn', async () => {
			const key = await vscode.window.showInputBox({
				title: 'Cerberus AI: Sign In',
				prompt: 'Paste your Cerberus AI API key',
				password: true,
				ignoreFocusOut: true,
				placeHolder: 'sk-...',
				validateInput: value => (value && value.trim().length > 0
					? null
					: 'API key cannot be empty'),
			});
			if (!key) {
				return;
			}
			await config.setApiKey(key.trim());
			await vscode.window.showInformationMessage('Cerberus AI is now signed in.');
		}),

		vscode.commands.registerCommand('cerberusAi.signOut', async () => {
			await config.clearApiKey();
			await vscode.window.showInformationMessage('Cerberus AI signed out.');
		}),

		vscode.commands.registerCommand('cerberusAi.setApiBaseUrl', async () => {
			const current = config.apiBaseUrl;
			const next = await vscode.window.showInputBox({
				title: 'Cerberus AI: Set API Base URL',
				prompt: 'Override the gateway base URL for this user.',
				value: current,
				ignoreFocusOut: true,
				validateInput: value => {
					if (!value) {
						return 'URL cannot be empty';
					}
					try {
						const url = new URL(value);
						return url.protocol === 'http:' || url.protocol === 'https:'
							? null
							: 'URL must be http(s)';
					} catch {
						return 'Not a valid URL';
					}
				},
			});
			if (!next || next === current) {
				return;
			}
			await vscode.workspace
				.getConfiguration('cerberusAi')
				.update('apiBaseUrl', next.trim(), vscode.ConfigurationTarget.Global);
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
		// Proposed API not available in this build. Surface a one-time hint
		// rather than failing activation outright, since the rest of the
		// extension (commands, settings) is still useful.
		void vscode.window.showWarningMessage(
			'Cerberus AI: language model API is not enabled in this build.',
		);
		return;
	}

	// Live list (admin panel) wins; fall back to product.json baked defaults.
	const remote = await config.fetchModelsFromGateway();
	const models = remote && remote.length > 0 ? remote : config.models;

	for (const model of models) {
		const provider = new CerberusChatProvider(model, config);

		const disposable = lm.registerLanguageModelChatProvider
			? lm.registerLanguageModelChatProvider(
				{ vendor: 'aiwebmodel', family: model.family, id: model.id },
				provider,
				provider.metadata,
			)
			: lm.registerChatModelProvider!(model.id, provider, provider.metadata);

		context.subscriptions.push(disposable);
	}
}
