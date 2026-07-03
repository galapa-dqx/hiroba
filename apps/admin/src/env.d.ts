/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

type RuntimeEnv = {
  DB: D1Database;
  WORKFLOW_MANAGER: DurableObjectNamespace;
};

declare namespace App {
  interface Locals {
    runtime: { env: RuntimeEnv };
  }
}

type ImportMetaEnv = {
  readonly PUBLIC_API_URL: string;
};

type ImportMeta = {
  readonly env: ImportMetaEnv;
};
