// A reviewer agent's run as pages show it: its progress in the sidebar while it runs, and its
// transcript (reviewers/transcript.ts) on a page of its own.
import type { ReviewRunRow } from '../db.ts';
import { CANCELLED } from '../service.ts';
import type { RunUsage } from '../reviewers/reviewer.ts';
import { runsCommand, type Entry, type Progress, type Step, type ToolCallLocation, type ToolCallStatus, type ToolCallView, type ToolKind } from '../reviewers/transcript.ts';
import { html, icon, plural, raw, relTime, shortSha, since, type Safe } from './html.ts';
import { renderMarkdown } from './markdown.ts';
import { browseUrl } from './diffview.ts';

/** Where a run's pages are, and the repository browser its paths link into. */
export interface RunBase {
  /** The pull request's pages: /owner/repo/pull/N. */
  htmlBase: string;
  /** The repository: /owner/repo. */
  repoBase: string;
}

export const runUrl = (b: RunBase, run: ReviewRunRow) => `${b.htmlBase}/runs/${run.id}`;

export function tokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export function dollars(n: number): string {
  return `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

/** What a run cost, in a few words: "$0.01 · 45k tokens in, 2k out · 7 turns". */
export function usageParts(u: RunUsage): string[] {
  const input = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  return [u.cost_usd !== null ? dollars(u.cost_usd) : null, `${tokens(input)} tokens in, ${tokens(u.output_tokens)} out`, u.turns !== null ? plural(u.turns, 'turn') : null].filter((x) => x !== null);
}

const KIND_ICON: Record<ToolKind, string> = {
  read: 'file',
  edit: 'pencil',
  delete: 'trash',
  move: 'arrow-right',
  search: 'search',
  execute: 'terminal',
  think: 'light-bulb',
  fetch: 'globe',
  other: 'tools',
};

/** `ended`: the run is over, so a step still running or waiting never finished (it was cancelled or interrupted). */
function statusIcon(status: ToolCallStatus, ended = false): Safe {
  if (ended && (status === 'in_progress' || status === 'pending')) return icon('circle-slash', { cls: 'color-fg-muted', label: 'Did not finish' });
  if (status === 'completed') return icon('check', { cls: 'color-fg-success', label: 'Done' });
  if (status === 'failed') return icon('x', { cls: 'color-fg-danger', label: 'Failed' });
  if (status === 'in_progress') return icon('dot-fill', { cls: 'run-step-running', label: 'Running' });
  return icon('clock', { cls: 'color-fg-muted', label: 'Waiting' });
}

/** A path in the repository browser at the reviewed commit; a path outside the checkout is only named. */
function location(b: RunBase, run: ReviewRunRow, l: ToolCallLocation): Safe {
  const text = `${l.path}${l.line ? `:${l.line}` : ''}`;
  if (l.path === '.' || l.path.startsWith('/') || l.path === '..' || l.path.startsWith('../')) return html`<code>${text}</code>`;
  return html`<a class="run-location" href="${browseUrl(b.repoBase, 'blob', run.head_sha, l.path)}${l.line ? `#L${l.line}` : ''}"><code>${text}</code></a>`;
}

/** What a step does, in a line: the files it reads, the command it runs, or its title. */
function stepLabel(b: RunBase, run: ReviewRunRow, step: Pick<Step, 'title' | 'kind' | 'locations' | 'command'>): Safe {
  if (step.kind === 'read' && step.locations.length) return html`Read ${step.locations.map((l, i) => html`${i ? ', ' : ''}${location(b, run, l)}`)}`;
  if (step.command) return html`<code class="run-command">${step.title}</code>`;
  return html`<span>${step.title}</span>`;
}

/** How long a run took: "40 s", "3 min 5 s", "25 min". */
function took(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 10 && s % 60 ? `${m} min ${s % 60} s` : `${Math.round(s / 60)} min`;
}

/**
 * What a running review is doing, for the sidebar under the reviewer's row (which says how long
 * it has run): its latest steps with the current one last, what it last said, and the tokens so
 * far. The page fetches it again when the run makes progress.
 */
export function runProgress(b: RunBase, run: ReviewRunRow, progress: Progress): Safe {
  const used = progress.usage ? tokens(progress.usage.input_tokens + progress.usage.cache_creation_input_tokens + progress.usage.cache_read_input_tokens + progress.usage.output_tokens) : null;
  return html`<div class="run-progress js-run-progress" data-run="${run.id}" data-src="${runUrl(b, run)}/progress">
    ${progress.steps.length ? html`<ol class="run-steps">${progress.steps.map((step) => html`<li class="run-step run-step--${step.status}">${statusIcon(step.status)}<span class="run-step-label">${stepLabel(b, run, step)}</span></li>`)}</ol>` : ''}
    ${progress.said ? html`<p class="run-said" title="What it last said">${progress.said}</p>` : ''}
    <p class="run-foot"><a class="run-link" href="${runUrl(b, run)}">${icon('list-unordered')} Transcript${progress.total ? ` (${plural(progress.total, 'step')})` : ''}</a>${used ? html`<span class="color-fg-muted"> · ${used} tokens</span>` : ''}</p>
  </div>`;
}

/** Whether a text is a JSON object or array, as a reviewer's answer is: shown as code. */
function json(text: string): string | null {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

function toolEntry(b: RunBase, run: ReviewRunRow, call: ToolCallView, n: number): Safe {
  const output = (call.content ?? []).map((c) => c.content.text).join('\n');
  const exit = (call.rawOutput as { exit_code?: unknown } | undefined)?.exit_code;
  const label = stepLabel(b, run, { title: call.title, kind: call.kind, locations: call.locations ?? [], command: runsCommand(call) });
  // The command in full, as it ran: the title may be cut short, or by the summary's width.
  const command = runsCommand(call) ? (call.rawInput as { command: string }).command : null;
  const summary = html`${icon(KIND_ICON[call.kind] ?? 'tools', { cls: 'run-kind' })} <span class="run-tool-label">${label}</span> ${statusIcon(call.status, run.status !== 'running')}${typeof exit === 'number' && exit !== 0 ? html` <span class="color-fg-danger">exit ${exit}</span>` : ''}`;
  const body = html`${command ? html`<pre class="run-output run-output--command">$ ${command}</pre>` : ''}${output ? html`<pre class="run-output">${output}</pre>` : ''}`;
  if (!output && !command) return html`<li class="run-entry run-tool run-tool--${call.status}"><div class="run-tool-summary"><span class="run-chevron"></span>${summary}</div></li>`;
  return html`<li class="run-entry run-tool run-tool--${call.status}"><details class="js-keep-open" id="step-${n}"><summary class="run-tool-summary">${icon('chevron-right', { cls: 'run-chevron' })}${summary}</summary>${body}</details></li>`;
}

function entry(b: RunBase, run: ReviewRunRow, e: Entry, n: number): Safe {
  switch (e.type) {
    case 'prompt':
      return html`<li class="run-entry run-prompt"><details class="js-keep-open" id="step-${n}"><summary class="run-tool-summary">${icon('chevron-right', { cls: 'run-chevron' })}${icon('person', { cls: 'run-kind' })} The prompt laatsux gave it</summary><pre class="run-output">${e.text}</pre></details></li>`;
    case 'message': {
      const code = json(e.text);
      return html`<li class="run-entry run-message">${icon('comment', { cls: 'run-kind' })}<div class="run-text">${code ? html`<pre class="run-output">${code}</pre>` : html`<div class="markdown-body">${raw(renderMarkdown(e.text))}</div>`}</div></li>`;
    }
    case 'thought':
      return html`<li class="run-entry run-thought">${icon('light-bulb', { cls: 'run-kind' })}<div class="run-text markdown-body">${raw(renderMarkdown(e.text))}</div></li>`;
    case 'plan':
      return html`<li class="run-entry run-plan">${icon('checklist', { cls: 'run-kind' })}<ul class="run-text">${e.entries.map((p) => html`<li>${statusIcon(p.status, run.status !== 'running')} ${p.content}</li>`)}</ul></li>`;
    case 'tool':
      return toolEntry(b, run, e.call, n);
    case 'error':
      return html`<li class="run-entry run-error">${icon('alert', { cls: 'run-kind color-fg-danger' })}<pre class="run-text run-output">${e.message}</pre></li>`;
    case 'cut':
      return html`<li class="run-entry run-cut">${icon('fold', { cls: 'run-kind' })}<span class="run-text color-fg-muted">The transcript stops here: it reached its size limit, and ${plural(e.dropped, 'later update')} ${e.dropped === 1 ? 'was' : 'were'} left out.</span></li>`;
  }
}

/** A run's transcript: what it was asked, every step with its output, what it said and thought, and what it cost. */
export function transcriptContent(b: RunBase, o: { run: ReviewRunRow; login: string; label: string; entries: Entry[]; live: Progress | null }): Safe {
  const { run, entries, live } = o;
  const usage: RunUsage | null = run.usage ? JSON.parse(run.usage) : (live?.usage ?? null);
  const model = [run.model || 'default model', run.effort ? `${run.effort} effort` : null].filter(Boolean).join(', ');
  const after = run.finished_at ? `, after ${took(Date.parse(run.finished_at) - Date.parse(run.started_at))}` : '';
  const state =
    run.status === 'running'
      ? html`<span class="codex-status--running">${icon('dot-fill')} Reviewing for ${since(run.started_at)}</span>`
      : run.status === 'done'
        ? html`${icon('check', { cls: 'color-fg-success' })} <a href="${b.htmlBase}#pullrequestreview-${run.review_id}">Posted its review</a> ${relTime(run.finished_at)}${after}`
        : run.status === 'cancelled'
          ? html`${icon('circle-slash', { cls: 'color-fg-muted' })} Cancelled${run.reason ? ` (${CANCELLED[run.reason]})` : ''} ${relTime(run.finished_at)}${after}`
          : run.status === 'interrupted'
            ? html`${icon('sync', { cls: 'color-fg-attention' })} Interrupted by a restart ${relTime(run.finished_at)}${after}`
            : html`${icon('x-circle-fill', { cls: 'color-fg-danger' })} Failed ${relTime(run.finished_at)}${after}`;
  const steps = entries.filter((e) => e.type === 'tool').length;
  return html`<div class="container container-xl run-page">
  <div class="run-header">
    <h2 class="run-title">${o.login}'s ${run.trigger === 'auto' ? 'automatic review' : 'review on request'} of <code>${shortSha(run.head_sha)}</code></h2>
    <p class="run-meta color-fg-muted">${o.label} (${model}) · started ${relTime(run.started_at)} · ${state}</p>
    <p class="run-meta color-fg-muted">${plural(steps, 'step')}${usage ? ` · ${usageParts(usage).join(' · ')}` : ''}${run.status === 'running' && usage && usage.cost_usd === null ? ' so far' : ''}</p>
    ${run.status === 'failed' && run.error ? html`<pre class="run-output run-failure">${run.error}</pre>` : ''}
  </div>
  ${entries.length ? html`<ol class="run-transcript">${entries.map((e, i) => entry(b, run, e, i))}</ol>` : html`<p class="blankslate">${run.status === 'running' ? 'Nothing yet: its steps show here as it takes them.' : 'laatsux did not keep a transcript of this run.'}</p>`}
</div>`;
}
