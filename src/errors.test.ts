import { describe, expect, it } from 'vitest';
import { resolveConfig, validateConfig } from './config.js';
import {
  ConfigError,
  formatError,
  isQuotaExceededError,
  isQuotaExceededMessage,
  ReviewerError,
} from './errors.js';

describe('typed errors', () => {
  it('throws ConfigError for invalid config', () => {
    expect(() => validateConfig(resolveConfig([], {}))).toThrow(ConfigError);
  });

  it('formats typed errors with code and hint', () => {
    const error = new ReviewerError('review failed', { hint: 'check logs' });
    expect(formatError(error)).toBe('[REVIEWER_ERROR] review failed\nHint: check logs');
  });
});

describe('isQuotaExceededMessage', () => {
  it.each([
    'Agent failed: 402 Insufficient wholesale credits. Please add additional credits',
    'Your credit balance is too low to access the API',
    '429 insufficient_quota: You exceeded your current quota',
    'Payment Required',
    'You are out of credit',
    'billing hard limit has been reached',
  ])('matches credit/quota exhaustion: %s', (message) => {
    expect(isQuotaExceededMessage(message)).toBe(true);
  });

  it.each([
    undefined,
    '',
    '429 Too Many Requests: rate limit exceeded',
    'Agent returned an empty response.',
    'Review timed out after 600s',
  ])('does not match transient/unrelated errors: %s', (message) => {
    expect(isQuotaExceededMessage(message)).toBe(false);
  });
});

describe('isQuotaExceededError', () => {
  it('honours the quotaExceeded flag on a typed error', () => {
    expect(isQuotaExceededError(new ReviewerError('Agent failed', { quotaExceeded: true }))).toBe(
      true,
    );
  });

  it('classifies a plain Error by its message', () => {
    expect(isQuotaExceededError(new Error('402 Insufficient wholesale credits'))).toBe(true);
    expect(isQuotaExceededError(new Error('boom'))).toBe(false);
  });

  it('returns false for non-error values', () => {
    expect(isQuotaExceededError('nope')).toBe(false);
    expect(isQuotaExceededError(undefined)).toBe(false);
  });
});
