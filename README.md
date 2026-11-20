![](https://img.shields.io/badge/dynamic/json?logo=obsidian&color=%23483699&label=downloads&query=%24%5B%22github-sync%22%5D.downloads&url=https%3A%2F%2Fraw.githubusercontent.com%2Fobsidianmd%2Fobsidian-releases%2Fmaster%2Fcommunity-plugin-stats.json)

# GitHub Sync

Simple plugin that allows you to sync your vault to a personal GitHub repo for **syncing across devices**.

## Highlights
- Sync your vault with a single ribbon action.
- Reduce notice noise with configurable notice levels.
- Keep the success notice to one short confirmation message or hide it entirely.

![](screenshots/ribbon-button.png)

## How to Use
Click the **Sync with Remote** ribbon icon to pull changes from your GitHub repo and push local changes. 
If there are any conflicts, the unmerged files will be opened for you to resolve (or just push again with the unresolved conflicts - that should work too).

## Setup

### Setting up a GitHub repo
If your vault is already set up as a GitHub repository, you can skip this step. Otherwise, create a new public or private GitHub repository that you want to use for your vault.

Navigate to your vault and `git init` the folder. 
At this point, add anything you don't want syncing across your devices to a `.gitignore`.

This is not required, but you should try pushing your vault to your GitHub repository before continuing to make sure you can do that in the first place before using this plugin:
```
git add .
git commit -m "my obsidian vault first commit"
git branch -M main
git remote add origin <remote-url>
git push -u origin main
```
Verify that this works before continuing.

> For simplicity, this plugin does not support branching. Everything gets pushed to main.

### Setting up remote URL
All this plugin needs now is your GitHub repo's remote URL. You can grab this from the GitHub repo page for your vault:

![](screenshots/remote-url.png)

You can use either the HTTPS or SSH url. Grab it and paste it in the GitHub Sync settings tab like so:

![](screenshots/new-settings-page.png)

Done. Try clicking the Sync button now - it should work.

The first time may prompt you to authenticate if you haven't, or it may ask you to configure git with your email and name.

### Optional

You can reduce UI noise from sync operations with the `Notice level` setting:
- `ALL` shows every GitHub Sync notice.
- `WARNING` shows only warnings and errors.
- `ERROR` shows only error notices, so sync can run mostly in the background.

You can also use `Hide Success Message` to suppress the single confirmation notice shown after a successful sync. With the toggle off and `Notice level` set to `ALL`, a successful sync shows exactly one success message instead of multiple informational notices.

If your git binary is not accessible from your system PATH (i.e. if you open up Command Prompt or Terminal and can't use git), you need to provide its location. I initialize git only when launching Cmder, so I need to input a custom path like so: `C:/Users/Kevin/scoop/apps/cmder-full/current/vendor/git-for-windows/cmd/`. Note that I excluded `git.exe` from the end of the path.

You can also include your GitHub username and personal access token in the remote url. Like so: `https://{username}:{personal access token}@github.com/{username}/{repository name}`. This is not recommended anymore, but it was how the plugin worked prior to 1.0.4. If you're doing this, you'll have to add `.obsidian/plugins/github-sync/data.json` to your `.gitignore`.

## Contributing

Commits and PR titles follow [Conventional Commits](https://www.conventionalcommits.org/), because releases are automated with [release-please](https://github.com/googleapis/release-please):

- `feat: ...` new feature (minor version bump)
- `fix: ...` bug fix (patch version bump)
- `feat!: ...` or a `BREAKING CHANGE:` footer: breaking change (major version bump)
- `docs:`, `chore:`, `ci:`, `refactor:`, `test:` do not trigger a release

The release workflow only runs when code files change (`main.ts`, `styles.css`, build config, `package*.json`, `manifest.json`). Docs-only pushes such as `README.md` never trigger it, even with a `feat:` or `fix:` title. To run it manually, use the Actions tab or `gh workflow run release-please.yml`; it still needs at least one `feat:` or `fix:` commit since the last release, or a `Release-As: x.y.z` footer to force a version.

Pull requests are merged with **squash** or **rebase** (no merge commits), so the PR title must follow the convention.

On each push to `main`, release-please opens or updates a release PR that bumps `package.json` and `manifest.json`. Merging it creates the tag (without a `v` prefix) and the GitHub release, with `main.js`, `manifest.json` and `styles.css` attached. Release notes are generated on the GitHub release; there is no `CHANGELOG.md`.

## Rationale

This plugin is for personal use, but I figured others might find it useful too. This is basically a glorified script - the code is tiny its like ~200 SLOC.
I keep a private GitHub repository for my Markdown notes, and I wanted some way to pull/push my notes from within Obsidian without opening a command line to run a script or set up an auto sync script on a timer. I don't use Git branches for my notes so this plugin doesn't support branching. 

The Node API used by this plugin works with any remote host, but I use GitHub so I centered the whole plugin around that.

Mobile support could come in the future depending on how much I need it myself.

Follow my stuff at https://github.com/lideke

