import { DragonglassSettings } from '../settings';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { HttpClient } from './http';
import { OllamaProvider } from './ollama';
import { OpenAIProvider } from './openai';
import { Provider, ProviderId } from './types';

export interface SecretReader {
	getSecret(id: string): string | null;
}

/**
 * Builds provider instances from settings. Providers read config lazily
 * through closures so settings changes take effect without rebuilding.
 */
export function createProviders(
	http: () => HttpClient,
	settings: () => DragonglassSettings,
	secrets: SecretReader,
): Record<ProviderId, Provider> {
	const lazyHttp: HttpClient = {
		get supportsStreaming() {
			return http().supportsStreaming;
		},
		request: (req) => http().request(req),
		stream: (req) => http().stream(req),
	};
	// Each cloud provider reads only its own secret, so a key is never sent to
	// another provider.
	const keyFor = (id: 'openai' | 'anthropic' | 'gemini') => () => {
		const secretId = settings()[id].apiKeySecretId;
		return secretId ? secrets.getSecret(secretId) : null;
	};
	return {
		ollama: new OllamaProvider(lazyHttp, () => ({
			baseUrl: settings().ollama.baseUrl,
			numCtx: settings().ollama.numCtx,
			think: settings().ollama.think,
		})),
		openai: new OpenAIProvider(lazyHttp, () => ({ baseUrl: settings().openai.baseUrl, apiKey: keyFor('openai') })),
		anthropic: new AnthropicProvider(lazyHttp, () => ({
			baseUrl: settings().anthropic.baseUrl,
			apiKey: keyFor('anthropic'),
			maxTokens: settings().anthropic.maxTokens,
		})),
		gemini: new GeminiProvider(lazyHttp, () => ({ baseUrl: settings().gemini.baseUrl, apiKey: keyFor('gemini') })),
	};
}

export function modelFor(settings: DragonglassSettings, id: ProviderId): string {
	return settings[id].model;
}

export function setModelFor(settings: DragonglassSettings, id: ProviderId, model: string): void {
	settings[id].model = model;
}
