/**
 * The FlowHub mount for this worker (DQX-19).
 *
 * The registration list below is the ONE def-name → workflow-binding map in
 * the system (docs/flow-framework.md) — each port PR (DQX-20+) adds its flow
 * here and nowhere else.
 */

import {
  createFlowHub,
  type FlowHubClass,
  type FlowRegistration,
} from '@hiroba/flow/hub';
import { BannerFlow, GlossaryRegenFlow } from '@hiroba/flows';

const registrations: FlowRegistration[] = [
  { def: BannerFlow, binding: 'BANNER_WORKFLOW' },
  { def: GlossaryRegenFlow, binding: 'GLOSSARY_REGENERATE_WORKFLOW' },
];

// Annotated so the exported class type doesn't reference the factory's
// anonymous class expression (TS2742).
const HubBase: FlowHubClass = createFlowHub(registrations);

export class FlowHub extends HubBase {}
