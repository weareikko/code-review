import { describe, expect, it } from 'vitest';
import { renderIntentBlock } from './intent.js';

describe('renderIntentBlock', () => {
  it('renders title and description inside an <intent> block', () => {
    const block = renderIntentBlock({ title: 'Add retries', description: 'Retry 3 times.' });
    expect(block).toBe(
      '<intent>\n<title>Add retries</title>\n<description>\nRetry 3 times.\n</description>\n</intent>',
    );
  });

  it('returns an empty string when there is no intent to show', () => {
    expect(renderIntentBlock(undefined)).toBe('');
    expect(renderIntentBlock({})).toBe('');
    expect(renderIntentBlock({ title: '   ', description: '  \n ' })).toBe('');
  });

  it('omits the description when only a title is given', () => {
    const block = renderIntentBlock({ title: 'Add retries', description: null });
    expect(block).toBe('<intent>\n<title>Add retries</title>\n</intent>');
  });

  it('caps a long description and marks the truncation', () => {
    const block = renderIntentBlock({ title: 't', description: 'x'.repeat(5_000) });
    expect(block).toContain('… (description truncated)');
    expect(block.length).toBeLessThan(4_200);
  });
});
