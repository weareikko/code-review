### Security

- Reusable workflow: pass the `version` and `args` inputs to the review step through environment variables instead of `${{ }}` expressions in `run:`, so a crafted input can no longer inject shell code.
