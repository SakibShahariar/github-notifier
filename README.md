# GitHub Notifier

**Your GitHub inbox and repository activity, right in the GNOME top bar.**

[![GNOME Shell 45–51](https://img.shields.io/badge/GNOME_Shell-45%E2%80%9351-4A86CF?logo=gnome&logoColor=white)](https://extensions.gnome.org/) [![License: GPL v3+](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](LICENSE)

![GitHub Notifier panel menu](screenshots/panel-menu.png)

GitHub Notifier brings unread notifications, watched-repository activity, and star-count changes to your desktop, so you can keep up with GitHub without constantly switching to a browser.

## What you can do

- **Keep up with your inbox.** View mentions, team mentions, review requests, assignments, conversations, and CI-related notifications from the panel menu. Open the related GitHub page or mark notifications as read.
- **Watch repositories.** Follow repositories using `owner/repo` names and see new issues, pull requests, and changes in star counts. Star tracking reports count changes; it does not identify individual stargazers.
- **Get useful desktop alerts.** Receive alerts for new activity, with controls for notification categories, muted repositories, and quiet hours.
- **Tune how it behaves.** Adjust the polling interval, pause polling, choose which notification categories appear, and decide whether opening an item marks it as read.
- **Use optional integrations.** Open issues and pull requests with the GitHub CLI when `gh` and a supported terminal are installed, and enable local daily activity statistics if you want them.

## Requirements

- GNOME Shell **45–51**.
- A GitHub personal access token. The inbox requires a **classic token** with the `notifications` scope; repository watching may need additional repository access.
- Secret Service (usually GNOME Keyring) for protected token storage. The extension can retain and migrate an existing legacy token if Secret Service is temporarily unavailable.

## Install

Clone the repository and install the extension for your user:

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

Open **Preferences** from the panel menu, or run:

```bash
gnome-extensions prefs github-notifier@SakibShahariar
```

If the extension does not appear immediately, restart the GNOME session. On X11 you can use **Alt+F2**, enter `r`, and press Enter; on Wayland, log out and back in.

## First-time setup

1. Open **Preferences → Account**.
2. Add your GitHub username and a classic personal access token with the `notifications` scope.
3. Use **Test connection** to check the account and token.
4. Open **Watching** and add repositories in `owner/repo` format if you also want repository activity.
5. Choose your notification filters, polling interval, and quiet-hours preferences.

The inbox works without repository watching. Private repositories require a token with access to those repositories; use the `repo` scope when necessary. Avoid granting broader access than your use case requires.

## Using the extension

Click the GitHub icon in the GNOME top bar to open the menu. From there you can review unread notifications, inspect watched-repository activity, and open the corresponding GitHub pages. Notification actions can mark items as read, while repository watching keeps track of new issues, pull requests, and star-count changes.

The preferences let you control:

- **Account:** GitHub username, API host, token, and connection testing.
- **Watching:** repositories to monitor and repositories to mute.
- **Notifications:** inbox categories, desktop alerts, quiet hours, and whether opening an item marks it read.
- **Polling:** update interval and pause controls.
- **Optional features:** daily statistics and GitHub CLI actions.

Quiet hours suppress desktop alerts without hiding the inbox or stopping its badge from updating. You can optionally pause polling during quiet hours. GNOME Do Not Disturb is respected; GitHub Notifier does not change the system-wide DND setting.

## Documentation and help

- **[User guide](docs/user-guide.md)** — detailed setup, token permissions, preferences, quiet hours, notification categories, integrations, and troubleshooting.
- **[Token storage security model](docs/security-model.md)** — how credentials are stored, migrated, and recovered.
- **[Contributing](CONTRIBUTING.md)** — development and commit conventions.
- **[Issues and feature requests](https://github.com/SakibShahariar/github-notifier/issues)** — report a problem or suggest an improvement.

## Development

The repository includes source-level tests and GitHub Actions checks for JavaScript syntax, helper logic, metadata, and GSettings schemas. These checks do not replace testing in a real GNOME Shell session; graphical behavior and GNOME-version compatibility should be verified in the target desktop environment.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
