import { DragonglassSettings } from '../settings';
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
	return {
		ollama: new OllamaProvider(lazyHttp, () => ({ baseUrl: settings().ollama.baseUrl })),
		openai: new OpenAIProvider(lazyHttp, () => ({
			baseUrl: settings().openai.baseUrl,
			apiKey: () => {
				const id = settings().openai.apiKeySecretId;
				return id ? secrets.getSecret(id) : null;
			},
		})),
	};
}

export function modelFor(settings: DragonglassSettings, id: ProviderId): string {
	return id === 'ollama' ? settings.ollama.model : settings.openai.model;
}
