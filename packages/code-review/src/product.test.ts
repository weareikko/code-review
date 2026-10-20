import { describe, expect, it } from 'vitest';
import { PRODUCT_LINK, PRODUCT_NAME, PRODUCT_URL } from './product.js';

describe('product footer constants', () => {
  it('composes the footer link from the name and URL', () => {
    expect(PRODUCT_LINK).toBe(`[${PRODUCT_NAME}](${PRODUCT_URL})`);
  });

  // The reviewed-commit footer format is a migration tripwire: this pins the
  // exact rendered link so a rename cannot silently break dedup/skip parsing.
  it('renders the exact link used in review footers', () => {
    expect(PRODUCT_LINK).toBe('[@weareikko/code-review](https://github.com/weareikko/code-review)');
  });
});
