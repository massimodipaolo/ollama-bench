/**
 * Terminal-Bench 2.1 (harbor-framework/terminal-bench-2-1, Apache-2.0) in Harbor's task format:
 *   tasks/<name>/instruction.md        what the agent is asked to do
 *   tasks/<name>/task.toml             prebuilt image, cpus/memory, agent + verifier timeouts, internet
 *   tasks/<name>/tests/test.sh         copied to /tests after the agent finishes; writes /logs/verifier/reward.txt
 * Shared by the dataset fetch script and the test.
 */
export interface TbCase {
  id: string; // task name
  title: string;
  quick?: boolean;
  /** task directory, relative to .data/datasets/terminal-bench */
  dir: string;
  difficulty: string;
  category: string;
  image: string;
  cpus: number;
  memoryMb: number;
  agentTimeoutS: number;
  verifierTimeoutS: number;
}

const str = (s: string, re: RegExp) => (s.match(re) ?? [])[1];
const section = (s: string, name: string) => s.split(`[${name}]`)[1]?.split(/\n\[/)[0] ?? '';

/** The few task.toml fields the harness needs (a full TOML parser isn't worth a dependency here). */
export function parseTaskToml(name: string, toml: string): Omit<TbCase, 'dir' | 'quick'> {
  const env = section(toml, 'environment');
  const image = str(env, /^docker_image\s*=\s*"([^"]+)"/m);
  if (!image) throw new Error(`${name}: no environment.docker_image in task.toml`);
  return {
    id: name,
    title: name,
    difficulty: str(toml, /^difficulty\s*=\s*"([^"]*)"/m) ?? 'unknown',
    category: str(toml, /^category\s*=\s*"([^"]*)"/m) ?? 'unknown',
    image,
    cpus: Number(str(env, /^cpus\s*=\s*([\d.]+)/m) ?? 1),
    memoryMb: Number(str(env, /^memory_mb\s*=\s*(\d+)/m) ?? 2048),
    agentTimeoutS: Number(str(section(toml, 'agent'), /^timeout_sec\s*=\s*([\d.]+)/m) ?? 900),
    verifierTimeoutS: Number(str(section(toml, 'verifier'), /^timeout_sec\s*=\s*([\d.]+)/m) ?? 900),
  };
}
