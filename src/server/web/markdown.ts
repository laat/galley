import { Marked, type Tokens } from 'marked';
import sanitizeHtml from 'sanitize-html';
import hljs from 'highlight.js';
import { esc } from './html.ts';
import { UPLOAD_PATH } from '../uploads.ts';

const ALLOWED_TAGS = [
  ...sanitizeHtml.defaults.allowedTags,
  'img',
  'details',
  'summary',
  'input',
  'del',
  'ins',
  'kbd',
  'sup',
  'sub',
  'span',
  'picture',
  'source',
  'h1',
  'h2',
];

const SANITIZE: sanitizeHtml.IOptions = {
  allowedTags: ALLOWED_TAGS,
  allowedAttributes: {
    a: ['href', 'name', 'title', 'target', 'rel'],
    img: ['src', 'alt', 'title', 'width', 'height', 'align'],
    input: ['type', 'checked', 'disabled'],
    details: ['open'],
    td: ['align', 'colspan', 'rowspan'],
    th: ['align', 'colspan', 'rowspan'],
    source: ['srcset', 'media'],
    ol: ['start'],
    '*': ['class', 'aria-hidden', 'dir'],
  },
  allowedClasses: {
    '*': ['hljs*', 'language-*', 'suggestion*', 'blob-*', 'task-list-item*', 'contains-task-list', 'markdown-alert*', 'anchor'],
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  transformTags: {
    a: (tag, attribs) => {
      const external = /^https?:/.test(attribs.href ?? '');
      return { tagName: 'a', attribs: external ? { ...attribs, target: '_blank', rel: 'noopener noreferrer' } : attribs };
    },
    input: (tag, attribs) => ({ tagName: 'input', attribs: { ...attribs, disabled: '' } }),
    // Images come from the web or from laatsux's own uploads, never from another local URL.
    img: (tag, { src, ...attribs }) => ({ tagName: 'img', attribs: src && (/^https?:\/\//i.test(src) || UPLOAD_PATH.test(src)) ? { src, ...attribs } : attribs }),
  },
};

export function languageFor(path: string): string | undefined {
  const base = path.split('/').pop() ?? '';
  const special: Record<string, string> = { Dockerfile: 'dockerfile', Makefile: 'makefile', 'CMakeLists.txt': 'cmake', Gemfile: 'ruby', Rakefile: 'ruby' };
  if (special[base]) return special[base];
  const ext = base.includes('.') ? base.split('.').pop()!.toLowerCase() : '';
  const alias: Record<string, string> = { mjs: 'javascript', cjs: 'javascript', mts: 'typescript', cts: 'typescript', tsx: 'typescript', jsx: 'javascript', svelte: 'xml', vue: 'xml', tf: 'hcl', lock: 'yaml', jsonc: 'json', zsh: 'bash' };
  const lang = alias[ext] ?? ext;
  return lang && hljs.getLanguage(lang) ? lang : undefined;
}

export function highlight(code: string, lang: string | undefined): string {
  if (!lang || !hljs.getLanguage(lang)) return esc(code);
  try {
    return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch {
    return esc(code);
  }
}

/**
 * Highlight a block of code and split the result into lines, closing and reopening the
 * spans that cross line breaks so each line is valid HTML on its own.
 */
export function highlightLines(lines: string[], lang: string | undefined): string[] {
  if (!lang) return lines.map(esc);
  const htmlText = highlight(lines.join('\n'), lang);
  const out: string[] = [];
  const open: string[] = [];
  let cur = '';
  const re = /(<span[^>]*>)|(<\/span>)|(\n)|([^<\n]+)/g;
  for (const m of htmlText.matchAll(re)) {
    if (m[1]) {
      open.push(m[1]);
      cur += m[1];
    } else if (m[2]) {
      open.pop();
      cur += m[2];
    } else if (m[3]) {
      out.push(cur + '</span>'.repeat(open.length));
      cur = open.join('');
    } else {
      cur += m[4];
    }
  }
  out.push(cur + '</span>'.repeat(open.length));
  return out.length === lines.length ? out : lines.map(esc);
}

export interface MarkdownContext {
  /** The lines a review comment points at; turns ```suggestion blocks into a diff. */
  suggestionLines?: string[];
  suggestionLang?: string;
  /** Keep every image URL, for a caller that points them somewhere safe itself (the repository browser). */
  keepImageUrls?: boolean;
}

const KEEP_IMAGE_URLS: sanitizeHtml.IOptions = { ...SANITIZE, transformTags: { ...SANITIZE.transformTags, img: (tag, attribs) => ({ tagName: 'img', attribs }) } };

function makeMarked(ctx: MarkdownContext): Marked {
  const m = new Marked({ gfm: true, breaks: true });
  m.use({
    renderer: {
      code(token: Tokens.Code) {
        const lang = (token.lang ?? '').trim().split(/\s+/)[0];
        if (lang === 'suggestion') return suggestion(token.text, ctx);
        const body = highlight(token.text, lang || undefined);
        return `<pre><code class="hljs${lang ? ` language-${esc(lang)}` : ''}">${body}</code></pre>\n`;
      },
    },
  });
  return m;
}

function suggestion(text: string, ctx: MarkdownContext): string {
  const before = ctx.suggestionLines ?? [];
  const after = text === '' ? [] : text.replace(/\n$/, '').split('\n');
  const del = highlightLines(before, ctx.suggestionLang);
  const add = highlightLines(after, ctx.suggestionLang);
  const rows = [
    ...del.map((l) => `<tr><td class="blob-code blob-code-deletion"><span class="blob-marker">-</span>${l}</td></tr>`),
    ...add.map((l) => `<tr><td class="blob-code blob-code-addition"><span class="blob-marker">+</span>${l}</td></tr>`),
  ];
  return `<div class="suggestion"><div class="suggestion-header">Suggested change</div><table class="suggestion-table"><tbody>${rows.join('')}</tbody></table></div>\n`;
}

export function renderMarkdown(text: string, ctx: MarkdownContext = {}): string {
  if (!text.trim()) return '';
  const rendered = makeMarked(ctx).parse(text, { async: false }) as string;
  return sanitizeHtml(rendered, ctx.keepImageUrls ? KEEP_IMAGE_URLS : SANITIZE);
}
