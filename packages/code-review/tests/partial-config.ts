import type { Config } from '../src/config.js';

/**
 * A `Config` for a test that sets only the fields the code under test reads.
 * `Partial<Config>` still checks the name and the type of each field it sets.
 */
export function partialConfig(fields: Partial<Config>): Config {
  return fields as Config;
}
