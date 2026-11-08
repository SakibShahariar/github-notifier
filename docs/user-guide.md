# User guide

## Install from source

Requires GNOME Shell 45–51.

```bash
git clone https://github.com/SakibShahariar/github-notifier.git
cd github-notifier
UUID="github-notifier@SakibShahariar"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
mkdir -p "$DEST/schemas" "$DEST/icons"
cp ./*.js metadata.json stylesheet.css "$DEST/"
cp icons/* "$DEST/icons/"
cp schemas/*.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas"
gnome-extensions enable "$UUID"
```

Open Preferences from the panel menu, or run `gnome-extensions prefs github-notifier@SakibShahariar`.

This guide covers setup, permissions, settings, optional integrations, and common problems. For a quick overview and installation steps, see the [README](../README.md).

## Requirements and installation notes

- GNOME Shell **45–51**.
- A GitHub personal access token for inbox access.
- A Secret Service provider (usually GNOME Keyring) and the `Secret-1.0` GObject introspection namespace for protected token storage.
- An internet connection.

After installing, open preferences from the panel menu or run:

```bash
gnome-extensions prefs github-notifier@SakibShahariar
```

If upgrading an installation that used `github-notifier@local`, disable the old extension and install this version under `github-notifier@SakibShahariar`. The settings schema and path are unchanged, so existing preferences are preserved. **Do not reset dconf during the upgrade.**

On X11, restart GNOME Shell with **Alt+F2**, then enter `r`. On Wayland, log out and back in if needed.

## GitHub token permissions and storage

- The inbox requires a **classic personal access token** with the `notifications` scope. GitHub's notifications endpoints do not currently support fine-grained tokens.
- Repository watching needs access to the issues, pull requests, and repository endpoints. Use the `repo` scope for private repositories; avoid granting it if you only watch public repositories and your setup works without it.
- Marking notifications read requires the relevant write access. If GitHub rejects the request, the item remains visible.
- Tokens are stored in Secret Service (typically GNOME Keyring). Legacy tokens in GSettings/dconf are migrated on first access and cleared from the plaintext setting only after Secret Service confirms the write.
- If Secret Service is unavailable during migration, the existing token is retained and may continue to be used. New tokens are never silently written back to plaintext settings.
- Each API host has a separate credential. Changing the username does not switch credentials; replace the token when changing GitHub accounts. **Remove saved token** deletes the credential for the currently configured API host.

See the [token storage security review](security-model.md) for implementation and recovery details.

## Preferences

Settings are grouped into **Account**, **Watching**, and **Settings**.

| Setting | Purpose |
|---|---|
| Token | GitHub personal access token. Create one in [GitHub settings](https://github.com/settings/personal-access-tokens). |
| Username | Your GitHub username. |
| API host | Hostname such as `api.github.com` or `github.example.com`. Enterprise paths such as `github.example.com/enterprise/api/v3` are supported. Enter a hostname/path only—no scheme, credentials, query, or fragment. HTTPS is added automatically. |
| Repositories | Comma-separated `owner/repo` names to watch. |
| Muted repositories | Excludes repositories from issue/star polling, inbox display, badges, and desktop banners. Muting does not mark notifications as read. |
| Poll interval | 60–3600 seconds; default is 120 seconds. |
| Notification filters | Choose which inbox categories appear and contribute to the badge and desktop alerts. All categories are enabled by default. |
| Mark read on open | Choose whether opening an item also marks it read on GitHub. |
| Quiet hours | Suppress desktop alerts during a local-time window; optionally pause polling during that window. |
| Daily statistics | Optional local counts for newly observed notifications and repository activity today and over the last seven days. Off by default. |
| GitHub CLI action | Adds an issue/PR terminal action when `gh` and a supported terminal are installed. |

Muted repository names are validated and matched case-insensitively. Unmuting re-establishes the issue/star baseline so activity accumulated while muted is not replayed. Notification filters only affect local display and alerting; hidden items are not unsubscribed or marked as read.

## Advanced features

### Quiet hours and Do Not Disturb

Quiet hours use local 24-hour `HH:MM` times. The start is included and the end is excluded; overnight windows such as `22:00`–`07:00` work. Equal start and end times disable the interval.

During quiet hours, the inbox and badge continue updating while desktop alerts are suppressed. GNOME Do Not Disturb is also respected: when `org.gnome.desktop.notifications show-banners` is `false`, no new desktop alerts are enqueued. GitHub Notifier never changes the system DND setting.

Enable **Pause polling during quiet hours** to avoid API requests during that interval; the badge may be stale until polling resumes.

### Notification categories

| Category | GitHub notification reasons |
|---|---|
| Mentions | `mention`, `team_mention` |
| Reviews | `review_requested`, `requested_reviewer`, `approval_requested`, `review_request_removed` |
| Assignments | `assign` |
| Conversation | `author`, `comment`, `manual`, `state_change`, `subscribed` |
| CI and checks | `ci_activity`, `CheckSuite` / `WorkflowRun` subjects |
| Other notifications | Security alerts, invitations, unknown reasons, and reasons not listed above |

Changing a filter does not permanently discard inbox items.

### GitHub CLI integration

When `gh` and a supported terminal (`kgx`, Ptyxis, GNOME Terminal, or `x-terminal-emulator`) are available, issue and pull-request rows offer an action that runs `gh issue view` or `gh pr view` in a new terminal. Authenticate the CLI separately with `gh auth login`. Browser opening remains available, and the CLI action is omitted when a dependency or issue/PR number is unavailable.

### Companion integration API

The GSettings key `notification-summary` exposes a versioned JSON snapshot containing only `version`, `enabled`, `unreadNotifications`, `activityItems`, `totalCount`, and `updatedAt`. It never includes tokens, usernames, repository names, notification text, or URLs. Counts represent the currently visible/filtered lists; `enabled: false` means the extension is disabled and the counts are the last observed values.

The key is in schema `org.gnome.shell.extensions.github-notifier` at `/org/gnome/shell/extensions/github-notifier/`. Consumers should handle missing or invalid JSON and ignore unknown fields. A companion extension can load the schema from this extension's `schemas` directory with `Gio.SettingsSchemaSource.new_from_directory()` and monitor `changed::notification-summary`.

### GitHub Enterprise Server

Set **API host** to your Enterprise host and any required path prefix. Browser-link conversion preserves the configured path prefix and removes the API `/api/v3` suffix. URL helpers have automated coverage for issues, discussions, pull requests, commits, releases, and workflow links; verify links with your own proxy layout if it differs from the usual format.

## Troubleshooting

- **No notifications:** Check the token and its permissions.
- **Repository watching fails:** Confirm each repository uses `owner/repo` and the token can access it.
- **Rate-limit errors:** Increase the polling interval or wait for the applicable limit to reset.
- **Connection errors:** Check that the network is fully connected.
- **GNOME Shell logs:** `journalctl -f /usr/bin/gnome-shell`
- **Looking Glass:** On X11, press **Alt+F2** and enter `lg`.

## Uninstall

```bash
gnome-extensions disable github-notifier@SakibShahariar
rm -rf ~/.local/share/gnome-shell/extensions/github-notifier@SakibShahariar
dconf reset -f /org/gnome/shell/extensions/github-notifier/
```

## Development notes

GitHub Actions runs source-level validation on pushes to `main`, including JavaScript syntax checks, unit tests for pure helpers and polling/security paths, metadata JSON parsing, and strict GSettings schema validation.

These checks do **not** replace testing in a real GNOME Shell session; runtime behavior and compatibility still need verification there. Polling is non-overlapping, with up to three watched repositories checked concurrently. Inbox and watched-repository requests use conditional validators where supported, and repeated unchanged successful polls gradually back off (without shortening the configured interval or GitHub's retry guidance).

For contribution workflow and commit conventions, see [CONTRIBUTING.md](../CONTRIBUTING.md).
