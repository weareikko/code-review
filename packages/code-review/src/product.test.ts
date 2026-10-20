import { skillSourceUrl } from '@weareikko/agent-context';
import { describe, expect, it } from 'vitest';
import { BUILTIN_SKILLS, PRODUCT_LINK, PRODUCT_NAME, PRODUCT_URL } from './product.js';

describe('product footer constants', () => {
  it('composes the footer link from the name and URL', () => {
    expect(PRODUCT_LINK).toBe(`[${PRODUCT_NAME}](${PRODUCT_URL})`);
  });

  // The reviewed-commit footer format is a migration tripwire: this pins the
  // exact rendered link so a rename cannot silently break dedup/skip parsing.
  it('renders the exact link used in review footers', () => {
    expect(PRODUCT_LINK).toBe('[@weareikko/code-review](https://github.com/weareikko/code-review)');
  });

  it('links a built-in skill to the package directory of the monorepo at the version tag', () => {
    expect(
      skillSourceUrl({ kind: 'builtin', name: 'code-review' }, { builtinSkills: BUILTIN_SKILLS }),
    ).toBe(
      `https://github.com/weareikko/code-review/blob/${BUILTIN_SKILLS.ref}/packages/code-review/skills/code-review/SKILL.md`,
    );
  });
});
