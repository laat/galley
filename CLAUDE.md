# galley

Local pull request staging server: a CLI mirroring `gh pr`/`gh api` for agents, a GitHub-like web UI for review, and publishing to GitHub. See README.md for the user-facing picture.

## Commands

- `pnpm test`: node:test, `test/**/*.test.ts`. The files in `test/e2e/` run the whole agent loop against a temp repo, a bare remote and a fake `gh`, one feature per file, each with a server of its own from `startHarness()` (`test/helpers/harness.ts`): node runs the files in parallel and the tests in a file in sequence, so the longest file sets the suite's time. A test file that starts a server or runs the CLI imports `./helpers/env.ts` first, which keeps it off the user's galley, config, `gh`, `codex`, `claude` and the network. In a reviewer agent's sandbox the end-to-end tests need the setting "Let Claude's tests listen on localhost", and the `sandbox-exec` tests skip themselves, since macOS does not nest sandboxes.
- `pnpm typecheck`: `tsc --noEmit` (TypeScript 7).
- `pnpm dev`: server on :24823 with `--watch`. Use `GALLEY_HOME=<tmp> node bin/galley.ts serve --port 0` for a throwaway instance (it prints the URL of the port it got), and stage against a scratch repository or a mirror, not the one you work in.
- `GALLEY_NO_AUTOSTART=1 node bin/galley.ts …`: the CLI from a worktree. Without the variable, a call made while the server is away starts one from the branch's code.

## Conventions

- No build step: Node 24 strips types. Only erasable syntax (no enums, no parameter properties, no namespaces), and relative imports end in `.ts`.
- `src/cli` never touches the database or runs git against the server's view; it talks HTTP to the server. When nothing answers at a local URL, `src/cli/client.ts` starts a detached `galley serve`, so agents never have to.
- API responses copy GitHub's REST shapes (snake_case); `gh --json` output copies gh's shapes (camelCase). Both live in `src/server/github.ts`. Additions beyond GitHub are named as extensions in comments.
- HTML is built with the `html` tagged template (`src/server/web/html.ts`), which escapes every interpolation unless it is `Safe`. Use `raw()` only for markup we produced (sanitized markdown, highlight.js output, octicons).
- Every state change goes through `Service` and calls `emit()`, or `emitSystem()` for one no actor made (from GitHub or git), which drives live UI updates and wakes `pr wait`.
- Live updates reach the browser through one SharedWorker (`public/live-worker.js`) shared by all tabs. Never open an EventSource or other long-lived request per tab: browsers allow six HTTP/1.1 connections per host, and the seventh tab hangs.
- Each document has one reader. README.md is for users: what they can see and do, a sentence or two per feature. Implementation details and edge cases go in code comments where they apply, agent instructions in `skills/galley/SKILL.md`, and API extensions in `docs/api.md`.

## Layout

- `src/server/service.ts`: domain logic: repos, pulls, revisions (push detection), reviews, comments, line placement, wait, publish.
- `src/server/events.ts`: a pull request's timeline events, written and read back typed by their type. Some decide what galley does next: whether a push signs, whether a failed push is tried again.
- `src/server/feedback.ts`: what others post on a pull request, and what of it asks something of the author; `pr wait` (`Service.wait`), `Service.turn` and `Reviewer.answered` read it here.
- `src/server/github-follow.ts`: what galley reads about a published pull request on GitHub (merge, checks, review decision, threads, conflicts) to show the reviewer; `Service.followGithub` asks GitHub on a timer. The author agent hears only of a merge or close.
- `src/server/diff.ts`: unified diff parser, `mapLine` for carrying comments across revisions.
- `src/server/git.ts`: git plumbing, cached when all inputs are full SHAs.
- `src/server/api.ts`: REST routes under `/api`.
- `src/server/uploads.ts`: images pasted into comments, stored in the data directory by the SHA-256 of their bytes and served from `/uploads/`.
- `src/server/reviewers/reviewer.ts`: a reviewer agent: triggered by the `author-waiting` bus event, reviews in a temporary checkout (installing the dependencies first when it may run the tests) and posts a review as its bot, one attempt per head (per version of the description for a reviewer of the description: `Reviewer.subject`) within the per-pull-request limit. Each is one actor whose login follows its name (`meta.<engine>_actor_id`, or `meta.reviewer_actor_id:<name>` for a custom reviewer), and the API refuses CLI callers that claim it. What differs per tool is its `Engine` (`Reviewer.engine`, whose id is `Reviewer.engineId`): how to run it, its models, how to read its answer.
- `src/server/reviewers/head-status.ts`: where a reviewer agent stands with a pull request's head (`Reviewer.headStatus`), and what each state counts as: for whose turn it is, for handing the head to the user, for auto-publish.
- `src/server/reviewers/codex.ts`: Codex as an engine: `codex exec` in Codex's sandbox (default name `codex-review`; `--reviewer codex` finds it by its engine). The CLI calls author agents running in Codex `codex-agent`.
- `src/server/reviewers/claude.ts`: Claude as an engine: `claude -p` in Claude Code's sandbox (default name `claude-review`, since author agents in Claude Code are `claude`); its installs run in `sandbox.ts` (macOS `sandbox-exec`). The Codex and Claude reviewers' settings live in `src/server/settings.ts`.
- `src/server/reviewers/install.ts`: installing a pull request's dependencies before a review, only from a lockfile and without running anything the repository provides (no lifecycle scripts).
- `src/server/reviewers/transcript.ts`: what a reviewer agent does while it reviews, as ACP `session/update` updates that each engine reads its tool's stream into (`EngineJob.onUpdate`). Stored per run, capped, for the run's transcript page (`src/server/web/runs.ts`); the latest steps are followed in memory for the sidebar, which hears of them through `progress` events, not `change`.
- `src/server/reviewers/custom.ts`: custom reviewers: the user's own, one Markdown file each in `<configDir>/reviewers`, run by Codex's or Claude's engine. Each is a `Reviewer` whose `key` (in `review_runs.reviewer` and the API) is its name; it reviews the repositories its globs match (`Service.reviewersFor`), the code or the description (title, description and commit messages), and may approve, which never counts toward `reviewDecision`. Its settings are its file; its per-pull-request settings are JSON in `pulls.reviewer_overrides`.
- `src/server/reviewers/definition.ts`: a custom reviewer's file: front matter with its settings (`engine`, `repos`, `reviews`, `verdict`, `max_iterations`, …) and a body with its instructions. Reads, checks and writes them.
- `src/server/auto-publish.ts`: auto-publish (after GitHub's auto-merge): publishes a pull request the reviewer approved in advance once `Service.readiness` says the agents are done with it; after publishing, pushes each head the author waits with (`Service.pushReady`, `Service.pushUpdate`).
- `src/server/web/`: server-rendered pages; `public/app.js` adds the interactive parts (event delegation, soft refresh that keeps drafts).
- `src/config.ts`: what the server and the CLI share: the port and URL, the data directory and `configDir()`, the `GALLEY_*` variables (`fromEnv`) and who the CLI acts as (`cliActor`).
- `src/cli/`: the CLI: `main.ts` starts the server for `serve` and hands the other commands to `pr.ts` (`gh pr`), `api.ts` (`gh api`), `browse.ts` and `reviewers.ts`; `client.ts` talks HTTP to the server, and `format.ts` prints pull requests, threads and conversations.
