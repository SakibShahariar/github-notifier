# GitHub Notifier

**Your GitHub activity, right in the GNOME top bar.**

[![GNOME Shell 45–51](https://img.shields.io/badge/GNOME_Shell-45%E2%80%9351-4A86CF?logo=gnome&logoColor=white)](https://extensions.gnome.org/)

GitHub Notifier brings your unread inbox, watched-repository activity, and star-count changes into GNOME Shell—so you can keep up without leaving your desktop.

![GitHub Notifier panel menu](screenshots/panel-menu.png)

## What it does

- **Inbox at a glance** — unread GitHub notifications, including mentions, review requests, assignments, conversations, and CI activity.
- **Watch repositories** — detect new issues and pull requests, and track repository star-count changes.
- **Useful desktop alerts** — open an item or mark it read from the notification; burst activity can be grouped into a summary.
- **Stay in control** — pause polling, hide the panel icon when there is nothing to show, filter notification categories, or mute noisy repositories.
- **Quiet hours and network awareness** — suppress alerts on a schedule, respect GNOME Do Not Disturb, and pause automatic checks on metered or limited connections.
- **Optional extras** — daily local activity statistics and a GitHub CLI action for issue and pull-request rows.
- **Companion support** — expose a small, versioned count summary for integrations without sharing credentials or starting another poller.

Star tracking detects changes in counts; it does not identify individual new stargazers. Mark-all-as-read updates the local view only after GitHub confirms the request succeeded.

## Requirements

- GNOME Shell **45–51**.
- A GitHub personal access token with permissions for the features you use.
- A Secret Service provider (usually GNOME Keyring) and the <code>Secret-1.0</code> GObject introspection namespace for protected token storage.
- An internet connection.

> **Token note:** GitHub's notifications API requires a **classic** personal access token. See [Token permissions and storage](#token-permissions-and-storage).

## Install

Clone the repository and copy the extension into your local GNOME extensions directory:

~~~bash
git clone https://github.com/SakibShahariar/github-notifier.git
cd github-notifier

UUID="github-notifier@SakibShahariar"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST/schemas" "$DEST/icons"
cp ./*.js metadata.json stylesheet.css "$DEST/"
cp icons/* "$DEST/icons/"
cp schemas/*.xml "$DEST/schemas/"
glib-compile-schemas "$DEST/schemas/"

gnome-extensions enable "$UUID"
~~~

Open preferences from the panel menu or run:

~~~bash
gnome-extensions prefs github-notifier@SakibShahariar
~~~

If upgrading an installation that used <code>github-notifier@local</code>, disable the old extension and install this version under the UUID above. The settings schema and path are unchanged, so existing preferences are preserved. **Do not reset dconf during the upgrade.**

On X11, restart GNOME Shell with **Alt+F2**, then enter <code>r</code>. On Wayland, log out and back in if needed.

## Configure

Settings are grouped into **Account**, **Watching**, and **Settings**.

| Setting | Purpose |
|---|---|
| Token | GitHub personal access token. Create one in [GitHub settings](https://github.com/settings/personal-access-tokens). |
| Username | Your GitHub username. |
| API host | Hostname such as <code>api.github.com</code> or <code>github.example.com</code>; Enterprise paths such as <code>github.example.com/enterprise/api/v3</code> are supported. Enter a hostname/path only—no scheme, credentials, query, or fragment. HTTPS is added automatically. |
| Repositories | Comma-separated <code>owner/repo</code> names to watch. |
| Muted repositories | Repositories excluded from issue/star polling, inbox display, badges, and desktop banners. Muting does not mark notifications as read. |
| Poll interval | 60–3600 seconds; default is 120 seconds. |
| Notification filters | Choose which inbox categories appear and contribute to the badge and desktop alerts. All categories are enabled by default. |
| Mark read on open | Choose whether opening an item also marks it read on GitHub. |
| Quiet hours | Suppress desktop alerts during a local-time window; optionally pause polling during that window. |
| Daily statistics | Optional local counts for newly observed notifications and repository activity today and over the last seven days. Off by default. |
| GitHub CLI action | Adds an issue/PR terminal action when <code>gh</code> and a supported terminal are installed. |

Muted repository names are validated and matched case-insensitively. Unmuting re-establishes the issue/star baseline so activity accumulated while muted is not replayed. Notification filters only affect local display and alerting; hidden items are not unsubscribed or marked as read.

## Token permissions and storage

- The inbox requires a **classic personal access token** with the <code>notifications</code> scope. GitHub's notifications endpoints do not currently support fine-grained tokens.
- Repository watching needs access to the issues, pull requests, and repository endpoints. Use the <code>repo</code> scope for private repositories; avoid granting it if you only watch public repositories and your setup works without it. GitHub also accepts <code>repo</code> for inbox access, but <code>notifications</code> is narrower.
- Marking notifications read requires the relevant write access. If GitHub rejects the request, the item remains visible.
- New tokens are stored in Secret Service (typically GNOME Keyring), with lookup attributes scoped to the configured API host. Legacy tokens in GSettings/dconf are migrated on first access and cleared from the plaintext setting only after Secret Service confirms the write.
- If Secret Service is unavailable during migration, the existing token is retained and may continue to be used. New tokens are never silently written back to plaintext settings.
- Each API host has a separate credential. Changing the username does not switch credentials; replace the token when changing GitHub accounts. **Remove saved token** deletes the credential for the currently configured API host.

See the [token storage security review](docs/security-model.md) for implementation and recovery details.

## Advanced features

<details>
<summary><strong>Quiet hours and Do Not Disturb</strong></summary>

Quiet hours use local 24-hour <code>HH:MM</code> times. The start is included and the end is excluded; overnight windows such as <code>22:00</code>–<code>07:00</code> work. Equal start and end times disable the interval.

During quiet hours, the inbox and badge continue updating while desktop alerts are suppressed. GNOME Do Not Disturb is also respected: when <code>org.gnome.desktop.notifications show-banners</code> is <code>false</code>, no new desktop alerts are enqueued. GitHub Notifier never changes the system DND setting.

Enable **Pause polling during quiet hours** to avoid API requests during that interval; the badge may be stale until polling resumes.
</details>

<details>
<summary><strong>Notification categories</strong></summary>

| Category | GitHub notification reasons |
|---|---|
| Mentions | <code>mention</code>, <code>team_mention</code> |
| Reviews | <code>review_requested</code>, <code>requested_reviewer</code>, <code>approval_requested</code>, <code>review_request_removed</code> |
| Assignments | <code>assign</code> |
| Conversation | <code>author</code>, <code>comment</code>, <code>manual</code>, <code>state_change</code>, <code>subscribed</code> |
| CI and checks | <code>ci_activity</code>, <code>CheckSuite</code> / <code>WorkflowRun</code> subjects |
| Other notifications | Security alerts, invitations, unknown reasons, and reasons not listed above |

The underlying inbox items remain available to the extension, so changing a filter does not permanently discard them.
</details>

<details>
<summary><strong>GitHub CLI integration</strong></summary>

When <code>gh</code> and a supported terminal (<code>kgx</code>, Ptyxis, GNOME Terminal, or <code>x-terminal-emulator</code>) are available, issue and pull-request rows offer an action that runs <code>gh issue view</code> or <code>gh pr view</code> in a new terminal. Authenticate the CLI separately with <code>gh auth login</code>. Browser opening remains available, and the CLI action is omitted when a dependency or issue/PR number is unavailable.
</details>

<details>
<summary><strong>Companion integration API</strong></summary>

The GSettings key <code>notification-summary</code> exposes a versioned JSON snapshot containing only <code>version</code>, <code>enabled</code>, <code>unreadNotifications</code>, <code>activityItems</code>, <code>totalCount</code>, and <code>updatedAt</code>. It never includes tokens, usernames, repository names, notification text, or URLs. Counts represent the currently visible/filtered lists; <code>enabled: false</code> means the extension is disabled and the counts are the last observed values.

The key is in schema <code>org.gnome.shell.extensions.github-notifier</code> at <code>/org/gnome/shell/extensions/github-notifier/</code>. Consumers should handle missing or invalid JSON and ignore unknown fields. A companion extension can load the schema from this extension's <code>schemas</code> directory with <code>Gio.SettingsSchemaSource.new_from_directory()</code> and monitor <code>changed::notification-summary</code>.
</details>

<details>
<summary><strong>GitHub Enterprise Server</strong></summary>

Set **API host** to your Enterprise host and any required path prefix. Browser-link conversion preserves the configured path prefix and removes the API <code>/api/v3</code> suffix. URL helpers have automated coverage for issues, discussions, pull requests, commits, releases, and workflow links; verify links with your own proxy layout if it differs from the usual format.
</details>

## Troubleshooting

- **No notifications:** Check the token and its permissions.
- **Repository watching fails:** Confirm each repository uses <code>owner/repo</code> and the token can access it.
- **Rate-limit errors:** Increase the polling interval or wait for the applicable limit to reset.
- **Connection errors:** Check that the network is fully connected.
- **GNOME Shell logs:** <code>journalctl -f /usr/bin/gnome-shell</code>
- **Looking Glass:** On X11, press **Alt+F2** and enter <code>lg</code>.

## Development and checks

GitHub Actions runs source-level validation on pushes to <code>main</code>, including JavaScript syntax checks, unit tests for pure helpers and polling/security paths, metadata JSON parsing, and strict GSettings schema validation.

These checks do **not** replace testing in a real GNOME Shell session; runtime behavior and compatibility still need verification there.

The extension uses bounded, non-overlapping polling (up to three watched repositories at a time). <code>extension.js</code> coordinates the Shell indicator and lifecycle, while focused modules handle API access, polling, settings, credentials, UI, and testable repository helpers.

## Uninstall

~~~bash
gnome-extensions disable github-notifier@SakibShahariar
rm -rf ~/.local/share/gnome-shell/extensions/github-notifier@SakibShahariar
dconf reset -f /org/gnome/shell/extensions/github-notifier/
~~~

## License and feedback

Licensed under the **GNU General Public License v3.0 or later**; see [LICENSE](LICENSE).

Found a bug or have an idea? [Open an issue](https://github.com/SakibShahariar/github-notifier/issues). Contributions are welcome.
