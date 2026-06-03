import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AgentEvent, AgentTool } from '@earendil-works/pi-agent-core';
import { Agent } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, KnownProvider, Model } from '@earendil-works/pi-ai';
import { getModel } from '@earendil-works/pi-ai';
import { createReadOnlyTools } from '@earendil-works/pi-coding-agent';
import type { Config } from './config.js';
import { ReviewerError } from './errors.js';
import type { Logger } from './logger.js';
import { noopLogger } from './logger.js';
import type { PriorThread } from './prior-threads.js';
import { renderPriorThreadsBlock } from './prior-threads.js';
import type { Skill } from './skills.js';
import { loadAutoDiscoveredSkills, loadNamedSkill } from './skills.js';
import type { GitLabReviewSeverity, ThinkingLevel } from './types.js';
import { splitModel, toGitLabReviewSeverity } from './types.js';

export interface UsageBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface ReviewUsage {
  model: string;
  tokens: UsageBreakdown;
  cost: UsageBreakdown;
  skills: string[];
}

export interface AgentLike {
  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void;
  prompt(input: string): Promise<void>;
}

export interface CreateAgentParams {
  systemPrompt: string;
  model: Model<string>;
  tools: AgentTool[];
  thinkingLevel: ThinkingLevel;
  getApiKey: () => Promise<string>;
}

export type CreateAgent = (params: CreateAgentParams) => AgentLike;

export interface RunReviewOptions {
  cwd?: string;
  diff: string;
  /**
   * Commit messages for all non-merge commits in the MR (merge-base…HEAD),
   * in chronological order. When provided, a `<commits>` section is prepended
   * to the user prompt so the reviewer understands the intent behind each change.
   * Produced by `getMergeCommitLog` in `src/git.ts`.
   */
  commitLog?: string;
  createAgent?: CreateAgent;
  timeoutMs?: number;
  logger?: Logger;
  /**
   * Prior developer replies to bot-posted review threads on the MR.
   * When provided, a `<prior_review_feedback>` section is appended to the user
   * prompt after `<diff>` so the reviewer can avoid re-raising already-acknowledged
   * concerns and can provide contextual follow-up.
   * Produced by `extractPriorThreads` in `src/prior-threads.ts`.
   */
  priorThreads?: PriorThread[];
  /**
   * Called with the agent after it is created, before the first prompt.
   * Use this to attach telemetry (e.g. `otelBridge.createAgentTelemetry(runId)`).
   * The returned function, if any, is called after the review completes.
   */
  attachTelemetry?: (agent: AgentLike) => (() => void) | undefined;
}

const DEFAULT_REVIEW_TIMEOUT_MS = 10 * 60 * 1000;

interface ContextFile {
  path: string;
  content: string;
}

interface ReviewContext {
  conventions: ContextFile[];
  reviewRules: ContextFile[];
  skills: Skill[];
}

const DEFAULT_MAX_DIFF_CHARS = 100_000;
const CONVENTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
const REVIEW_RULE_FILES = ['REVIEW.md'];
const CONFIG_DIRS = ['.pi', '.claude', '.agents'];

const NOISE_PATTERNS: RegExp[] = [
  /^gitlab-review\.md$/,
  /^package-lock\.json$/,
  /^yarn\.lock$/,
  /^pnpm-lock\.yaml$/,
  /^bun\.lockb$/,
  /^\.yarn\//,
  /^dist\//,
  /^build\//,
  /^\.next\//,
  /^out\//,
  /^coverage\//,
  /^node_modules\//,
  /\.min\.(js|css)$/,
  /\.generated\.(ts|js)$/,
  /\.d\.ts$/,
];

const SEVERITY_RULE: Record<GitLabReviewSeverity, string | null> = {
  INFO: null,
  WARN: '- Only report CRITICAL and WARN issues — skip INFO',
  CRITICAL: '- Only report CRITICAL issues — skip WARN and INFO',
};

const exec = promisify(execFile);

function defaultCreateAgent(params: CreateAgentParams): AgentLike {
  return new Agent({
    initialState: {
      systemPrompt: params.systemPrompt,
      model: params.model,
      tools: params.tools,
      thinkingLevel: params.thinkingLevel,
    },
    getApiKey: params.getApiKey,
  });
}

async function findGitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd });
    return stdout.trim() || cwd;
  } catch {
    return cwd;
  }
}

async function readFirstMatch(dir: string, filenames: string[]): Promise<ContextFile | null> {
  for (const candidate of [dir, ...CONFIG_DIRS.map((d) => join(dir, d))]) {
    let entries: string[];
    try {
      entries = await readdir(candidate);
    } catch {
      continue;
    }
    const wanted = new Set(filenames.map((f) => f.toLowerCase()));
    const match = entries.find((entry) => wanted.has(entry.toLowerCase()));
    if (!match) continue;
    const fullPath = join(candidate, match);
    try {
      const content = await readFile(fullPath, 'utf8');
      return { path: fullPath, content };
    } catch {
      continue;
    }
  }
  return null;
}

async function walkUpContextFiles(
  cwd: string,
  filenames: string[],
  gitRoot: string,
): Promise<ContextFile[]> {
  const dirs: string[] = [];
  let current = cwd;
  while (true) {
    dirs.unshift(current);
    if (current === gitRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  const result: ContextFile[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    const file = await readFirstMatch(dir, filenames);
    if (!file || seen.has(file.path)) continue;
    seen.add(file.path);
    result.push({ path: relative(cwd, file.path) || file.path, content: file.content });
  }
  return result;
}

export async function loadReviewContext(
  cwd: string,
  skillNames: string[] = [],
  warn?: (msg: string) => void,
): Promise<ReviewContext> {
  const gitRoot = await findGitRoot(cwd);
  const [conventions, reviewRules, discovered] = await Promise.all([
    walkUpContextFiles(cwd, CONVENTION_FILES, gitRoot),
    walkUpContextFiles(cwd, REVIEW_RULE_FILES, gitRoot),
    loadAutoDiscoveredSkills(cwd, gitRoot, warn),
  ]);

  const skills = [...discovered];
  const discoveredNames = new Set(discovered.map((s) => s.name));
  const named = await Promise.all(
    skillNames.filter((n) => !discoveredNames.has(n)).map((n) => loadNamedSkill(n, cwd)),
  );
  skills.push(...named);

  return { conventions, reviewRules, skills };
}

export interface FilteredDiff {
  diff: string;
  skippedFiles: string[];
}

function parseFilePath(header: string): string | null {
  const match = header.match(/^diff --git a\/.+ b\/(.+)$/);
  return match?.[1] ?? null;
}

function isNoise(filePath: string): boolean {
  return NOISE_PATTERNS.some((re) => re.test(filePath));
}

export function filterDiff(raw: string, maxChars = DEFAULT_MAX_DIFF_CHARS): FilteredDiff {
  const sections = raw.split(/(?=^diff --git )/m).filter((section) => section.trim());
  const kept: string[] = [];
  const skippedFiles: string[] = [];

  for (const section of sections) {
    const firstLine = section.split('\n', 1)[0] ?? '';
    const filePath = parseFilePath(firstLine);
    if (filePath && isNoise(filePath)) {
      skippedFiles.push(filePath);
    } else {
      kept.push(section);
    }
  }

  const included: string[] = [];
  let totalChars = 0;
  for (const section of kept) {
    if (totalChars + section.length > maxChars) {
      const firstLine = section.split('\n', 1)[0] ?? '';
      const filePath = parseFilePath(firstLine);
      if (filePath) skippedFiles.push(filePath);
      continue;
    }
    included.push(section);
    totalChars += section.length;
  }

  return { diff: included.join(''), skippedFiles };
}

function mergeContent(files: ContextFile[]): string {
  return files.map((file) => file.content).join('\n\n');
}

function buildSkillSection(skill: Skill): string {
  const lines = [
    `<skill name="${skill.name}">`,
    `<description>${skill.description}</description>`,
    `<skill_file>${skill.filePath}</skill_file>`,
  ];
  if (skill.resourceDirs.length > 0) {
    const dirList = skill.resourceDirs.map((d) => `${d}/`).join(', ');
    lines.push(
      '',
      '<skill_resources>',
      `This skill is located at: ${skill.rootDir}`,
      `You can read files from ${dirList} using the Read tool with the full path.`,
      '</skill_resources>',
    );
  }
  lines.push('</skill>');
  return lines.join('\n');
}

function buildSharedBase(minSeverity: GitLabReviewSeverity): string[] {
  const rule = SEVERITY_RULE[minSeverity];
  const today = new Date().toISOString().slice(0, 10);
  return [
    `You are a code reviewer. Review the following PR diff carefully. Today's date is ${today}.`,
    '',
    '<severity_tiers>',
    'Severity reflects the IMPACT of the defect if it occurs. It is independent of how certain you are the code is wrong (that is `confidence`, see below).',
    '',
    '- CRITICAL: runtime failure, data loss or corruption, security vulnerability, broken auth, or production outage. Affects users, persistence, money, or availability.',
    '- WARN: logic error, dropped error, type-unsafe access, or contract break that produces wrong behaviour but does not rise to runtime failure or data loss.',
    '- INFO: nits, style, naming, hints, suggestions, questions. Things that are not concrete defects.',
    '</severity_tiers>',
    '',
    '<confidence_tiers>',
    'Confidence reflects how certain you are that the code is actually wrong. It is independent of severity (impact).',
    '',
    '- high: the defect is demonstrable from the diff alone. You can name the failing input or the exact line, and the violated contract is visible in the diff, the surrounding code, or referenced docs/tests.',
    '- medium: a defect is likely but depends on assumptions about caller behaviour, external state, or runtime context not fully visible in the diff.',
    '- low: a defect is plausible but you cannot prove it from the diff alone — you are reporting a smell or pattern that usually indicates a bug but might be intentional here.',
    '</confidence_tiers>',
    '',
    '<severity_confidence_interaction>',
    '- A CRITICAL finding MUST be high confidence. If you cannot prove the failure path from the diff, either downgrade severity (WARN/INFO) or downgrade confidence and re-evaluate severity.',
    '- A WARN finding at low confidence SHOULD be re-classified as INFO unless the impact is severe enough that even a chance is worth flagging.',
    '- When a commit message, prior thread reply, or in-file ADR/incident reference justifies a pattern that would otherwise be CRITICAL or WARN, do not raise it as severe — surface it in the summary Notes section instead.',
    '- Silence beats fabrication: a confident wrong CRITICAL is worse than a missed bug.',
    '</severity_confidence_interaction>',
    '',
    '<rules>',
    '- Only flag what is actually wrong in the diff — no hypotheticals',
    '- If nothing is wrong, say so clearly',
    '- Do not make claims about external state (dates, library versions, deprecation status, API availability) that cannot be verified from the diff itself',
    '- Write declaratively. Avoid "consider", "might want to", "could potentially", "you may want to" in issue and suggestion subjects. State the defect and the fix directly. If unsure it is wrong, omit it. (The question and thought labels are inherently tentative and exempt.)',
    '- The summary lists findings by their Conventional Comment subject only; it MUST NOT repeat the discussion, impact ("why it matters"), or suggested fix from any inline comment',
    '- Cross-cutting content (suppressed findings, unreviewed files, overall verdict) goes in the summary, never in inline comments',
    '- When a commit message, prior thread reply, or in-file ADR/incident reference suppresses what would otherwise be a CRITICAL or WARN finding, you MUST add a one-line bullet to the summary Notes section naming the file:line, the pattern, and the context that suppressed it (e.g. "src/probe.ts:13 — empty .catch() suppressed per ADR-042 / INC-2891"). Silent suppression is not acceptable: the developer must be able to audit what context you applied.',
    ...(rule ? [rule] : []),
    '</rules>',
  ];
}

export function buildJSONSystemPrompt(
  context: ReviewContext,
  minSeverity: GitLabReviewSeverity,
): string {
  const base = [
    ...buildSharedBase(minSeverity),
    '- Do not repeat what the project conventions already enforce',
    '',
    'Return only a JSON object matching this schema exactly (no markdown fences, no extra text, no extra fields — do not include the diff or any other field):',
    '<output_format>',
    '{',
    '  "summary": "Overall review in **Markdown**, following the <summary_skeleton> below.",',
    '  "comments": [',
    '    { "file": "src/auth.ts", "line": 42, "side": "RIGHT", "severity": "CRITICAL", "confidence": "high", "body": "issue (blocking): <subject>\\n\\n<discussion>" }',
    '  ]',
    '}',
    '</output_format>',
    '',
    'Field rules:',
    '- summary: overall review written in Markdown, following <summary_skeleton>',
    '- comments: inline comments attached to specific diff lines (may be empty [])',
    '- file: relative path from repo root',
    '- line: line number in the file (not the diff position)',
    '- side: "RIGHT" for added/context lines, "LEFT" for removed lines',
    '- severity: "CRITICAL" | "WARN" | "INFO" — the IMPACT tier from <severity_tiers>',
    '- confidence: "high" | "medium" | "low" — your CERTAINTY the code is wrong, from <confidence_tiers>. Required on every comment.',
    '- body: a Conventional Comment, see <comment_format>',
    '',
    '<comment_format>',
    'Each comment body is a Conventional Comment (https://conventionalcomments.org/) with this shape:',
    '',
    '  <label> [decoration]: <Subject — short, action-oriented, 5-10 words>',
    '',
    '  <Discussion: 1-2 sentences stating the concrete defect and observable impact, then the suggested fix. Prefer a fenced ```suggestion``` block when the fix is a small edit on the line(s) being commented; otherwise use prose or a ```diff``` block.>',
    '',
    'Allowed labels: issue, suggestion, nitpick, question, todo, chore, note, thought',
    'Allowed decorations: (blocking), (non-blocking), (if-minor)',
    'Do NOT emit "praise:" comments — out of scope for this reviewer.',
    '',
    'Label and decoration must match the severity field:',
    '- CRITICAL → "issue (blocking): ..."',
    '- WARN     → "issue: ..."  (no decoration; an unmarked issue is implicitly blocking per the spec)',
    '- INFO     → choose the fitting label: "nitpick: ...", "suggestion (non-blocking): ...", "note: ...", "question: ...", or "thought: ..."',
    '</comment_format>',
    '',
    '<summary_skeleton>',
    'The summary is rendered under a fixed "### Code Review" heading so every review looks the same and is easy to scan. Write the summary content in this EXACT order. The risk line and the overview are ALWAYS present; the issues block and the notes block appear only when they have content.',
    '',
    '  **Risk: <Low | Medium | High>** — <one sentence: the impact of merging this MR and how it should be handled. Low = no blocking issues, safe to merge aside from nits. Medium = wrong behaviour or missed cases that should be fixed before merge. High = data loss, security, broken auth, or a critical-path crash — do not merge until resolved. Anchor the level to the most severe finding.>',
    '',
    '  <2-3 sentence plain-prose overview of what the MR does. ALWAYS present, including on a clean review.>',
    '',
    '  **<N> issue(s) found:**',
    '  - **<label>** — `file:line` — <subject>',
    '  <One bullet per inline comment. Show only the subject (the text after the comment label); never restate the discussion, impact, or fix — those live in the inline comment. Omit this entire block when there are no inline comments.>',
    '',
    '  **Notes:**',
    '  <Only when there is something to surface: suppressed CRITICAL/WARN findings (one bullet each — file:line, the pattern, and the commit/ADR/prior-thread that justified leaving it un-flagged) and any unreviewed/skipped files. Omit this entire block when there is nothing to note.>',
    '</summary_skeleton>',
    '',
    '<example>',
    'Example output for a diff that introduces one real bug and one style nit:',
    '```json',
    '{',
    '  "summary": "**Risk: High** — The retry loop overcharges customers on the free-tier path; do not merge until the off-by-one is fixed.\\n\\nAdds a checkout retry helper used by the cart route, with one blocking off-by-one and one naming nit.\\n\\n**2 issues found:**\\n- **issue (blocking)** — `src/cart/retry.ts:42` — Loop runs N+1 attempts on first call\\n- **nitpick** — `src/cart/retry.ts:8` — Helper name shadows the `Retry` type",',
    '  "comments": [',
    '    {',
    '      "file": "src/cart/retry.ts",',
    '      "line": 42,',
    '      "side": "RIGHT",',
    '      "severity": "CRITICAL",',
    '      "confidence": "high",',
    '      "body": "issue (blocking): Loop runs N+1 attempts on first call\\n\\nThe `attempt <= maxAttempts` predicate executes the body one extra time when `maxAttempts === 0`, which is the configured value for the free-tier path. The first call therefore charges the customer twice on a 5xx response.\\n\\n```suggestion\\nwhile (attempt < maxAttempts) {\\n```"',
    '    },',
    '    {',
    '      "file": "src/cart/retry.ts",',
    '      "line": 8,',
    '      "side": "RIGHT",',
    '      "severity": "INFO",',
    '      "confidence": "high",',
    '      "body": "nitpick: Helper name shadows the `Retry` type\\n\\nNaming the local `Retry` shadows the imported `Retry` type from `./types.ts`. Rename to `runWithRetry`."',
    '    }',
    '  ]',
    '}',
    '```',
    '</example>',
  ].join('\n');

  const sections = [base];
  const conventions = mergeContent(context.conventions).trim();
  if (conventions) sections.push(`<conventions>\n${conventions}\n</conventions>`);
  const reviewRules = mergeContent(context.reviewRules).trim();
  if (reviewRules) sections.push(`<review_rules>\n${reviewRules}\n</review_rules>`);
  if (context.skills.length > 0) {
    const preamble = [
      'Read each skill file before applying it. Skills are mandatory rule sets — the actual review criteria live in the SKILL.md body, not in the one-line description below.',
      '',
      'For every skill listed below, you MUST:',
      '  1. Call the Read tool with the path in <skill_file> to load the SKILL.md content. Example: Read({ file_path: "/abs/path/to/skills/code-review/SKILL.md" }).',
      '  2. If the skill lists <skill_resources>, Read the references relevant to the languages or frameworks present in this diff (skip references that do not match the diff).',
      "  3. Apply the skill's criteria when forming and grading findings.",
      '',
      'A skill loaded but never read is a no-op — the description alone is not enough to apply the rules correctly.',
    ].join('\n');
    const skillSections = context.skills.map(buildSkillSection).join('\n\n');
    sections.push(`<skills>\n${preamble}\n\n${skillSections}\n</skills>`);
  }
  return sections.join('\n\n');
}

export function buildUserPrompt(
  diff: string,
  skippedFiles: string[] = [],
  commitLog?: string,
  priorThreads?: PriorThread[],
): string {
  const parts: string[] = [];
  if (commitLog?.trim()) {
    parts.push(`Commits in this MR (oldest first):\n<commits>\n${commitLog.trim()}\n</commits>`);
  }
  parts.push(`Review this diff:\n<diff>\n${diff}\n</diff>`);
  if (skippedFiles.length > 0) {
    parts.push(
      `<skipped_files>\n${skippedFiles
        .map((file) => `- ${file}`)
        .join(
          '\n',
        )}\n</skipped_files>\nThe above files were not included because the diff exceeded the size limit. Mention them explicitly in your summary as not reviewed.`,
    );
  }
  if (priorThreads && priorThreads.length > 0) {
    const block = renderPriorThreadsBlock(priorThreads);
    if (block) {
      parts.push(
        `The following threads were posted by a previous review run and have received developer replies. Use this context to avoid repeating already-acknowledged concerns and to provide informed follow-up:\n${block}`,
      );
    }
  }
  return parts.join('\n\n');
}

function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .map((part) => (part.type === 'text' ? part.text : ''))
    .join('')
    .trim();
}

export function extractLastAssistantText(messages: AssistantMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const text = extractAssistantText(messages[i]);
    if (text) return text;
  }
  return '';
}

/**
 * Build a Model object for an Ollama-hosted model.
 *
 * Ollama exposes an OpenAI-compatible `/v1` endpoint, so we use the
 * `openai-completions` API adapter. The `baseUrl` is taken from the
 * already-resolved config (derived from `OLLAMA_HOST` or `GITLAB_REVIEW_BASE_URL`).
 * Cost is zero — Ollama runs locally.
 */
function buildOllamaModel(
  modelId: string,
  baseUrl: string,
  maxTokens: number,
): Model<'openai-completions'> {
  const effectiveMaxTokens = maxTokens > 0 ? maxTokens : 4096;
  // Use a generous context window default. Ollama model context sizes vary
  // widely and can only be known by querying the server at runtime. We set a
  // large constant so the agent doesn't truncate context unnecessarily; the
  // model itself will cap actual generation at its own limit.
  const contextWindow = 131072;
  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions' as const,
    provider: 'ollama',
    baseUrl,
    reasoning: false,
    input: ['text' as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: effectiveMaxTokens,
  };
}

/**
 * Resolve a model string into a pi-ai `Model` object.
 *
 * The model string must be `"provider/modelId"` where `modelId` may itself
 * contain slashes for providers like OpenRouter (`openrouter/anthropic/claude-3-opus`).
 * Splitting is always done on the **first** slash only.
 *
 * Special providers:
 * - `ollama`: builds a local OpenAI-compatible model with the given `baseUrl`.
 *
 * @param modelString - Full model string, e.g. `"anthropic/claude-sonnet-4-5"`.
 * @param baseUrl     - Custom base URL override (used for Ollama or generic endpoints).
 * @param maxTokens   - Max output tokens; 0 means use the model's default.
 */
function resolveModel(modelString: string, baseUrl: string, maxTokens: number): Model<string> {
  const { provider, modelId } = splitModel(modelString);
  if (provider === undefined || modelId === undefined) {
    throw new ReviewerError(
      `Invalid model format "${modelString}". Expected "provider/modelId" (e.g. "anthropic/claude-sonnet-4-5").`,
    );
  }

  // Built-in Ollama support via the OpenAI-compatible API.
  if (provider === 'ollama') {
    const effectiveBase = baseUrl || 'http://localhost:11434/v1';
    return buildOllamaModel(modelId, effectiveBase, maxTokens);
  }

  const model = getModel(provider as KnownProvider, modelId as never) as Model<string> | undefined;
  if (!model) {
    throw new ReviewerError(`Unknown model "${modelString}".`, {
      hint: `Check that "${provider}" is a valid provider and "${modelId}" is a registered model ID.`,
    });
  }

  // Apply overrides when provided.
  // - baseUrl: redirect to a custom OpenAI-compatible endpoint.
  // - maxTokens: cap output tokens (0 keeps the model's registered default).
  if (baseUrl || maxTokens > 0) {
    return {
      ...model,
      ...(baseUrl ? { baseUrl } : {}),
      ...(maxTokens > 0 ? { maxTokens } : {}),
    };
  }
  return model;
}

interface AggregatedUsage {
  tokens: UsageBreakdown;
  cost: UsageBreakdown;
}

function emptyUsage(): AggregatedUsage {
  return {
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function accumulateUsage(target: AggregatedUsage, message: AssistantMessage): void {
  const usage = message.usage;
  if (!usage) return;
  target.tokens.input += usage.input;
  target.tokens.output += usage.output;
  target.tokens.cacheRead += usage.cacheRead;
  target.tokens.cacheWrite += usage.cacheWrite;
  target.tokens.total += usage.totalTokens;
  if (usage.cost) {
    target.cost.input += usage.cost.input;
    target.cost.output += usage.cost.output;
    target.cost.cacheRead += usage.cost.cacheRead;
    target.cost.cacheWrite += usage.cost.cacheWrite;
    target.cost.total += usage.cost.total;
  }
}

export async function runReview(config: Config, options: RunReviewOptions): Promise<ReviewUsage> {
  const cwd = options.cwd ?? config.cwd;
  const minSeverity = toGitLabReviewSeverity(config.minSeverity);
  const logger = options.logger ?? noopLogger;

  const { diff, skippedFiles } = filterDiff(options.diff);
  if (!diff.trim()) {
    throw new ReviewerError('No reviewable diff content after filtering noise files.', {
      hint: 'Ensure the merge request introduces changes outside of generated/lock files.',
    });
  }

  const context = await loadReviewContext(cwd, config.skills, (msg) => logger.warn(msg));
  const systemPrompt = buildJSONSystemPrompt(context, minSeverity);
  const userPrompt = buildUserPrompt(diff, skippedFiles, options.commitLog, options.priorThreads);

  const skillNames = context.skills.map((s) => s.name);
  if (skillNames.length > 0) {
    logger.debug(`Skills loaded: ${skillNames.join(', ')}`);
  }
  if (context.conventions.length > 0) {
    logger.debug(`Conventions: ${context.conventions.map((f) => f.path).join(', ')}`);
  }
  if (context.reviewRules.length > 0) {
    logger.debug(`Review rules: ${context.reviewRules.map((f) => f.path).join(', ')}`);
  }

  const model = resolveModel(config.model, config.baseUrl ?? '', config.maxTokens ?? 0);
  const tools = createReadOnlyTools(cwd) as AgentTool[];

  const createAgent = options.createAgent ?? defaultCreateAgent;
  const agent = createAgent({
    systemPrompt,
    model,
    tools,
    thinkingLevel: config.thinkingLevel,
    getApiKey: async () => config.apiKey,
  });

  const aggregated = emptyUsage();
  const collectedAssistantMessages: AssistantMessage[] = [];
  let turnCount = 0;
  let toolCallCount = 0;

  // Attach telemetry before the first prompt so all events fire.
  const detachTelemetry = options.attachTelemetry?.(agent);

  const timeoutMs = options.timeoutMs ?? DEFAULT_REVIEW_TIMEOUT_MS;
  let unsubscribe: (() => void) | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let finalText = '';
  try {
    const ended = new Promise<void>((resolvePromise, rejectPromise) => {
      unsubscribe = agent.subscribe(async (event) => {
        if (event.type === 'turn_start') {
          turnCount += 1;
          logger.debug(`Turn ${turnCount} started`);
        }
        if (event.type === 'tool_execution_start') {
          toolCallCount += 1;
          const argsPreview = formatToolArgs(event.toolName, event.args);
          logger.debug(`  → ${event.toolName}${argsPreview}`);
        }
        if (event.type === 'message_end' && event.message.role === 'assistant') {
          const assistant = event.message as AssistantMessage;
          collectedAssistantMessages.push(assistant);
          accumulateUsage(aggregated, assistant);
        }
        if (event.type !== 'agent_end') return;
        const messages = event.messages.filter(
          (message): message is AssistantMessage => message.role === 'assistant',
        );
        const last = messages[messages.length - 1];
        if (last?.stopReason === 'error' || last?.errorMessage) {
          rejectPromise(new ReviewerError(`Agent failed: ${last.errorMessage ?? 'unknown error'}`));
          return;
        }
        finalText = extractLastAssistantText(
          collectedAssistantMessages.length > 0 ? collectedAssistantMessages : messages,
        );
        if (!finalText) {
          rejectPromise(new ReviewerError('Agent returned an empty response.'));
          return;
        }
        resolvePromise();
      });
    });

    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () =>
          reject(
            new ReviewerError(`Review timed out after ${Math.round(timeoutMs / 1000)}s`, {
              timeout: true,
              hint: 'Increase timeoutMs or reduce the diff size.',
            }),
          ),
        timeoutMs,
      );
    });

    await agent.prompt(userPrompt);
    await Promise.race([ended, timeout]);
  } finally {
    clearTimeout(timeoutId);
    unsubscribe?.();
    detachTelemetry?.();
  }

  const reviewPath = resolve(cwd, config.reviewFile);
  await mkdir(dirname(reviewPath), { recursive: true });
  await writeFile(reviewPath, finalText, 'utf8');

  logger.debug(`Agent finished: ${turnCount} turn(s), ${toolCallCount} tool call(s)`);

  return {
    model: config.model,
    tokens: aggregated.tokens,
    cost: aggregated.cost,
    skills: context.skills.map((s) => s.name),
  };
}

function formatToolArgs(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const obj = args as Record<string, unknown>;
  if (toolName === 'Read' || toolName === 'read') {
    return typeof obj.file_path === 'string' ? ` ${obj.file_path}` : '';
  }
  if (toolName === 'Bash' || toolName === 'bash') {
    return typeof obj.command === 'string' ? ` ${obj.command.slice(0, 80)}` : '';
  }
  const entries = Object.entries(obj)
    .slice(0, 2)
    .map(([k, v]) => `${k}=${String(v).slice(0, 40)}`);
  return entries.length > 0 ? ` ${entries.join(' ')}` : '';
}
