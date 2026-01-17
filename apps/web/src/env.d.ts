/// <reference types="astro/client" />

type RuntimeEnv = {
  DB: D1Database;
  OPENAI_API_KEY: string;
  NEWS_ITEM_DO: DurableObjectNamespace;
};

declare namespace App {
  type Locals = {
    runtime: { env: RuntimeEnv };
  };
}

type ImportMetaEnv = {
  readonly API_URL: string;
};

type ImportMeta = {
  readonly env: ImportMetaEnv;
};
