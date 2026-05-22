import * as vscode from 'vscode';
import { CerberusClient, ChatMessage } from './client';
import { CerberusConfig } from './config';
import { CerberusAgent, approveDiffViaQuickPick } from './agent';

const SYSTEM = `Sen Cerberus Inline Edit'sin.
Kullanıcı bir kod parçası seçti ve dönüştürmek istiyor.
Görevin:
1) Önce read_file ile dosyanın tamamını oku (gerekirse).
2) edit_file ile DOĞRU şekilde tek seferlik bir replace yap.
3) Mümkünse tek tool call ile bitir.
ASLA sohbet etme — tool çağır, kısa onay yaz, dur.`;

/**
 * Cursor-style Cmd+K inline edit:
 *   - capture selection
 *   - ask user for instruction
 *   - feed agent with selection + filename + instruction
 *   - agent uses edit_file (with diff approval)
 */
export async function runInlineEdit(client: CerberusClient, config: CerberusConfig): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		await vscode.window.showInformationMessage('Cerberus: önce bir dosya aç ve düzenlemek istediğin parçayı seç.');
		return;
	}

	let selection = editor.selection;
	if (selection.isEmpty) {
		const word = editor.document.getWordRangeAtPosition(selection.active);
		if (word) selection = new vscode.Selection(word.start, word.end);
	}

	const instruction = await vscode.window.showInputBox({
		title: 'Cerberus Inline Edit',
		prompt: 'Bu kod için ne yapayım?',
		placeHolder: 'örn. "fonksiyonu async yap", "hata yönetimi ekle"',
		ignoreFocusOut: true,
	});
	if (!instruction) return;

	const apiKey = await config.getApiKey();
	if (!apiKey) {
		await vscode.commands.executeCommand('cerberusAi.signIn');
		return;
	}

	const filename = vscode.workspace.asRelativePath(editor.document.uri);
	const language = editor.document.languageId;
	const codeText = editor.document.getText(selection);
	const startLine = selection.start.line + 1;
	const endLine = selection.end.line + 1;

	const userPrompt =
`File: \`${filename}\` (${language}, lines ${startLine}-${endLine})

Kullanıcı talimatı:
${instruction}

Seçilen kod:
\`\`\`${language}
${codeText}
\`\`\`

Bu seçimi talimata göre güncelle. \`edit_file\` ile uygula. \`old_str\` olarak yukarıdaki seçilen kodun TAM HALİNİ kullan.`;

	const conversation: ChatMessage[] = [
		{ role: 'system', content: SYSTEM },
		{ role: 'user', content: userPrompt },
	];

	const agent = new CerberusAgent(client);
	const cancel = new vscode.CancellationTokenSource();
	const model = await pickModelForEdit(config);

	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: 'Cerberus düzenliyor…', cancellable: true },
		async (progress, token) => {
			token.onCancellationRequested(() => cancel.cancel());

			let lastTool = '';
			for await (const ev of agent.run(conversation, {
				model,
				mode: 'composer',
				maxIterations: 6,
				approveWrite: approveDiffViaQuickPick(),
				onProgress: (m) => progress.report({ message: m }),
			}, cancel.token)) {
				if (ev.kind === 'tool_call_start' && ev.toolName) {
					lastTool = ev.toolName;
					progress.report({ message: `tool: ${ev.toolName}` });
				}
				if (ev.kind === 'tool_call_end') {
					if (!ev.toolResult?.ok) {
						await vscode.window.showWarningMessage(`Cerberus: ${lastTool} hata — ${ev.toolResult?.error?.slice(0, 200)}`);
					}
				}
			}
		},
	);
}

async function pickModelForEdit(config: CerberusConfig) {
	const models = await config.fetchModelsFromGateway() ?? config.models;
	const preferred = models.find(m => m.id === config.defaultModelId);
	return preferred ?? models[0];
}
