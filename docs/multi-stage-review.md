# Multi-stage review

Status: **proposed** (skateboard landed behind `--review-depth verify`, default off)

## Motivation

Today `runReview` is a **single agent, single pass**: one system prompt + skill,
one `agent.prompt(...)`, and the last assistant message is taken as the complete
`{ summary, comments }` JSON. Find, verify, and summarize all happen inside one
model's context.

The `code-review` skill already encodes a verification step ("Report only
defects that survive this verification") and the system prompt states the guiding
priority outright:

> Silence beats fabrication: a confident wrong CRITICAL is worse than a missed bug.

But that verification is **self-review in the same context** — the weakest kind.
A model is a poor skeptic of claims it just generated. The Claude Code review
loop (`Find → Triage → Verify → Sweep → Verify sweep`) wins precisely by making
the verifier a _separate_ agent that does not share the finder's context and is
told to break the finding.

This document describes how we adopt that pattern incrementally.

## Target architecture: three core stages

1. **Find** — produce candidate findings. Starts as today's single agent;
   pluggable to N finders later. Output: `CandidateFinding[]`, no summary.
2. **Verify** — each candidate goes to a separate, adversarial agent prompted to
   **refute** it. Output: a `Verdict` (`keep | downgrade | drop` + reason). The
   decision rule is applied in code, not by the model — it operationalizes the
   `severity_confidence_interaction` rules that today are only prose in the
   system prompt.
3. **Synthesize** — reconcile severities, dedup, and **write the summary from the
   set that survived Verify**. This is the non-obvious bit: in the single pass the
   summary and comments are produced together, so a verify pass that drops
   findings would leave the summary stale. Summary generation therefore moves out
   of Find and into Synthesize.

Verify's drops/downgrades are recorded in the summary **Notes** section so the
developer can audit what the pipeline suppressed — consistent with the existing
"silent suppression is not acceptable" rule.

### Why three, not five

The Claude Code display also shows **Triage** and **Sweep / Verify-sweep**. Those
are refinements with a poor cost-per-yield ratio for a CI-on-every-MR/PR reviewer:

- **Triage** (semantic dedup _between_ finders) only earns its keep once Find
  fans out into multiple overlapping agents. With one finder there is nothing to
  triage. It turns on with multi-angle Find.
- **Sweep → Verify-sweep** is the loop-until-dry tail: the most expensive, lowest
  marginal yield per token. Our diff is bounded, so there is far less to find in a
  "what did we miss" loop than in an open-ended repo task. Add it last, if ever.

## Depth tiers

A `--review-depth` flag (env `CODE_REVIEW_DEPTH`) selects how much of the
pipeline runs:

| `--review-depth`  | Stages active                       | Use                                  |
| ----------------- | ----------------------------------- | ------------------------------------ |
| `single`          | Find                                | today's behavior, cheapest, fallback |
| `verify` (target) | Find → Verify → Synthesize          | the 3-stage pipeline                 |
| `full` (future)   | + multi-angle Find + Triage + Sweep | large/risky MRs, opt-in              |

The current skateboard ships `single` and `verify`. `full` is future work.

### Stage-scoped model routing (`--verify-model`)

At `verify`/`full` depth the Find and Verify stages have different jobs: Find
casts a wide net (recall), Verify adversarially prunes (precision). `--verify-model`
(env `CODE_REVIEW_VERIFY_MODEL`) routes the Verify stage to its own model so a
**cheap, high-recall finder** can pair with a **strong, high-precision verifier**.
Measured on the eval fixtures, a cheap-find/strong-verify pairing matched an
all-strong pipeline on recall and precision at a fraction of the cost.

Two rules of thumb, both borne out by the measurements:

- **Don't route Verify to a cheaper tier than Find.** Verify is a precision-judgment
  task; a weak verifier refutes real findings and silently drops them (recall loss).
  The tool warns when the verify model looks cheaper than the find model.
- **Put the cheap tier on Find, the strong tier on Verify** — not the reverse.

Empty (default) keeps the pool-based cross-family verifier selection unchanged.

## Large diffs / the 100k cap (deferred)

`filterDiff` drops whole files once the diff crosses `DEFAULT_MAX_DIFF_CHARS`
(100k) and lists them as `skippedFiles`. That cap is a single-context artifact.
The fix is **chunked fan-out Find**: partition the diff into per-chunk budgets and
run one finder per chunk, so the global cap becomes a per-chunk cap and coverage
scales with finder count.

This is a property of the **Find** stage and is deferred. The intended policy when
it lands:

- **Coverage** (chunk-when-over-budget vs drop-when-over-budget) engages at the
  default depth, conditional on size — a normal MR/PR stays under budget and pays
  nothing extra.
- **Intensity** (multi-angle per chunk, Triage, Sweep) is what `full` buys.
- `single` keeps drop-and-flag as the cheap, predictable fallback.
- Residual hard case: a single file/hunk larger than the chunk budget needs
  intra-file splitting by hunk; anything still over budget is logged, never
  silently dropped.

## Skateboard scope (this change)

The smallest faithful slice that proves the precision win:

- New `reviewDepth` config (`single` | `verify`), default `single`.
- `single` mode is **byte-identical** to today: write the model's final text
  verbatim. All new code is behind `verify`.
- `verify` mode:
  - **Find**: the existing single agent, unchanged.
  - **Verify**: for each **severe** (CRITICAL/WARN) finding, an adversarial agent
    returns `keep | downgrade | drop`. INFO findings pass through untouched (they
    are not the precision risk and verifying them wastes tokens). Verifiers run
    concurrently with a small bound and reuse read-only repo tools.
  - **Synthesize**: deterministic. Filter/downgrade comments, regenerate the
    summary risk line + issues block from survivors, preserve Find's overview
    prose, and append an audit of what Verify changed to the Notes section. Emit
    the same `{ summary, comments }` JSON contract so the parser, payload builder,
    and posting path are untouched.

Deterministic synthesis is a deliberate skateboard choice: it keeps the variable
under test (Verify's drop decisions) isolated from a second LLM's variance and is
fully unit-testable. The **production** Synthesize stage should be an LLM call that
writes a richer summary — noted as follow-up.

## Validation

The eval harness drives `runReview` directly and re-parses the review file, so the
skateboard is measurable by threading `reviewDepth` through the harness and running
the _same_ fixture at both depths:

1. **Precision lift** — on a false-positive-prone fixture (`justified-intentional`),
   compare `NoSevereFindings` / `HonestRefusal` judge scores at `single` vs
   `verify`. Expectation: Verify drops the fabricated severe finding (`single`
   scores 0, `verify` scores 1).
2. **No recall loss** — on a real-bug fixture (`async-foreach-bug`), assert the bug
   is still detected at `verify` depth.
3. **Cost** — `ReviewUsage` aggregates verifier tokens, so the eval reports the
   token/cost delta of the extra pass.

## Follow-up (not in the skateboard)

- LLM-based Synthesize that writes a richer summary from survivors.
- Multi-angle Find + Triage (`full`).
- Chunked fan-out Find to remove the 100k coverage hole.
- Sweep / Verify-sweep loop-until-dry.
- Severity-scaled Verify (a small panel for CRITICALs, single verifier otherwise).
