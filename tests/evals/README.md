# Eval suite

LLM-backed evaluations for the gitlab-review reviewer agent. Real model calls
hit Anthropic (or your configured provider); the suite is skipped automatically
when no API key is present.

Run with: `npm run test:evals`

## What this suite is for

These evals exist to keep the reviewer **reliable on the workflows users
actually run** — not to chase a benchmark score. Each `describeEval` block
exercises one concrete failure mode that we either observed in production or
deliberately want to prevent from regressing.

The framing is floor-raising: ask **"which case fails?"**, not "what's our
average score?". If you find yourself wanting to add a new eval, the right
question is "what real review failure does this prevent from coming back?".

## Anatomy

Each eval has three moving parts:

1. **A fixture** in `fixtures/` — usually a `.diff` and (optionally) a
   `.commitlog` and `.prior-threads.json`.
2. **A judge** (or panel) that decides pass/fail.
3. **A `describeEval` block** that wires the fixture to the judges and sets
   the threshold.

Judges come in two flavours:

- **Deterministic / lexical** judges (`createJudge` from `vitest-evals`) — for
  things that are genuinely string-shaped: severity counts, regex matches on
  the Conventional Comments header, lookups for specific tokens like
  `ADR-042`, `VPN`, or the 10.x subnet in prior-thread evals.
- **Rubric LLM judges** (`createLlmJudge` from `./llm-judge.ts`) — for "did
  the reviewer correctly identify X?" questions where keyword matching is
  brittle. The judge sees the full summary + inline comments and returns a
  structured `{score, rationale}` verdict against a written rubric.

Use the deterministic kind whenever the property is actually lexical. Reach
for the LLM judge when the property is semantic and a keyword list would let
through false positives.

## Trajectory capture

`tests/evals/trajectory.ts` captures the agent's turn count and tool calls
via the existing `attachTelemetry` hook. The trajectory is exposed on
`EvalOutput.trajectory` so judges can assert on the path the agent took, not
just its output. Two trajectory-based judges live in the suite:

- `TrajectoryShapeJudge` — always passes, surfaces turn/tool counts in run
  metadata for observability.
- `SkillFileReadJudge` — recording-only; flags runs where a configured skill
  is never opened.

## Adding a new eval

The reproduction-first loop:

1. Reproduce the failure: `npm run snapshot:mr -- --project group/repo --mr 123 --name <slug>`
2. Paste the printed `describeEval` stub into `review.eval.ts`.
3. Pick the right judge(s):
   - **Bug detection** ("the reviewer should have caught X") → LLM judge with
     a one-sentence rubric.
   - **False positive prevention** ("the reviewer should NOT have flagged Y")
     → `NoSevereFindingsJudge` plus `HonestRefusalJudge`.
   - **Format / structural** invariants → deterministic regex/severity judges.
4. Pick the threshold:
   - `judgeThreshold: 1` — enforcing. Use only when the property is stable
     enough that a one-off LLM blip will not constantly flake CI.
   - `judgeThreshold: null` — recording only. Use when the property is
     valuable to track but model variance would cause noise.

## Pruning policy

> "20 high-signal cases beats 200 low-signal ones."

Every eval costs real tokens on every run. Bloat is the failure mode here —
not too few cases. Apply this checklist before keeping a new eval long-term:

- Does it catch a class of failure we **actually saw** in production or in a
  prior review? Speculative tests that "might be useful someday" add cost
  without signal.
- Is the judge **measuring the thing we care about**? A judge that almost
  always scores 1 isn't proving the property holds — it's proving the
  property is easy. Either tighten the rubric or remove the judge.
- Does the fixture **discriminate**? If with-skill and without-skill produce
  identical scores, the eval isn't measuring the skill's contribution.

And periodically:

- **3-month no-fail rule**: if an enforcing eval has never failed in the last
  3 months across model upgrades, ask whether it's still pulling its weight.
  Either downgrade it to recording-only, or remove it. The exception is
  format/structural evals — those are cheap and the property is binary.
- **Recording-only graveyard**: a recording-only eval that hasn't produced a
  surprising score in 3 months should probably be deleted, not promoted.
  Recording-only evals exist to gather evidence; once the evidence is in,
  the eval has done its job.

When in doubt, lean toward removing. We can always re-add an eval from a new
production failure via `snapshot:mr`.

## Environment

- `GITLAB_REVIEW_API_KEY` (or `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY`) — required.
- `GITLAB_REVIEW_EVAL_MODEL` — reviewer model under test. Default:
  `anthropic/claude-sonnet-4-5`.
- `GITLAB_REVIEW_EVAL_JUDGE_MODEL` — LLM judge model. Default:
  `claude-haiku-4-5-20251001` (fast and cheap; the judge task is small).
- `GITLAB_REVIEW_EVAL_JUDGE_BASE_URL` — override the judge API base URL when
  using a proxy. The judge endpoint is always `/v1/messages`.
- `GITLAB_REVIEW_BASE_URL`, `GITLAB_REVIEW_MAX_TOKENS` — passed through to
  the reviewer config.
