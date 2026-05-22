import * as vscode from 'vscode';

export interface CerberusModelDescriptor {
	readonly id: string;
	readonly label: string;
	readonly family: string;
	readonly capabilities: ReadonlyArray<string>;
	readonly maxInputTokens?: number;
	readonly maxOutputTokens?: number;
}

interface CerberusProductJson {
	readonly cerberusAiApiBaseUrl?: string;
	readonly cerberusAiHomepageUrl?: string;
	readonly cerberusAiDefaultModels?: ReadonlyArray<CerberusModelDescriptor>;
}

const SECRET_KEY = 'cerberusAi.apiKey';
const FALLBACK_API_BASE_URL = 'https://ide.aiwebmodel.com/v1';
const FALLBACK_MODELS: ReadonlyArray<CerberusModelDescriptor> = [
	{
		id: 'cerberus-coder',
		label: 'Cerberus Coder',
		family: 'cerberus',
		capabilities: ['chat', 'completions'],
		maxInputTokens: 128_000,
		maxOutputTokens: 8_192,
	},
];

/**
 * Resolves runtime configuration for the Cerberus AI provider.
 *
 * Precedence (highest first):
 *   1. User settings (`cerberusAi.*`)
 *   2. `product.json` (`cerberusAi*` keys, baked in at build time)
 *   3. Hard-coded fallbacks for development builds
 */
export class CerberusConfig {
	constructor(
		private readonly secrets: vscode.SecretStorage,
	) { }

	get apiBaseUrl(): string {
		const fromSettings = vscode.workspace
			.getConfiguration('cerberusAi')
			.get<string>('apiBaseUrl', '')
			.trim();
		if (fromSettings) {
			return fromSettings.replace(/\/$/, '');
		}
		const fromProduct = this.product().cerberusAiApiBaseUrl;
		if (fromProduct) {
			return fromProduct.replace(/\/$/, '');
		}
		return FALLBACK_API_BASE_URL;
	}

	get defaultModelId(): string {
		return vscode.workspace
			.getConfiguration('cerberusAi')
			.get<string>('defaultModel', 'cerberus-coder');
	}

	get requestTimeoutMs(): number {
		const value = vscode.workspace
			.getConfiguration('cerberusAi')
			.get<number>('requestTimeoutMs', 120_000);
		return Math.max(1_000, value);
	}

	get models(): ReadonlyArray<CerberusModelDescriptor> {
		const fromProduct = this.product().cerberusAiDefaultModels;
		if (fromProduct && fromProduct.length > 0) {
			return fromProduct;
		}
		return FALLBACK_MODELS;
	}

	/**
	 * Pull the live model list from the Cerberus admin gateway. Returns
	 * `undefined` if anything goes wrong — callers should fall back to
	 * `models` (the bake-time defaults).
	 */
	async fetchModelsFromGateway(): Promise<ReadonlyArray<CerberusModelDescriptor> | undefined> {
		const apiKey = await this.getApiKey();
		if (!apiKey) {
			return undefined;
		}
		try {
			const response = await fetch(`${this.apiBaseUrl}/models`, {
				method: 'GET',
				headers: { 'Authorization': `Bearer ${apiKey}` },
			});
			if (!response.ok) {
				return undefined;
			}
			const json = await response.json() as {
				data?: Array<{
					id: string;
					display_name?: string;
					owned_by?: string;
					capabilities?: string[];
					max_input_tokens?: number;
					max_output_tokens?: number;
				}>;
			};
			if (!json.data) {
				return undefined;
			}
			return json.data.map(entry => ({
				id: entry.id,
				label: entry.display_name ?? entry.id,
				family: entry.owned_by ?? 'cerberus',
				capabilities: entry.capabilities ?? ['chat', 'completions'],
				maxInputTokens: entry.max_input_tokens,
				maxOutputTokens: entry.max_output_tokens,
			}));
		} catch {
			return undefined;
		}
	}

	async getApiKey(): Promise<string | undefined> {
		const value = await this.secrets.get(SECRET_KEY);
		return value && value.length > 0 ? value : undefined;
	}

	async setApiKey(key: string): Promise<void> {
		await this.secrets.store(SECRET_KEY, key);
	}

	async clearApiKey(): Promise<void> {
		await this.secrets.delete(SECRET_KEY);
	}

	onSecretChange(listener: () => void): vscode.Disposable {
		return this.secrets.onDidChange(event => {
			if (event.key === SECRET_KEY) {
				listener();
			}
		});
	}

	private product(): CerberusProductJson {
		// `vscode.env.appName`/`appHost` aren't enough — we need the raw
		// product.json values that the build pipeline injected. They are
		// exposed at runtime via the (proposed) `vscode.env.appRoot` +
		// dynamic `require`, but the canonical accessor on the renderer
		// side is `vscode.env.appRoot`/process.env. The cleanest portable
		// path is to read them off the global `product` object exposed by
		// the workbench. We fall back gracefully if the shape changes.
		const anyGlobal = globalThis as unknown as {
			readonly _VSCODE_PRODUCT_JSON?: CerberusProductJson;
			readonly product?: CerberusProductJson;
		};
		return anyGlobal._VSCODE_PRODUCT_JSON ?? anyGlobal.product ?? {};
	}
}
