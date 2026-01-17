/**
 * Glossary fetcher for DQX translation terms.
 * Fetches the glossary CSV from the dqx-translation-project GitHub repo.
 *
 * Note: The upstream CSV is malformed (unquoted fields containing commas),
 * so we parse manually by splitting on the first comma only.
 */

/** Glossary entry for translation. */
export type GlossaryEntry = {
	japanese_text: string;
	english_text: string;
};

export const GLOSSARY_URL =
	"https://raw.githubusercontent.com/dqx-translation-project/dqx-custom-translations/main/csv/glossary.csv";

/**
 * Fetch and parse the glossary CSV from GitHub.
 */
export async function fetchGlossary(): Promise<GlossaryEntry[]> {
	const response = await fetch(GLOSSARY_URL, {
		headers: {
			"User-Agent": "DQX-News-Worker/1.0",
		},
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch glossary: ${response.status}`);
	}

	const text = await response.text();
	const lines = text.split("\n");
	const entries: GlossaryEntry[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		// Split on first comma only (English text may contain commas)
		const commaIndex = trimmed.indexOf(",");
		if (commaIndex === -1) continue;

		const japanese = trimmed.slice(0, commaIndex).trim();
		const english = trimmed.slice(commaIndex + 1).trim();

		// Skip empty entries or potential headers
		if (japanese && english && japanese !== "Japanese") {
			entries.push({
				japanese_text: japanese,
				english_text: english,
			});
		}
	}

	return entries;
}
