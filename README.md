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

Teach your agents the workflow with the `stage-pr` skill in [`skills/stage-pr/SKILL.md`](skills/stage-pr/SKILL.md).
Agents use it when you say "stage a PR", or when you run `/stage-pr` in Claude Code. Codex
and opencode read skills from `~/.agents/skills`, Claude Code from `~/.claude/skills`:

```sh
mkdir -p ~/.agents/skills ~/.claude/skills
ln -s "$PWD/skills/stage-pr" ~/.agents/skills/stage-pr       # Codex, opencode
ln -s ~/.agents/skills/stage-pr ~/.claude/skills/stage-pr    # Claude Code
```

opencode reads `~/.claude/skills` too, and loads a skill it finds in both once.

## Run

```sh
laatsux serve            # http://localhost:7171
```

You rarely need to: when nothing answers at a local `LAATSUX_URL`, the CLI starts
`laatsux serve` in the background (log in `~/.local/share/laatsux/server.log`) and carries on.
The server is detached, so it keeps running after the agent that started it is done.
`LAATSUX_NO_AUTOSTART=1` turns this off.

The server runs with the permissions of whoever started it, and publishing needs `git push`
and `gh pr create` (and your signing key, when signing) to work there. If an agent sandbox
blocks any of them, start the server yourself outside it.

## The CLI

`laatsux` takes the same subcommands and flags as `gh`, so an agent that knows gh needs no
new vocabulary. Flags that mean nothing here (labels, assignees, reviewers other than Codex) are accepted and ignored.

| Command | |
|---|---|
| `laatsux pr create` | Stage the current branch. `--title`, `--body`, `--body-file`, `--base`, `--head`, `--draft`, `--fill`, `--fill-first`, `--fill-verbose`. `-r, --reviewer codex` turns automatic Codex reviews on for this pull request, `codex:3` with its own limit of 3; `--no-review` turns them off. Without either, the settings decide |
| `laatsux pr list` | `--state open\|published\|closed\|all`, `--json`, `--jq` |
| `laatsux pr view [<n>]` | `--comments` adds reviews and review threads; `--json`, `--jq`, `--web` |
| `laatsux pr diff [<n>]` | `--name-only`, `--patch` |
| `laatsux pr edit [<n>]` | `--title`, `--body`, `--body-file`, `--base` |
| `laatsux pr comment [<n>]` | `--body`, `--body-file`, `--edit-last`, and `--reply-to <thread>` to answer a review thread, with `--resolve` to resolve it too |
| `laatsux pr review [<n>]` | `--approve`, `--comment`, `--request-changes`, `--body` |
| `laatsux pr checkout`, `status`, `ready`, `close`, `reopen` | as in gh |
| `laatsux pr wait [<n>]` | Block until someone other than the author responds, then print the new feedback. `--timeout 10m` gives up after 10 minutes with exit code 124 |
| `laatsux pr publish [<n>]` | Push and open the pull request on GitHub, like the Publish button. `--sign`, `--no-sign`, `--draft`, `--force`, `--during-review`. Refused for agents |
| `laatsux api <endpoint>` | GitHub REST paths, `{owner}`/`{repo}` placeholders, `-f`, `-F`, `-X`, `--input`, `--jq` |
| `laatsux serve` | Run the server and web UI |

A pull request is found the way gh finds it: by number, URL, branch name, or the current branch.

`pr view --json` supports gh's fields plus `reviewThreads` (with `isResolved`, `isOutdated`,
`path`, `line`, `diffHunk` and the comments), `publishedUrl` and `waiting`. `reviewRequests`
lists a reviewer agent that is reviewing or about to, with `status` (`IN_PROGRESS` or
`QUEUED`), `commit` and `startedAt`.

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
`POST|GET …/pulls/{n}/reviewers/codex` (ask Codex to review; list its runs and this pull
request's settings), `PATCH …/pulls/{n}/reviewers/codex` (this pull request's own `enabled` and
`max_iterations`; null follows the settings, and fields left out stay as they are),
`GET /api/settings` and `PUT /api/settings/codex`, and `GET /events` (server-sent events).

`POST …/pulls` also takes the reviewer agents for the new pull request. `reviewers` turns the
named ones on: logins as in GitHub's requested reviewers (`["codex"]`), or
`{"login": "codex", "max_iterations": 3}` for a limit of its own. A login matches a reviewer
agent by its kind (`codex`) or its name in settings; others are ignored and listed in the
response's `ignored_reviewers`. `"automatic_reviews": false` turns all of them off (`true`
turns all of them on), and is refused together with a reviewer agent in `reviewers`. Left
out, the settings decide.

Requests carry the caller's identity in `X-Laatsux-Actor`. The CLI sets it to
`LAATSUX_ACTOR`, or to the detected agent (`claude` in Claude Code, `codex-agent` in Codex,
`opencode` in opencode), or to `agent` when it runs without a terminal. Run at a terminal
with none of those, and in the web UI, you act as yourself. Agents cannot publish or delete
staged pull requests.

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
- **Signing**: agents commit unsigned; the commits are yours once you publish. Publishing
  can sign them: laatsux makes a signed copy of each commit with `git commit-tree -S`, with
  the same tree, message and author and you as committer (GitHub only verifies a signature
  whose key belongs to the committer), and pushes the copies. The agent's branch is left as
  it is. Copies are remembered per commit, so publishing again after the agent added commits
  is a fast-forward on GitHub. Signing is on by default when your git has
  `commit.gpgsign = true`, and the Publish button has a checkbox for it.
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
| `LAATSUX_CODEX` | `codex` | Codex binary used for reviews |
| `LAATSUX_NO_AUTOSTART` | unset | Do not start a server when none is running |

## Codex reviews

Codex can review staged pull requests before you do. Turn it on under **Settings** (the gear
in the header):

| Setting | |
|---|---|
| Review automatically | Codex reviews when the author agent runs `laatsux pr wait`, before you look |
| Model | Any model from `codex debug models`, or Codex's own default |
| Reasoning effort | The levels the chosen model supports, or Codex's default |
| Max iterations | Automatic reviews per pull request, so Codex and the author agent do not go back and forth forever |

How it runs:

- Each head commit gets one automatic review. Codex runs `codex exec --sandbox read-only
  --ephemeral` in a temporary checkout of that commit, answers in a JSON schema, and laatsux
  posts the result as a review from the reviewer bot, named `codex` unless you rename it in
  settings. Renaming keeps its earlier reviews. Findings on lines outside the diff go
  in the review's body.
- The review wakes the author's `pr wait`, so the agent addresses Codex's comments and waits
  again; Codex then reviews the new commit, until the cap is reached.
- Codex reviews only comment. They never approve or request changes, so the review decision
  stays yours.
- A pull request's own limit is set with the − and + after the number in its sidebar
  ("Automatic reviews: 3 of 3 − +"); "reset" goes back to the setting. If the author is
  waiting when the limit goes up, Codex starts right away.
- Staging can decide for one pull request, whatever the setting says:
  `laatsux pr create --reviewer codex:3` turns automatic reviews on with a limit of 3,
  `--reviewer codex` turns them on with the limit from settings, and `--no-review` turns them
  off. The sidebar then says "Turned on for this pull request (off in Settings)", or off, and
  its "reset" goes back to the setting.
- "Ask Codex to review" in a pull request's sidebar runs a review at any time, regardless of
  the cap. The sidebar also shows a running review and the error of a failed one.
- While Codex reviews, `pr view` and `pr wait` say so, an approval no longer tells the agent
  that nothing is left open, and publishing takes a second click on the Publish button (or
  `pr publish --during-review`). The server decides, so a page loaded before the review
  started asks too: `POST …/pulls/{n}/publish` answers 428 unless the body has
  `"during_review": true`.
- Codex must be installed and logged in where the server runs.

## Other review agents

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
