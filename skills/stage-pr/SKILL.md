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
- Never write a staged pull request's number where GitHub shows it: commit messages, the title
  and description (they become the GitHub pull request), issues and GitHub comments. Refer to a
  published pull request by its GitHub number, an unpublished one by what it does or its branch.
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

   It prints the review URL. Tell the user you staged it, with the URL, and that the reviewer
   agents review it first. Do not ask for the user's review yet. `--fill`, `--base`, `--head` and
   `--draft` work as in gh. If the user said how the pull request should be reviewed, add the
   flag from [Reviewer agents](#reviewer-agents). If the server is not running, the CLI starts it
   and says so; mention that to the user along with the URL.

2. Wait for the review. This blocks until a reviewer agent or the user submits a review or
   comment, the reviewer agents are done with your latest commit, or the user publishes or closes
   the pull request (and once published, until it is merged or closed on GitHub), then prints
   only what is new:

   ```sh
   laatsux pr wait
   ```

   It can block for hours, longer than most shell tools let a command run. Tell the user you
   are waiting, and run it the way your agent allows:

   - In Claude Code, run it with `run_in_background` so you are woken when it returns.
   - In Codex, the command keeps running when the tool call returns a session ID. Poll that
     session (`write_stdin` with no input, `yield_time_ms` up to 300000) until it exits.
   - Where the shell tool kills a command after a time limit (opencode's does after 2 minutes,
     unless you pass a larger `timeout`), add `--timeout` under that limit, for example
     `laatsux pr wait --timeout 9m` with a tool timeout of 10 minutes. On exit code 124 it
     timed out with no feedback: run it again. Nothing is lost between runs, because feedback
     counts as seen only once a wait has printed it.

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
   - `Image: <url>` under a comment is a screenshot or other image the user pasted. Look at it:
     run `laatsux pr view --comments --download-images <dir>` (or give `pr wait` the same flag)
     and read the files it prints in place of the URLs.

   For the whole conversation, run `laatsux pr view --comments`. For JSON, run
   `laatsux pr view --json reviewThreads,reviews,comments`.

4. Address every thread, with a change or a reply:
   - Change the code and commit. Amend or fix up the commit the feedback is about, so the
     history stays the way the user wants it published.
   - Change the title or description with `laatsux pr edit --title "..." --body-file -`.
   - Reply to every thread, saying what you did or why you did not, and resolve the ones you
     fixed:

     ```sh
     laatsux pr comment --reply-to 12 --resolve -b "Switched to backoff() in 3f2a1c9."
     laatsux pr comment --reply-to 14 -b "Kept the loop: backoff() can't retry here because …"
     laatsux pr comment --reply-to 15 -b "Out of scope: the parser did this before this change. Follow-up issue?"
     ```

   - For anything that needs the user's input, ask in a reply or with `laatsux pr comment -b "..."`.

   The pull request does one thing: what its title and description say.
   - Fix what the feedback finds in that change. A finding outside it (a bug that was already
     there, an improvement next to the change, a case far from it) does not belong here: reply
     that it is out of scope, propose a follow-up issue or pull request, and leave the thread
     open so the user decides. The user may ask for it anyway.
   - Do not add features, refactors or cleanups nobody asked for. Mention them in a reply or
     the description instead.
   - If each round finds new cases in the same area, the approach may be wrong. Say so and
     propose the structural fix to the user before you rewrite, instead of patching case after
     case.

5. Run `laatsux pr wait` again, and repeat steps 2 to 4 with the reviewer agents until it says
   they are done with your latest commit:

   ```
   The reviewer agents are done with 3f2a1c9 (codex-review found nothing in 3f2a1c9); ask the reviewer to review it: <url>
   ```

   It says so once per commit, when none of them reviews it or is about to: their review was
   clean, they used up their automatic reviews (or the user stopped them), or they have nothing
   more to say. When none is turned on, it says
   `No reviewer agent reviews 3f2a1c9; ask the reviewer to review it` instead.

6. Ask the user to review. Tell them the pull request is ready for their review, with the URL,
   and in a few lines what the reviewer agents found and what you changed. Then run
   `laatsux pr wait` again.

7. Loop with the user the same way until `pr wait` prints `Published to GitHub: <url>` or
   reports that the pull request was closed. After a new commit the reviewer agents may review
   it first: ask the user again, as in step 6, when `pr wait` says they are done with it. If it
   says auto-publish is on, the user has approved publishing in advance: address the feedback
   and wait again, and laatsux publishes while you wait once the reviewer agents are done. If it
   says it also turns on auto-merge, GitHub merges the pull request once its required checks
   pass; you do not merge it.

8. After `Published to GitHub: <url>`, tell the user the GitHub URL, and run `laatsux pr wait`
   once more, the same way. laatsux follows the pull request on GitHub, so this blocks until it
   is merged or closed there, or new feedback arrives:

   - `Merged on GitHub as e468a4e by laat: <url>`: clean up, as in [After the merge](#after-the-merge).
   - `Closed on GitHub without merging`: you are done. Leave the branch and worktree unless the
     user says otherwise.
   - New feedback: address it as in step 4 and wait again. The user publishes the update, or
     auto-publish does once the reviewer agents are done with it and you are waiting.

## After the merge

The branch is on the base branch now. Clean up, unless the user wants to keep something:

1. Bring the local base branch up to the merge: `git fetch origin`, then
   `git merge --ff-only origin/<base>` where the base branch is checked out, or
   `git fetch origin <base>:<base>` when it is checked out nowhere.
2. Remove the pull request's worktree (`git worktree remove <path>`, if you made one) and its
   branch. GitHub has signed copies of your commits (a squash merge makes new ones), so git does
   not see the branch as merged: delete it with `git branch -D <branch>`.
3. Rebase your other open pull requests that touch the same files onto the new base, so their
   diffs and the user's review stay current: compare `laatsux pr diff <n> --name-only` with the
   merged files, then `git rebase origin/<base>` on each such branch. laatsux records the rebase
   as a new revision and carries the review comments along.

Leave the `refs/laatsux/...` refs alone; the review comments are anchored to those commits.

## Several pull requests

An agent that looks after several pull requests can wait on all of them:
`laatsux pr wait 5 6` returns as soon as one of them has news, says which, and leaves the news
of the others for the next wait. A merged or closed pull request is reported on every wait, so
leave it out of the next one, as the output says.

## Reviewer agents

Codex and Claude can review the pull request before the user does. They review when you run
`laatsux pr wait`, and their reviews wake you like the user's: address them the same way and
wait again. One loop is one review from each reviewer agent and your answer to them. Whether
they review is the user's setting, unless they say otherwise when they ask you to stage:

| The user says | Add to `laatsux pr create` |
|---|---|
| "stage PR with codex 3 loops" | `--reviewer codex:3` |
| "stage PR with codex 1 loop" | `--reviewer codex:1` |
| "stage PR with codex" | `--reviewer codex` (as many loops as the settings allow) |
| "stage PR with claude" | `--reviewer claude` (`claude:2` for two loops) |
| "stage PR with codex and claude" | `--reviewer codex --reviewer claude` |
| "stage PR no review" | `--no-review` |
| nothing about review | nothing; the settings decide |

## Reference

| gh | laatsux | notes |
|---|---|---|
| `gh pr create` | `laatsux pr create` | stages; never pushes. `--reviewer codex[:N]`, `--reviewer claude[:N]`, `--no-review` |
| `gh pr view [--comments] [--json f] [--jq q]` | same | `--comments` includes review threads; `--json reviewThreads` exists; `--download-images <dir>` saves pasted images as files |
| `gh pr list`, `diff`, `edit`, `comment`, `checkout`, `status`, `ready`, `close`, `reopen` | same | |
| `gh pr review -c/-a/-r -b` | same | for reviewer agents |
| `gh api repos/{owner}/{repo}/pulls/N/comments` | same path | REST subset; see `laatsux api --help` |
| | `laatsux pr wait [<n>...]` | block until feedback or the reviewer agents are done with your latest commit, or after publishing until merged or closed on GitHub; several numbers return the first with news |
| | `laatsux pr comment --reply-to ID [--resolve]` | reply to a review thread, and resolve it |
| `gh browse path:line --commit sha` | `laatsux browse path:line[-line] [--commit sha]` | prints a link to those lines in the web UI (default: HEAD); give it to the user when you point at code |

`laatsux api` speaks the GitHub REST shapes for pulls, review comments, reviews and issue
comments, with `-f`, `-F`, `-X`, `--input` and `--jq`. GraphQL is not supported.

Comments you make are attributed to your agent name: `claude` in Claude Code (`claude-review`
is the Claude reviewer), `codex-agent` in Codex (`codex-review` is the Codex reviewer), `opencode` in
opencode. Set `LAATSUX_ACTOR` to use another name, for example when acting as a reviewer agent.
