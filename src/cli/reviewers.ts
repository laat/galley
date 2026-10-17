import { parseArgs } from 'node:util';
import { CliError, repoPath, type Client } from './client.ts';
import { checkFields, err, out, printJson } from './output.ts';

/** A reviewer agent, as GET …/reviewers and POST …/pulls give it (reviewerAgentJson). */
export interface ReviewerAgent {
  login: string;
  reviewer: string;
  engine: string;
  reviews: 'code' | 'description';
  automatic: boolean;
  max_iterations: number;
}

export const REVIEWERS_USAGE = `List the reviewer agents that review the repository: Codex, Claude, and the reviewers you
defined that name it. Pass a name to \`galley pr create --reviewer\` to have one review.

USAGE
  galley reviewers [flags]

FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository
      --json [<fields>]          Output JSON, with the fields given or all of them
  -q, --jq <expression>          Filter JSON output using a jq expression

COLUMNS
  NAME        Its name, for --reviewer
  REVIEWS     code, or description: the title, description and commit messages
  AUTOMATIC   Whether it reviews your pull requests when you wait, without --reviewer
  LIMIT       How many times it reviews a pull request on its own
`;

// The --json fields: the columns.
const FIELDS = ['name', 'engine', 'reviews', 'automatic', 'limit'] as const;

const json = (r: ReviewerAgent) => ({ name: r.login, engine: r.engine, reviews: r.reviews, automatic: r.automatic, limit: r.max_iterations });

export async function reviewers(client: Client, cwd: string, args: string[]): Promise<number> {
  // A bare --json is every field; parseArgs would demand a value.
  const fixed = args.map((a, i) => (a === '--json' && (i === args.length - 1 || args[i + 1].startsWith('-')) ? '--json=' : a));
  let parsed;
  try {
    parsed = parseArgs({
      args: fixed,
      options: {
        repo: { type: 'string', short: 'R' },
        json: { type: 'string' },
        jq: { type: 'string', short: 'q' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    const m = String((e as Error).message).match(/Unknown option '([^']+)'/);
    throw new CliError(m ? `unknown flag: ${m[1]}` : (e as Error).message);
  }
  const { values: v } = parsed;
  if (v.help) {
    out(REVIEWERS_USAGE);
    return 0;
  }
  const fields = (v.json ? checkFields(v.json, FIELDS) : FIELDS) as readonly (typeof FIELDS)[number][];
  const repo = await client.repoFor(cwd, v.repo);
  const list = await client.get<ReviewerAgent[]>(`${repoPath(repo)}/reviewers`);
  if (v.json !== undefined) {
    printJson(list.map((r) => Object.fromEntries(fields.map((f) => [f, json(r)[f]]))), v.jq);
    return 0;
  }
  if (!list.length) {
    err(`No reviewer agent reviews ${repo.owner}/${repo.name}.`);
    return 0;
  }
  const rows = [['NAME', 'ENGINE', 'REVIEWS', 'AUTOMATIC', 'LIMIT'], ...list.map((r) => [r.login, r.engine, r.reviews, r.automatic ? 'yes' : 'no', String(r.max_iterations)])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)));
  for (const row of rows) out(row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]))).join('  '));
  return 0;
}

const and = (names: string[]) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);
const review = (names: string[]) => `${and(names)} ${names.length > 1 ? 'review' : 'reviews'}`;

/**
 * Who reviews a pull request just staged, from POST …/pulls's `reviewer_agents`: "When you wait,
 * codex-review reviews the code, and house-rules the title, description and commit messages."
 */
export function whoReviews(agents: ReviewerAgent[]): string {
  const on = agents.filter((a) => a.automatic);
  const code = on.filter((a) => a.reviews === 'code').map((a) => a.login);
  const description = on.filter((a) => a.reviews === 'description').map((a) => a.login);
  const messages = 'the title, description and commit messages';
  if (code.length && description.length) return `When you wait, ${review(code)} the code, and ${and(description)} ${messages}.`;
  if (code.length) return `When you wait, ${review(code)} the code.`;
  if (description.length) return `When you wait, ${review(description)} ${messages}.`;
  return 'No reviewer agent reviews it.';
}
