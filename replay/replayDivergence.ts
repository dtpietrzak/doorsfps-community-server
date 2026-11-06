/**
 * Epic 18.5 — divergence detection.
 *
 * Reports the first difference between two 9.1 authoritative checkpoints.
 * The stored report is the 9.4 `CheckpointDivergence`: tick, checkpointTick,
 * horizonOffset, entityId, fieldPath, expected, actual. This module reads
 * those columns as tick, entity, component, expected value, and actual value.
 * It does not add, rename, or remove a column.
 *
 * Equality stays `compareCheckpoints`. Object keys are not sorted here.
 * Regression fixtures are 18.6. The live match does not call this module.
 */
import type { AuthoritativeCheckpoint } from "./authoritativeCheckpoint.ts";
import {
  type CheckpointDivergence,
  compareCheckpoints,
} from "./checkpointValidation.ts";

/**
 * The five names in the 18.5 report. `entity` is `entityId`. `component`
 * is `fieldPath`. `checkpointTick` and `horizonOffset` stay on the stored
 * report and are not part of this view.
 */
export type ReplayDivergenceFacts = {
  readonly tick: number;
  readonly entity: string;
  readonly component: string;
  readonly expected: unknown;
  readonly actual: unknown;
};

/**
 * First checkpoint difference, or null when the two captures match.
 * Omitting `checkpointTick` uses the 9.4 default (`expected.tick`).
 */
export function detectReplayDivergence(
  expected: AuthoritativeCheckpoint,
  actual: AuthoritativeCheckpoint,
  tick: number,
  checkpointTick?: number,
): CheckpointDivergence | null {
  return compareCheckpoints(expected, actual, tick, checkpointTick);
}

/** Read the stored columns as tick, entity, component, expected, and actual. */
export function replayDivergenceFacts(
  report: CheckpointDivergence,
): ReplayDivergenceFacts {
  return Object.freeze({
    tick: report.tick,
    entity: report.entityId,
    component: report.fieldPath,
    expected: report.expected,
    actual: report.actual,
  });
}

/** One line: `tick N entity E component C expected V actual V`. */
export function formatReplayDivergence(report: CheckpointDivergence): string {
  const facts = replayDivergenceFacts(report);
  return `tick ${facts.tick} entity ${renderValue(facts.entity)} component ${
    renderValue(facts.component)
  } expected ${renderValue(facts.expected)} actual ${
    renderValue(facts.actual)
  }`;
}

function renderValue(value: unknown): string {
  if (Object.is(value, -0)) return "-0";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "NaN";
    if (value === Infinity) return "Infinity";
    if (value === -Infinity) return "-Infinity";
  }
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}
