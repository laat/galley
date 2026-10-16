import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { CliError, Client, currentBranch, type RepoRef } from './client.ts';
import { err, isTTY, out, runJq } from './output.ts';

const USAGE = `Make a request to the laatsux API. Mirrors \`gh api\`.

USAGE
  laatsux api <endpoint> [flags]

The endpoint is a path of the GitHub REST API, like "repos/{owner}/{repo}/pulls/1/comments".
{owner}, {repo} and {branch} are filled in from the repository in the current directory.

Supported endpoints (GitHub-compatible):
  repos/{owner}/{repo}/pulls                          GET, POST
  repos/{owner}/{repo}/pulls/N                        GET, PATCH
  repos/{owner}/{repo}/pulls/N/commits|files          GET
  repos/{owner}/{repo}/pulls/N/comments               GET, POST
  repos/{owner}/{repo}/pulls/N/comments/ID/replies    POST
  repos/{owner}/{repo}/pulls/comments/ID              GET, PATCH, DELETE
  repos/{owner}/{repo}/pulls/N/reviews                GET, POST
  repos/{owner}/{repo}/pulls/N/reviews/ID[/comments]  GET
  repos/{owner}/{repo}/pulls/N/reviews/ID/events      POST
  repos/{owner}/{repo}/issues/N/comments              GET, POST
  repos/{owner}/{repo}/issues/comments/ID             GET, PATCH, DELETE
  repos/{owner}/{repo}/issues/N/timeline              GET
laatsux extensions:
  repos/{owner}/{repo}/pulls/N/threads/ID/resolved    PUT, DELETE
  repos/{owner}/{repo}/pulls/N/publish                POST
  repos/{owner}/{repo}/pulls/N/wait?timeout=SECONDS   GET

FLAGS
  -X, --method string       The HTTP method (default GET, or POST with fields)
  -f, --raw-field key=value Add a string parameter
  -F, --field key=value     Add a typed parameter (true, false, null, numbers, @file)
  -H, --header key:value    Add a request header
      --input file          The file to use as the request body ("-" for stdin)
  -q, --jq expression       Filter the JSON response with jq
  -i, --include             Include the HTTP status line and headers
      --silent              Do not print the response body
`;

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** gh's typed field rules for -F. */
function typed(value: string): Json {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  if (value.startsWith('@')) return readFileSync(value === '@-' ? 0 : value.slice(1), 'utf8');
  return value;
}

/** Set `key` (which may be nested like a[b], a[], a[][b]) on obj, the way gh builds request bodies. */
export function setField(obj: Record<string, Json>, key: string, value: Json): void {
  const m = key.match(/^([^[]+)((?:\[[^\]]*\])*)$/);
  if (!m) throw new CliError(`invalid key: "${key}"`);
  const path = [m[1], ...[...m[2].matchAll(/\[([^\]]*)\]/g)].map((x) => x[1])];
  let cur: any = obj;
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    const last = i === path.length - 1;
    const next = path[i + 1];
    if (seg === '') {
      // Array segment: append, or extend the last object if this key is not set on it yet.
      if (last) {
        cur.push(value);
        return;
      }
      let el = cur[cur.length - 1];
      if (!el || typeof el !== 'object' || (path.length === i + 2 && next in el)) {
        el = next === '' ? [] : {};
        cur.push(el);
      }
      cur = el;
      continue;
    }
    if (last) {
      cur[seg] = value;
      return;
    }
    cur[seg] ??= next === '' ? [] : {};
    cur = cur[seg];
  }
}

export async function api(client: Client, cwd: string, args: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        method: { type: 'string', short: 'X' },
        'raw-field': { type: 'string', short: 'f', multiple: true },
        field: { type: 'string', short: 'F', multiple: true },
        header: { type: 'string', short: 'H', multiple: true },
        input: { type: 'string' },
        jq: { type: 'string', short: 'q' },
        template: { type: 'string', short: 't' },
        include: { type: 'boolean', short: 'i' },
        silent: { type: 'boolean' },
        paginate: { type: 'boolean' },
        slurp: { type: 'boolean' },
        verbose: { type: 'boolean' },
        hostname: { type: 'string' },
        cache: { type: 'string' },
        preview: { type: 'string', short: 'p', multiple: true },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (e) {
    const m = String((e as Error).message).match(/Unknown option '([^']+)'/);
    throw new CliError(m ? `unknown flag: ${m[1]}` : (e as Error).message);
  }
  const { values: v, positionals } = parsed;
  if (v.help || positionals.length === 0) {
    out(USAGE);
    return positionals.length === 0 && !v.help ? 1 : 0;
  }
  if (v.template) throw new CliError('--template is not supported; use --jq');
  let endpoint = positionals[0];
  if (endpoint === 'graphql') {
    throw new CliError(
      'laatsux does not implement the GraphQL API. Use `laatsux pr view --json reviewThreads` to read review threads, ' +
        '`laatsux pr comment N --reply-to ID` to reply, and the REST endpoints listed in `laatsux api --help`.',
    );
  }

  let repo: RepoRef | null = null;
  const fill = async (s: string, colon = false) => {
    const colonRe = /(^|\/):(owner|repo)(?=\/|$)/g;
    if (!/\{(owner|repo|branch)\}/.test(s) && !(colon && colonRe.test(s))) return s;
    repo ??= await client.repoFor(cwd);
    const r = repo;
    if (colon) s = s.replace(colonRe, (_, pre, key) => pre + (key === 'owner' ? r.owner : r.name));
    return s
      .replace(/\{owner\}/g, r.owner)
      .replace(/\{repo\}/g, r.name)
      .replace(/\{branch\}/g, currentBranch(cwd) ?? '');
  };
  endpoint = await fill(endpoint, true);
  endpoint = endpoint.replace(/^https?:\/\/[^/]+/, '').replace(/^\/+/, '').replace(/^api\//, '');

  const params: Record<string, Json> = {};
  for (const f of (v['raw-field'] as string[] | undefined) ?? []) {
    const i = f.indexOf('=');
    if (i < 0) throw new CliError(`field "${f}" requires a value separated by an '=' sign`);
    setField(params, f.slice(0, i), f.slice(i + 1));
  }
  for (const f of (v.field as string[] | undefined) ?? []) {
    const i = f.indexOf('=');
    if (i < 0) throw new CliError(`field "${f}" requires a value separated by an '=' sign`);
    const raw = f.slice(i + 1);
    const val = typed(raw);
    setField(params, f.slice(0, i), typeof val === 'string' && !raw.startsWith('@') ? await fill(val) : val);
  }
  const hasParams = Object.keys(params).length > 0;
  const method = String(v.method ?? (hasParams || v.input ? 'POST' : 'GET')).toUpperCase();
  const headers: Record<string, string> = {};
  for (const h of (v.header as string[] | undefined) ?? []) {
    const i = h.indexOf(':');
    if (i > 0) headers[h.slice(0, i).trim().toLowerCase()] = h.slice(i + 1).trim();
  }

  let path = '/api/' + endpoint;
  let rawBody: string | undefined;
  if (v.input) {
    rawBody = readFileSync(v.input === '-' ? 0 : String(v.input), 'utf8');
    if (hasParams) path += (path.includes('?') ? '&' : '?') + new URLSearchParams(params as Record<string, string>);
  } else if (hasParams) {
    if (method === 'GET') path += (path.includes('?') ? '&' : '?') + new URLSearchParams(params as Record<string, string>);
    else rawBody = JSON.stringify(params);
  }

  const res = await client.raw(method, path, { rawBody, headers });
  const text = await res.text();
  if (v.include) {
    out(`HTTP/1.1 ${res.status} ${res.statusText}`);
    res.headers.forEach((value, key) => out(`${key}: ${value}`));
    out('');
  }
  if (!v.silent && text) {
    if (v.jq && res.ok) process.stdout.write(runJq(String(v.jq), text));
    else if (isTTY && (res.headers.get('content-type') ?? '').includes('json')) out(JSON.stringify(JSON.parse(text), null, 2));
    else out(text);
  }
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = JSON.parse(text).message ?? message;
    } catch {}
    err(`laatsux: ${message.split('\n')[0]} (HTTP ${res.status})`);
    return 1;
  }
  return 0;
}
