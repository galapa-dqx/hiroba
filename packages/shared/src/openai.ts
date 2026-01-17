/**
 * OpenAI translation utilities.
 *
 * Pure functions for AI-powered translation with glossary support.
 */

import OpenAI from "openai";

export type GlossaryTerm = {
	sourceText: string;
	translatedText: string;
};

export type TranslatedFields = {
	fields: Record<string, string>;
	model: string;
};

const SYSTEM_PROMPT = `You are a professional translator specializing in Japanese video game content,
particularly Dragon Quest X (DQX) online game. Translate the following Japanese text to natural English.

Guidelines:
- Keep game-specific terms, item names, location names, and character names that players would recognize
- Preserve any formatting like bullet points, numbered lists, dates, and times
- Convert Japanese date/time formats to be internationally readable while keeping original values
- Keep URLs and technical identifiers unchanged
- Maintain the original tone (official announcements should sound official)
- If there are instructions or steps, ensure they remain clear and actionable

Return your translation as a JSON object with the same field names as the input.`;

/**
 * Translate content using OpenAI.
 *
 * Pure function with no database dependencies.
 *
 * @param fields - Map of field names to source text (e.g., { title: "...", content: "..." })
 * @param targetLanguage - Target language code (e.g., "en")
 * @param glossaryTerms - List of terms with required translations
 * @param apiKey - OpenAI API key
 * @returns Translated fields and model used
 */
export async function translateWithAI(
	fields: Record<string, string>,
	targetLanguage: string,
	glossaryTerms: GlossaryTerm[],
	apiKey: string,
): Promise<TranslatedFields> {
	const client = new OpenAI({ apiKey });
	const model = "gpt-4o";

	const glossaryContext =
		glossaryTerms.length > 0
			? `\n\nGlossary (use these exact translations):\n${glossaryTerms.map((e) => `- ${e.sourceText} → ${e.translatedText}`).join("\n")}`
			: "";

	// Build input as labeled fields
	const fieldEntries = Object.entries(fields)
		.map(([name, value]) => `${name}: ${value}`)
		.join("\n\n");

	const userMessage = `Translate to ${targetLanguage}:
${glossaryContext}

${fieldEntries}`;

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
		const parsed = JSON.parse(responseText) as Record<string, string>;
		// Ensure all requested fields are in the result
		const result: Record<string, string> = {};
		for (const key of Object.keys(fields)) {
			result[key] = parsed[key] ?? fields[key];
		}
		return { fields: result, model };
	} catch {
		// If parsing fails, return original fields
		return { fields: { ...fields }, model };
	}
}
