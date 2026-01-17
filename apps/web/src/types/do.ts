/**
 * Type definitions for Durable Object RPC interfaces.
 *
 * These match the methods exposed by NewsItemDO in apps/cron.
 */

import type { FieldTranslations, ItemType } from "@hiroba/db";

export interface BodyContent {
	contentJa: string;
}

export interface NewsItemDO {
	fetchBodyIfNeeded(itemId: string): Promise<BodyContent | null>;
	translateFields(
		itemId: string,
		itemType: ItemType,
		language: string,
		sourceFields: Record<string, string>,
		publishedAt: number,
	): Promise<FieldTranslations>;
}
