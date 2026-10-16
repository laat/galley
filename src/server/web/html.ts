import { createRequire } from 'node:module';
import type { Actor } from '../db.ts';

/** HTML that is already escaped. Anything else interpolated into `html` gets escaped. */
export class Safe {
  value: string;
  constructor(value: string) {
    this.value = value;
  }
  toString(): string {
    return this.value;
  }
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

function flatten(v: unknown): string {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof Safe) return v.value;
  if (Array.isArray(v)) return v.map(flatten).join('');
  return esc(String(v));
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Safe {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += flatten(values[i]) + strings[i + 1];
  return new Safe(out);
}

export function raw(s: string): Safe {
  return new Safe(s);
}

// ---------------------------------------------------------------- octicons

const octicons = createRequire(import.meta.url)('@primer/octicons/build/data.json') as Record<
  string,
  { heights: Record<string, { width: number; path: string }> }
>;

export function icon(name: string, opts: { size?: 16 | 24; cls?: string; label?: string } = {}): Safe {
  const size = opts.size ?? 16;
  const data = octicons[name]?.heights[size] ?? octicons[name]?.heights[16];
  if (!data) return raw('');
  const aria = opts.label ? `role="img" aria-label="${esc(opts.label)}"` : 'aria-hidden="true"';
  return raw(
    `<svg class="octicon octicon-${name}${opts.cls ? ' ' + opts.cls : ''}" width="${size}" height="${size}" viewBox="0 0 ${data.width} ${size}" ${aria} fill="currentColor">${data.path}</svg>`,
  );
}

// ------------------------------------------------------------------- misc

export function relTime(iso: string | null | undefined): Safe {
  if (!iso) return raw('');
  const d = new Date(iso);
  return html`<relative-time datetime="${iso}" title="${d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}">${ago(d)}</relative-time>`;
}

export function ago(d: Date, nowMs = Date.now()): string {
  const s = Math.round((nowMs - d.getTime()) / 1000);
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
  const h = Math.round(m / 60);
  if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
  const days = Math.round(h / 24);
  if (days < 30) return days === 1 ? 'yesterday' : `${days} days ago`;
  return `on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

export function avatar(src: string, login: string, size = 40, cls = ''): Safe {
  return html`<img class="avatar ${cls}" src="${src}" width="${size}" height="${size}" alt="@${login}" loading="lazy">`;
}

/** A deterministic avatar for bots and users without a GitHub login. */
export function avatarSvg(login: string, type: Actor['type']): string {
  let hash = 0;
  for (const ch of login) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = hash % 360;
  const bg = `hsl(${hue} 55% 46%)`;
  const glyph =
    type === 'Bot'
      ? octicons['hubot'].heights[24].path.replace('<path', '<path fill="#fff" transform="translate(4 4)"')
      : `<text x="16" y="21.5" text-anchor="middle" font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="15" font-weight="600" fill="#fff">${esc(login.slice(0, 1).toUpperCase())}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><rect width="32" height="32" fill="${bg}"/>${glyph}</svg>`;
}

export function shortSha(sha: string | null | undefined): string {
  return (sha ?? '').slice(0, 7);
}

export function plural(n: number, one: string, many = one + 's'): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A stable id for a file's anchor, like GitHub's diff-<sha256(path)>. */
export function fileAnchor(path: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < path.length; i++) {
    h ^= path.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `diff-${h.toString(16)}`;
}
