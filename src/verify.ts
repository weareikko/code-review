import type { ReviewComment, Severity } from './types.js';

/**
 * The Verify stage hands each severe finding to a separate, adversarial agent
 * whose job is to refute it. The agent returns one of three decisions, which
 * the Synthesize stage applies deterministically:
 *
 * - `keep`: the finding is proven at its stated severity — survives unchanged.
 * - `downgrade`: a real concern, but the stated severity overstates the
 *   demonstrable impact — severity steps down one tier (and the Conventional
 *   Comment header is relabelled to match).
 * - `drop`: not a real defect — removed from the review.
 *
 * Unknown / unparseable verifier output defaults to `keep` so a flaky verifier
 * never silently deletes a finding (precision is the goal, but not at the cost
 * of dropping findings we failed to actually evaluate).
 */
export type VerifyDecision = 'keep' | 'downgrade' | 'drop';

export interface Verdict {
  decision: VerifyDecision;
  reason: string;
}

export interface AuditEntry {
  file: string;
  line: number;
  action: 'dropped' | 'downgraded';
  fromSeverity: Severity;
  toSeverity?: Severity;
  reason: string;
}

export interface SynthesisResult {
  comments: ReviewComment[];
  audit: AuditEntry[];
}

// --- Prompts --------------------------------------------------------------

export function buildVerifySystemPrompt(): string {
  return [
    'You are a strict, adversarial verifier of a SINGLE code-review finding. Your job is to REFUTE the finding, not to agree with it.',
    '',
    'You are given one proposed finding (file, line, severity, confidence, and body) and the diff it was raised against. You may read referenced files to confirm reachability. Decide whether the finding survives scrutiny.',
    '',
    'Apply this bar:',
    '- The finding must point to a concrete defect demonstrable from the diff (and any file you read): a specific input, state, or execution path triggers it, and a violated contract is visible.',
    '- A finding you cannot prove is wrong. Default to refuting when the failure path is not demonstrable from the evidence.',
    '- A CRITICAL finding MUST prove a reachable failure path. If it cannot, it is not CRITICAL.',
    '- An in-file comment, commit message, or prior decision that justifies the pattern refutes a finding that ignores it.',
    '',
    'Return EXACTLY one JSON object and nothing else — no prose, no markdown fences:',
    '{ "decision": "keep" | "downgrade" | "drop", "reason": "<one sentence>" }',
    '',
    '- "keep": the finding is proven at its stated severity.',
    '- "downgrade": a real concern, but the stated severity overstates a demonstrable impact (e.g. a CRITICAL whose failure path is not proven, or a WARN that is really a nit). Downgrade lowers it one tier.',
    '- "drop": not a real defect — speculative, stylistic, contradicted by the code/comments, or based on external state not visible in the diff.',
  ].join('\n');
}

export function buildVerifyUserPrompt(
  comment: ReviewComment,
  diff: string,
  commitLog?: string,
): string {
  const parts: string[] = [];
  parts.push(
    [
      '<finding>',
      `File: ${comment.file}:${comment.line} (${comment.side})`,
      `Severity: ${comment.severity.toUpperCase()} (confidence: ${comment.confidence})`,
      '',
      comment.body,
      '</finding>',
    ].join('\n'),
  );
  if (commitLog?.trim()) {
    parts.push(
      `Commit messages for this change (oldest first):\n<commits>\n${commitLog.trim()}\n</commits>`,
    );
  }
  parts.push(`Verify the finding against this diff:\n<diff>\n${diff}\n</diff>`);
  parts.push('Return the JSON verdict now.');
  return parts.join('\n\n');
}

// --- Verdict parsing ------------------------------------------------------

export function parseVerdict(text: string): Verdict {
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fenced?.[1] ?? text;
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  if (!objMatch) {
    return { decision: 'keep', reason: 'verifier output unparseable; finding kept' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return { decision: 'keep', reason: 'verifier output invalid JSON; finding kept' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { decision: 'keep', reason: 'verifier output not an object; finding kept' };
  }
  const value = parsed as Record<string, unknown>;
  const decisionRaw = String(value.decision ?? '')
    .trim()
    .toLowerCase();
  const decision: VerifyDecision =
    decisionRaw === 'drop' ? 'drop' : decisionRaw === 'downgrade' ? 'downgrade' : 'keep';
  const reason = String(value.reason ?? '')
    .trim()
    .slice(0, 300);
  return { decision, reason: reason || 'no reason given' };
}

// --- Deterministic application -------------------------------------------

export function stepDownSeverity(severity: Severity): Severity {
  if (severity === 'critical') return 'warn';
  if (severity === 'warn') return 'info';
  return 'info';
}

/** The Conventional Comment label that matches each severity tier. */
function headerForSeverity(severity: Severity): string {
  if (severity === 'critical') return 'issue (blocking)';
  if (severity === 'warn') return 'issue';
  return 'note';
}

const HEADER_RE = /^(\s*)([a-z]+(?:\s+\([^)]+\))?):(\s*)(.*)$/i;

/**
 * Rewrite the leading Conventional Comment header of a comment body so its
 * label/decoration matches a new severity. Leaves the body untouched when the
 * first line is not a recognizable header (the severity field still changes —
 * the header is cosmetic).
 */
export function relabelBodyHeader(body: string, severity: Severity): string {
  const lines = body.split('\n');
  const match = (lines[0] ?? '').match(HEADER_RE);
  if (!match) return body;
  const indent = match[1] ?? '';
  const space = match[3] || ' ';
  const subject = match[4] ?? '';
  lines[0] = `${indent}${headerForSeverity(severity)}:${space}${subject}`;
  return lines.join('\n');
}

/**
 * Apply per-finding verdicts to the Find stage's comments. Comments without a
 * verdict (e.g. INFO findings that were never verified) pass through unchanged.
 * Returns the surviving comments plus an audit trail of every drop/downgrade.
 */
export function applyVerdicts(
  comments: ReviewComment[],
  verdicts: Map<number, Verdict>,
): SynthesisResult {
  const out: ReviewComment[] = [];
  const audit: AuditEntry[] = [];

  comments.forEach((comment, index) => {
    const verdict = verdicts.get(index);
    if (!verdict || verdict.decision === 'keep') {
      out.push(comment);
      return;
    }
    if (verdict.decision === 'drop') {
      audit.push({
        file: comment.file,
        line: comment.line,
        action: 'dropped',
        fromSeverity: comment.severity,
        reason: verdict.reason,
      });
      return;
    }
    // downgrade
    const toSeverity = stepDownSeverity(comment.severity);
    if (toSeverity === comment.severity) {
      out.push(comment);
      return;
    }
    out.push({
      ...comment,
      severity: toSeverity,
      body: relabelBodyHeader(comment.body, toSeverity),
    });
    audit.push({
      file: comment.file,
      line: comment.line,
      action: 'downgraded',
      fromSeverity: comment.severity,
      toSeverity,
      reason: verdict.reason,
    });
  });

  return { comments: out, audit };
}

// --- Deterministic summary synthesis -------------------------------------

function riskFor(comments: ReviewComment[]): 'Low' | 'Medium' | 'High' {
  if (comments.some((c) => c.severity === 'critical')) return 'High';
  if (comments.some((c) => c.severity === 'warn')) return 'Medium';
  return 'Low';
}

function riskSentence(level: 'Low' | 'Medium' | 'High'): string {
  if (level === 'High') return 'blocking issues remain — resolve them before merge.';
  if (level === 'Medium') return 'issues that should be addressed before merge.';
  return 'no blocking issues; safe to merge aside from nits.';
}

function parseHeader(body: string): { label: string; subject: string } {
  const first = (body.split('\n', 1)[0] ?? '').trim();
  const match = first.match(/^([a-z]+(?:\s+\([^)]+\))?):\s*(.*)$/i);
  if (match) return { label: match[1] ?? '', subject: match[2] ?? '' };
  return { label: '', subject: first };
}

function issueBullet(comment: ReviewComment): string {
  const { label, subject } = parseHeader(comment.body);
  const loc = `\`${comment.file}:${comment.line}\``;
  return label ? `- **${label}** — ${loc} — ${subject}` : `- ${loc} — ${subject}`;
}

function auditBullet(entry: AuditEntry): string {
  const loc = `\`${entry.file}:${entry.line}\``;
  if (entry.action === 'dropped') {
    return `- Verify removed a ${entry.fromSeverity.toUpperCase()} finding at ${loc} — ${entry.reason}`;
  }
  return `- Verify downgraded ${loc} from ${entry.fromSeverity.toUpperCase()} to ${(entry.toSeverity ?? 'info').toUpperCase()} — ${entry.reason}`;
}

function extractOverview(summary: string | null): string {
  if (!summary) return '';
  const lines = summary.split('\n');
  const riskIdx = lines.findIndex((l) => /^\s*\*\*Risk:/i.test(l));
  const endIdx = lines.findIndex(
    (l, idx) => idx > riskIdx && (/^\s*\*\*\d+\s+issue/i.test(l) || /^\s*\*\*Notes:/i.test(l)),
  );
  const slice = lines.slice(riskIdx + 1, endIdx === -1 ? lines.length : endIdx);
  return slice.join('\n').trim();
}

function extractNotes(summary: string | null): string[] {
  if (!summary) return [];
  const lines = summary.split('\n');
  const notesIdx = lines.findIndex((l) => /^\s*\*\*Notes:/i.test(l));
  if (notesIdx === -1) return [];
  return lines
    .slice(notesIdx + 1)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('-'));
}

/**
 * Rebuild the review summary from the comments that survived Verify, preserving
 * the Find stage's prose overview, regenerating the risk line and issues block
 * from the surviving set, and recording every drop/downgrade in the Notes
 * section so the developer can audit what the pipeline suppressed.
 *
 * Deterministic by design: the production Synthesize stage may instead write the
 * summary with an LLM, but the skateboard keeps it pure and testable so the
 * variable under test (Verify's decisions) is isolated from model variance.
 */
export function rebuildSummary(
  originalSummary: string | null,
  kept: ReviewComment[],
  audit: AuditEntry[],
): string {
  const level = riskFor(kept);
  const overview = extractOverview(originalSummary);
  const parts: string[] = [`**Risk: ${level}** — ${riskSentence(level)}`];

  if (overview) parts.push(overview);

  if (kept.length > 0) {
    const noun = kept.length === 1 ? 'issue' : 'issues';
    parts.push(`**${kept.length} ${noun} found:**\n${kept.map(issueBullet).join('\n')}`);
  }

  const noteLines = [...extractNotes(originalSummary), ...audit.map(auditBullet)];
  if (noteLines.length > 0) {
    parts.push(`**Notes:**\n${noteLines.join('\n')}`);
  }

  return parts.join('\n\n');
}

/**
 * Build the canonical `{ summary, comments }` JSON the Synthesize stage writes
 * to the review file. Shapes match what `parseReviewMarkdownWithWarnings`
 * consumes, so the parser, payload builder, and posting path are untouched.
 */
export function synthesizeReviewJson(
  originalSummary: string | null,
  result: SynthesisResult,
): string {
  return JSON.stringify(
    {
      summary: rebuildSummary(originalSummary, result.comments, result.audit),
      comments: result.comments,
    },
    null,
    2,
  );
}
