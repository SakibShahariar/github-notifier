# GitHub Notifier

> Mentions, reviews, issues/PRs and stars — in your top panel.

![GNOME 45-51](https://img.shields.io/badge/GNOME-45--51-blue)

### What it does

| | |
|---|---|
| 💬 **Inbox** | Full unread GitHub notifications (live mirror of `/notifications`, not a local diff) |
| 📝 **Watch** | New issues/PRs on chosen repos |
| ⭐ **Stars** | New stars count |
| 🔔 **Toasts** | `Open` / `Mark read` + grouped by repo |

Inbox uses `participating=false`, so you see the same unread list as github.com/notifications (mentions, review requests, subscribed threads, etc.).

`Mark all as read` clears locally + `PUT /notifications {last_read_at}` on GitHub. Pause from menu, `Hide when empty` keeps icon hidden unless error.

### Install

```bash
cp -r github-notifier@local ~/.local/share/gnome-shell/extensions/
glib-compile-schemas ~/.local/share/gnome-shell/extensions/github-notifier@local/schemas/
# X11: Alt+F2 → r | Wayland: logout
gnome-extensions enable github-notifier@local
```

Prefs: panel → `Settings…` or `gnome-extensions prefs github-notifier@local`

### Configure

| Setting | Notes |
|---|---|
| **Token** | `github.com/settings/tokens` — Classic `notifications`+`repo`, or fine-grained Issues/PRs + Metadata |
| **Username** | your GitHub handle |
| **API host** | `api.github.com` or `github.example.com` (GHES → `/api/v3`) |
| **Repos** | `owner/repo, owner/repo` — banner if empty while watches on |
| **Poll** | 30–3600s, default 120s |

Sections: **Account** / **Watching** / **Settings**

### How it works

* Polls `/notifications`, `/repos/{repo}/issues` (page 2 verified when 20 new), `/repos/{repo}` stars.
* Baseline `now tracking` toast on first poll.
* `FULL` internet only — skips on portal/LOCAL to avoid timeout storm.
* `150` notifs cap → `More than shown` sentinel; `!` stays visible on 401/403.

<details>
<summary>Notes</summary>

* Icon `icons/github-symbolic.svg` — `fill=currentColor`, recolors with theme. GitHub mark is trademark.
* Token is stored plain in `dconf` (GSettings). Prefer a **fine-grained, read-only** PAT with only the scopes you need; revoke if the machine is shared or compromised.
* Rate limit 5000/hr authenticated (shared across all clients using the token).
* API host may be `api.github.com` or a GHES host; web links follow the same host via `_webBase()`.
</details>
