# GitHub Notifier

> Mentions, reviews, issues/PRs, and stars — right in your GNOME top panel.

![GNOME 45–51](https://img.shields.io/badge/GNOME-45--51-blue)

GitHub Notifier is a GNOME Shell extension that brings your GitHub activity into the top panel. It displays your unread GitHub inbox, watches selected repositories for new issues and pull requests, and tracks star-count changes — without needing to keep GitHub open in a browser.

## Screenshot

![Panel menu](screenshots/panel-menu.png)

## Features

| Feature | Description |
|---|---|
| 💬 **Inbox** | Mirrors your unread GitHub notifications. |
| 📝 **Repository watching** | Checks selected repositories for new issues and pull requests; add a repo to watching directly from inbox or activity rows. |
| ⭐ **Star tracking** | Detects changes in repository star counts. |
| 🔔 **Desktop notifications** | Per-item notifications with Open and Mark read actions, plus a summary for notification bursts. |
| ⏸️ **Pause polling** | Temporarily stop checks from the panel menu. |
| 👁️ **Hide when empty** | Keep the panel icon hidden when there is nothing to show, unless an error needs attention. |
| **Mark read on open** | Choose whether opening a notification also marks it as read on GitHub. |
| **Metered network handling** | Pause automatic polling on metered connections while keeping manual refresh available through the banner action. |
| **Quiet hours** | Suppress desktop alerts during a configurable local-time window; optionally pause polling instead of silently updating inbox and badge, with a one-click Refresh once banner action. |
| **Daily statistics** | Optional local-only counts for newly observed notifications and repository activity today and over the last seven days; off by default. |
| **Companion integration** | Exposes a versioned, non-secret count summary for integrations such as material-panel without sharing tokens or adding another poller. |

The inbox uses GitHub's notifications API with `participating=false`, so it includes unread activity such as mentions, review requests, and subscribed threads. Star tracking detects count changes; it does not identify individual new stargazers.

**Mark all as read** clears the local view only after GitHub confirms the request succeeded; if it fails, the items remain visible.

## Requirements

- GNOME Shell 45–51. The notification source and notification constructors include a compatibility path for GNOME 45's positional API and GNOME 46+'s object-parameter API.
- A GitHub personal access token with the permissions required for the API features you use.
- For new token storage, a Secret Service provider such as GNOME Keyring and the libsecret GObject introspection namespace (`Secret-1.0`). Package names vary by distribution; Debian/Ubuntu commonly provide the typelib in `gir1.2-secret-1`.
- An internet connection. The extension pauses polling when the connection is detected as limited or local-only.

## Installation

Clone the repository, then install the extension files into the directory matching its UUID:

```bash
git clone https://github.com/SakibShahariar/github-notifier.git
cd github-notifier

UUID="github-notifier@SakibShahariar"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST/schemas" "$DEST/icons"
cp extension.js prefs.js metadata.json stylesheet.css "$DEST/"
cp icons/* "$DEST/icons/"
cp schemas/*.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas/"
```

If you are upgrading an existing installation that used `github-notifier@local`, disable that old extension and install this version under the new UUID. The GSettings schema ID and settings path are unchanged, so your existing preferences are preserved; do not reset dconf during the upgrade.

Then enable the extension:

```bash
gnome-extensions enable github-notifier@SakibShahariar
```

On X11, you can restart GNOME Shell with **Alt+F2**, then enter `r`. On Wayland, log out and log back in if required.

Open the extension preferences from the panel menu or run:

```bash
gnome-extensions prefs github-notifier@SakibShahariar
```

## Configuration

| Setting | Description |
|---|---|
| **Token** | Your GitHub personal access token. Create one from [GitHub Settings](https://github.com/settings/personal-access-tokens). |
| **Username** | Your GitHub username. |
| **API host** | Enter a hostname only, such as `api.github.com` or `github.example.com`; Enterprise deployments may include a path such as `github.example.com/enterprise/api/v3`. Use HTTPS (added automatically). Do not include `https://`, credentials, query strings, or fragments. |
| **Repositories** | Comma-separated repository names in `owner/repo` format. |
| **Muted repositories** | Comma-separated `owner/repo` names excluded from issue/star polling, inbox display, badges, and desktop banners. You can also mute a repository from its inbox/activity row, with a short-lived Undo action in the panel menu. Muting does not mark GitHub notifications as read. |
| **Poll interval** | How often to check for updates: 60–3600 seconds, with a default of 120 seconds. |
| **Mark notifications read when opened** | Turn off to open notification links without automatically marking them read. |
| **Daily notification stats** | Enable in Settings to show local counts for new notifications and repository activity today and over the last seven days. Disabled by default; counts are stored locally and never sent to GitHub or companion integrations. |
| **GitHub CLI action** | When `gh` and a supported terminal are installed, issue and pull-request rows include an action to open them with the CLI. Browser opening remains available. |

Settings are organized into **Account**, **Watching**, and **Settings** sections.

### Companion integration API

The GSettings key `notification-summary` exposes a versioned JSON snapshot for companion extensions. It contains only `version`, `enabled`, `unreadNotifications`, `activityItems`, `totalCount`, and `updatedAt`; it never includes the token, username, repository names, notification text, or URLs. Counts reflect the extension’s currently visible/filtered lists. `enabled: false` means GitHub Notifier has been disabled; the counts are the last observed values. Consumers should handle missing or invalid JSON and ignore unknown fields. The key lives in the `org.gnome.shell.extensions.github-notifier` schema at `/org/gnome/shell/extensions/github-notifier/` and changes when the summary changes. A companion extension can locate GitHub Notifier through GNOME Shell’s extension manager, load the schema from that extension’s `schemas` directory with `Gio.SettingsSchemaSource.new_from_directory()`, and monitor `changed::notification-summary`. This avoids duplicated token storage and API polling.

### Quiet hours and Do Not Disturb

Enable **Quiet hours** in Settings and choose local 24-hour start/end times (`HH:MM`). The interval includes the start and excludes the end; overnight windows such as `22:00`–`07:00` are supported. Equal start and end times disable the interval. During quiet hours, the extension suppresses new desktop alerts while continuing to update its inbox and badge. GNOME's system **Do Not Disturb** switch is also respected: when `org.gnome.desktop.notifications show-banners` is `false`, GitHub Notifier does not enqueue new desktop alerts, but inbox and badge updates continue. The setting is read when an alert would be emitted, so toggling DND takes effect without restarting the extension. Enable **Pause polling during quiet hours** to avoid API requests during that interval; the badge may then become stale until polling resumes. This extension never changes your system DND setting.

### GitHub CLI integration

When the `gh` executable and a supported terminal (`kgx`, Ptyxis, GNOME Terminal, or `x-terminal-emulator`) are available, issue and pull-request rows show a terminal action. It runs `gh issue view` or `gh pr view` in a new terminal, using the repository from the item. The normal row activation still opens the browser; the CLI action is additive. The CLI must be authenticated separately with `gh auth login`. The action is omitted when the CLI, terminal, or an issue/PR number is unavailable.

### Muted repositories

Use the **Muted repositories** field on the Watching page to enter comma-separated repository names, such as `owner/noisy-project, org/another-project`. Names are validated before saving and matched case-insensitively. Muted repositories are skipped during issue/star polling, and their inbox items, activity entries, badge counts, and desktop banners are hidden. Existing GitHub notifications are not marked as read. When a repository is unmuted, its issue/star baseline is re-established to avoid replaying the events accumulated while it was muted.

### Notification filter categories

The **Notification filters** group controls which GitHub inbox notifications contribute to the visible list, panel badge, and desktop notification banners. All categories are enabled by default.

| Category | GitHub notification reasons |
|---|---|
| **Mentions** | `mention`, `team_mention` |
| **Reviews** | `review_requested`, `requested_reviewer`, `approval_requested`, `review_request_removed` |
| **Assignments** | `assign` |
| **Conversation** | `author`, `comment`, `manual`, `state_change`, `subscribed` |
| **CI and checks** | `ci_activity`, and `CheckSuite` / `WorkflowRun` subjects |
| **Other notifications** | Security alerts, invitations, unknown reasons, and anything not covered above |

Filtering affects the local display and alerting only; it does not unsubscribe from GitHub threads or mark hidden notifications as read. The underlying inbox items remain available to the extension so changing a filter does not permanently discard them.

### Token permissions and security

**The inbox requires a classic personal access token**: GitHub's notifications endpoints do not currently support fine-grained personal access tokens. Grant the classic token the `notifications` scope for the inbox. Repository watching uses the issues, pull requests, and repository endpoints; use the `repo` scope if you need access to private repositories, and avoid granting it when you only use public repositories and your setup works without it. GitHub's notifications API also accepts `repo` in place of `notifications`, but `notifications` is the narrower choice for inbox access. Marking notifications read requires the token to have the relevant write access; if that action is rejected, the item remains visible.

New tokens are stored in the user's Secret Service (typically GNOME Keyring) using non-secret lookup attributes scoped to the configured API host. Existing tokens in the legacy GSettings/dconf key are migrated on first access and the plaintext setting is cleared only after Secret Service confirms the write. If Secret Service is unavailable during migration, the existing token is retained and may continue to be used; new tokens are never silently saved back to plaintext settings. Unlock or install a compatible Secret Service provider to save or retrieve a protected token. Changing the API host selects that host's separate credential; changing the username alone does not change the stored credential, so replace the token when switching GitHub accounts. Use **Remove saved token** to delete the credential for the currently configured API host. See [the token storage security review](docs/security-model.md) for implementation details and recovery behavior.

## Automated checks

GitHub Actions runs source-level checks on pushes to `main`:

- JavaScript syntax checks for the extension, preferences, and focused helper modules.
- Unit tests for repository validation and polling, notification categories and icons, row-detail and relative-time formatting, muted/watched repository handling, GitHub CLI arguments, quiet-hours logic, daily summaries, and Secret Service migration/error paths.
- JSON parsing for `metadata.json`.
- Strict validation of the GSettings schema.

These checks do not replace testing inside GNOME Shell; runtime behavior and compatibility still need verification in a GNOME session.

## How it works

- Polls GitHub's notifications API for unread notifications.
- Checks selected repositories for issues and pull requests, and checks star counts for changes.
- Uses one non-overlapping poll cycle with bounded concurrency (up to three watched repositories at a time).
- Uses a configurable polling interval and limits the number of notifications displayed.
- Reports connection and polling status in the panel when attention is needed.

### Source layout

- `extension.js` coordinates the GNOME Shell indicator, settings, lifecycle, and poll-cycle state.
- `api.js`, `repository-polling.js`, `notification-actions.js`, and `state.js` handle API requests, watched-repository polling, read/dismiss actions, and persisted state.
- `secret-store.js` manages host-scoped credentials through Secret Service, with safe migration from the legacy setting.
- `repo-utils.js` contains pure validation, categorization, formatting, and summary helpers that can be tested without GNOME Shell.
- `ui-indicator.js`, `ui-animations.js`, `ui-utils.js`, `ui-theme.js`, and `notifications.js` separate menu rendering, motion, tooltips, theme loading, and desktop notifications from the main indicator class.

The panel may display an error indicator when GitHub requests fail. Rate limits and permission errors are different conditions and should be diagnosed accordingly.

## GitHub Enterprise Server

Configure the API host for your Enterprise instance. GitHub.com and Enterprise installations may use different API and web URL formats.

If your Enterprise instance is hosted under a URL path rather than directly at the domain root, verify that generated browser links preserve that path. Support for a particular Enterprise deployment layout depends on the current implementation.

## Troubleshooting

- **No notifications:** Check that the token is valid and has the required permissions.
- **Repository watching does not work:** Verify each repository uses the `owner/repo` format and that the token can access it.
- **Rate-limit errors:** Reduce polling frequency or wait for the applicable GitHub rate limit to reset.
- **Connection-related issues:** Check that your network is fully connected.
- **GNOME Shell logs:** Follow the shell log with:

  ```bash
  journalctl -f /usr/bin/gnome-shell
  ```

- **Looking Glass:** On X11, press **Alt+F2** and enter `lg` to open GNOME Shell's debugging tool.

## Uninstall

Disable the extension, remove its directory, and reset its settings:

```bash
gnome-extensions disable github-notifier@SakibShahariar
rm -rf ~/.local/share/gnome-shell/extensions/github-notifier@SakibShahariar
dconf reset -f /org/gnome/shell/extensions/github-notifier/
```

## License

This project is licensed under the **GNU General Public License v3.0 or later**. See [`LICENSE`](LICENSE) for the full license text.

## Feedback

Found a bug or have an idea? Open an [issue](https://github.com/SakibShahariar/github-notifier/issues). Contributions are welcome.
