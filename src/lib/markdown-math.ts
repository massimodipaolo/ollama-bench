/**
 * Prepare model output for remark-math, outside fenced and inline code (code is left exactly as written):
 * - \( … \) and \[ … \] (common in model output) become $ … $ and $$ … $$, which remark-math reads;
 * - a dollar amount ($5, $1,200.50) is escaped, so "$5 and $10" stays text instead of becoming inline math.
 *   Only a plain number that ends at a space, punctuation or the line end counts as money: $2^n$ is still math.
 * Plain function: shared by the Markdown preview and tests.
 */
export function normalizeMath(md: string): string {
  return md
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, m: string) => `\n$$\n${m.trim()}\n$$\n`)
            .replace(/\\\((.+?)\\\)/g, (_, m: string) => `$${m}$`)
            .replace(/(^|[^\\$])\$(?=\d[\d,]*(?:\.\d+)?(?:[\s.,;:!?)\]]|$))/gm, '$1\\$'),
    )
    .join('');
}
