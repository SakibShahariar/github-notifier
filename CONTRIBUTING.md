# Contributing

## Commit messages

Use a short imperative subject with a conventional prefix, and link issue-specific work by adding the issue number in parentheses at the end of the subject.

Format:

`type: concise description (#issue)`

Examples:

- `fix: stop worker scheduling after failures (#47)`
- `test: cover worker failure handling (#47)`
- `refactor: extract notification actions (#48)`
- `docs: clarify token storage behavior (#45)`

Use the issue that the change directly advances. If one commit genuinely addresses multiple issues, include each relevant issue reference, for example `fix: correct polling and cancellation (#47, #52)`. Do not attach an unrelated issue number just to satisfy a pattern.

Common prefixes: `feat`, `fix`, `refactor`, `test`, `docs`, `perf`, and `chore`.

Before finishing a batch, inspect the latest ten GitHub Actions runs, investigate every failure, and verify that a successful run covers the final commit. Do not describe a change as validated while its checks are still running or failing.
