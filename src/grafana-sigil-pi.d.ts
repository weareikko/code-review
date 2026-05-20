/**
 * Ambient type declaration for @grafana/sigil-pi.
 *
 * The package ships a single bundled dist/index.js with no .d.ts files.
 * We only call `default(pi)` where `pi` needs an `.on()` method, so the
 * minimal type below is sufficient.
 */
declare module '@grafana/sigil-pi' {
  type PiEventHandler = (...args: unknown[]) => void | Promise<void>;
  type MinimalPi = { on: (event: string, handler: PiEventHandler) => void };
  const sigilPiFactory: (pi: MinimalPi) => void | Promise<void>;
  export default sigilPiFactory;
}
