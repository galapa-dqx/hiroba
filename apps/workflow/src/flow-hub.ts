/**
 * The FlowHub mount for this worker (DQX-19).
 *
 * The registration list below is the ONE def-name → workflow-binding map in
 * the system (docs/flow-framework.md) — each port PR (DQX-20+) adds its flow
 * here and nowhere else. Empty until the first port: the hub deploys dark,
 * with zero callers, so the DO + panel are proven before any workflow moves.
 */

import {
  createFlowHub,
  type FlowHubClass,
  type FlowRegistration,
} from '@hiroba/flow/hub';

const registrations: FlowRegistration[] = [];

// Annotated so the exported class type doesn't reference the factory's
// anonymous class expression (TS2742).
const HubBase: FlowHubClass = createFlowHub(registrations);

export class FlowHub extends HubBase {}
