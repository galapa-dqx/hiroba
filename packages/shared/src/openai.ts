/**
 * OpenAI translation utilities.
 *
 * Pure functions for AI-powered translation with glossary support.
 */

import OpenAI from "openai";

export interface GlossaryTerm {
	sourceText: string;
	translatedText: string;
}

export interface TranslatedContent {
	title: string;
	content: string;
	model: string;
}

const SYSTEM_PROMPT = `You are a professional translator specializing in Japanese video game content,
particularly Dragon Quest X (DQX) online game. Translate the following Japanese text to natural English.

Guidelines:
- Keep game-specific terms, item names, location names, and character names that players would recognize
- Preserve any formatting like bullet points, numbered lists, dates, and times
- Convert Japanese date/time formats to be internationally readable while keeping original values
- Keep URLs and technical identifiers unchanged
- Maintain the original tone (official announcements should sound official)
- If there are instructions or steps, ensure they remain clear and actionable

Return your translation in the following JSON format:
{"title": "translated title", "content": "translated content"}`;

/**
 * Translate content using OpenAI.
 *
 * Pure function with no database dependencies.
 */
export async function translateWithAI(
	title: string,
	content: string,
	targetLanguage: string,
	glossaryTerms: GlossaryTerm[],
	apiKey: string,
): Promise<TranslatedContent> {
	const client = new OpenAI({ apiKey });
	const model = "gpt-4o";

	const glossaryContext =
		glossaryTerms.length > 0
			? `\n\nGlossary (use these exact translations):\n${glossaryTerms.map((e) => `- ${e.sourceText} → ${e.translatedText}`).join("\n")}`
			: "";

	const userMessage = `Translate to ${targetLanguage}:
${glossaryContext}

Title: ${title}

Content:
${content}`;

	const response = await client.chat.completions.create({
		model,
		temperature: 0.3,
		response_format: { type: "json_object" },
		messages: [
			{ role: "system", content: SYSTEM_PROMPT },
			{ role: "user", content: userMessage },
		],
	});

	const responseText = response.choices[0]?.message?.content ?? "{}";

	try {
		const parsed = JSON.parse(responseText) as { title?: string; content?: string };
		return {
			title: parsed.title ?? title,
			content: parsed.content ?? content,
			model,
		};
	} catch {
		return {
			title: title,
			content: responseText,
			model,
		};
	}
}
