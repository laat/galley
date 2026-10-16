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
| `laatsux pr view [<n>]` | `--comments` adds reviews and review threads; `--json`, `--jq`, `--web`. `--download-images <dir>` saves the images in them as files |
| `laatsux pr diff [<n>]` | `--name-only`, `--patch` |
| `laatsux pr edit [<n>]` | `--title`, `--body`, `--body-file`, `--base` |
| `laatsux pr comment [<n>]` | `--body`, `--body-file`, `--edit-last`, and `--reply-to <thread>` to answer a review thread, with `--resolve` to resolve it too |
| `laatsux pr review [<n>]` | `--approve`, `--comment`, `--request-changes`, `--body` |
| `laatsux pr checkout`, `status`, `ready`, `close`, `reopen` | as in gh |
| `laatsux pr wait [<n>]` | Block until someone other than the author responds, then print the new feedback. Only the author can wait: waiting tells reviewer agents and auto-publish it is ready. `--timeout 10m` gives up after 10 minutes with exit code 124. `--download-images <dir>` saves the images in it as files |
| `laatsux pr publish [<n>]` | Push and open the pull request on GitHub, like the Publish button. `--sign`, `--no-sign`, `--draft`, `--force`, `--during-review`; `--auto` and `--disable-auto` for [auto-publish](#auto-publish); `--auto-merge` for [auto-merge on GitHub](#auto-merge), with or without `--auto`. Refused for agents |
| `laatsux api <endpoint>` | GitHub REST paths, `{owner}`/`{repo}` placeholders, `-f`, `-F`, `-X`, `--input`, `--jq` |
| `laatsux browse [<number> \| <path>[:<line>[-<line>]] \| <sha>]` | Print the web UI's URL for a pull request, a file (at a line or lines) or a directory, and open it when run at a terminal. `-c, --commit` (default: HEAD), `-b, --branch`, `-n, --no-browser`, `-R, --repo` (commits and paths are then looked up in that repository, through the server). The URL names the commit, so it keeps pointing at the code you meant. A number is a pull request; when no pull request has it, a commit SHA |
| `laatsux serve` | Run the server and web UI |

A pull request is found the way gh finds it: by number, URL, branch name, or the current branch.

`pr view --json` supports gh's fields plus `reviewThreads` (with `isResolved`, `isOutdated`,
`path`, `line`, `diffHunk` and the comments), `publishedUrl`, `waiting`, and `autoPublishRequest`
(who turned [auto-publish](#auto-publish) on and when, and its options; null when it is off).
`autoMergeRequest` is gh's field for the [auto-merge](#auto-merge) laatsux enabled on the GitHub
pull request. `reviewRequests`
lists a reviewer agent that is reviewing or about to, with `status` (`IN_PROGRESS` or
`QUEUED`), `commit` and `startedAt`. `turn` says whose move it is (`AUTHOR`, `REVIEWER_AGENTS`,
`REVIEWER` or `NONE`) and why, as on the [front page](#the-front-page). `unpublishedChanges` lists
what a published pull request has that GitHub does not yet (`COMMITS`, `TITLE`, `BODY`); `state`
stays `PUBLISHED`, as gh would show it. `pr view` and `pr status` print both.

## The web UI

- The [front page](#the-front-page): the pull requests waiting for you, then those the agents are working on
- Per pull request the Conversation, Commits and Files changed tabs
- Unified and split diffs with syntax highlighting, a file tree, and per-file "Viewed"
- Unfold arrows on hunk headers load more lines of the file above and below a hunk, as on GitHub
- The repository at any commit, read from git's objects without a checkout: "View file" (and the old
  version) in each file's menu on Files changed, "Browse files" (`<>`) on each commit and revision.
  Directories list their files and show their README; files show with line numbers and syntax
  highlighting, and a click on a line number (shift-click for a range) links to it as `#L12-L20`.
  Markdown and SVG render, with a Code toggle. The URLs are GitHub's: `/:owner/:repo/tree/<sha>/<path>`,
  `/blob/<sha>/<path>` and `/raw/<sha>/<path>`
- Comment on a line, or drag across the `+` buttons to comment on a range; single comments or a pending review submitted as Comment, Approve or Request changes
- ```` ```suggestion ```` blocks rendered as a diff
- References linked as on GitHub: `#12`, `GH-12` and `owner/repo#12` go to issues and pull requests on GitHub (with their title on hover once looked up), `@user` to the profile, and commit SHAs to the commit. `#12` means number 12 on GitHub, since descriptions are written for GitHub. The publish box lists the issues that "Fixes #12" and the like close once merged
- Comments on a commit, for asking the agent to reword its message
- Images in every comment box: paste, drop or attach PNG, JPEG, GIF or WebP files of up to 10 MB. Under a comment with images, `pr wait` and `pr view --comments` print each image's URL, or with `--download-images <dir>` the file it was saved to, for agents that read image files
- Edit the title and description yourself; description edits show as a diff in the timeline
- Each push is a revision. Force-pushes get a Compare link, and "Changes since your last review" shows what changed since you last submitted a review
- Comments follow their lines across pushes, or are marked outdated when the code under them changed
- Live updates while the agent works, and a "waiting for your review" indicator while it runs `pr wait`
- Publish, with options to open as a draft and to [enable auto-merge on GitHub](#auto-merge). Publishing again after changes force-pushes if needed and updates the GitHub pull request with `gh pr edit`
- Publish when reviews are done: [auto-publish](#auto-publish)

### The front page

The Open tab lists the pull requests whose turn it is for you first, oldest first, then those
with the agents, then those published with nothing new. The author agent's turn starts when
`pr wait` (or `pr view --comments`) hands it feedback that asks something of it, and lasts until
its next action: a push, an edit, a reply, or waiting again. A reviewer agent's turn lasts while
it reviews the pull request or is about to. After that it is your turn: the author has answered
and waits, or has stopped ("claude is not waiting"), and the reviewer agents are done with the
latest commit. A failed review is your turn too, with a Retry button, and so is feedback the
author has not been handed while it is not waiting ("claude has not seen the latest feedback"):
it hears of it only when you tell it.

Each row says why: whether the author waits and for how long, pushes and answered threads since
your last review, what each reviewer agent made of the latest commit, your decision, unresolved
threads, and an update not published yet (a published pull request that changed since shows as
open, "Update not published: commits, title"). The tab's title counts your turn, "(2) Staged pull
requests", and **Notify me** shows a desktop notification when a pull request in any repository
becomes your turn, while a list page (any tab) is open.

Conversations stay in laatsux. Publishing sends the branch, title and description, not the review.
Images in the description stay too: GitHub has no API for uploading them, so they would be broken
there, and the publish box warns about them.

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
GET             /api/repos/{owner}/{repo}/commits/{ref}
GET             /api/repos/{owner}/{repo}/contents/{path}?ref=       (ref defaults to HEAD, not the default branch)
```

Extensions: `PUT|DELETE …/pulls/{n}/threads/{id}/resolved`, `POST …/pulls/{n}/publish`,
`PUT|DELETE …/pulls/{n}/auto-publish` (body `{sign, draft, force, auto_merge}`; with `auto_merge`,
both take the `merge_method` the page shows, and answer 412 when the setting has changed since),
`GET …/pulls/{n}/wait?timeout=s`, `GET …/gh/pulls[/{n}]?fields=` (the `gh --json` shapes),
`POST|GET …/pulls/{n}/reviewers/codex` (ask Codex to review; list its runs and this pull
request's settings), `PATCH …/pulls/{n}/reviewers/codex` (this pull request's own `enabled` and
`max_iterations`; null follows the settings, and fields left out stay as they are),
`GET /api/settings`, `PUT /api/settings/codex` and `PUT /api/settings/publish` (`mergeMethod`), `POST /api/uploads` (an image's bytes; answers
with its `path`, `/uploads/<sha256>.<ext>`) and `GET /uploads/<sha256>.<ext>`, and `GET /events`
(server-sent events). A pull request also has `turn` (`whose`: `author`, `reviewer_agents`,
`reviewer` or `none`, and `reasons`) and `unpublished_changes`.

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
  changed, the comment is outdated. Besides the lines of the diff, a comment can sit on an
  unchanged line of a changed file, the lines the unfold arrows load (an extension; the API
  takes them too). The Files changed tab shows such a thread with the lines around it.
- **Publishing** pushes the reviewed commit (`git push origin <sha>:refs/heads/<branch>`)
  and runs `gh pr create`, or `gh pr edit` when the pull request already exists. The Publish
  button sends a fingerprint of the commits, title and description on screen; if the agent
  changed any of them since the page loaded, publishing is refused. It force-pushes only
  when the push would drop the commit GitHub has (a rewritten history, or the agent's unsigned
  commits that signing replaces with copies) and force was chosen, with `--force-with-lease`
  against the last published commit (before the first publish, the branch as last fetched or
  pushed), so commits added on GitHub are never overwritten.
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
- **Data** lives in SQLite at `~/.local/share/laatsux/laatsux.db` (`$LAATSUX_HOME`), and uploaded
  images in `uploads/` beside it, named by the SHA-256 of their bytes. The server accepts PNG,
  JPEG, GIF and WebP by their magic bytes, and no SVG, which can carry script. Rendered Markdown
  shows images from the web and from `/uploads/`, and no other local URL.
- **Security**: the server listens on 127.0.0.1 only, rejects requests whose `Host` is not
  localhost (DNS rebinding) and writes with a foreign `Origin` (cross-site requests).
  `/raw` never serves a committed file as something that runs: HTML, SVG and other text are
  `text/plain`, binaries other than images are downloads, and every response has `nosniff`,
  a sandboxing `Content-Security-Policy` and `Cross-Origin-Resource-Policy: same-origin`.
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

## Auto-publish

**Publish when reviews are done**, next to Publish, approves publishing in advance, like
GitHub's "Enable auto-merge". laatsux then publishes on its own once:

- every reviewer agent is done with the head commit: Codex's latest review of it found
  nothing, Codex has used up its automatic reviews, or it is off for the pull request
  (in Settings, or with `pr create --no-review`);
- the author agent is waiting in `laatsux pr wait`, with all feedback seen;
- none of the conversations you started is unresolved.

The box shows what it is waiting for.

- It publishes what the agent pushed after you pressed the button (its answers to Codex),
  but only the commit it checked: a push in between waits for the next check. Its last
  check comes right before the push, after signing (which can wait for a prompt), so a
  Cancel, new feedback, or turning it on again with other options stops that attempt.
- The options are those in the publish box when you press the button: signing and draft as
  checked, and force-pushing if it was checked and turns out to be needed.
- Nothing is published while Codex reviews. A failed Codex review holds it up until you ask
  Codex again, or publish by hand.
- Signing, the push and each `gh` call get two minutes, since nobody is there to answer a
  prompt. A failure is shown on the pull request and turns auto-publish off.
- With "Enable auto-merge on GitHub" checked, it enables [auto-merge](#auto-merge) after publishing,
  with the merge method set when it was turned on.
- It publishes once, then turns off. Cancel, closing the pull request, your own "Request
  changes" and a new base turn it off too; the agent editing the title or description does not.
- Agents see it in `pr view` and in `pr wait`'s output, but only you can turn it on:
  `laatsux pr publish --auto` (with `--sign`, `--no-sign`, `--draft`, `--force`, `--auto-merge`) and
  `laatsux pr publish --disable-auto`, after `gh pr merge --auto`.

## Auto-merge

**Enable auto-merge on GitHub** in the publish box (or `pr publish --auto-merge`) has GitHub
merge the pull request once its requirements are met, such as required checks. With
auto-publish, a staged pull request goes from "the reviewers are done" to merged with
the repository's CI as the last gate.

- The option shows only when the repository on GitHub allows auto-merge. laatsux reads that
  with the counts on the repository tabs, in the background every five minutes; until it
  knows, or when gh fails, the option is hidden. Publishing with auto-merge, by hand or by
  auto-publish, asks GitHub again first and refuses, before anything is pushed, when the
  repository does not allow it.
- After the push and `gh pr create` or `gh pr edit`, laatsux runs
  `gh pr merge <url> --auto --squash --match-head-commit <sha>`. GitHub refuses that if the
  branch on GitHub is no longer the commit laatsux pushed, but it does not tie the merge to
  that commit: GitHub merges whatever the branch has once the requirements are met. A push by
  someone without write access turns auto-merge off; a push by someone with write access,
  such as an update published from laatsux, keeps it on and is merged too.
- The merge method is under **Settings** → Publishing (squash and merge by default). The
  publish box shows it, and publishing refuses if it changed after the page was loaded.
  Auto-publish uses the method from when it was turned on. When the repository does not allow
  the method, the publish box says so and publishing refuses, before anything is pushed.
- When GitHub has nothing left to wait for, gh merges at once. Right after `gh pr create`
  GitHub may not know that yet and refuses auto-merge ("Pull request is in clean status");
  laatsux then asks again, and gh merges.
- A failure does not undo the publish: the pull request is on GitHub. gh's message is shown
  in the merge box and the timeline, and `pr publish --auto-merge` exits with 1.
- Under auto-publish, the `gh` calls get two minutes like the others.
- The merge box, `pr view` (`auto-merge:` and `autoMergeRequest`, as in gh) and the API's
  `auto_merge` show that auto-merge is on. They say what GitHub answered then: laatsux does
  not follow the pull request on GitHub afterwards. When gh accepted the request but laatsux
  could not check whether GitHub merged at once, the merge box says auto-merge was requested,
  and the others do not claim it is on.
- What came of it stays in the merge box even when the option itself is hidden.

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
