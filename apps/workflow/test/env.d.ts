// pool-workers ≥0.18 types `env` from 'cloudflare:test' as the global
// Cloudflare.Env (the `wrangler types` convention) — merge our test bindings
// into it. Interface (not type): merging is the point.
declare namespace Cloudflare {
  // eslint-disable-next-line @typescript-eslint/consistent-type-definitions
  interface Env {
    FLOW_HUB: DurableObjectNamespace;
    BANNER_WORKFLOW: Workflow;
    GLOSSARY_REGENERATE_WORKFLOW: Workflow;
  }
}
