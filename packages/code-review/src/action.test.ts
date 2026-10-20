import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { PRODUCT_NAME } from './product.js';

// The composite action lives at the repo root (referenced as
// `weareikko/code-review@<ref>` from consumer workflows), one level up from
// this `src/` file.
const actionPath = fileURLToPath(new URL('../action.yml', import.meta.url));
const action = parse(readFileSync(actionPath, 'utf8')) as {
  runs?: { using?: string; steps?: Array<{ uses?: string; run?: string; shell?: string }> };
  inputs?: Record<string, { required?: boolean; default?: unknown }>;
};

describe('action.yml composite action', () => {
  it('is a composite action', () => {
    expect(action.runs?.using).toBe('composite');
  });

  it('requires a model input and defaults the github token to the workflow token', () => {
    expect(action.inputs?.model?.required).toBe(true);
    expect(action.inputs?.['github-token']?.default).toBe('${{ github.token }}');
  });

  it('runs the published package, not a renamed fork', () => {
    const runStep = action.runs?.steps?.find((step) => typeof step.run === 'string');
    expect(runStep?.shell).toBe('bash');
    expect(runStep?.run).toContain(`${PRODUCT_NAME}@`);
  });

  it('sets up Node before running the CLI', () => {
    const steps = action.runs?.steps ?? [];
    const setupIndex = steps.findIndex((step) => step.uses?.startsWith('actions/setup-node@'));
    const runIndex = steps.findIndex((step) => typeof step.run === 'string');
    expect(setupIndex).toBeGreaterThanOrEqual(0);
    expect(runIndex).toBeGreaterThan(setupIndex);
  });
});
