---
name: galley
description: Stage a pull request in galley, the user's local review server, instead of opening it on GitHub. Use when the user says "stage PR" or "stage a PR". The CLI mirrors `gh pr` and `gh api`; the user reviews in a GitHub-like web UI, you address the feedback, and the user publishes to GitHub.
---

# Stage a PR

`galley` takes `gh`'s subcommands and flags: `galley pr` for `gh pr`, `galley api` for `gh api`.

## Rules

- Do not `git push` or run `gh pr create`. The user publishes. After that, commit and run
  `galley pr wait`: it pushes your commits. Never push to GitHub yourself.
- Do not run `galley pr publish`, `pr close` or `pr review` unless the user asks.
- Commit on a branch, with at least one commit over the base.
- Commit unsigned. If `git commit` tries to sign, use `git -c commit.gpgsign=false commit …`.
- Write a staged pull request as `s#4` ("s" for staged), to the user and in galley's comments,
  where it links to it. `#4` is GitHub's issue or pull request 4. In commands, `s4` (`galley pr
  wait s4`).
- Never write a staged pull request's number where GitHub shows it: commit messages, the title
  and description, issues and GitHub comments. Refer to a published pull request by its GitHub
  number, an unpublished one by what it does or its branch.
- You may rewrite history (amend, fixup, rebase, reword).
- Resolve the threads you addressed, with `--resolve` on your reply. Leave a thread open when you
  disagree, only partly addressed it, or need the user's answer.

## The loop

1. Stage the branch you are on:

   ```sh
   galley pr create --title "Add retry to the uploader" --body-file - <<'EOF'
   Why the change is needed, and what it does.
   EOF
   ```

   Tell the user the URL it prints, that you staged it, and that the reviewer agents review it
   first; do not ask for the user's review yet. Say so if the CLI started the server. If the
   user said how to review it, add the flag from [Reviewer agents](#reviewer-agents).

2. Run `galley pr wait`. It can block for hours. Tell the user you are waiting, and run it the
   way your agent allows:

   - Claude Code: with `run_in_background`, so you are woken when it returns.
   - Codex: when the tool call returns a session ID, poll it (`write_stdin` with no input,
     `yield_time_ms` up to 300000) until it exits.
   - A shell tool with a time limit (opencode's is 2 minutes unless you pass a larger
     `timeout`): add `--timeout` under it, such as `--timeout 9m` with a 10-minute tool timeout.
     On exit code 124, run it again; nothing is lost.

3. Read what it printed:

   ```
   thread 12 on src/upload.ts:40-42 [unresolved]
       +  for (let i = 0; i < 3; i++) {
       laat:
         Use the backoff helper here.
   ```

   - `thread <id> on <path>:<lines>`: about those lines. `[outdated]`: the code changed since;
     check whether it still applies.
   - `thread <id> on commit <sha>`: about that commit's message. Reword the commit.
   - A ```` ```suggestion ```` block replaces the commented lines. Apply it unless it is wrong.
   - Comments without a thread: about the whole pull request, often the title or description.
   - `This branch conflicts with origin/main …; rebase onto origin/main`: rebase onto it (it is
     fetched), resolve the conflicts, run the tests, and wait again. Only behind
     (`mergeStateStatus` `BEHIND`): leave it unless the user asks for a rebase.
   - `Image: <url>`: add `--download-images <dir>` to `pr wait` or `pr view --comments`, and
     read the files it prints.

   `galley pr view --comments` shows the whole conversation (`--json
   reviewThreads,reviews,comments` for JSON).

4. Address every thread, with a change or a reply:

   - Amend or fix up the commit the feedback is about.
   - Edit the title or description with `galley pr edit --title "..." --body-file -`.
   - Reply to every thread with what you did or why not:

     ```sh
     galley pr comment --reply-to 12 --resolve -b "Switched to backoff() in 3f2a1c9."
     galley pr comment --reply-to 15 -b "Out of scope: the parser did this before. Follow-up issue?"
     ```

   - Ask the user in a reply, or with `galley pr comment -b "..."`.

   Keep to what the title and description say. A finding outside the change (a bug that was
   there before, an improvement next to it, a case far from it): reply that it is out of scope,
   propose a follow-up, and leave the thread open. Add no features, refactors or cleanups nobody
   asked for; mention them instead. If each round finds new cases in the same area, propose a
   structural fix to the user before you rewrite.

5. Wait again, and repeat steps 2 to 4 until `pr wait` says the reviewer agents are done with
   your latest commit:

   ```
   The reviewer agents are done with 3f2a1c9 (codex-review found nothing in 3f2a1c9); ask the reviewer to review it: <url>
   ```

   or `No reviewer agent reviews 3f2a1c9; ask the reviewer to review it`.

6. Ask the user to review: the URL, and in a few lines what the reviewer agents found and what
   you changed. Wait again.

7. Loop with the user the same way until `pr wait` prints `Published to GitHub: <url>` or says
   it was closed. After a new commit, ask the user again only once `pr wait` says the reviewer
   agents are done with it. If auto-publish is on, address the feedback and wait; galley
   publishes. With auto-merge, GitHub merges it, not you.

8. After `Published to GitHub: <url>`, tell the user the GitHub URL and wait again. From now on
   no reviewer agent reviews your commits, and each commit you wait with is pushed to GitHub:

   - `Merged on GitHub as e468a4e by laat: <url>`: clean up as in [After the merge](#after-the-merge).
   - `Closed on GitHub without merging`: you are done. Leave the branch and worktree unless the
     user says otherwise.
   - New feedback: address it as in step 4, commit, and wait again.
   - `Pushed 3f2a1c9 to GitHub: <url>`: wait again.
   - `Could not push 3f2a1c9 to GitHub: …`: nothing was pushed. Do not push or force-push it
     yourself; the user decides. Tell the user why, and wait again.

## After the merge

Unless the user wants to keep something:

1. `git fetch origin`, then `git merge --ff-only origin/<base>` where the base is checked out,
   or `git fetch origin <base>:<base>` when it is checked out nowhere.
2. Remove your worktree and delete the branch with `git branch -D` (`-d` refuses: GitHub
   merged copies of your commits).
3. Rebase your other pull requests that touch the merged files onto `origin/<base>` (compare
   `galley pr diff s4 --name-only`).

Leave the `refs/galley/...` refs alone.

## Several pull requests

`galley pr wait s5 s6` returns when one has news and says which. Leave a merged or closed one out
of the next wait.

## Reviewer agents

Codex, Claude and reviewers the user defined review when you wait, until the pull request is
published, and their reviews wake you like the user's. Some review only the title, description
and commit messages, again whenever you change them. One loop is one review from each and your answer. A reviewer agent's approval
is not the user's: wait for the user all the same. The settings decide whether they review,
unless the user says otherwise when asking you to stage. Add to `galley pr create`:

- "with codex": `--reviewer codex` (as many loops as the settings allow); "codex 3 loops":
  `--reviewer codex:3`. The same for `claude`, or a reviewer the user defined by its name
  (`--reviewer house-rules:2`).
- "with codex and claude": `--reviewer codex --reviewer claude`.
- "no review": `--no-review`.

## Reference

- `galley browse <path>[:<line>[-<line>]] [--commit <sha>]` prints a link to those lines in the
  web UI. Give it to the user when you point at code.
- `galley api <endpoint>` takes GitHub REST paths with `-f`, `-F`, `-X`, `--input` and `--jq`.
  No GraphQL.
- Your comments are attributed to your agent: `claude` in Claude Code, `codex-agent` in Codex,
  `opencode` in opencode. `GALLEY_ACTOR` sets another name.
