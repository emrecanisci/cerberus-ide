import * as vscode from 'vscode';

export interface CerberusModelDescriptor {
	readonly id: string;
	readonly label: string;
	readonly family: string;
	readonly capabilities?: ReadonlyArray<string>;
	readonly maxInputTokens?: number;
	readonly maxOutputTokens?: number;
}

interface CerberusProductJson {
	readonly cerberusAiApiBaseUrl?: string;
	readonly cerberusAiHomepageUrl?: string;
	readonly cerberusAiDefaultModels?: ReadonlyArray<CerberusModelDescriptor>;
}

const SECRET_KEY = 'cerberusAi.apiKey';
const FALLBACK_API_BASE_URL = 'https://ide.aiwebmodel.com';
const FALLBACK_MODELS: ReadonlyArray<CerberusModelDescriptor> = [
	{ id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', family: 'cerberus', maxInputTokens: 200_000, maxOutputTokens: 8192 },
];

/**
 * Resolves runtime configuration for the Cerberus AI provider.
 *
 * Precedence:
 *   1. User settings (`cerberusAi.*`)
 *   2. `product.json` (`cerberusAi*` keys baked into the build)
 *   3. Hard-coded fallbacks for development builds
 */
export class CerberusConfig {
	constructor(private readonly secrets: vscode.SecretStorage) { }

	get apiBaseUrl(): string {
		const fromSettings = vscode.workspace.getConfiguration('cerberusAi').get<string>('apiBaseUrl', '').trim();
		if (fromSettings) return fromSettings.replace(/\/$/, '');
		const fromProduct = this.product().cerberusAiApiBaseUrl;
		if (fromProduct) return fromProduct.replace(/\/$/, '');
		return FALLBACK_API_BASE_URL;
	}

	get defaultModelId(): string {
		return vscode.workspace.getConfiguration('cerberusAi').get<string>('defaultModel', 'claude-sonnet-4-6');
	}

	get requestTimeoutMs(): number {
		const value = vscode.workspace.getConfiguration('cerberusAi').get<number>('requestTimeoutMs', 120_000);
		return Math.max(1_000, value);
	}

	get inlineCompletionsEnabled(): boolean {
		return vscode.workspace.getConfiguration('cerberusAi').get<boolean>('inlineCompletions.enabled', true);
	}

	get inlineCompletionModel(): string | undefined {
		const v = vscode.workspace.getConfiguration('cerberusAi').get<string>('inlineCompletions.model', '').trim();
		return v || undefined;
	}

	get models(): ReadonlyArray<CerberusModelDescriptor> {
		const fromProduct = this.product().cerberusAiDefaultModels;
		if (fromProduct && fromProduct.length > 0) return fromProduct;
		return FALLBACK_MODELS;
	}

	async getApiKey(): Promise<string | undefined> {
		const value = await this.secrets.get(SECRET_KEY);
		return value && value.length > 0 ? value : undefined;
	}

	async setApiKey(key: string): Promise<void> { await this.secrets.store(SECRET_KEY, key); }
	async clearApiKey(): Promise<void> { await this.secrets.delete(SECRET_KEY); }

	onSecretChange(listener: () => void): vscode.Disposable {
		return this.secrets.onDidChange(event => {
			if (event.key === SECRET_KEY) listener();
		});
	}

	/**
	 * Ask the panel for the active model catalogue. Falls back to the
	 * baked-in defaults if anything goes wrong (no key, network error,
	 * gateway returns nothing useful).
	 */
	async fetchModelsFromGateway(): Promise<ReadonlyArray<CerberusModelDescriptor> | undefined> {
		const apiKey = await this.getApiKey();
		if (!apiKey) return undefined;
		try {
			const response = await fetch(`${this.apiBaseUrl}/api/models`, {
				method: 'GET',
				headers: { 'Authorization': `Bearer ${apiKey}` },
			});
			if (!response.ok) return undefined;
			const json = await response.json();
			const list = Array.isArray(json)
				? json
				: Array.isArray((json as any).models)
					? (json as any).models
					: Array.isArray((json as any).data)
						? (json as any).data
						: [];
			const out: CerberusModelDescriptor[] = list.map((entry: any) => ({
				id: String(entry.name ?? entry.id ?? ''),
				label: String(entry.display_name ?? entry.label ?? entry.name ?? entry.id ?? ''),
				family: String(entry.provider ?? 'cerberus'),
				maxInputTokens: entry.context_window ?? undefined,
				maxOutputTokens: undefined,
			})).filter((m: CerberusModelDescriptor) => m.id);
			return out.length > 0 ? out : undefined;
		} catch {
			return undefined;
		}
	}

	/**
	 * Sign in with Cerberus IDE credentials → token from
	 * POST /api/auth/login (same as the panel uses). Token returned is what
	 * we store as the "API key" for subsequent requests.
	 */
	async signInWithPassword(username: string, password: string): Promise<void> {
		const response = await fetch(`${this.apiBaseUrl}/api/auth/login`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ username, password }),
		});
		if (!response.ok) {
			const text = await response.text().catch(() => '');
			throw new Error(`Giriş başarısız (${response.status}): ${text || response.statusText}`);
		}
		const json = await response.json() as { token?: string };
		if (!json.token) throw new Error('Geçersiz cevap: token yok');
		await this.setApiKey(json.token);
	}

	private product(): CerberusProductJson {
		const anyGlobal = globalThis as unknown as {
			readonly _VSCODE_PRODUCT_JSON?: CerberusProductJson;
			readonly product?: CerberusProductJson;
		};
		return anyGlobal._VSCODE_PRODUCT_JSON ?? anyGlobal.product ?? {};
	}
}
