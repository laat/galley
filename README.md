# laatsux

A local staging area for pull requests. Agents stage a pull request with a CLI that
mirrors `gh`. You review it in a web UI that looks like GitHub: comment on lines, on commit
messages and on the description, and loop with the agent until the title, body and
commits are right. Then you publish it to GitHub.

```
agent                         laatsux (localhost:7171)                you
─────                         ────────────────────────                ───
laatsux pr create   ───────▶  stages the branch, tracks pushes
laatsux pr wait     ◀───────  blocks until feedback          ◀──────  review in the browser
(amend, reply, edit)───────▶  new revision, comments follow
laatsux pr wait     ◀───────  "Published to GitHub: …"       ◀──────  Publish: git push + gh pr create
```

## Requirements

- Node 24 or newer (runs the TypeScript sources directly)
- git
- [gh](https://cli.github.com), authenticated, for publishing
- jq, for `--jq`

## Install

```sh
git clone https://github.com/laat/laatsux && cd laatsux
pnpm install
ln -s "$PWD/bin/laatsux.ts" ~/.local/bin/laatsux   # or: npm link
```

To also get it as a gh extension (`gh laatsux pr create …`):

```sh
dir="${XDG_DATA_HOME:-$HOME/.local/share}/gh/extensions/gh-laatsux"
mkdir -p "$dir" && ln -s "$PWD/bin/laatsux.ts" "$dir/gh-laatsux"
```

Teach your agents the workflow with the skill in [`skills/laatsux/SKILL.md`](skills/laatsux/SKILL.md):

```sh
ln -s "$PWD/skills/laatsux" ~/.claude/skills/laatsux
```

## Run

```sh
laatsux serve            # http://localhost:7171
```

`laatsux --version` prints the server URL the CLI will talk to, which helps when
`LAATSUX_URL` or `LAATSUX_PORT` is set.

Run the server outside any agent sandbox: it runs `git push` and `gh pr create` with your
credentials when you publish. The CLI only talks HTTP to the server, so agents in a sandbox
can use it.

## The CLI

`laatsux` takes the same subcommands and flags as `gh`, so an agent that knows gh needs no
new vocabulary. Flags that mean nothing here (labels, assignees, reviewers) are accepted and ignored.

| Command | |
|---|---|
| `laatsux pr create` | Stage the current branch. `--title`, `--body`, `--body-file`, `--base`, `--head`, `--draft`, `--fill`, `--fill-first`, `--fill-verbose` |
| `laatsux pr list` | `--state open\|published\|closed\|all`, `--json`, `--jq` |
| `laatsux pr view [<n>]` | `--comments` adds reviews and review threads; `--json`, `--jq`, `--web` |
| `laatsux pr diff [<n>]` | `--name-only`, `--patch` |
| `laatsux pr edit [<n>]` | `--title`, `--body`, `--body-file`, `--base` |
| `laatsux pr comment [<n>]` | `--body`, `--body-file`, `--edit-last`, and `--reply-to <thread>` to answer a review thread |
| `laatsux pr review [<n>]` | `--approve`, `--comment`, `--request-changes`, `--body` |
| `laatsux pr checkout`, `status`, `ready`, `close`, `reopen` | as in gh |
| `laatsux pr wait [<n>]` | Block until someone other than the author responds, then print the new feedback. `--timeout 10m` |
| `laatsux pr publish [<n>]` | Push and open the pull request on GitHub, like the Publish button. Refused for agents |
| `laatsux api <endpoint>` | GitHub REST paths, `{owner}`/`{repo}` placeholders, `-f`, `-F`, `-X`, `--input`, `--jq` |
| `laatsux serve` | Run the server and web UI |

A pull request is found the way gh finds it: by number, URL, branch name, or the current branch.

`pr view --json` supports gh's fields plus `reviewThreads` (with `isResolved`, `isOutdated`,
`path`, `line`, `diffHunk` and the comments), `publishedUrl` and `waiting`.

## The web UI

- Pull request list, and per pull request the Conversation, Commits and Files changed tabs
- Unified and split diffs with syntax highlighting, a file tree, and per-file "Viewed"
- Comment on a line, or drag across the `+` buttons to comment on a range; single comments or a pending review submitted as Comment, Approve or Request changes
- ```` ```suggestion ```` blocks rendered as a diff
- Comments on a commit, for asking the agent to reword its message
- Edit the title and description yourself; description edits show as a diff in the timeline
- Each push is a revision. Force-pushes get a Compare link, and "Changes since your last review" shows what changed since you last submitted a review
- Comments follow their lines across pushes, or are marked outdated when the code under them changed
- Live updates while the agent works, and a "waiting for your review" indicator while it runs `pr wait`
- Publish, with an option to open as a draft. Publishing again after changes force-pushes if needed and updates the GitHub pull request with `gh pr edit`

Conversations stay in laatsux. Publishing sends the branch, title and description, not the review.

## The API

The server speaks a subset of the GitHub REST API under `/api`, so `laatsux api` calls look
like `gh api` calls:

```
GET/POST        /api/repos/{owner}/{repo}/pulls
GET/PATCH       /api/repos/{owner}/{repo}/pulls/{n}                  (Accept: …diff / …patch for raw text)
GET             /api/repos/{owner}/{repo}/pulls/{n}/commits | files
GET/POST        /api/repos/{owner}/{repo}/pulls/{n}/comments
POST            /api/repos/{owner}/{repo}/pulls/{n}/comments/{id}/replies
GET/PATCH/DEL   /api/repos/{owner}/{repo}/pulls/comments/{id}
GET/POST        /api/repos/{owner}/{repo}/pulls/{n}/reviews           (POST takes comments[], like GitHub)
POST            /api/repos/{owner}/{repo}/pulls/{n}/reviews/{id}/events
GET/POST        /api/repos/{owner}/{repo}/issues/{n}/comments
GET             /api/repos/{owner}/{repo}/issues/{n}/timeline
```

Extensions: `PUT|DELETE …/pulls/{n}/threads/{id}/resolved`, `POST …/pulls/{n}/publish`,
`GET …/pulls/{n}/wait?timeout=s`, `GET …/gh/pulls[/{n}]?fields=` (the `gh --json` shapes),
and `GET /events` (server-sent events).

Requests carry the caller's identity in `X-Laatsux-Actor`. The CLI sets it to
`LAATSUX_ACTOR`, or to the detected agent (`claude` in Claude Code, `codex` in Codex), or to
`agent` when it runs without a terminal. Run at a terminal with none of those, and in the web
UI, you act as yourself. Agents cannot publish or delete staged pull requests.

## How it works

- **Repositories** are registered the first time the CLI runs in them, keyed by the git
  common directory so worktrees share one entry. The URL name is the GitHub `owner/repo` of
  `origin`, or `local/<dir>` without one.
- **Diffs** compare the head branch with its merge base against `origin/<base>`, falling
  back to the local `<base>`. That is what GitHub will show after publishing.
- **Revisions**: the server polls branch refs every two seconds. Each new head is recorded
  and pinned as `refs/laatsux/pull/<n>/<revision>` in your repository, so old revisions
  survive rebases and garbage collection.
- **Comments** are anchored to the commit and line they were made on. To place them on the
  current head, the server maps the line through `git diff -U0`; if the line itself
  changed, the comment is outdated.
- **Publishing** pushes the reviewed commit (`git push origin <sha>:refs/heads/<branch>`)
  and runs `gh pr create`, or `gh pr edit` when the pull request already exists. The Publish
  button sends a fingerprint of the commits, title and description on screen; if the agent
  changed any of them since the page loaded, publishing is refused. Force-pushes use
  `--force-with-lease` against the last published commit, so commits added on GitHub are
  never overwritten.
- **Git settings** that change diff output (`diff.noprefix`, `diff.mnemonicPrefix`,
  `diff.relative`, `diff.interHunkContext`, `log.showSignature`) are overridden for the
  server's git calls.
- **Data** lives in SQLite at `~/.local/share/laatsux/laatsux.db` (`$LAATSUX_HOME`).
- **Security**: the server listens on 127.0.0.1 only, rejects requests whose `Host` is not
  localhost (DNS rebinding) and writes with a foreign `Origin` (cross-site requests).
  Anything running as you on this machine can use it.

## Configuration

| Variable | Default | |
|---|---|---|
| `LAATSUX_URL` | `http://localhost:7171` | Where the CLI finds the server |
| `LAATSUX_PORT` | `7171` | Port for `serve` and the default URL |
| `LAATSUX_HOME` | `~/.local/share/laatsux` | Server data directory |
| `LAATSUX_ACTOR` | see below | Who CLI calls act as |
| `LAATSUX_USER` | your `gh` login | The reviewer's name in the UI |
| `LAATSUX_GH` | `gh` | gh binary used for publishing |

## Review agents

Reviews are not tied to the human. Another agent can review by setting its own identity and
using the same calls a GitHub review bot would:

```sh
LAATSUX_ACTOR=reviewer laatsux api repos/{owner}/{repo}/pulls/3/reviews --input review.json
LAATSUX_ACTOR=reviewer laatsux pr review 3 --comment -b "Looks fine apart from the retry loop."
```

Its comments show with a bot badge, and they wake the author's `pr wait` like yours do.

## Development

```sh
pnpm dev          # server with --watch on :7171
pnpm test         # unit tests and an end-to-end run of the agent loop
pnpm typecheck
```
