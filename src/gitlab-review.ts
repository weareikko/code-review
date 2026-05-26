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
import type { Skill } from './skills.js';
import { loadAutoDiscoveredSkills, loadNamedSkill } from './skills.js';
import type { GitLabReviewSeverity, ThinkingLevel } from './types.js';
import { toGitLabReviewSeverity } from './types.js';

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
  createAgent?: CreateAgent;
  timeoutMs?: number;
  logger?: Logger;
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
    '- 🔴 CRITICAL: bugs causing runtime failures, security vulnerabilities, data loss risks',
    '- 🟡 WARN: type errors, missing error handling, logic issues, test gaps',
    '- 🔵 INFO: style, naming, performance hints, suggestions',
    '</severity_tiers>',
    '',
    '<rules>',
    '- Only flag what is actually wrong in the diff — no hypotheticals',
    '- If nothing is wrong, say so clearly',
    '- Do not make claims about external state (dates, library versions, deprecation status, API availability) that cannot be verified from the diff itself',
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
    '  "summary": "Overall review in **Markdown**. Use bullet points, `code spans`, and **bold** for clarity.",',
    '  "comments": [',
    '    { "file": "src/auth.ts", "line": 42, "side": "RIGHT", "severity": "CRITICAL", "body": "Inline comment in Markdown." }',
    '  ]',
    '}',
    '</output_format>',
    '',
    'Field rules:',
    '- summary: overall review written in Markdown',
    '- comments: inline comments attached to specific diff lines (may be empty [])',
    '- file: relative path from repo root',
    '- line: line number in the file (not the diff position)',
    '- side: "RIGHT" for added/context lines, "LEFT" for removed lines',
    '- severity: "CRITICAL" | "WARN" | "INFO"',
    '- body: inline comment text, may use Markdown',
  ].join('\n');

  const sections = [base];
  const conventions = mergeContent(context.conventions).trim();
  if (conventions) sections.push(`<conventions>\n${conventions}\n</conventions>`);
  const reviewRules = mergeContent(context.reviewRules).trim();
  if (reviewRules) sections.push(`<review_rules>\n${reviewRules}\n</review_rules>`);
  if (context.skills.length > 0) {
    const preamble =
      'Read each skill file before applying it. Skills contain additional review guidelines specific to this project.';
    const skillSections = context.skills.map(buildSkillSection).join('\n\n');
    sections.push(`<skills>\n${preamble}\n\n${skillSections}\n</skills>`);
  }
  return sections.join('\n\n');
}

export function buildUserPrompt(diff: string, skippedFiles: string[] = []): string {
  const parts = [`Review this diff:\n<diff>\n${diff}\n</diff>`];
  if (skippedFiles.length > 0) {
    parts.push(
      `<skipped_files>\n${skippedFiles
        .map((file) => `- ${file}`)
        .join(
          '\n',
        )}\n</skipped_files>\nThe above files were not included because the diff exceeded the size limit. Mention them explicitly in your summary as not reviewed.`,
    );
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
  const idx = modelString.indexOf('/');
  if (idx < 0) {
    throw new ReviewerError(
      `Invalid model format "${modelString}". Expected "provider/modelId" (e.g. "anthropic/claude-sonnet-4-5").`,
    );
  }
  const provider = modelString.slice(0, idx);
  const modelId = modelString.slice(idx + 1);

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
  const userPrompt = buildUserPrompt(diff, skippedFiles);

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
