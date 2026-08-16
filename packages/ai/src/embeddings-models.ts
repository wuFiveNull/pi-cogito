import { defaultProviderAuthContext as defaultAuthContext } from "./auth/context.ts";
import { InMemoryCredentialStore } from "./auth/credential-store.ts";
import { type AuthResolutionOverrides, ModelsError, resolveProviderAuth } from "./auth/resolve.ts";
import type { AuthContext, AuthResult, CredentialStore, ProviderAuth } from "./auth/types.ts";
import type { CreateModelsOptions } from "./models.ts";
import type {
	EmbeddingModel,
	EmbeddingResult,
	EmbeddingsApi,
	EmbeddingsContext,
	EmbeddingsOptions,
	ProviderEmbeddings,
} from "./types.ts";

/**
 * An embeddings provider: the embedding counterpart of `Provider` and
 * `ImagesProvider`. Owns id/name metadata, auth, model listing, and
 * embedding behavior.
 */
export interface EmbeddingsProvider {
	readonly id: string;
	readonly name: string;

	/** Same semantics as chat/image providers; undefined when unconfigured. */
	readonly auth: ProviderAuth;

	/**
	 * Current known models, sync. Static providers return their catalog;
	 * dynamic providers return the list as of the last `refreshModels()`.
	 * Must not throw.
	 */
	getModels(): readonly EmbeddingModel<EmbeddingsApi>[];

	/** Dynamic providers only: fetch and update the model list. */
	refreshModels?(): Promise<void>;

	embedTexts(
		model: EmbeddingModel<EmbeddingsApi>,
		context: EmbeddingsContext,
		options?: EmbeddingsOptions,
	): Promise<EmbeddingResult>;
}

/**
 * Runtime collection of embeddings providers plus auth application and
 * embedding convenience: the embedding counterpart of `Models`/`ImagesModels`.
 */
export interface EmbeddingsModels {
	getProviders(): readonly EmbeddingsProvider[];
	getProvider(id: string): EmbeddingsProvider | undefined;

	/** Sync read of last-known models from one provider or all providers. */
	getModels(provider?: string): readonly EmbeddingModel<EmbeddingsApi>[];

	/** Sync runtime model lookup against last-known lists. */
	getModel(provider: string, id: string): EmbeddingModel<EmbeddingsApi> | undefined;

	/** Ask dynamic providers to re-fetch their model lists. */
	refresh(provider?: string): Promise<void>;

	/**
	 * Resolve request auth by provider id or embedding model. Same contract
	 * as `Models.getAuth()`.
	 */
	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: EmbeddingModel<EmbeddingsApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;

	/**
	 * Embed texts through the owning provider with auth resolved and merged
	 * (explicit options win per field). Never rejects; failures are returned
	 * as an `EmbeddingResult` with `stopReason: "error"`.
	 */
	embedTexts(
		model: EmbeddingModel<EmbeddingsApi>,
		context: EmbeddingsContext,
		options?: EmbeddingsOptions,
	): Promise<EmbeddingResult>;
}

export interface MutableEmbeddingsModels extends EmbeddingsModels {
	/** Upsert/replace by provider.id. Provider ids are unique. */
	setProvider(provider: EmbeddingsProvider): void;
	deleteProvider(id: string): void;
	clearProviders(): void;
}

class EmbeddingsModelsImpl implements MutableEmbeddingsModels {
	private providers = new Map<string, EmbeddingsProvider>();
	private credentials: CredentialStore;
	private authContext: AuthContext;

	constructor(options?: CreateModelsOptions) {
		this.credentials = options?.credentials ?? new InMemoryCredentialStore();
		this.authContext = options?.authContext ?? defaultAuthContext();
	}

	setProvider(provider: EmbeddingsProvider): void {
		this.providers.set(provider.id, provider);
	}

	deleteProvider(id: string): void {
		this.providers.delete(id);
	}

	clearProviders(): void {
		this.providers.clear();
	}

	getProviders(): readonly EmbeddingsProvider[] {
		return Array.from(this.providers.values());
	}

	getProvider(id: string): EmbeddingsProvider | undefined {
		return this.providers.get(id);
	}

	getModels(provider?: string): readonly EmbeddingModel<EmbeddingsApi>[] {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry) return [];
			try {
				return entry.getModels();
			} catch {
				return [];
			}
		}

		const models: EmbeddingModel<EmbeddingsApi>[] = [];
		for (const entry of this.providers.values()) {
			try {
				models.push(...entry.getModels());
			} catch {
				// Best-effort: ill-behaved providers yield no models.
			}
		}
		return models;
	}

	getModel(provider: string, id: string): EmbeddingModel<EmbeddingsApi> | undefined {
		return this.getModels(provider).find((model) => model.id === id);
	}

	async refresh(provider?: string): Promise<void> {
		if (provider !== undefined) {
			const entry = this.providers.get(provider);
			if (!entry?.refreshModels) return;
			try {
				await entry.refreshModels();
			} catch (error) {
				if (error instanceof ModelsError) throw error;
				throw new ModelsError("model_source", `Model refresh failed for ${provider}`, { cause: error });
			}
			return;
		}

		await Promise.allSettled(Array.from(this.providers.values(), async (entry) => entry.refreshModels?.()));
	}

	getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	getAuth(model: EmbeddingModel<EmbeddingsApi>, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
	async getAuth(
		providerOrModel: string | EmbeddingModel<EmbeddingsApi>,
		overrides?: AuthResolutionOverrides,
	): Promise<AuthResult | undefined> {
		const providerId = typeof providerOrModel === "string" ? providerOrModel : providerOrModel.provider;
		const provider = this.providers.get(providerId);
		if (!provider) return undefined;
		return resolveProviderAuth(provider, this.credentials, this.authContext, overrides);
	}

	async embedTexts(
		model: EmbeddingModel<EmbeddingsApi>,
		context: EmbeddingsContext,
		options?: EmbeddingsOptions,
	): Promise<EmbeddingResult> {
		try {
			const provider = this.providers.get(model.provider);
			if (!provider) {
				throw new ModelsError("provider", `Unknown provider: ${model.provider}`);
			}

			const resolution = await this.getAuth(model, {
				apiKey: options?.apiKey,
				env: options?.env,
			});
			const auth = resolution?.auth;
			if (!auth) {
				return provider.embedTexts(model, context, options);
			}

			const requestModel = auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model;

			// Explicit request options win per-field; headers/env merge per key.
			const apiKey = options?.apiKey ?? auth.apiKey;
			const headers = auth.headers || options?.headers ? { ...auth.headers, ...options?.headers } : undefined;
			const env =
				resolution.env || options?.env ? { ...(resolution.env ?? {}), ...(options?.env ?? {}) } : undefined;

			return await provider.embedTexts(requestModel, context, { ...options, apiKey, headers, env });
		} catch (error) {
			return {
				api: model.api,
				provider: model.provider,
				model: model.id,
				embeddings: [],
				stopReason: "error",
				errorMessage: error instanceof Error ? error.message : String(error),
				timestamp: Date.now(),
			};
		}
	}
}

export function createEmbeddingsModels(options?: CreateModelsOptions): MutableEmbeddingsModels {
	return new EmbeddingsModelsImpl(options);
}

export interface CreateEmbeddingsProviderOptions {
	id: string;
	/** Display name. Default: `id`. */
	name?: string;
	/** Required — every provider has auth semantics, even ambient/keyless ones. */
	auth: ProviderAuth;
	/** Initial model list (empty for purely dynamic providers). */
	models: readonly EmbeddingModel<EmbeddingsApi>[];
	/**
	 * Dynamic providers: fetch the current list. Stored on success; concurrent
	 * calls share one in-flight fetch.
	 */
	refreshModels?: () => Promise<readonly EmbeddingModel<EmbeddingsApi>[]>;
	api: ProviderEmbeddings;
}

/** Builds an embeddings provider from parts. */
export function createEmbeddingsProvider(input: CreateEmbeddingsProviderOptions): EmbeddingsProvider {
	let models = input.models;
	let inflightRefresh: Promise<void> | undefined;
	const refreshModels = input.refreshModels;

	return {
		id: input.id,
		name: input.name ?? input.id,
		auth: input.auth,
		getModels: () => models,
		refreshModels: refreshModels
			? () => {
					inflightRefresh ??= (async () => {
						try {
							models = await refreshModels();
						} finally {
							inflightRefresh = undefined;
						}
					})();
					return inflightRefresh;
				}
			: undefined,
		embedTexts: (model, context, options) => input.api.embedTexts(model, context, options),
	};
}
