/**
 * @hiroba/flow — the unified base for Cloudflare Workflows.
 *
 * Layer map (see docs/flow-framework.md for the decision record):
 *   define.ts   — definition-as-value: defineFlow + step/units/phase descriptors
 *   snapshot.ts — report protocol, snapshot types, reference reducer, renderers
 *   tracker.ts  — createFlow: the typed Flow surface over a real engine step
 *   inline.ts   — runFlowInline: the fast in-memory test harness
 *
 * The runtime half (FlowHub DO, FlowEntrypoint base class, hub client) lands
 * with DQX-18 and builds on exactly these exports.
 */

export {
  defineFlow,
  step,
  units,
  unitsForEach,
  phase,
  type AnyFlowDef,
  type FlowDef,
  type ParamsOf,
  type StepDesc,
  type StepsOf,
  type StepsShape,
} from './define';

export {
  createRunState,
  isActiveRunStatus,
  isTerminalRunStatus,
  renderCount,
  seedSnapshot,
  segmentView,
  type FlowReporter,
  type Report,
  type RunStatus,
  type SegmentView,
  type Snapshot,
  type SnapshotFor,
  type StepRunState,
  type StepState,
} from './snapshot';

export {
  createFlow,
  DEFAULT_STEP_CONFIG,
  DRAIN_STOP,
  FlowJoinError,
  joinRequest,
  type JoinRequest,
  type CreateFlowOptions,
  type EngineStep,
  type EngineStepConfig,
  type Flow,
  type FlowLogger,
  type JoinOutcome,
  type JoinPort,
  type OpenHandle,
  type PhaseStep,
} from './tracker';

export {
  inlineJoinPort,
  runFlowInline,
  type InlineResult,
  type InlineTraceEntry,
  type RunFlowInlineOptions,
} from './inline';
