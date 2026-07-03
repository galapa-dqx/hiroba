/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

type RuntimeEnv = {
  DB: D1Database;
  WORKFLOW_MANAGER: DurableObjectNamespace;
};

declare namespace App {
  // Must be an interface — Astro's App.Locals is an interface and this merges into it.
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
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
