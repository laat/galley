# laatsux

Local pull request staging server: a CLI mirroring `gh pr`/`gh api` for agents, a GitHub-like web UI for review, and publishing to GitHub. See README.md for the user-facing picture.

## Commands

- `pnpm test`: node:test, `test/*.test.ts`. `test/e2e.test.ts` runs the whole agent loop against a temp repo, a bare remote and a fake `gh`. In a reviewer agent's sandbox the end-to-end tests need the setting "Let Claude's tests listen on localhost", and the `sandbox-exec` tests skip themselves, since macOS does not nest sandboxes.
- `pnpm typecheck`: `tsc --noEmit` (TypeScript 7).
- `pnpm dev`: server on :7171 with `--watch`. Use `LAATSUX_HOME=<tmp> node bin/laatsux.ts serve --port <p>` for a throwaway instance, and stage against a scratch repository or a mirror, not the one you work in.

## Conventions

- No build step: Node 24 strips types. Only erasable syntax (no enums, no parameter properties, no namespaces), and relative imports end in `.ts`.
- `src/cli` never touches the database or runs git against the server's view; it talks HTTP to the server. When nothing answers at a local URL, `src/cli/client.ts` starts a detached `laatsux serve`, so agents never have to.
- API responses copy GitHub's REST shapes (snake_case); `gh --json` output copies gh's shapes (camelCase). Both live in `src/server/github.ts`. Additions beyond GitHub are named as extensions in comments.
- HTML is built with the `html` tagged template (`src/server/web/html.ts`), which escapes every interpolation unless it is `Safe`. Use `raw()` only for markup we produced (sanitized markdown, highlight.js output, octicons).
- Every state change goes through `Service` and calls `emit()`, which drives live UI updates and wakes `pr wait`.
- Live updates reach the browser through one SharedWorker (`public/live-worker.js`) shared by all tabs. Never open an EventSource or other long-lived request per tab: browsers allow six HTTP/1.1 connections per host, and the seventh tab hangs.
- Each document has one reader. README.md is for users: what they can see and do, a sentence or two per feature. Implementation details and edge cases go in code comments where they apply, agent instructions in `skills/stage-pr/SKILL.md`, and API extensions in `docs/api.md`.

## Layout

- `src/server/service.ts`: domain logic: repos, pulls, revisions (push detection), reviews, comments, line placement, wait, publish.
- `src/server/github-follow.ts`: what laatsux reads about a published pull request on GitHub (merge, checks, review decision, threads, conflicts) to show the reviewer; `Service.followGithub` asks GitHub on a timer. The author agent hears only of a merge or close.
- `src/server/diff.ts`: unified diff parser, `mapLine` for carrying comments across revisions.
- `src/server/git.ts`: git plumbing, cached when all inputs are full SHAs.
- `src/server/api.ts`: REST routes under `/api`.
- `src/server/reviewers/reviewer.ts`: a reviewer agent: triggered by the `author-waiting` bus event, reviews the head in a temporary checkout (installing the dependencies first when it may run the tests), posts a review as its bot, one attempt per head within the per-pull-request limit. Its name is a setting; it is one actor (`meta.<engine>_actor_id`) whose login follows the setting, and the API refuses CLI callers that claim it. What differs per tool is its `Engine`: how to run it, its models, how to read its answer.
- `src/server/reviewers/codex.ts`: Codex as an engine: `codex exec` in Codex's sandbox (default name `codex-review`; `--reviewer codex` finds it by its kind). The CLI calls author agents running in Codex `codex-agent`.
- `src/server/reviewers/transcript.ts`: what a reviewer agent does while it reviews, as ACP `session/update` updates that each engine reads its tool's stream into (`EngineJob.onUpdate`). Stored per run, capped, for the run's transcript page (`src/server/web/runs.ts`); the latest steps are followed in memory for the sidebar, which hears of them through `progress` events, not `change`.
- `src/server/reviewers/custom.ts`: custom reviewers: the user's own, one Markdown file each in `<configDir>/reviewers` (`configDir()` in `src/config.ts`; the file format is `definition.ts`), run by Codex's or Claude's engine. Each is a `Reviewer` whose `key` (in `review_runs.reviewer` and the API) is its name; it reviews the repositories its globs match (`Service.reviewersFor`), the code or the description (title, description and commit messages, one attempt per version: `Reviewer.subject`), and may approve, which never counts toward `reviewDecision`. Their per-pull-request settings are JSON in `pulls.reviewer_overrides`.
- `src/server/reviewers/claude.ts`: Claude as an engine: `claude -p` in Claude Code's sandbox (default name `claude-review`, since author agents in Claude Code are `claude`); its installs run in `sandbox.ts` (macOS `sandbox-exec`). Settings for both live in `src/server/settings.ts`.
- `src/server/auto-publish.ts`: auto-publish (after GitHub's auto-merge): publishes a pull request the reviewer approved in advance once `Service.readiness` says the agents are done with it.
- `src/server/web/`: server-rendered pages; `public/app.js` adds the interactive parts (event delegation, soft refresh that keeps drafts).
