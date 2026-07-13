/// <reference types="astro/client" />

type RuntimeEnv = {
  DB: D1Database;
  /** FlowHub DO (flow framework control plane) — single 'hub' instance; the
   *  list-view title-backfill trigger starts flows through it. */
  FLOW_HUB: DurableObjectNamespace;
  /** Base host for image URLs — the `galapa--images` R2 bucket's public
   *  custom domain (e.g. https://img.example.com), so images are served straight
   *  from R2's edge cache with no Worker hop. Set in wrangler.jsonc `vars`. */
  IMAGE_BASE?: string;
};

declare namespace App {
  /** An enabled language from the whitelist (see @hiroba/db languages). */
  type SiteLanguage = {
    code: string;
    label: string;
    nativeLabel: string;
  };

  type Locals = {
    runtime: { env: RuntimeEnv };
    /** The page's language, validated against the whitelist (pages only). */
    lang?: string;
    /** The enabled languages, resolved once per request (pages only). */
    languages?: SiteLanguage[];
  };
}

type ImportMetaEnv = {
  readonly API_URL: string;
};

type ImportMeta = {
  readonly env: ImportMetaEnv;
};
