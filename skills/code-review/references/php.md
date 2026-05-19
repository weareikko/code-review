# PHP / Laravel Correctness Reference

Use this reference when reviewing PHP or Laravel code changes. Load only when materially useful — do not apply patterns mechanically.

## Type System and Coercion

- **Loose comparison**: `==` in PHP coerces types before comparing. `0 == "foo"` is true in PHP 7 (false in PHP 8), `0 == ""` is true in PHP 7, `"1" == true` is true in any version. Use `===` when the type matters.
- **`empty()` conflation**: `empty($x)` returns true for `0`, `""`, `"0"`, `[]`, `null`, `false`, and unset variables. Using it as a null check silently rejects legitimate zero and empty-string values.
- **`isset()` vs `array_key_exists()`**: `isset($arr['key'])` returns false when the key exists with a `null` value; `array_key_exists` does not. Use the latter when distinguishing missing from null.
- **Implicit int/string coercion in array keys**: PHP coerces numeric strings to integers when used as array keys. `$arr["1"]` and `$arr[1]` access the same slot.

## Null Handling

- **Nullsafe operator short-circuit**: `$a?->b->c` only short-circuits the first dereference; `$a?->b?->c` is needed when `b` may also be null.
- **Return type narrowing**: adding `?` to a return type is a widening change; removing `?` is a narrowing one. Callers that handled `null` now receive an unexpected non-null, or callers that didn't will receive null they cannot handle.
- **`null` coalescence with side effects**: `$x ?? someCall()` only calls `someCall()` when `$x` is null. If the call had necessary side effects, removing the null path skips them.

## Laravel-Specific

- **Eloquent `firstOrFail` vs `first`**: swapping one for the other changes whether a missing record throws a `ModelNotFoundException` or returns `null`. Callers expecting an exception now receive null; callers expecting null now get an exception.
- **Mass assignment without `$fillable`**: adding a new field to a form request without adding it to `$fillable` silently ignores it. Adding it to `$fillable` without a form request validation rule may expose it to arbitrary input.
- **Query builder vs Eloquent**: a raw query builder call bypasses model observers, global scopes, and casting. Switching from Eloquent to query builder removes those guarantees silently.
- **Eager loading N+1**: adding a relationship access inside a loop on a collection loaded without `with()` produces N additional queries. Check whether the relationship is loaded before the loop.
- **`->get()` vs `->all()`**: on a Collection, `->all()` returns the underlying array; on a query builder, calling `->all()` does not exist. Mixing these causes a fatal error or unexpected return type.
- **`Cache::remember` race**: two concurrent requests can both miss the cache and execute the callback simultaneously. For expensive or write-sensitive operations, consider atomic locking.
- **Queued job serialization**: Eloquent models in a queued job are serialized by ID and re-fetched on the worker. If the model is deleted before the job runs, the job fails with a `ModelNotFoundException`.
- **`withTrashed` scope leakage**: applying `withTrashed()` to a query builder instance affects all subsequent chained calls on that builder, including unrelated filters added later.

## Error Handling

- **Swallowed exceptions**: an empty `catch` block or a `catch` that only logs silently continues execution after a failure, leaving downstream code to operate on invalid state.
- **`@` error suppression operator**: `@function()` suppresses PHP errors and warnings, hiding real failures. Removing it can expose previously silent errors; adding it hides new ones.
- **Exception hierarchy**: catching `\Exception` does not catch `\Error` (including `TypeError`, `ParseError`). Catching `\Throwable` catches both; not catching `\Throwable` leaves fatal errors unhandled.

## Database and Transactions

- **Non-atomic multi-step write**: two separate queries that must succeed together (e.g., deducting balance and inserting a record) without a transaction can leave data in a partial state on failure.
- **`DB::statement` bypasses bindings**: raw SQL statements without parameter binding are vulnerable to injection and also bypass query logging and profiling.
- **`updateOrCreate` uniqueness**: `updateOrCreate` is not atomic; two concurrent requests with the same match conditions can both insert, violating a unique constraint.
- **Migration rollback safety**: a migration that adds a `NOT NULL` column without a default value cannot be rolled back safely on a non-empty table if the `down()` method tries to re-add data.

## Arrays and Collections

- **`array_map` vs `Collection::map`**: `array_map` preserves keys; `Collection::map` reindexes the result. Swapping one for the other changes the return structure for callers that relied on associative keys.
- **`array_merge` vs `+`**: `array_merge` reindexes numeric keys and concatenates; `+` keeps the left-hand keys for duplicates. They produce different results for associative arrays with shared keys.
- **Passing arrays by value**: PHP arrays are copy-on-write. Modifying an array inside a function does not affect the caller's copy unless passed by reference or returned.
