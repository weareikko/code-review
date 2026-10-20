/**
 * Location-matching scorer for the input-mode comparison eval.
 *
 * The existing evals proxy recall with "did any severe finding appear" — which
 * scores an agent that commented on file 1 identically to one that found the
 * planted bug in file 7. This scorer matches each finding to a planted bug by
 * file + new-side line (within a tolerance) so we get real per-bug recall and a
 * precision figure (share of severe findings that actually hit a planted bug).
 *
 * Read-coverage is computed separately from the trajectory: the caller resolves
 * which SOURCE files the agent opened (mapping staged-diff disk paths back to
 * their origin where relevant) and passes them in, because that mapping depends
 * on the input mode's staging layout, not on scoring.
 */

import type { ReviewComment } from '../../src/types.js';
import type { PlantedBug } from './synthetic.js';

const DEFAULT_TOLERANCE = 3;

function isSevere(comment: ReviewComment): boolean {
  return comment.severity === 'critical' || comment.severity === 'warn';
}

export interface BugOutcome {
  bug: PlantedBug;
  detected: boolean;
  /** Detected by a severe (critical/warn) finding, not just an info note. */
  detectedSevere: boolean;
  matchedLine?: number;
}

export interface ReadCoverage {
  filesReadCount: number;
  allFilesCount: number;
  coverage: number;
  bugFilesRead: number;
  bugFilesTotal: number;
  bugFileCoverage: number;
}

export interface ScoreResult {
  totalBugs: number;
  detected: number;
  detectedSevere: number;
  recall: number;
  recallSevere: number;
  severeFindings: number;
  matchedSevereFindings: number;
  /** matched severe findings / all severe findings; null when there are none. */
  precision: number | null;
  falsePositives: number;
  perBug: BugOutcome[];
  readCoverage?: ReadCoverage;
}

export interface ScoreInput {
  comments: ReviewComment[];
  groundTruth: PlantedBug[];
  /** New-side line tolerance for a location match (default 3). */
  tolerance?: number;
  /** Source files the agent actually opened (already mapped from disk paths). */
  filesReadSource?: string[];
  /** All source files in the change (for read-coverage denominator). */
  allFiles?: string[];
}

function matchesBug(comment: ReviewComment, bug: PlantedBug, tolerance: number): boolean {
  return comment.file === bug.file && Math.abs(comment.line - bug.line) <= tolerance;
}

export function scoreReview(input: ScoreInput): ScoreResult {
  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;
  const { comments, groundTruth } = input;

  const perBug: BugOutcome[] = groundTruth.map((bug) => {
    const hits = comments.filter((c) => matchesBug(c, bug, tolerance));
    const severeHit = hits.find(isSevere);
    const anyHit = hits[0];
    return {
      bug,
      detected: hits.length > 0,
      detectedSevere: severeHit !== undefined,
      matchedLine: (severeHit ?? anyHit)?.line,
    };
  });

  const detected = perBug.filter((b) => b.detected).length;
  const detectedSevere = perBug.filter((b) => b.detectedSevere).length;

  const severe = comments.filter(isSevere);
  const matchedSevereFindings = severe.filter((c) =>
    groundTruth.some((bug) => matchesBug(c, bug, tolerance)),
  ).length;

  const totalBugs = groundTruth.length;
  const result: ScoreResult = {
    totalBugs,
    detected,
    detectedSevere,
    recall: totalBugs === 0 ? 1 : detected / totalBugs,
    recallSevere: totalBugs === 0 ? 1 : detectedSevere / totalBugs,
    severeFindings: severe.length,
    matchedSevereFindings,
    precision: severe.length === 0 ? null : matchedSevereFindings / severe.length,
    falsePositives: severe.length - matchedSevereFindings,
    perBug,
  };

  if (input.filesReadSource && input.allFiles) {
    const read = new Set(input.filesReadSource);
    const bugFiles = new Set(groundTruth.map((b) => b.file));
    const bugFilesRead = [...bugFiles].filter((f) => read.has(f)).length;
    const readInChange = input.allFiles.filter((f) => read.has(f)).length;
    result.readCoverage = {
      filesReadCount: readInChange,
      allFilesCount: input.allFiles.length,
      coverage: input.allFiles.length === 0 ? 1 : readInChange / input.allFiles.length,
      bugFilesRead,
      bugFilesTotal: bugFiles.size,
      bugFileCoverage: bugFiles.size === 0 ? 1 : bugFilesRead / bugFiles.size,
    };
  }

  return result;
}

/** Average a set of score results (across trials), for reporting mean recall/precision/etc. */
export function meanScores(results: ScoreResult[]): {
  recall: number;
  recallSevere: number;
  precision: number | null;
  falsePositives: number;
  bugFileCoverage: number | null;
} {
  if (results.length === 0) {
    return {
      recall: 0,
      recallSevere: 0,
      precision: null,
      falsePositives: 0,
      bugFileCoverage: null,
    };
  }
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const precisions = results.map((r) => r.precision).filter((p): p is number => p !== null);
  const coverages = results
    .map((r) => r.readCoverage?.bugFileCoverage)
    .filter((c): c is number => c !== undefined);
  return {
    recall: mean(results.map((r) => r.recall)),
    recallSevere: mean(results.map((r) => r.recallSevere)),
    precision: precisions.length === 0 ? null : mean(precisions),
    falsePositives: mean(results.map((r) => r.falsePositives)),
    bugFileCoverage: coverages.length === 0 ? null : mean(coverages),
  };
}
