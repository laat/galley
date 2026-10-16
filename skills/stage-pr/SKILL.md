---
name: stage-pr
description: Stage a pull request in laatsux, the user's local review server, instead of opening it on GitHub. Use when the user says "stage PR" or "stage a PR". The CLI mirrors `gh pr` and `gh api`; the user reviews in a GitHub-like web UI, you address the feedback, and the user publishes to GitHub.
---

# Stage a PR

The user reviews your pull requests locally before anything reaches GitHub. You stage the
pull request, the user comments on lines, commits and the description, you address the
feedback, and the loop repeats until the user publishes it.

`laatsux` takes the same subcommands and flags as `gh`. Swap `gh pr` for `laatsux pr` and
`gh api` for `laatsux api`. (`gh laatsux pr ...` works too if it is installed as a gh extension.)

## Rules

- Do not `git push` and do not run `gh pr create`. Publishing is the user's decision; the
  server pushes the exact commit the user reviewed.
- Do not run `laatsux pr publish`, `laatsux pr close` or `laatsux pr review` unless the user asks.
- Commit on a branch. Staging needs at least one commit between the base and your branch.
- Commit unsigned. laatsux signs the commits as the user when they publish. If `git commit`
  tries to sign (it asks for a key, or fails on signing), commit with
  `git -c commit.gpgsign=false commit …`.
- You may rewrite history freely (amend, fixup, rebase, reword). The server records each
  push as a revision and carries review comments to the new lines.
- Resolve the threads you addressed, in the same command as your reply (`--resolve`). Keep a
  thread open when you disagree, only partly addressed it, or need the user's answer. The
  user can reopen any thread.

## The loop

1. Stage the branch you are on:

   ```sh
   laatsux pr create --title "Add retry to the uploader" --body-file - <<'EOF'
   Why the change is needed, and what it does.
   EOF
   ```

   It prints the review URL. Give that URL to the user. `--fill`, `--base`, `--head` and
   `--draft` work as in gh. If the user said how the pull request should be reviewed, add the
   flag from [Codex reviews](#codex-reviews). If the server is not running, the CLI starts it
   and says so; mention that to the user along with the URL.

2. Wait for the review. This blocks until the user submits a review or comment, publishes,
   or closes the pull request, then prints only the new feedback:

   ```sh
   laatsux pr wait
   ```

   In Claude Code, run it with `run_in_background` so you are woken when it returns, and
   tell the user you are waiting. `--timeout 10m` bounds it (exit code 124 on timeout).

3. Read what it printed. Each review thread looks like this:

   ```
   thread 12 on src/upload.ts:40-42 [unresolved]
       +  for (let i = 0; i < 3; i++) {
       laat:
         Use the backoff helper here.
   ```

   - `thread <id> on <path>:<lines>` is a comment on those lines of the current diff.
   - `[outdated]` means the code under the comment has changed since; check whether it still applies.
   - `thread <id> on commit <sha>` is about that commit's **message**. Reword the commit.
   - A ```` ```suggestion ```` block is a replacement for the commented lines. Apply it as written unless it is wrong.
   - Comments without a thread are about the pull request as a whole, often the title or description.

   For the whole conversation, run `laatsux pr view --comments`. For JSON, run
   `laatsux pr view --json reviewThreads,reviews,comments`.

4. Address everything:
   - Change the code and commit. Amend or fix up the commit the feedback is about, so the
     history stays the way the user wants it published.
   - Change the title or description with `laatsux pr edit --title "..." --body-file -`.
   - Reply to every thread you handled, saying what you did or why you did not, and resolve
     the ones you fixed:

     ```sh
     laatsux pr comment --reply-to 12 --resolve -b "Switched to backoff() in 3f2a1c9."
     laatsux pr comment --reply-to 14 -b "Kept the loop: backoff() can't retry here because …"
     ```

   - For anything that needs the user's input, ask in a reply or with `laatsux pr comment -b "..."`.

5. Run `laatsux pr wait` again. Repeat until it prints `Published to GitHub: <url>` (you are
   done; tell the user the GitHub URL) or reports that the pull request was closed. If it says
   a reviewer such as codex is still reviewing, its review is coming: wait for it before you
   tell the user the pull request is ready.

## Codex reviews

Codex can review the pull request before the user does. It reviews when you run
`laatsux pr wait`, and its review wakes you like the user's: address it the same way and wait
again. One loop is one Codex review and your answer to it. Whether Codex reviews is the user's
setting, unless they say otherwise when they ask you to stage:

| The user says | Add to `laatsux pr create` |
|---|---|
| "stage PR with codex 3 loops" | `--reviewer codex:3` |
| "stage PR with codex 1 loop" | `--reviewer codex:1` |
| "stage PR with codex" | `--reviewer codex` (as many loops as the settings allow) |
| "stage PR no review" | `--no-review` |
| nothing about review | nothing; the settings decide |

## Reference

| gh | laatsux | notes |
|---|---|---|
| `gh pr create` | `laatsux pr create` | stages; never pushes. `--reviewer codex[:N]`, `--no-review` |
| `gh pr view [--comments] [--json f] [--jq q]` | same | `--comments` includes review threads; `--json reviewThreads` exists |
| `gh pr list`, `diff`, `edit`, `comment`, `checkout`, `status`, `ready`, `close`, `reopen` | same | |
| `gh pr review -c/-a/-r -b` | same | for reviewer agents |
| `gh api repos/{owner}/{repo}/pulls/N/comments` | same path | REST subset; see `laatsux api --help` |
| | `laatsux pr wait` | block until feedback |
| | `laatsux pr comment --reply-to ID [--resolve]` | reply to a review thread, and resolve it |

`laatsux api` speaks the GitHub REST shapes for pulls, review comments, reviews and issue
comments, with `-f`, `-F`, `-X`, `--input` and `--jq`. GraphQL is not supported.

Comments you make are attributed to your agent name (`claude` in Claude Code). Set
`LAATSUX_ACTOR` to use another name, for example when acting as a reviewer agent.
