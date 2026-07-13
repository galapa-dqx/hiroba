/// <reference types="astro/client" />
/// <reference types="@cloudflare/workers-types" />

type RuntimeEnv = {
  DB: D1Database;
  IMAGES_BUCKET: R2Bucket;
  /** Service binding to the workflow worker's plain routes (DQX-26):
   *  /sse, /flow/runs, /regenerate-image. */
  WORKFLOW: Fetcher;
  /** FlowHub DO (flow framework control plane) — single 'hub' instance. */
  FLOW_HUB: DurableObjectNamespace;
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
