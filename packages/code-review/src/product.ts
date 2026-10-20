import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BuiltinSkillsLocation } from '@weareikko/agent-context';

declare const __PKG_VERSION__: string;

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

/** The tool's name for its cache directory: `<cache>/code-review/skills`. */
export const PRODUCT_SLUG = 'code-review';

/** Prefix of every environment variable this tool reads, named in configuration hints. */
export const ENV_PREFIX = 'CODE_REVIEW_';

/** The skills bundled in the package's `skills/` directory, which bare skill names resolve against. */
export const BUILTIN_SKILLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

/**
 * Where the bundled skills are published, so a footer links the exact version
 * that ran: the package's `skills/` directory in the monorepo, at the version tag.
 */
export const BUILTIN_SKILLS: BuiltinSkillsLocation = {
  repoWebUrl: PRODUCT_URL,
  ref: __PKG_VERSION__,
  path: 'packages/code-review/skills',
};
