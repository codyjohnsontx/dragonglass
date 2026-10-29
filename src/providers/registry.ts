import { CustomSettings, DragonglassSettings } from '../settings';
import { AnthropicProvider } from './anthropic';
import { GeminiProvider } from './gemini';
import { HttpClient } from './http';
import { OllamaProvider } from './ollama';
import { OpenAIAuth, OpenAIProvider } from './openai';
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
	const keyFor = (id: 'openai' | 'anthropic' | 'gemini' | 'custom') => () => {
		const secretId = settings()[id].apiKeySecretId;
		return secretId ? secrets.getSecret(secretId) : null;
	};
	return {
		ollama: new OllamaProvider(lazyHttp, () => ({
			baseUrl: settings().ollama.baseUrl,
			model: settings().ollama.model,
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
		custom: new OpenAIProvider(
			lazyHttp,
			() => {
				const c = settings().custom;
				return {
					baseUrl: c.baseUrl,
					apiKey: keyFor('custom'),
					auth: customAuth(c),
					streaming: c.streaming,
					toolCalling: c.toolCalling,
					local: isLoopbackUrl(c.baseUrl),
				};
			},
			{ id: 'custom', displayName: 'Custom' },
		),
	};
}

function customAuth(c: CustomSettings): OpenAIAuth {
	if (c.auth === 'header') return { kind: 'header', name: c.authHeader };
	return { kind: c.auth };
}

/** True when `url` points at this machine (LM Studio, llama.cpp, a local vLLM). */
export function isLoopbackUrl(url: string): boolean {
	let host: string;
	try {
		host = new URL(url.trim()).hostname;
	} catch {
		return false;
	}
	return host === 'localhost' || host === '[::1]' || /^127(\.\d{1,3}){3}$/.test(host);
}

export function modelFor(settings: DragonglassSettings, id: ProviderId): string {
	return settings[id].model;
}

export function setModelFor(settings: DragonglassSettings, id: ProviderId, model: string): void {
	settings[id].model = model;
}
