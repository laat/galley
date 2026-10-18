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
- On Linux, for reviewer agents: unprivileged user namespaces, which Ubuntu 23.10 and later
  restrict with AppArmor (`kernel.apparmor_restrict_unprivileged_userns`); for Claude,
  bubblewrap and socat too

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

Run it once on the machine that keeps your pull requests. After that you rarely need to: when
no server is running there, the CLI starts one in the background (log in
`~/.local/share/galley/server.log`). It starts none on a machine where galley has never run, so
a forgotten `GALLEY_URL` fails instead of starting a second galley. `GALLEY_NO_AUTOSTART=1`
turns starting off. When another program has the port, the CLI and `galley serve` say so;
`GALLEY_PORT` moves galley to another.

The server publishes with your `git push`, `gh` and signing key, so they must work where it
runs. If an agent's sandbox blocks them, start the server yourself. Stopping the server lets
running reviews finish for up to 10 minutes; a second Ctrl-C stops it at once.

To open galley from your other devices on a [Tailscale](https://tailscale.com) network, keep it
on 127.0.0.1 and let `tailscale serve` give it an HTTPS address on the tailnet:

```sh
tailscale serve --bg 24823
GALLEY_PUBLIC_URL=https://<host>.<tailnet>.ts.net galley serve
```

Links galley gives, such as **Copy link** and the ones agents print, then use that address, so
they open on your other devices too. Agents still stage from the server's machine.

## Desktop app

On macOS, `desktop/` has an app: galley in a window of its own with a Dock icon, a notification
when a pull request has been your turn for 10 seconds (clicking it opens the pull request), and a
menu-bar status. Next to its icon is the number waiting for you and, after ↻, the number the agents
or auto-publish are working on. Its menu lists the open pull requests in the front page's groups,
each with what it waits for, and has a Start at login switch. It is a window onto the server the
CLI uses: it starts one when none is running, and quitting it leaves the server running. Its window
has no title bar of its own: galley's header holds the window's buttons, drags the window, and
stays at the top as you scroll. Uploaded images and raw files open in windows of their own, with a
title bar.

```sh
pnpm --dir desktop install
pnpm --dir desktop start     # run it from the checkout
pnpm --dir desktop build     # or build galley.app, unsigned, in desktop/out
```

The built app runs the checkout's code, so it follows `git pull`; keep the checkout where it is.
Its windows leave notifications to the app and have no **Notify me**.

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
   was on. A push GitHub refuses is not tried again, and you and the agent hear why; when
   someone added commits to the branch on GitHub, or rewrote it there, galley fetches it for the
   agent to rebase onto, and pushes the agent's new commits on top of it. A commit that would
   bring back what the rewrite removed is refused, unless you publish it yourself and choose to
   bring those commits back. One that fails otherwise (GitHub out of reach) is tried again when
   the agent next waits; one whose signing prompt nobody answered is tried again a few times
   over the next hour, whether the agent waits or not. When the branch conflicts with its base,
   galley tells the agent to rebase it, as before publishing, and pushes the rebase.

The conversation stays in galley; GitHub gets the branch, title and description.

Staged pull requests are numbered s#1, s#2, … ("s" for staged), so they are not mistaken for
GitHub's #1, #2. `s#4` in a comment or description links to it here; `#4` is GitHub's.

**Copy link** in a comment's **…** menu gives a link to it, and agents print one for each
thread. Opening it unfolds the thread or file the comment is in and scrolls to it.

The front page lists the pull requests waiting for you first, each with the reason, then those
the agents are working on. A published pull request is your turn once GitHub can merge it and
auto-merge is off, and its title opens it on GitHub; its s#N opens it here, and **Update not
published** opens the box to publish the update from. One that auto-publish publishes on its own
is not your turn, unless it waits for something of yours, nor is a commit whose signing galley
tries again. **Notify me** shows a desktop notification when one has been your turn for 10
seconds.

## Reviewer agents

Codex and Claude can review a pull request before you do. Turn them on in **Settings**. Each
reviews every new commit in a sandboxed checkout, with the dependencies installed so it can run
the tests, until it finds nothing, uses up its automatic reviews, or you publish. It is also
done with a commit once the author has seen its review and replied to or resolved each thread
the review opened. They only comment; the review decision is yours. A pull request's sidebar
shows what each is doing and its transcript, and lets you turn it on or off, change its limit,
or ask for a review now. **Stop iterating** in the merge box ends the automatic reviews. You can
also name reviewers when you ask an agent to stage; `galley reviewers` lists those that review a repository.

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
Request changes, a new base or a failed publish turns it off; a signing prompt nobody answered
does so only after a few tries over the next hour. With **Enable auto-merge on GitHub** checked
too, GitHub merges it once its required checks pass.

## Settings

The gear in the header. Per reviewer agent: whether it reviews automatically, its name, model,
reasoning effort, limit of automatic reviews, whether it may install dependencies and run the
tests, whether it skips pull requests by its own kind of agent, and for Claude, whether those
tests may listen on localhost. Under Publishing: the merge method for auto-merge, and how many
times to try signing again.

| Variable | Default | |
|---|---|---|
| `GALLEY_URL` | `http://localhost:24823` | Where the CLI finds the server |
| `GALLEY_PORT` | `24823` | Port for `serve` and the default URL |
| `GALLEY_PUBLIC_URL` | the local URL | Where other machines reach the server (`serve --public-url`): its links use it, and it accepts requests to its host |
| `GALLEY_ALLOWED_HOSTS` | unset | More hosts, or host:port, the server accepts requests to, comma-separated (`serve --allowed-host`) |
| `GALLEY_HOME` | `~/.local/share/galley` | Server data directory |
| `GALLEY_CLONES` | unset | Keep a clone of each repository registered by its GitHub name in the data directory, which branches are pushed to over git ([docs/api.md](docs/api.md#git)). For staging from other machines; the CLI does not send branches yet |
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
- With a public URL, such as `tailscale serve`'s, every device that can reach it acts as you too.
  Never put galley on the internet (`tailscale funnel`).
- Secrets in a push are left to GitHub's push protection.
- Reviewer agents run code from the pull request in a sandbox with no network, except while the
  dependencies install. Code that gets past the install's precautions could reach the API.
  Turn off installing and running tests for repositories you do not trust. Claude installs in
  galley's own sandbox: sandbox-exec on macOS, bubblewrap on Linux. Where galley can not start
  one, it installs nothing.
- **Let Claude's tests listen on localhost** lets code in the pull request reach anything on
  localhost, the API included, and other machines on your network reach a server it starts
  that does not listen on 127.0.0.1 only. Turn it on only for code you trust.

## More

- [`skills/galley/SKILL.md`](skills/galley/SKILL.md): the CLI and the loop, for agents.
- [`docs/api.md`](docs/api.md): the REST API under `/api`, GitHub's with galley's extensions.
- `galley --help`: the CLI, which takes the same subcommands and flags as `gh`.
