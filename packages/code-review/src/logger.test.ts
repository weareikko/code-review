import { describe, expect, it, vi } from 'vitest';
import { createLogger, noopLogger } from './logger.js';

describe('logger', () => {
  it('noopLogger never writes to stderr', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    noopLogger.debug('d');
    noopLogger.info('i');
    noopLogger.warn('w');
    noopLogger.error('e');
    expect(write).not.toHaveBeenCalled();
    write.mockRestore();
  });

  it('createLogger at info level suppresses debug, emits info/warn/error', () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const logger = createLogger('info');
    logger.debug('hidden');
    logger.info('visible-info');
    logger.warn('visible-warn');
    logger.error('visible-error');
    vi.restoreAllMocks();
    expect(lines.some((l) => l.includes('hidden'))).toBe(false);
    expect(lines.some((l) => l.includes('visible-info'))).toBe(true);
    expect(lines.some((l) => l.includes('visible-warn'))).toBe(true);
    expect(lines.some((l) => l.includes('visible-error'))).toBe(true);
  });

  it('createLogger at debug level emits all levels', () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const logger = createLogger('debug');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    vi.restoreAllMocks();
    expect(lines.some((l) => l.includes('d'))).toBe(true);
    expect(lines.some((l) => l.includes('i'))).toBe(true);
  });

  it('createLogger at error level only emits error', () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const logger = createLogger('error');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('only-this');
    vi.restoreAllMocks();
    expect(lines.filter((l) => l.includes('[code-review]'))).toHaveLength(1);
    expect(lines.some((l) => l.includes('only-this'))).toBe(true);
  });

  it('prefixes every line with [code-review]', () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const logger = createLogger('debug');
    logger.info('hello');
    vi.restoreAllMocks();
    expect(lines[0]).toBe('[code-review] hello\n');
  });

  it('createLogger defaults to info level when no argument is passed', () => {
    const lines: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      lines.push(String(chunk));
      return true;
    });
    const logger = createLogger();
    logger.debug('should-be-hidden');
    logger.info('should-show');
    vi.restoreAllMocks();
    expect(lines.some((l) => l.includes('should-be-hidden'))).toBe(false);
    expect(lines.some((l) => l.includes('should-show'))).toBe(true);
  });
});
