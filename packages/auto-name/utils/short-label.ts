import { completeSimple } from "@mariozechner/pi-ai";

type SummaryModel = Parameters<typeof completeSimple>[0];
type SummaryResult = Awaited<ReturnType<typeof completeSimple>>;

type AuthResult = {
	ok: boolean;
	apiKey?: string;
	headers?: Record<string, string>;
};

export type ShortLabelContext = {
	model?: SummaryModel;
	modelRegistry?: {
		getApiKeyAndHeaders: (model: SummaryModel) => Promise<AuthResult>;
	};
};

export type GenerateShortLabelOptions = {
	systemPrompt: string;
	prompt: string;
	maxTokens?: number;
	timeoutMs?: number;
	extractText?: (content: SummaryResult["content"]) => string;
};

function defaultExtractText(content: SummaryResult["content"]): string {
	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("")
		.trim();
}

export async function generateShortLabel(ctx: ShortLabelContext, options: GenerateShortLabelOptions): Promise<string> {
	const model = ctx.model;
	if (!model || !ctx.modelRegistry) return "";

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) return "";

	const controller = new AbortController();
	const timeoutMs = options.timeoutMs ?? 10000;
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const result = await completeSimple(
			model,
			{
				systemPrompt: options.systemPrompt,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: options.prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: auth.apiKey,
				headers: auth.headers,
				signal: controller.signal,
				reasoning: "minimal",
				maxTokens: options.maxTokens ?? 60,
			},
		);

		if (result.stopReason !== "stop") return "";
		const extractText = options.extractText ?? defaultExtractText;
		return extractText(result.content);
	} catch {
		return "";
	} finally {
		clearTimeout(timer);
	}
}
