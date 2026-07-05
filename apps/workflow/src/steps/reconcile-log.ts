/**
 * Shared logging for translation attribute reconciliation.
 *
 * `reconcileAttributes` (in @hiroba/richtext) is pure — it returns what it
 * changed and never logs. Both translate steps route its report through here so
 * the workflow surfaces, via observability, exactly how often (and where) the
 * translation LLM drifts a non-linguistic attribute:
 *   • a `repair` = an attribute we silently restored from the JA source;
 *   • a `divergence` = a node bucket whose counts didn't line up, so we couldn't
 *     pair it and left it untouched — a louder signal that the round-trip is off.
 *
 * These go to `console.warn` (captured by the worker's observability the same as
 * the steps' existing `console.error` fallbacks); a clean round-trip logs nothing.
 */

import type { ReconcileReport } from '@hiroba/richtext';

/** Emit one warn line per repair and per divergence. Silent on a clean report. */
export function logReconciliation(
  scope: string,
  report: ReconcileReport,
): void {
  for (const r of report.repairs) {
    console.warn(
      `${scope}: restored ${r.nodeType}.${r.field} #${r.index} from source ` +
        `(translation had ${JSON.stringify(r.from)}, restored ${JSON.stringify(r.to)})`,
    );
  }
  for (const d of report.divergences) {
    console.warn(
      `${scope}: <${d.nodeType}> count diverged ` +
        `(${d.sourceCount} source vs ${d.translatedCount} translated); ` +
        `left its attributes unreconciled`,
    );
  }
}
