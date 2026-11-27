/**
 * Whole-file edit format: the model writes each file's path on its own line, then the complete content in a fenced
 * block. A file the model doesn't return keeps its current content (like Aider: unchanged).
 */
const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;

/** "**src/lib.rs**", "`bowling.py`", "### File: bowling.py", "bowling.py:" → the bare path. */
function asPath(line: string): string {
  return line
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/^(file(name)?|path)\s*:\s*/i, '')
    .replace(/^[*_`"']+|[*_`"':]+$/g, '')
    .trim();
}

/** A bare path line naming one of the files (full path or basename); "// path" comments don't count. */
function isSolutionPath(p: string, solution: string[]): boolean {
  if (!p || /\s/.test(p)) return false;
  return solution.some((f) => p === f || p.endsWith('/' + f) || p === f.split('/').pop());
}

export function parseWholeFiles(response: string, solution: string[]): { files: Record<string, string>; missing: string[] } {
  const lines = response.replace(/\r\n/g, '\n').split('\n');
  const blocks: { path: string; content: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = lines[i].match(FENCE_OPEN);
    if (!open) continue;
    const fence = open[1];
    // closing fence: only fence characters, at least as many as the opening one
    const closes = (l: string) => l.trim().startsWith(fence) && /^[`~]+$/.test(l.trim());
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && !closes(lines[j])) body.push(lines[j++]);
    // the path is the nearest non-empty line above the fence (within 2 lines)
    let p = '';
    for (let k = i - 1; k >= Math.max(0, i - 2); k--) {
      if (lines[k].trim()) {
        p = asPath(lines[k]);
        break;
      }
    }
    // some models put the path inside the block as its first line: it names the file, and isn't code
    const first = body.findIndex((l) => l.trim());
    if (first >= 0 && isSolutionPath(asPath(body[first]), solution)) {
      if (!isSolutionPath(p, solution)) p = asPath(body[first]);
      body.splice(0, first + 1);
    }
    blocks.push({ path: p, content: body.join('\n') + '\n' });
    i = j;
  }
  const files: Record<string, string> = {};
  const base = (f: string) => f.split('/').pop()!;
  for (const f of solution) {
    const hit = blocks.find((b) => b.path === f) ?? blocks.find((b) => b.path && (b.path.endsWith('/' + f) || base(b.path) === base(f)));
    if (hit) files[f] = hit.content;
  }
  // one file expected and one unnamed block: that's it
  if (solution.length === 1 && !files[solution[0]] && blocks.length === 1) files[solution[0]] = blocks[0].content;
  return { files, missing: solution.filter((f) => !(f in files)) };
}

const EXT_LANG: Record<string, string> = {
  py: 'python',
  js: 'javascript',
  go: 'go',
  rs: 'rust',
  cpp: 'cpp',
  h: 'cpp',
  hpp: 'cpp',
  java: 'java',
};

/** Files as shown to the model: path line + fenced content. */
export function showFiles(files: Record<string, string>): string {
  return Object.entries(files)
    .map(([f, content]) => `${f}\n\`\`\`${EXT_LANG[f.split('.').pop() ?? ''] ?? ''}\n${content.replace(/\n$/, '')}\n\`\`\``)
    .join('\n\n');
}
