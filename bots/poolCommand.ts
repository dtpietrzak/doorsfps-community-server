/**
 * `DOORS_POOL_BRAIN_CMD` is the official pool brain.
 * A JSON array is a command (`["deno","run",...]`). Anything else is a binary path.
 * The host does not read the bytes that brain decodes.
 */

export function poolBrainCommandFromEnv(
  env: { get(name: string): string | undefined } = Deno.env,
): readonly string[] | undefined {
  const raw = env.get("DOORS_POOL_BRAIN_CMD")?.trim();
  if (!raw) return undefined;
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
      const command: string[] = [];
      for (const part of parsed) {
        if (typeof part !== "string" || part.length === 0) return undefined;
        command.push(part);
      }
      return command;
    } catch {
      return undefined;
    }
  }
  return [raw];
}
