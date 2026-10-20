import { FINGERPRINT_MARKER_PATTERN } from './fingerprints.js';
import type { Discussion, DiscussionNote } from './gitlab.js';
import { isBotNote } from './prior-threads.js';
import type { Severity } from './types.js';

// Global matcher so we can collect every fingerprint hash in a note body.
const FINGERPRINT_MARKER_GLOBAL_RE = new RegExp(FINGERPRINT_MARKER_PATTERN, 'gi');

/**
 * A bot-posted inline finding from a previous review run whose thread is still
 * open (unresolved). Carried into the current summary so an unresolved thread
 * never silently disappears from the issue list when a later run doesn't
 * re-emit it (#92).
 */
export interface CarryOverFinding {
  file: string;
  line: number | null;
  severity: Severity;
  /** Conventional Comment label incl. decoration, e.g. `issue (blocking)`. */
  header: string;
  subject: string;
  /** All fingerprint hashes found in the bot note (primary + secondary). */
  hashes: string[];
}

const RISK_RANK: Record<'Low' | 'Medium' | 'High', number> = { Low: 0, Medium: 1, High: 2 };

function positionFile(note: DiscussionNote): string | null {
  return note.position?.new_path ?? note.position?.old_path ?? null;
}

function positionLine(note: DiscussionNote): number | null {
  return note.position?.new_line ?? note.position?.old_line ?? null;
}

function noteHashes(body: string): string[] {
  const hashes: string[] = [];
  for (const match of body.matchAll(FINGERPRINT_MARKER_GLOBAL_RE)) {
    if (match[1]) hashes.push(match[1]);
  }
  return hashes;
}

const HEADER_RE = /^\s*([a-z]+(?:\s+\([^)]+\))?)\s*:\s*(.*)$/i;

/** Parse the Conventional Comment header from a finding body's first line. */
function parseHeader(body: string): { header: string; subject: string } {
  const first = body.replace(FINGERPRINT_MARKER_GLOBAL_RE, '').trim().split('\n', 1)[0] ?? '';
  const match = first.match(HEADER_RE);
  if (!match) return { header: '', subject: first.trim() };
  return { header: match[1]?.trim() ?? '', subject: (match[2] ?? '').trim() };
}

/** Map a Conventional Comment header back to the severity tier it encodes. */
function severityFromHeader(header: string): Severity {
  if (/^issue\s*\(blocking\)/i.test(header)) return 'critical';
  if (/^issue$/i.test(header)) return 'warn';
  return 'info';
}

function riskForSeverity(severity: Severity): 'Low' | 'Medium' | 'High' {
  if (severity === 'critical') return 'High';
  if (severity === 'warn') return 'Medium';
  return 'Low';
}

/**
 * Extract still-open (unresolved) bot-posted inline findings from prior MR
 * discussions. A discussion qualifies when its first bot note carries fingerprint
 * markers, sits on a file position, and no note in it is resolved.
 */
export function extractOpenBotFindings(discussions: Discussion[]): CarryOverFinding[] {
  const findings: CarryOverFinding[] = [];
  for (const discussion of discussions) {
    const notes = discussion.notes ?? [];
    const botNote = notes.find(isBotNote);
    if (!botNote) continue;
    // Only carry forward threads that are still open.
    if (notes.some((n) => n.resolved === true)) continue;
    const file = positionFile(botNote);
    if (!file) continue;
    const body = botNote.body ?? '';
    const hashes = noteHashes(body);
    if (hashes.length === 0) continue;
    const { header, subject } = parseHeader(body);
    findings.push({
      file,
      line: positionLine(botNote),
      severity: severityFromHeader(header),
      header,
      subject,
      hashes,
    });
  }
  return findings;
}

/**
 * From the still-open prior findings, keep only those the current run did NOT
 * re-emit — i.e. none of their fingerprints appear in `currentFingerprints`.
 * A re-emitted finding is already represented (posted or deduplicated), so it
 * must not be double-listed.
 */
export function selectCarryOver(
  openFindings: CarryOverFinding[],
  currentFingerprints: Set<string>,
): CarryOverFinding[] {
  return openFindings.filter((f) => !f.hashes.some((h) => currentFingerprints.has(h)));
}

function carryOverBullet(f: CarryOverFinding): string {
  const loc = f.line !== null ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
  const label = f.header ? `**${f.header}** — ` : '';
  const subject = f.subject ? ` — ${f.subject}` : '';
  return `- ${label}${loc}${subject}`;
}

/**
 * Fold carried-over findings into a summary so unresolved prior threads stay
 * visible and the risk line never drops below a still-open finding's level:
 *
 * 1. Bump the `**Risk: …**` line up (never down) if a carry-over outranks it.
 * 2. Append a `**Still open from earlier reviews (N):**` block listing them.
 *
 * Returns the summary unchanged when there is nothing to carry over, so
 * single-run / first-run output is byte-identical.
 */
export function applyCarryOverToSummary(summary: string, carryOvers: CarryOverFinding[]): string {
  if (carryOvers.length === 0) return summary;

  let result = summary;

  // 1. Monotonic risk: bump the level up if a carry-over outranks the stated one.
  const maxLevel = carryOvers
    .map((f) => riskForSeverity(f.severity))
    .reduce((a, b) => (RISK_RANK[b] > RISK_RANK[a] ? b : a), 'Low' as 'Low' | 'Medium' | 'High');
  result = result.replace(/^(\s*\*\*Risk:\s*)(Low|Medium|High)\b/im, (whole, prefix, current) => {
    const cur = current as 'Low' | 'Medium' | 'High';
    return RISK_RANK[maxLevel] > RISK_RANK[cur] ? `${prefix}${maxLevel}` : whole;
  });

  // 2. Append the still-open block.
  const noun = carryOvers.length === 1 ? 'finding' : 'findings';
  const block = [
    `**Still open from earlier reviews (${carryOvers.length} ${noun}):**`,
    ...carryOvers.map(carryOverBullet),
  ].join('\n');

  return `${result.trimEnd()}\n\n${block}`;
}

/**
 * Convenience wrapper: extract still-open prior findings, drop the ones the
 * current run re-emitted, and fold the rest into the summary.
 */
export function withCarriedOverFindings(
  summary: string,
  discussions: Discussion[],
  currentFingerprints: Set<string>,
): string {
  const carryOvers = selectCarryOver(extractOpenBotFindings(discussions), currentFingerprints);
  return applyCarryOverToSummary(summary, carryOvers);
}
