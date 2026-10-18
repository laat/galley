import type { Service } from '../service.ts';
import type { Reviewer } from '../reviewers/reviewer.ts';
import type { Definition } from '../reviewers/definition.ts';
import { readSettings, MAX_ITERATIONS_LIMIT, MAX_SIGNING_RETRIES, MERGE_METHODS } from '../settings.ts';
import { html, icon, raw, type Safe } from './html.ts';
import { layout } from './components.ts';

/** Merge methods as GitHub's merge button names them. */
const MERGE_METHOD_NAMES: Record<string, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };

/** A settings page: the sections, and the selected one's form. */
function settingsLayout(s: Service, section: string, main: Safe): string {
  const item = (href: string, octicon: string, label: string) =>
    html`<a class="settings-nav-item${href === section ? ' selected' : ''}" href="${href}">${icon(octicon)} ${label}</a>`;
  const body = html`<div class="container container-lg settings-layout">
  <nav class="settings-nav" aria-label="Settings">
    <h2 class="settings-nav-heading">Settings</h2>
    ${item('/settings', 'code-review', 'Code review')}
    ${item('/settings/reviewers', 'checklist', 'Custom reviewers')}
    ${item('/settings/publishing', 'mark-github', 'Publishing')}
  </nav>
  <div class="settings-main">${main}</div>
</div>`;
  return layout(s, { title: 'Settings · galley', crumbs: html`<a href="/">galley</a><span class="crumb-sep">/</span><a href="/settings"><strong>Settings</strong></a>`, body });
}

export async function settingsPage(s: Service): Promise<string> {
  const sections: Safe[] = [];
  for (const reviewer of s.builtInReviewers()) sections.push(await reviewerSection(reviewer));
  return settingsLayout(s, '/settings', html`${sections}`);
}

/** A reviewer agent's settings. */
async function reviewerSection(reviewer: Reviewer): Promise<Safe> {
  const engine = reviewer.engineId;
  const label = reviewer.label;
  const settings = reviewer.settings();
  const models = await reviewer.models();
  const defaults = reviewer.defaults();
  const defaultModel = models.find((m) => m.slug === defaults.model);
  const byDefault = `${label} default`;

  // "Codex default" means whatever config.toml says, falling back to the model's own default effort.
  const defaultEffort = (efforts: { defaultEffort: string } | undefined) => defaults.effort ?? efforts?.defaultEffort ?? '';
  const modelOptions: Safe[] = [
    html`<option value="" data-efforts="${(defaultModel?.efforts ?? reviewer.efforts('') ?? []).join(',')}" data-default-effort="${defaultEffort(defaultModel)}"${settings.model ? '' : raw(' selected')}>${byDefault}${defaults.model ? ` (${defaults.model})` : ''}</option>`,
    ...models.map(
      (m) =>
        html`<option value="${m.slug}" data-efforts="${m.efforts.join(',')}" data-default-effort="${defaultEffort(m)}"${settings.model === m.slug ? raw(' selected') : ''}>${m.name}${m.description ? ` – ${m.description}` : ''}</option>`,
    ),
  ];
  // A model set earlier that the catalog no longer lists stays selectable.
  if (settings.model && !models.some((m) => m.slug === settings.model)) {
    modelOptions.push(html`<option value="${settings.model}" data-efforts="" data-default-effort="${defaults.effort ?? ''}" selected>${settings.model}</option>`);
  }
  const selected = models.find((m) => m.slug === (settings.model || defaults.model));
  const efforts = selected?.efforts ?? reviewer.efforts(settings.model) ?? (settings.effort ? [settings.effort] : []);
  const effortDefault = defaultEffort(selected);
  const name = reviewer.actor().login;

  return html`<div class="Subhead" id="${engine}">
      <h2 class="Subhead-heading">${label}</h2>
      <p class="Subhead-description">Let ${label} review staged pull requests before you do. It reviews a throwaway checkout of the pull request and posts its findings as a review from <strong>${name}</strong>.</p>
    </div>
    ${
      models.length === 0 && reviewer.catalogSource
        ? html`<div class="flash flash-warn">${icon('alert')} Could not read the model list from <code>${reviewer.catalogSource}</code>. Check that ${label} is installed and logged in on the machine running galley.</div>`
        : ''
    }
    <form class="settings-form js-api-form" data-api="/api/settings/${engine}" data-method="PUT" data-toast="Settings saved">
      <div class="form-checkbox">
        <label><input type="checkbox" name="enabled"${settings.enabled ? raw(' checked') : ''}> Review automatically</label>
        <p class="note">When the author agent runs <code>galley pr wait</code>, ${label} reviews the new commits first. Its review wakes the agent, which addresses the comments before you look. Each commit is reviewed once.</p>
      </div>
      <div class="form-group">
        <label class="form-label" for="${engine}-name">Name</label>
        <input class="form-control input-medium" type="text" id="${engine}-name" name="name" value="${name}" autocomplete="off" spellcheck="false">
        <p class="note">Who the reviews are from. Renaming keeps the earlier reviews with the reviewer.</p>
      </div>
      <div class="form-group">
        <label class="form-label" for="${engine}-model">Model</label>
        <select class="form-select js-reviewer-model" id="${engine}-model" name="model">${modelOptions}</select>
      </div>
      <div class="form-group">
        <label class="form-label" for="${engine}-effort">Reasoning effort</label>
        <select class="form-select js-reviewer-effort" id="${engine}-effort" name="effort" data-default-label="${byDefault}">
          <option value=""${settings.effort ? '' : raw(' selected')}>${byDefault}${effortDefault ? ` (${effortDefault})` : ''}</option>
          ${efforts.map((e) => html`<option value="${e}"${settings.effort === e ? raw(' selected') : ''}>${e}</option>`)}
        </select>
        <p class="note">Higher effort finds more and takes longer. The levels depend on the model.</p>
      </div>
      <div class="form-group">
        <label class="form-label" for="${engine}-iterations">Automatic reviews</label>
        <input class="form-control input-narrow" type="number" id="${engine}-iterations" name="maxIterations" min="0" max="${MAX_ITERATIONS_LIMIT}" value="${settings.maxIterations}">
        <p class="note">At most this many per pull request, so ${label} and the author agent do not go back and forth forever. "Ask ${label} to review" on a pull request is not limited.</p>
      </div>
      <div class="form-checkbox">
        <label><input type="checkbox" name="runTests"${settings.runTests ? raw(' checked') : ''}> Let ${label} install dependencies and run tests</label>
        <p class="note">Before ${label} starts, galley installs the pull request's dependencies from its lockfile, without running its install scripts. ${label} may then run the typecheck, tests or build to check what it finds, without network access. It writes only to its checkout and a temporary directory, both removed after the review; your repository stays read-only. Off, ${label} only reads the code.</p>
      </div>
      ${
        reviewer.localServers
          ? html`<div class="form-checkbox">
        <label><input type="checkbox" name="localhost"${settings.localhost ? raw(' checked') : ''}> Let ${label}'s tests listen on localhost</label>
        <p class="note">With the setting above, ${label} may also run tests that start servers: its commands may listen and connect on localhost, but not connect to other hosts. Code in the pull request can then reach anything on localhost, including galley, which takes any local caller for you and could publish as you (<a href="https://github.com/laat/galley/issues/52" target="_blank" rel="noopener">#52</a>). Claude Code also lets them listen on every interface, so while they run, other machines on your network can reach a server that does not listen on 127.0.0.1 only. Turn it on only for repositories whose code you trust.</p>
      </div>`
          : ''
      }
      <div class="form-checkbox">
        <label><input type="checkbox" name="skipOwnKind"${settings.skipOwnKind ? raw(' checked') : ''}> Skip pull requests by agents in ${reviewer.authorTool}</label>
        <p class="note">Leave pull requests that an agent running in ${reviewer.authorTool} wrote to the other reviewers, so authors get a second opinion. Staging with <code>--reviewer ${engine}</code>, or turning it on in a pull request's sidebar, still has ${label} review it.</p>
      </div>
      <div class="flash flash-error js-form-error" hidden></div>
      <div class="form-actions form-actions-left"><button type="submit" class="btn btn-primary">Save settings</button></div>
    </form>`;
}

/** The custom reviewers: one file each, which Settings writes and you may edit too. */
export function customReviewersPage(s: Service): string {
  const custom = s.custom;
  const files = custom?.entries() ?? [];
  const rows = files.map((f) => {
    const d = f.definition;
    const facts = d
      ? [
          d.engine === 'codex' ? 'Codex' : 'Claude',
          d.reviews === 'description' ? 'the title, description and commit messages' : 'the code',
          d.repos ? d.repos.join(', ') : 'every repository',
          d.verdict === 'approve' ? 'approves when it finds nothing' : 'comments only',
          d.enabled ? `up to ${d.max_iterations} automatic reviews` : 'automatic reviews off',
        ]
      : [];
    return html`<li class="Box-row">
      <a href="/settings/reviewers/${f.name}"><strong>${f.name}</strong></a>
      ${facts.length ? html`<div class="note">${facts.join(' · ')}</div>` : ''}
      ${f.error ? html`<div class="flash flash-error">${icon('alert')} Not running: ${f.error}</div>` : ''}
    </li>`;
  });
  return settingsLayout(
    s,
    '/settings/reviewers',
    html`<div class="Subhead">
      <h2 class="Subhead-heading">Custom reviewers</h2>
      <p class="Subhead-description">Reviewer agents of your own, next to Codex and Claude: each with its own instructions, the repositories it reviews, and whether it reviews the code or the title, description and commit messages. One may approve when it finds nothing; its approval is its own, never yours. Each is a file in <code>${custom?.dir ?? ''}</code>, which you can edit too.</p>
    </div>
    <p><a class="btn btn-primary" href="/settings/new-reviewer">${icon('plus')} New reviewer</a></p>
    ${rows.length ? html`<ul class="Box">${rows}</ul>` : html`<p class="color-fg-muted">No custom reviewers yet.</p>`}`,
  );
}

/** A custom reviewer's form, or a new one's (name null). */
export async function customReviewerPage(s: Service, name: string | null): Promise<string> {
  const file = name === null ? null : s.custom?.entry(name);
  if (name !== null && !file) return settingsLayout(s, '/settings/reviewers', html`<div class="flash flash-error">No reviewer called ${name}. <a href="/settings/reviewers">All custom reviewers</a></div>`);
  const title = name ?? 'New reviewer';
  const head = html`<div class="Subhead">
      <h2 class="Subhead-heading"><a href="/settings/reviewers">Custom reviewers</a> / ${title}</h2>
      ${file ? html`<p class="Subhead-description">Its file is <code>${s.custom!.path(file.name)}</code>.</p>` : ''}
    </div>
    ${file?.error ? html`<div class="flash flash-error">${icon('alert')} Not running: ${file.error}</div>` : ''}`;
  const remove = file ? html`<button type="button" class="btn btn-danger js-delete-reviewer" data-api="/api/settings/reviewers/${file.name}" data-next="/settings/reviewers">${icon('trash')} Delete</button>` : '';
  // A file that can not be read is fixed in the file, or deleted: saving the form would write over what is in it.
  if (file && !file.definition) return settingsLayout(s, '/settings/reviewers', html`${head}<p>Fix the file, or delete the reviewer.</p>${remove}`);
  const d: Omit<Definition, 'name'> = file?.definition ?? { engine: 'claude', model: '', effort: '', repos: null, reviews: 'code', verdict: 'comment', max_iterations: 3, run_tests: true, enabled: true, instructions: '' };
  const { models, efforts } = await modelChoices(s, d);
  const checked = (on: boolean) => (on ? raw(' checked') : '');
  const radio = (field: string, value: string, label: string, note: string, cls = '') =>
    html`<div class="form-checkbox"><label><input type="radio" name="${field}" value="${value}"${cls ? raw(` class="${cls}"`) : ''}${checked((d as Record<string, unknown>)[field] === value)}> ${label}</label><p class="note">${note}</p></div>`;
  const form = html`<form class="settings-form js-api-form" data-api="${file ? `/api/settings/reviewers/${file.name}` : '/api/settings/reviewers'}" data-method="${file ? 'PATCH' : 'POST'}"${file ? raw(' data-toast="Reviewer saved"') : raw(' data-next="/settings/reviewers"')}>
      ${
        file
          ? ''
          : html`<div class="form-group">
        <label class="form-label" for="reviewer-name">Name</label>
        <input class="form-control input-medium" type="text" id="reviewer-name" name="name" required autocomplete="off" spellcheck="false">
        <p class="note">Who its reviews are from, and what <code>--reviewer</code> asks for it by. It names the file, and stays: to rename a reviewer, define one by the new name and delete this one.</p>
      </div>`
      }
      <div class="form-checkbox">
        <label><input type="checkbox" name="enabled"${checked(d.enabled)}> Review automatically</label>
        <p class="note">When the author agent runs <code>galley pr wait</code> on a pull request in its repositories, it reviews first, as Codex and Claude do. Off, it reviews when asked from the pull request.</p>
      </div>
      <div class="form-group">
        <span class="form-label">What it reviews</span>
        ${radio('reviews', 'description', 'The title, description and commit messages', 'Without a checkout, so it is quick and cheap. It reviews again when one of them changes, not for a new commit that leaves them as they are.', 'js-reviewer-reviews')}
        ${radio('reviews', 'code', 'The code', 'A checkout of the head, as Codex and Claude review it, once per commit.', 'js-reviewer-reviews')}
      </div>
      <div class="form-group">
        <label class="form-label" for="reviewer-instructions">Instructions</label>
        <textarea class="form-control" id="reviewer-instructions" name="instructions" rows="12">${d.instructions}</textarea>
        <p class="note">What to look for, in Markdown. For the code, left empty it looks for what Codex and Claude look for.</p>
      </div>
      <div class="form-group">
        <label class="form-label" for="reviewer-repos">Repositories</label>
        <textarea class="form-control" id="reviewer-repos" name="repos" rows="3" placeholder="every repository" spellcheck="false">${(d.repos ?? []).join('\n')}</textarea>
        <p class="note">On GitHub, one per line as <code>owner/name</code>, where <code>*</code> matches any part of either: <code>nrkno/*</code>. Empty, it reviews every repository, also those with no GitHub remote.</p>
      </div>
      <div class="form-group">
        <span class="form-label">Verdict</span>
        ${radio('verdict', 'comment', 'Comment only', 'Like Codex and Claude: it never approves or requests changes.')}
        ${radio('verdict', 'approve', 'Approve when it finds nothing', 'Otherwise it comments. Its approval is its own: it shows as its, and counts as it being done, never as your decision.')}
      </div>
      <div class="form-group">
        <label class="form-label" for="reviewer-engine">Tool</label>
        <select class="form-select js-reviewer-engine" id="reviewer-engine" name="engine">
          ${s.builtInReviewers().map((r) => html`<option value="${r.engineId}"${d.engine === r.engineId ? raw(' selected') : ''}>${r.label}</option>`)}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label" for="reviewer-model">Model</label>
        <select class="form-select js-reviewer-model" id="reviewer-model" name="model">${models}</select>
      </div>
      <div class="form-group">
        <label class="form-label" for="reviewer-effort">Reasoning effort</label>
        ${efforts}
      </div>
      <div class="form-group">
        <label class="form-label" for="reviewer-iterations">Automatic reviews</label>
        <input class="form-control input-narrow" type="number" id="reviewer-iterations" name="max_iterations" min="0" max="${MAX_ITERATIONS_LIMIT}" value="${d.max_iterations}">
        <p class="note">At most this many per pull request. Asking it to review from a pull request is not limited.</p>
      </div>
      <div class="form-checkbox js-code-only"${d.reviews === 'code' ? '' : raw(' hidden')}>
        <label><input type="checkbox" name="run_tests"${checked(d.run_tests)}> Let it install dependencies and run tests</label>
        <p class="note">As for Codex and Claude: galley installs the dependencies from the lockfile without their install scripts, and the reviewer may run the typecheck, tests or build without network access.</p>
      </div>
      <div class="flash flash-error js-form-error" hidden></div>
      <div class="form-actions form-actions-left"><button type="submit" class="btn btn-primary">${file ? 'Save reviewer' : 'Create reviewer'}</button> ${remove}</div>
    </form>`;
  return settingsLayout(s, '/settings/reviewers', html`${head}${form}`);
}

/** The models of both tools for a custom reviewer's form, those of the other tool hidden, and the efforts of the chosen model. */
async function modelChoices(s: Service, d: Omit<Definition, 'name'>): Promise<{ models: Safe[]; efforts: Safe }> {
  const models: Safe[] = [];
  let efforts = html``;
  for (const reviewer of s.builtInReviewers()) {
    const mine = reviewer.engineId === d.engine;
    const list = await reviewer.models();
    const defaults = reviewer.defaults();
    const byDefault = `${reviewer.label} default`;
    const defaultEffort = (m: { defaultEffort: string } | undefined) => defaults.effort ?? m?.defaultEffort ?? '';
    const defaultModel = list.find((m) => m.slug === defaults.model);
    const attrs = (selected: boolean) => raw(`data-engine="${reviewer.engineId}"${mine ? '' : ' hidden disabled'}${mine && selected ? ' selected' : ''}`);
    models.push(
      html`<option value="" data-efforts="${(defaultModel?.efforts ?? reviewer.efforts('') ?? []).join(',')}" data-default-effort="${defaultEffort(defaultModel)}" data-default-label="${byDefault}" ${attrs(!d.model)}>${byDefault}${defaults.model ? ` (${defaults.model})` : ''}</option>`,
      ...list.map((m) => html`<option value="${m.slug}" data-efforts="${m.efforts.join(',')}" data-default-effort="${defaultEffort(m)}" ${attrs(d.model === m.slug)}>${m.name}${m.description ? ` – ${m.description}` : ''}</option>`),
    );
    if (!mine) continue;
    // A model set earlier that the catalog no longer lists stays selectable.
    if (d.model && !list.some((m) => m.slug === d.model)) models.push(html`<option value="${d.model}" data-efforts="" data-default-effort="${defaults.effort ?? ''}" ${attrs(true)}>${d.model}</option>`);
    const selected = list.find((m) => m.slug === (d.model || defaults.model));
    const levels = selected?.efforts ?? reviewer.efforts(d.model) ?? (d.effort ? [d.effort] : []);
    const fallback = defaultEffort(selected);
    efforts = html`<select class="form-select js-reviewer-effort" id="reviewer-effort" name="effort" data-default-label="${byDefault}">
          <option value=""${d.effort ? '' : raw(' selected')}>${byDefault}${fallback ? ` (${fallback})` : ''}</option>
          ${levels.map((e) => html`<option value="${e}"${d.effort === e ? raw(' selected') : ''}>${e}</option>`)}
        </select>`;
  }
  return { models, efforts };
}

export function publishingSettingsPage(s: Service): string {
  const settings = readSettings(s.db).publish;
  return settingsLayout(
    s,
    '/settings/publishing',
    html`<div class="Subhead">
      <h2 class="Subhead-heading">Auto-merge</h2>
      <p class="Subhead-description">Publishing can enable auto-merge on the pull request on GitHub, which then merges it once its requirements are met, such as required checks. The option shows for repositories that allow auto-merge, and the repository must allow the merge method too.</p>
    </div>
    <form class="settings-form js-api-form" data-api="/api/settings/publish" data-method="PUT" data-toast="Settings saved">
      <div class="form-group">
        <label class="form-label" for="merge-method">Merge method</label>
        <select class="form-select" id="merge-method" name="mergeMethod">
          ${MERGE_METHODS.map((m) => html`<option value="${m}"${settings.mergeMethod === m ? raw(' selected') : ''}>${MERGE_METHOD_NAMES[m]}</option>`)}
        </select>
        <p class="note">How GitHub merges a pull request that galley enabled auto-merge for.</p>
      </div>
      <div class="flash flash-error js-form-error" hidden></div>
      <div class="form-actions form-actions-left"><button type="submit" class="btn btn-primary">Save settings</button></div>
    </form>
    <div class="Subhead">
      <h2 class="Subhead-heading">Signing</h2>
      <p class="Subhead-description">Auto-publish and the pushes after publishing sign with your key while nobody may be there to answer a prompt. When signing fails in a way that may pass, such as a 1Password prompt nobody answered or an agent that is locked or not running, they try again later instead of giving up: after 5 minutes, then 15, then 45, each wait three times the last. Each try may show the prompt again.</p>
    </div>
    <form class="settings-form js-api-form" data-api="/api/settings/publish" data-method="PUT" data-toast="Settings saved">
      <div class="form-group">
        <label class="form-label" for="signing-retries">Signing retries</label>
        <input class="form-control input-narrow" type="number" id="signing-retries" name="signingRetries" min="0" max="${MAX_SIGNING_RETRIES}" value="${settings.signingRetries}">
        <p class="note">After this many, auto-publish turns off and a push is not tried again, as for a signing failure that can not pass, such as a missing key. 0 gives up at once.</p>
      </div>
      <div class="flash flash-error js-form-error" hidden></div>
      <div class="form-actions form-actions-left"><button type="submit" class="btn btn-primary">Save settings</button></div>
    </form>`,
  );
}
