import { describe, expect, it } from 'vitest';
import { resolveConfig, validateConfig } from './config.js';
import { ConfigError, ReviewerError, formatError } from './errors.js';

describe('typed errors', () => {
  it('throws ConfigError for invalid config', () => {
    expect(() => validateConfig(resolveConfig([], {}))).toThrow(ConfigError);
  });

  it('formats typed errors with code and hint', () => {
    const error = new ReviewerError('review failed', { hint: 'check logs' });
    expect(formatError(error)).toBe('[REVIEWER_ERROR] review failed\nHint: check logs');
  });
});
