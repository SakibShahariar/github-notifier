# GitHub Notifier — GNOME Shell extension

Shows a panel indicator that tracks:
- Mentions & review requests (via your GitHub notifications inbox)
- New issues & PRs on repos you choose to watch
- New stars on repos you choose to watch

Clicking an item (in the dropdown or the toast) opens it in your
browser. Notification-inbox items have an inline button to mark just
that thread as read on GitHub. "Mark all as read" clears the local
list and also marks your GitHub inbox read. You can pause polling
from the dropdown, and optionally hide the panel icon entirely
whenever there's nothing unread (Settings → Display) — it reappears
as soon as something new comes in, and stays visible if there's an
error (bad token, rate limit) that needs your attention.

Built to be resilient: a failing or misconfigured repo in your watch
list won't block polling of the others, rate-limit responses back off
automatically instead of hammering the API, and an invalid token is
reported clearly rather than failing silently.

## Install

1. Copy this whole folder to:
   `~/.local/share/gnome-shell/extensions/github-notifier@local`

   ```bash
   cp -r github-notifier@local ~/.local/share/gnome-shell/extensions/
   ```

2. If `schemas/gschemas.compiled` isn't already there (it should be),
   compile it:

   ```bash
   glib-compile-schemas ~/.local/share/gnome-shell/extensions/github-notifier@local/schemas/
   ```

3. Restart GNOME Shell:
   - X11: `Alt+F2`, type `r`, Enter
   - Wayland: log out and back in

4. Enable it:

   ```bash
   gnome-extensions enable github-notifier@local
   ```

   Or via the **Extensions** app / extensions.gnome.org's local manager.

## Configure

Open the extension's Settings (from the panel dropdown menu, or via
`gnome-extensions prefs github-notifier@local`):

1. **Personal access token** — create one at
   https://github.com/settings/tokens
   - Classic token scopes: `notifications`, and `repo` (or
     `public_repo` if you only watch public repos)
   - Fine-grained token: read access to Issues, Pull requests, and
     Metadata for the repos you want to watch, plus access to your
     notifications
2. **GitHub username**
3. Toggle which categories to watch
4. **Watched repositories** — comma-separated `owner/repo` list, used
   for the "new issues/PRs" and "new stars" checks
5. Polling interval (default 2 minutes; minimum 30s to stay well
   within GitHub's API rate limits)

## Notes / limitations

- The token is stored in plain text via dconf (`gsettings`), same as
  most simple GNOME extensions handle secrets. Don't use a
  broad-scope token — a fine-grained, read-only token is safer.
- "New issue/PR" detection is per-repo and only starts working after
  the first successful poll (it needs a baseline to diff against).
- GitHub's REST API rate limit for authenticated requests is 5000/hr,
  so keep the interval reasonable if you're watching many repos.
- Tested against the GNOME 45+ ESM extension API (`gnome-shell` 45,
  46, 47, 48 in metadata.json — adjust if your version is older/newer).
