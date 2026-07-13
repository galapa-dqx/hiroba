/**
 * @hiroba/flows — hiroba's flow DEFINITIONS, and nothing else.
 *
 * Thin on purpose (docs/flow-framework.md §package layout): a definition is
 * name + dedup key + step shape, importable by apps/admin for typed snapshots
 * without dragging in step code. Flow bodies and step functions stay in
 * apps/workflow; the def-name → workflow-binding map lives where the hub is
 * mounted (apps/workflow/src/flow-hub.ts).
 */

export { BannerFlow } from './banner';
export { GlossaryRegenFlow } from './glossary-regen';
export { TitleBackfillFlow, TitleFlow } from './titles';
