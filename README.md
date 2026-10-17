# galley

![An agent stages a pull request, reviewer agents review it, you review it in a GitHub-like UI, and you publish it to GitHub. The conversation stays in galley; GitHub gets the branch, title and description.](docs/galley.webp)

A local staging area for pull requests. Agents stage a pull request with a CLI that mirrors
`gh`, reviewer agents review it, and you review it in a web UI that looks like GitHub. When the
title, description and commits are right, you publish it to GitHub.

## Requirements

- Node 24 or newer
- git 2.38 or newer
- [gh](https://cli.github.com), logged in, for publishing
- jq, for `--jq`
- For reviewer agents: Codex or Claude Code, installed and logged in

## Install

```sh
git clone https://github.com/laat/galley && cd galley
pnpm install
ln -s "$PWD/bin/galley.ts" ~/.local/bin/galley   # or: npm link
```

Give your agents the `galley` skill, which tells them how to stage, wait and answer feedback.
Codex and opencode read skills from `~/.agents/skills`, Claude Code from `~/.claude/skills`:

```sh
mkdir -p ~/.agents/skills ~/.claude/skills
ln -s "$PWD/skills/galley" ~/.agents/skills/galley       # Codex, opencode
ln -s ~/.agents/skills/galley ~/.claude/skills/galley    # Claude Code
```

Then ask an agent to "stage a PR", or run `/galley` in Claude Code.

To use it as a gh extension too (`gh galley pr create …`):

```sh
dir="${XDG_DATA_HOME:-$HOME/.local/share}/gh/extensions/gh-galley"
mkdir -p "$dir" && ln -s "$PWD/bin/galley.ts" "$dir/gh-galley"
```

## Run

```sh
galley serve            # http://localhost:24823
```

You rarely need to: when no server is running, the CLI starts one in the background (log in
`~/.local/share/galley/server.log`). `GALLEY_NO_AUTOSTART=1` turns that off. When another
program has the port, the CLI and `galley serve` say so; `GALLEY_PORT` moves galley to another.

The server publishes with your `git push`, `gh` and signing key, so they must work where it
runs. If an agent's sandbox blocks them, start the server yourself. Stopping the server lets
running reviews finish for up to 10 minutes; a second Ctrl-C stops it at once.

## The review loop

1. **The agent stages its branch** with `galley pr create` and waits with `galley pr wait`.
   Nothing is pushed.
2. **Reviewer agents review it.** The agent answers them, commits and waits again, until they
   find nothing or reach their limit. Then it asks you to review.
3. **You review it.** Comment on lines, commit messages and the description, approve or request
   changes, or edit the title and description yourself.
4. **The agent addresses your feedback** and waits again. Comments follow their lines when it
   rewrites history, and reviewer agents review its new commits before you.
5. **You publish.** Publish pushes the commit you reviewed and opens the pull request on GitHub,
   or updates it. It can sign the agent's commits as you and turn on auto-merge. galley then
   shows the pull request's checks and reviews on GitHub, and tells the agent when it is merged.
6. **After that, GitHub's reviews and checks take over.** The agent commits and waits, and
   galley pushes each commit it waits with, without reviews here: signed as you published,
   force-pushed only over what galley pushed last, and with auto-merge asked for again if it
   was on. A push GitHub refuses is not tried again, and you and the agent hear why; one that
   fails otherwise (GitHub out of reach, a signing prompt nobody answered) is tried again when
   the agent next waits.

The conversation stays in galley; GitHub gets the branch, title and description.

Staged pull requests are numbered s#1, s#2, … ("s" for staged), so they are not mistaken for
GitHub's #1, #2. `s#4` in a comment or description links to it here; `#4` is GitHub's.

The front page lists the pull requests waiting for you first, each with the reason, then those
the agents are working on. A published pull request is your turn once GitHub can merge it and
auto-merge is off, and its title opens it on GitHub. **Notify me** shows a desktop notification when one becomes your
turn.

## Reviewer agents

Codex and Claude can review a pull request before you do. Turn them on in **Settings**. Each
reviews every new commit in a sandboxed checkout, with the dependencies installed so it can run
the tests, until it finds nothing, uses up its automatic reviews, or you publish. It is also
done with a commit once the author has seen its review and replied to or resolved each thread
the review opened. They only comment; the review decision is yours. A pull request's sidebar
shows what each is doing and its transcript, and lets you turn it on or off, change its limit,
or ask for a review now. **Stop iterating** in the merge box ends the automatic reviews. You can
also name reviewers when you ask an agent to stage.

You can add reviewer agents of your own, each with its own instructions, in
`~/.config/galley/reviewers/<name>.md` or under **Settings** → Custom reviewers (saving there
rewrites the file without its comments). The front matter holds the settings, the body the
instructions:

```markdown
---
engine: claude            # or codex; also model, effort, max_iterations
repos: [nrkno/*]          # GitHub owner/name globs; left out: every repository
reviews: description      # the title, description and commit messages; or code
verdict: approve          # approve when it finds nothing; left out: comment only
---
Check the title and description against these rules: …
```

A description reviewer reviews again when the title, description or a commit message changes,
and until then its findings hold things up, whatever the replies.
A custom reviewer's approval is its own; it never counts as yours.

## Auto-publish

**Publish when reviews are done**, next to Publish, approves publishing in advance, like
GitHub's auto-merge. galley publishes once the reviewer agents are done with the latest commit,
the agent is waiting with all feedback seen, your conversations are resolved, and the branch
merges cleanly into its base. It is for the first publish only. Cancel, closing it, your own
Request changes, a new base or a failed publish turns it off. With **Enable auto-merge on
GitHub** checked too, GitHub merges it once its required checks pass.

## Settings

The gear in the header. Per reviewer agent: whether it reviews automatically, its name, model,
reasoning effort, limit of automatic reviews, whether it may install dependencies and run the
tests, whether it skips pull requests by its own kind of agent, and for Claude, whether those
tests may listen on localhost. Under Publishing: the merge method for auto-merge.

| Variable | Default | |
|---|---|---|
| `GALLEY_URL` | `http://localhost:24823` | Where the CLI finds the server |
| `GALLEY_PORT` | `24823` | Port for `serve` and the default URL |
| `GALLEY_HOME` | `~/.local/share/galley` | Server data directory |
| `GALLEY_CONFIG_DIR` | `~/.config/galley` | Custom reviewers, in `reviewers/` |
| `GALLEY_ACTOR` | the detected agent | Who CLI calls act as |
| `GALLEY_USER` | your `gh` login | Your name in the UI |
| `GALLEY_GH` | `gh` | gh binary used for publishing |
| `GALLEY_CODEX` | `codex` | Codex binary used for reviews |
| `GALLEY_CLAUDE` | `claude` | Claude Code binary used for reviews |
| `GALLEY_NO_AUTOSTART` | unset | Do not start a server when none is running |

## Security

- The server listens on 127.0.0.1 and refuses requests from web pages on other sites. Any
  process running as you can still call its API as you, publishing included: agents are kept
  from publishing only by the name the CLI gives them, which `GALLEY_ACTOR` overrides
  ([#52](https://github.com/laat/galley/issues/52)).
- Secrets in a push are left to GitHub's push protection.
- Reviewer agents run code from the pull request in a sandbox with no network, except while the
  dependencies install. Code that gets past the install's precautions could reach the API.
  Turn off installing and running tests for repositories you do not trust.
- **Let Claude's tests listen on localhost** lets code in the pull request reach anything on
  localhost, the API included, and other machines on your network reach a server it starts
  that does not listen on 127.0.0.1 only. Turn it on only for code you trust.

## More

- [`skills/galley/SKILL.md`](skills/galley/SKILL.md): the CLI and the loop, for agents.
- [`docs/api.md`](docs/api.md): the REST API under `/api`, GitHub's with galley's extensions.
- `galley --help`: the CLI, which takes the same subcommands and flags as `gh`.
