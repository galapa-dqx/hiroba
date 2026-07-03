/// <reference types="astro/client" />

type RuntimeEnv = {
  DB: D1Database;
  IMAGES: R2Bucket;
  WORKFLOW_MANAGER: DurableObjectNamespace;
  /** Optional base for image URLs. Unset → the `/img` worker route; set to a
   *  bucket custom-domain (e.g. https://img.example.com) to serve straight from R2. */
  IMAGE_BASE?: string;
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
