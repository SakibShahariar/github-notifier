# Changelog

## 3 — Initial stable release

First published release. Requires GNOME Shell 45–51.

### Features

- Full unread GitHub inbox in the top-bar menu, with search, pagination, category filters, and per-thread/global mark-read.
- Watched-repository polling for new issues, pull requests, and stars, with mute controls and case-insensitive deduplication.
- Dedicated menu sections for Conversation, Needs your action, Checks, New Releases, Issues & Pull Requests, and New Stars.
- Opt-in per-row details (number, author, state, labels, star/description data) sourced from already-fetched API payloads.
- Quiet hours and GNOME Do Not Disturb support, metered-network pausing, daily statistics, and a companion `notification-summary` GSettings key.
- GitHub Enterprise host/path support, GitHub CLI actions, and Matugen theming with Shell-theme fallback.

### Reliability and security

- Tokens stored in the freedesktop.org Secret Service with host-scoped migration and a `secret-tool` recovery path for stale keyring sessions.
- Bounded concurrency (up to three repositories per poll), non-overlapping poll cycles, conditional requests, rate-limit/backoff handling, and a retry cooldown for credential failures.
- Defensive URL, thread-ID, ETag, and API-response validation; plain-text row rendering with theme-aware tooltips and accessible names.

### Documentation

- User guide, token/data security model (threat model included), installation/troubleshooting, and a reproducible polling benchmark.
