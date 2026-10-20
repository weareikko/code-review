# JavaScript / TypeScript Correctness Reference

Use this reference when reviewing JavaScript, TypeScript, Node.js, React, or browser code changes. Load only when materially useful — do not apply patterns mechanically.

## Async and Promises

- **Missing await**: a `Promise` returned from an async function and not awaited silently discards the result and swallows thrown errors. Check call sites, event handlers, and middleware chains.
- **Unhandled rejection**: `Promise.all` rejects on the first failure; `Promise.allSettled` continues. Mixing them incorrectly drops results or hides errors.
- **Race condition in sequential reads**: reading a value before an async write completes produces stale data. Look for patterns where `.then()` chains or `await` steps are interleaved across shared mutable state.
- **`async` inside `forEach`**: `Array.prototype.forEach` does not await async callbacks. Use `for...of` or `Promise.all(arr.map(...))` when ordering or completion matters.

## Type and Value Coercion

- **Falsy conflation**: `0`, `""`, `false`, `null`, `undefined`, and `NaN` are all falsy. A guard like `if (!value)` incorrectly rejects legitimate values of `0` or `""`.
- **Loose equality**: `== null` matches both `null` and `undefined`; `=== null` does not. Changing from one to the other silently changes which values are accepted.
- **`typeof null === "object"`**: a classic trap. Distinguish `null` from objects explicitly when branching on type.
- **Optional chaining short-circuit**: `a?.b.c` evaluates `b.c` only when `a` is not null/undefined; `a?.b?.c` is needed when `b` may also be absent.

## Arrays and Collections

- **Mutating while iterating**: modifying an array inside a `forEach`, `for...of`, or `reduce` that reads the same array produces unpredictable results.
- **`Array.sort` is in-place**: `arr.sort(fn)` mutates the original. Callers expecting the original to be unchanged receive a sorted array.
- **Sparse array traps**: `Array(n)` creates a sparse array; `.map()` skips holes. Use `Array.from({ length: n })` for filled iteration.
- **`Set`/`Map` equality**: objects are compared by reference in `Set` and `Map`. Adding a structurally identical object creates a duplicate entry.

## Objects and Spread

- **Shallow copy**: `{ ...obj }` copies only top-level keys. Nested objects share the same reference; mutations propagate to both copies.
- **Prototype pollution**: merging untrusted input with `Object.assign` or spread can overwrite `__proto__`, `constructor`, or `toString`.
- **Key enumeration order**: `Object.keys` order is insertion order for string keys in modern engines but not guaranteed for numeric-like keys. Code relying on a specific order may break.

## Node.js Specifics

- **Synchronous blocking in async context**: `fs.readFileSync`, `execSync`, and similar block the event loop. Replacing an async path with a sync one in a request handler stalls concurrent requests.
- **`process.env` values are strings**: comparing `process.env.PORT === 8080` is always false; use `Number(process.env.PORT)`.
- **`require` caching**: modules are cached after first load. Mutating a required module's exports affects all other consumers in the same process.

## React / UI

- **Stale closure**: an event handler or `useEffect` callback closed over a state variable captures its value at render time. Reading it after an update returns the old value; use the functional updater form or a ref.
- **Missing dependency in `useEffect`**: omitting a variable from the dependency array means the effect does not re-run when that variable changes, silently using stale data.
- **Mutating state directly**: `state.items.push(x)` does not trigger a re-render; always return a new reference.
- **Key reuse across list types**: reusing the same `key` for different components in the same list causes React to reuse DOM nodes incorrectly.

## TypeScript-Specific

- **Non-null assertion `!`**: `value!` removes null/undefined from the type but adds no runtime check. If `value` is actually null at runtime, the assertion causes a downstream crash that TypeScript cannot catch.
- **`as` cast silences the compiler**: a cast `x as Foo` forces the type without checking. The bug becomes a runtime failure instead of a compile error.
- **`any` propagation**: a value typed as `any` disables type checking for all downstream operations. A change that widens a type to `any` can hide contract violations.
- **Discriminated union exhaustiveness**: removing a `case` or `default` from a switch on a discriminated union silently ignores valid values if `noImplicitReturns` is not enabled.
