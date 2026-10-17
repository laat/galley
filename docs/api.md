# API

The server speaks a subset of GitHub's REST API under `/api` (pulls, review comments, reviews,
issue comments, the timeline, commits and contents), in GitHub's shapes, so `galley api` calls
look like `gh api` calls. This page lists only what galley adds. Paths starting with `…` are
under `/api/repos/{owner}/{repo}`.

## Identity

- `X-Galley-Actor: <login>`: who the caller is; without it, the user. `X-Galley-Actor-Type: User|Bot` (default `Bot` unless the login is the user's). A reviewer agent's name is refused with 409.
- Another agent can review as a GitHub review bot does, under its own name: `GALLEY_ACTOR=reviewer galley pr review <n> --comment -b "…"`, or `POST …/pulls/{n}/reviews`. Its reviews wake the author's `pr wait` like the user's.
- Callers of type `Bot` get 403 from what is the user's to do: publishing, auto-publish, deleting, pinning, stop-iterating, settings, and asking for or configuring a reviewer agent.

## Pull requests

- `GET …/pulls?state=`: also `staged`, `published`, `done`, `merged` and `all`. `state` is `closed` once the pull request is done, merged on GitHub included.
- `POST …/pulls`: `reviewers` (logins, or `{"login": "codex", "max_iterations": 3}`) turns those reviewer agents on: a kind (`codex`, `claude`), a name in settings, or a custom reviewer of the repository. `automatic_reviews: false` turns all of them off. Unknown logins come back in `ignored_reviewers`.
- `DELETE …/pulls/{n}`: delete a staged pull request.
- `POST …/pulls/{n}/publish`: push and open or update the pull request on GitHub. Body `{sign, draft, force, expected, during_review, during_conflict, auto_merge, merge_method}`. 428 lists what the body must acknowledge in `acknowledge`; 412 when the pull request (`expected`, the page's fingerprint) or the merge method changed. The response adds `auto_merge_result`.
- `PUT|DELETE …/pulls/{n}/auto-publish`: turn auto-publish on (body `{sign, draft, force, auto_merge, merge_method}`) or off. It approves the first publish only: 422 once published.
- `GET …/pulls/{n}/wait?timeout=<s>`: long-poll for the author. `status` is `feedback`, `agents_done`, `conflicts`, `published`, `pushed`, `push_failed`, `closed`, `merged`, `closed_on_github` or `timeout`, with `pr` (the gh shape), `agents_done`, `conflicts`, `push`, `left_out`, `asks_author`, `still_to_review` and `seen_at`. `asks_author` says whether the author has anything to address once it has read what came: feedback that asks something of it (anything from anyone else but an approval without comments, or a reviewer agent's review that found nothing), a thread waiting for its answer (unresolved, with someone else's comment the latest), or a reviewer agent's findings in the head it has not answered; `still_to_review` is what the reviewer agents that still have the head to review are at. Both are null with `agents_done` and `timeout`. Once published, a wait with a head GitHub does not have pushes it, signed as the last publish was and force-pushed only with a lease on what galley pushed last; `push` says how (`source`, `head`, `before`, `force`, `signed`, `result`, `error`, `retry`), and is in the timeline as a `github_push` event. A push GitHub refused is `push_failed`, and is not tried again for that commit; one that failed otherwise (`retry`) is tried again at the author's next wait, which hears nothing of it. With `merged`, `left_out` is what the branch has that GitHub did not merge, or null: `commits` (`sha`, `parents`, `message`; oldest first), synced before galley heard of the merge or made after it, but none on a remote-tracking branch, such as the base's (copies a rebase made of published ones count); `head`, the branch's tip; and `deleted`, true when the branch is gone and `head` is what galley last saw of it.
- `PUT …/pulls/{n}/seen`: the author confirms it showed a wait's result: `{at, agents_done?, conflicts?}`.
- `PUT|DELETE …/pulls/{n}/pinned`: pin to the top of the front page.
- `PUT|DELETE …/pulls/{n}/stop-iterating`: stop the reviewer agents' automatic reviews, or resume them.
- `PUT …/pulls/{n}/viewed`: `{path, blob, viewed}`, a file's "Viewed" box.

Fields on a pull request: `staging_state` (`staged`, `published`, `done`), `published_url`, `published_at`, `github_state` (`open`, `merged`, `closed`; null until asked), `github_closed_at`, `github_closed_by`, `author_waiting`, `auto_publish`, `iterations_stopped`, `turn` (`whose`: `author`, `reviewer_agents`, `reviewer`, `none`, and `reasons`; a reviewer agent's reason has its `state` and `to_review`, true while it still has the head to review), `unpublished_changes`, `pinned_at`.

## Review comments and threads

- `PUT|DELETE …/pulls/{n}/threads/{id}/resolved`: resolve or unresolve a thread.
- `POST …/pulls/{n}/pending-comments`: add a comment to the caller's pending review, starting one.
- A comment may sit on an unchanged line of a changed file, outside the diff's hunks.
- Fields on a review comment: `priority`, `outdated`, `resolved`.

## Reviewer agents

`{reviewer}` is `codex`, `claude` or a custom reviewer's name; 404 for a custom reviewer that does not review the repository.

- `POST …/pulls/{n}/reviewers/{reviewer}`: review now, whatever the limit. Answers 202 with `run_id`.
- `GET …/pulls/{n}/reviewers/{reviewer}`: its runs (with `usage`, what each cost) and this pull request's settings.
- `PATCH …/pulls/{n}/reviewers/{reviewer}`: this pull request's `enabled` and `max_iterations`; null follows the settings.
- `GET …/reviewers`: the reviewer agents that review the repository: `login`, `reviewer` (as `{reviewer}` above), `engine`, `reviews` (`code` or `description`), `automatic` (whether it reviews the caller's pull requests on its own) and `max_iterations`, never their instructions. `POST …/pulls` answers with those of the new pull request, for it, in `reviewer_agents`.
- `GET|POST /api/settings/reviewers`, `GET|PATCH|DELETE /api/settings/reviewers/{name}`: custom reviewers, with their file's keys plus `path`, `login` and the `error` that keeps one from running. PATCH changes the fields given and refuses `name`.

## gh shapes

- `GET …/gh/pulls[/{n}]?fields=<a,b>`: what `gh pr list|view --json` prints. Besides gh's fields: `reviewThreads`, `publishedUrl`, `waiting`, `isPinned`, `autoPublishRequest`, `reviewRequests` (with `status`, `commit`, `startedAt`), `turn`, `unpublishedChanges`, `baseConflicts`, `githubStatus`, `ref` (`s4` for staged pull request s#4, as the CLI takes it), and `byReviewerAgent` on each review (such an approval is not in `reviewDecision`). `state` is also `STAGED` and `PUBLISHED`.

## Other

- `GET /api/settings`, `PUT /api/settings/{codex|claude}`, `PUT /api/settings/publish` (`mergeMethod`).
- `POST /api/repos` `{path}`: register the repository at that path. Its `full_name` is the GitHub owner/name of its remote, and follows the remote when it names another (a repository renamed on GitHub); the old name still works under `/api/repos`, and its pages redirect.
- `POST /api/markdown`: also takes `pull` (a pull request's API path), to link references as its pages do, `s#4` to staged pull request 4 among them.
- `POST /api/uploads`: an image's bytes; answers with its `path`, `/uploads/<sha256>.<ext>`, served by `GET /uploads/<sha256>.<ext>`.
- `GET /api/meta`: `{"name": "galley", "version": …}`, so the CLI knows it reached galley and not another program on its port. While the server starts, the same with 503.
- `GET /api/health`, and `GET /events` (server-sent events).
- `contents` defaults `ref` to `HEAD`, not the default branch.
