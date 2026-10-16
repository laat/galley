import type { Service } from '../service.ts';
import { readSettings, MAX_ITERATIONS_LIMIT, MERGE_METHODS } from '../settings.ts';
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
    ${item('/settings/publishing', 'mark-github', 'Publishing')}
  </nav>
  <div class="settings-main">${main}</div>
</div>`;
  return layout(s, { title: 'Settings · laatsux', crumbs: html`<a href="/">laatsux</a><span class="crumb-sep">/</span><a href="/settings"><strong>Settings</strong></a>`, body });
}

export async function settingsPage(s: Service): Promise<string> {
  const settings = readSettings(s.db).codex;
  const models = s.codex ? await s.codex.models() : [];
  const defaults = s.codex ? s.codex.defaults() : {};
  const defaultModel = models.find((m) => m.slug === defaults.model);

  // "Codex default" means whatever config.toml says, falling back to the model's own default effort.
  const defaultEffort = (efforts: { defaultEffort: string } | undefined) => defaults.effort ?? efforts?.defaultEffort ?? '';
  const modelOptions: Safe[] = [
    html`<option value="" data-efforts="${defaultModel?.efforts.join(',') ?? ''}" data-default-effort="${defaultEffort(defaultModel)}"${settings.model ? '' : raw(' selected')}>Codex default${defaults.model ? ` (${defaults.model})` : ''}</option>`,
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
  const efforts = selected?.efforts ?? (settings.effort ? [settings.effort] : []);
  const effortDefault = defaultEffort(selected);

  return settingsLayout(
    s,
    '/settings',
    html`<div class="Subhead" id="codex">
      <h2 class="Subhead-heading">Codex</h2>
      <p class="Subhead-description">Let Codex review staged pull requests before you do. It reviews a throwaway checkout of the pull request and posts its findings as a review from <strong>${s.codex?.actor().login ?? settings.name}</strong>.</p>
    </div>
    ${
      s.codex && models.length === 0
        ? html`<div class="flash flash-warn">${icon('alert')} Could not read the model list from <code>codex debug models</code>. Check that Codex is installed and logged in on the machine running laatsux.</div>`
        : ''
    }
    <form class="settings-form js-api-form" data-api="/api/settings/codex" data-method="PUT" data-toast="Settings saved">
      <div class="form-checkbox">
        <label><input type="checkbox" name="enabled"${settings.enabled ? raw(' checked') : ''}> Review automatically</label>
        <p class="note">When the author agent runs <code>laatsux pr wait</code>, Codex reviews the new commits first. Its review wakes the agent, which addresses the comments before you look. Each commit is reviewed once.</p>
      </div>
      <div class="form-group">
        <label class="form-label" for="codex-name">Name</label>
        <input class="form-control input-medium" type="text" id="codex-name" name="name" value="${s.codex?.actor().login ?? settings.name}" autocomplete="off" spellcheck="false">
        <p class="note">Who the reviews are from. Renaming keeps the earlier reviews with the reviewer.</p>
      </div>
      <div class="form-group">
        <label class="form-label" for="codex-model">Model</label>
        <select class="form-select js-codex-model" id="codex-model" name="model">${modelOptions}</select>
      </div>
      <div class="form-group">
        <label class="form-label" for="codex-effort">Reasoning effort</label>
        <select class="form-select js-codex-effort" id="codex-effort" name="effort">
          <option value=""${settings.effort ? '' : raw(' selected')}>Codex default${effortDefault ? ` (${effortDefault})` : ''}</option>
          ${efforts.map((e) => html`<option value="${e}"${settings.effort === e ? raw(' selected') : ''}>${e}</option>`)}
        </select>
        <p class="note">Higher effort finds more and takes longer. The levels depend on the model.</p>
      </div>
      <div class="form-group">
        <label class="form-label" for="codex-iterations">Max iterations</label>
        <input class="form-control input-narrow" type="number" id="codex-iterations" name="maxIterations" min="0" max="${MAX_ITERATIONS_LIMIT}" value="${settings.maxIterations}">
        <p class="note">Automatic reviews per pull request, so Codex and the author agent do not go back and forth forever. "Ask Codex to review" on a pull request is not limited.</p>
      </div>
      <div class="form-checkbox">
        <label><input type="checkbox" name="runTests"${settings.runTests ? raw(' checked') : ''}> Let Codex install dependencies and run tests</label>
        <p class="note">Before Codex starts, laatsux installs the pull request's dependencies from its lockfile, without running its install scripts. Codex may then run the typecheck, tests or build to check what it finds, without network access. It writes only to its checkout and a temporary directory, both removed after the review; your repository stays read-only. Off, Codex only reads the code.</p>
      </div>
      <div class="flash flash-error js-form-error" hidden></div>
      <div class="form-actions form-actions-left"><button type="submit" class="btn btn-primary">Save settings</button></div>
    </form>`,
  );
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
        <p class="note">How GitHub merges a pull request that laatsux enabled auto-merge for.</p>
      </div>
      <div class="flash flash-error js-form-error" hidden></div>
      <div class="form-actions form-actions-left"><button type="submit" class="btn btn-primary">Save settings</button></div>
    </form>`,
  );
}
