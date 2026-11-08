# GitHub Notifier

**Your GitHub inbox and repository activity in the GNOME top bar.**

[![GNOME Shell 45–51](https://img.shields.io/badge/GNOME_Shell-45%E2%80%9351-4A86CF?logo=gnome&logoColor=white)](https://extensions.gnome.org/) [![License: GPL v3+](https://img.shields.io/badge/License-GPL--3.0--or--later-blue.svg)](LICENSE)

![GitHub Notifier panel menu](screenshots/panel-menu.png)

GitHub Notifier brings unread notifications, watched-repository activity, and star-count changes to your desktop—without opening a browser.

## Features

- **GitHub inbox:** mentions, review requests, assignments, conversations, and CI activity.
- **Repository watch:** new issues and pull requests, plus star-count changes.
- **Desktop alerts:** actionable notifications, quiet hours, and GNOME Do Not Disturb support.
- **Stay in control:** filters, muted repositories, pause controls, and configurable polling.
- **Optional integrations:** GitHub CLI actions and daily activity statistics.

Star tracking reports count changes; it does not identify individual stargazers.

## Install

Requires GNOME Shell 45–51. Install from source:

```bash
git clone https://github.com/SakibShahariar/github-notifier.git
cd github-notifier
UUID="github-notifier@SakibShahariar"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
mkdir -p "$DEST"
cp -r ./*.js metadata.json stylesheet.css icons schemas "$DEST"/
glib-compile-schemas "$DEST/schemas"
gnome-extensions enable "$UUID"
```

Open **Preferences** from the panel menu, or run:

```bash
gnome-extensions prefs github-notifier@SakibShahariar
```

## Get started

1. Open **Preferences → Account**.
2. Add a GitHub **classic personal access token** with the `notifications` scope.
3. Add `owner/repo` names under **Watching** to monitor repositories.

The inbox works without repository watching. See the **[User guide](docs/user-guide.md)** for token permissions, setup details, advanced features, and troubleshooting.

## Links

- [User guide](docs/user-guide.md)
- [Contributing](CONTRIBUTING.md)
- [Security model](docs/security-model.md)
- [Report a bug or request a feature](https://github.com/SakibShahariar/github-notifier/issues)

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
