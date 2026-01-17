/// <reference types="astro/client" />

interface RuntimeEnv {
	DB: D1Database;
	OPENAI_API_KEY: string;
	NEWS_ITEM_DO: DurableObjectNamespace;
}

declare namespace App {
	interface Locals {
		runtime: { env: RuntimeEnv };
	}
}

interface ImportMetaEnv {
	readonly API_URL: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
