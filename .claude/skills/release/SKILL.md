---
name: release
description: Release galley to npm, as the package galley-proof. Use when the user asks to release galley, cut a version, or publish it to npm. Bumps the version in a staged pull request, then publishes a GitHub Release, whose workflow publishes the package with npm's trusted publishing.
---

# Release galley

galley is on npm as `galley-proof`; the command it installs is `galley`. Publishing a GitHub
Release runs `.github/workflows/release.yml` on the release's tag. It checks that the tag is
package.json's version with a `v` (`v0.3.0`), and that npm does not have that version yet. It runs
the tests, installs the package from its tarball and runs it, and then publishes `dist/`
(`pnpm build`) to npm. npm's trusted publishing takes the workflow's OIDC token in place of an npm token, and adds
provenance.

## Rules

- Release only when the user asks.
- Never run `npm publish`. The workflow publishes every version but the first, which the user
  published by hand ([Setting it up](#setting-it-up)).
- A version on npm is there for good: npm never takes the same version again, even after
  `npm unpublish`. A failed release gets a new version once npm has the old one.
- The version changes only in package.json (`galley --version` and `/api/meta` read it there).
  desktop/package.json stays: the app is not released, and runs its checkout's code.
- Before `npm install`, run `npm whoami`. When it fails, ask the user to run `! npm login`, and
  wait.

## The release

1. Check that main is green and that you release what is on GitHub:

   ```sh
   git fetch origin
   git status                       # your checkout: nothing to commit, nothing unpushed
   gh run list --repo laat/galley --workflow test.yml --commit "$(git rev-parse origin/main)"
   ```

   The run must have completed with success. If it is running, wait for it; if it failed, tell
   the user and stop. Releases come from `origin/main`, never a local branch.

2. Choose the version, from what merged since the last release:

   ```sh
   last=$(git describe --tags --abbrev=0 --match 'v*' origin/main)
   git log --format='- %s' "$last..origin/main"
   ```

   Each line is a merged pull request's title with its number. Versions follow semver; below
   1.0.0, as now:

   - minor (0.2.0 → 0.3.0): a pull request that breaks what users or agents rely on (a CLI
     command, flag or output, the API, the skill's loop, a setting, the data directory or the
     server's requirements), or adds a feature;
   - patch (0.2.0 → 0.2.1): fixes only.

   Tell the user the version, why, and the list. If the user named a version, use theirs. 1.0.0
   is the user's call.

3. Bump the version in a staged pull request, as the `galley` skill stages one, in a worktree
   on a new branch from `origin/main`:

   ```sh
   npm pkg set version=0.3.0
   node bin/galley.ts --version     # galley version 0.3.0
   git commit -am "Release 0.3.0"
   ```

   Stage it with `galley pr create`, the list from step 2 as the description, and turn on
   auto-publish with auto-merge when the user asked for the whole release. Wait until `pr wait`
   prints `Merged on GitHub`.

4. Publish the release, on the merge of the bump, with the titles merged since the last release
   as its notes, without the bump's own:

   ```sh
   git fetch origin
   sha=$(git rev-parse origin/main)
   last=$(git describe --tags --abbrev=0 --match 'v*' "$sha")
   git show "$sha:package.json" | grep '"version"'    # "version": "0.3.0"
   git log --format='- %s' "$last..$sha" | grep -v '^- Release 0\.3\.0'
   ```

   Check that `$sha` is the bump's merge and the notes are what you listed, then:

   ```sh
   git log --format='- %s' "$last..$sha" | grep -v '^- Release 0\.3\.0' \
     | gh release create v0.3.0 --repo laat/galley --target "$sha" --title v0.3.0 --notes-file -
   ```

   `gh release create` makes the tag on `$sha` and publishes the release, which starts the
   workflow. A pre-release has a pre-release version (`0.3.0-rc.1`) and `--prerelease`; npm gets
   it under the dist-tag `next` (`npm install galley-proof@next`), and `latest` stays.

5. Watch the workflow:

   ```sh
   gh run list --repo laat/galley --workflow release.yml --limit 1
   gh run watch <id> --repo laat/galley --exit-status
   ```

6. Check npm, and install the version in a directory of its own:

   ```sh
   npm whoami
   npm view galley-proof version                       # 0.3.0
   prefix=$(mktemp -d)
   npm install --global --prefix "$prefix" galley-proof@0.3.0
   "$prefix/bin/galley" --version                      # galley version 0.3.0
   GALLEY_HOME="$prefix/home" "$prefix/bin/galley" serve --check
   rm -rf "$prefix"
   ```

   `serve --check` says what the machine has for galley; a ✗ there is about the machine, not the
   release. Tell the user the version, the npm page (https://www.npmjs.com/package/galley-proof)
   and the release's URL.

## When the workflow fails

Read why with `gh run view <id> --repo laat/galley --log-failed`.

- The tag does not match package.json, or a check or test failed: npm has nothing. Delete the release and
  its tag (`gh release delete v0.3.0 --repo laat/galley --cleanup-tag --yes`), fix it in a pull
  request, and publish the release again on the new merge.
- `already on npm`: that version was published. Bump to the next version and release that.
- The publish step failed with 404, ENEEDAUTH or an OIDC error: npm did not take the workflow as
  the package's trusted publisher. Tell the user, with the error, and that the trusted publisher
  on npmjs.com must name owner `laat`, repository `galley` and workflow `release.yml`, with
  `npm publish` allowed. Once it does, re-run the failed job: `gh run rerun <id> --repo
  laat/galley --failed`. Never publish from a laptop instead.

## Setting it up

Once, by the user. npm takes a trusted publisher only for a package it has, so the first version
is published by hand:

1. In the checkout, on main with this workflow merged:

   ```sh
   npm whoami                          # when it fails: ! npm login
   git switch main && git pull --ff-only
   npm run build                       # needs nothing but Node
   npm publish ./dist --access public  # asks for a one-time password with 2FA
   git tag v0.1.0 && git push origin v0.1.0
   ```

   The tag, without a release, publishes nothing; the next release's notes start there.

2. Right before the first release by the workflow, add the trusted publisher. On npmjs.com:
   galley-proof → Settings → Trusted publishing → GitHub Actions:

   - Organization or user: `laat`
   - Repository: `galley`
   - Workflow filename: `release.yml`
   - Environment name: empty
   - Allowed actions: `npm publish`

   Or with npm 11.15.0 or newer and 2FA on the account:
   `npm trust github galley-proof --file release.yml --repo laat/galley --allow-publish`.

   A trusted publisher that has not published within 2 days expires, and must be deleted and
   added again. So add it when the next version is ready, and release it within 2 days.

3. After the workflow has published: Settings → Publishing access → **Require two-factor
   authentication and disallow tokens**. The workflow publishes without a token; nothing else
   should.
