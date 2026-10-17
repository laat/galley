/**
 * Files the repository browser shows rendered rather than as source: Markdown and SVG. Their
 * lines (#L12) are only in the source, at ?plain=1. The web UI and `galley browse` share this,
 * so their URLs agree.
 */
export function rendersByDefault(path: string): boolean {
  return /\.(md|markdown|mdown|mkd|svg)$/i.test(path);
}
