import { createJudge } from 'vitest-evals';
import type { Judge, JudgeContext } from 'vitest-evals';

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

type LlmJudgeVerdict = {
  score: 0 | 1;
  rationale: string;
};

function getApiKey(): string {
  return (
    process.env.GITLAB_REVIEW_API_KEY ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.CLAUDE_API_KEY ||
    ''
  );
}

function getBaseUrl(): string {
  // Reuse the reviewer's base URL when the user has configured a proxy (e.g.
  // OpenRouter via an Anthropic-compatible endpoint). If unset, hit Anthropic
  // directly. The judge endpoint is always /v1/messages.
  return process.env.GITLAB_REVIEW_EVAL_JUDGE_BASE_URL ?? DEFAULT_BASE_URL;
}

function getModel(): string {
  return process.env.GITLAB_REVIEW_EVAL_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
}

async function callJudge(systemPrompt: string, userPrompt: string): Promise<LlmJudgeVerdict> {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('LLM judge requires GITLAB_REVIEW_API_KEY / ANTHROPIC_API_KEY in env');
  }
  const url = `${getBaseUrl()}/v1/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      model: getModel(),
      max_tokens: 512,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `LLM judge request failed: ${res.status} ${res.statusText} — ${body.slice(0, 300)}`,
    );
  }
  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = (data.content ?? [])
    .map((c) => (c.type === 'text' ? (c.text ?? '') : ''))
    .join('')
    .trim();
  return parseVerdict(text);
}

function parseVerdict(text: string): LlmJudgeVerdict {
  // The judge is instructed to return a single JSON object. We strip code
  // fences and tolerate stray prose around the JSON.
  const fenced = text.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fenced?.[1] ?? text;
  const objMatch = candidate.match(/\{[\s\S]*\}/);
  if (!objMatch) {
    return { score: 0, rationale: `Judge returned non-JSON: ${text.slice(0, 200)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return { score: 0, rationale: `Judge returned invalid JSON: ${objMatch[0].slice(0, 200)}` };
  }
  if (!parsed || typeof parsed !== 'object' || !('score' in parsed) || !('rationale' in parsed)) {
    return {
      score: 0,
      rationale: `Judge JSON missing required fields: ${JSON.stringify(parsed).slice(0, 200)}`,
    };
  }
  const rawScore = (parsed as { score: unknown }).score;
  const score: 0 | 1 = rawScore === 1 || rawScore === '1' || rawScore === true ? 1 : 0;
  const rationale = String((parsed as { rationale: unknown }).rationale ?? '').slice(0, 600);
  return { score, rationale };
}

export type ReviewSummary = {
  summary: string;
  comments: Array<{
    file: string;
    line: number;
    severity: string;
    body: string;
  }>;
};

function renderReview(review: ReviewSummary): string {
  const commentLines = review.comments.map(
    (c, i) => `${i + 1}. [${c.severity.toUpperCase()}] ${c.file}:${c.line}\n${c.body}`,
  );
  return [
    '<summary>',
    review.summary || '(empty)',
    '</summary>',
    '',
    '<inline_comments>',
    commentLines.length > 0 ? commentLines.join('\n\n') : '(no inline comments)',
    '</inline_comments>',
  ].join('\n');
}

const JUDGE_SYSTEM_PROMPT = [
  'You are an evaluator of automated code reviews. Apply the rubric strictly:',
  'do not award credit for tangential mentions, vague concerns, or unrelated findings.',
  'Return a single JSON object with this exact shape, and nothing else:',
  '',
  '{"score": 0 | 1, "rationale": "<one short sentence>"}',
  '',
  'score=1 ONLY when the review clearly satisfies the rubric.',
  'score=0 when the review misses, is ambiguous about, or only tangentially touches the target.',
].join('\n');

/**
 * Build a rubric-driven LLM judge. The rubric is a short directive — one or
 * two sentences describing what counts as a passing review. The judge sees the
 * full summary and all inline comments.
 */
export function createLlmJudge<I, O extends ReviewSummary>(
  name: string,
  rubric: string,
): Judge<JudgeContext<I, O, Record<string, unknown>>> {
  return createJudge({
    name,
    assess: async ({ output }: JudgeContext<I, O, Record<string, unknown>>) => {
      const review = renderReview(output);
      const userPrompt = [
        'Evaluate the automated code review below against the rubric.',
        '',
        '<rubric>',
        rubric,
        '</rubric>',
        '',
        '<review>',
        review,
        '</review>',
        '',
        'Return the JSON verdict now.',
      ].join('\n');

      try {
        const verdict = await callJudge(JUDGE_SYSTEM_PROMPT, userPrompt);
        return {
          score: verdict.score,
          metadata: {
            rationale: verdict.rationale,
            judgeModel: getModel(),
          },
        };
      } catch (err) {
        return {
          score: 0,
          metadata: {
            rationale: `LLM judge error: ${(err as Error).message}`,
            judgeModel: getModel(),
          },
        };
      }
    },
  });
}
