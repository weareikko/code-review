/**
 * The published package name, shown in review footers. Independent of the review
 * platform: the same tool posts to GitLab and GitHub, so the footer identifies
 * the tool, not the backend. Kept as a single source of truth so the inline and
 * summary footers can never drift apart.
 */
export const PRODUCT_NAME = '@weareikko/code-review';

/** Canonical project URL used in the footer's markdown link. */
export const PRODUCT_URL = 'https://github.com/weareikko/code-review';

/**
 * The `[name](url)` markdown link used verbatim in both the inline comment footer
 * ({@link buildCommentBody}) and the reviewed-commit summary footer
 * ({@link buildReviewedCommitFooter}). Changing this changes the reviewed-commit
 * footer format, which is guarded by a migration test.
 */
export const PRODUCT_LINK = `[${PRODUCT_NAME}](${PRODUCT_URL})`;
