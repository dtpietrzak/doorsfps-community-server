/**
 * Bot-quality gate for the bot-official keys-only epic
 * (the keys-only note). Runs `simBotAudit.ts` over several seeds in
 * parallel, sums per-bot counters per scenario group across maps × seeds, and
 * either writes that aggregate as a baseline or compares against one.
 *
 * Usage (from server-community/):
 *   deno run -A --node-modules-dir=manual scripts/botAuditGate.ts \
 *     --write <keys-only baseline under notes/>
 *   deno run -A --node-modules-dir=manual scripts/botAuditGate.ts \
 *     --compare <keys-only baseline under notes/>
 *
 * Seeds are spaced by 1000 because simBotAudit advances the seed once per
 * scenario; adjacent seeds would replay each other's matches.
 *
 * Team fights are chaotic: with identical bot code, two disjoint 5-seed sets
 * differed by 30% in team scores and 2.5× in thrash windows. So the gate keeps
 * per-seed aggregates and fails a rule only when the change is both larger
 * than the rule's band (practical) and beyond {@link GATE_Z} standard errors of
 * seed-to-seed noise (statistical). 20 seeds ≈ 2 min on 8 cores.
 */

const DEFAULT_SEEDS = Array.from({ length: 20 }, (_, i) => 1 + i * 1000);

/** Minimum |z| (Welch, per-seed means) before a band violation counts. */
export const GATE_Z = 2.5;
const AUDIT_SCRIPT = new URL("./simBotAudit.ts", import.meta.url).pathname;

/** Summed per-bot counters from the audit JSON. */
const SUM_FIELDS = [
  "stuckEvents",
  "thrashEvents",
  "spinEvents",
  "wallAimEvents",
  "wallRamEvents",
  "doorDanceEvents",
  "shotsResolved",
  "hitsLanded",
  "damageDealt",
  "sprintTicks",
  "crouchTicks",
  "slideStarts",
  "scores",
  "kills",
  "deaths",
] as const;

type SumField = (typeof SUM_FIELDS)[number];

export type GroupAggregate = Record<SumField, number> & {
  scenarios: number;
  failedScenarios: number;
  highIssues: number;
  bots: number;
  doorEntries: number;
};

export type GateBaseline = {
  generatedAt: string;
  seeds: number[];
  seconds: number | null;
  /** Sums across all seeds (informational table). */
  groups: Record<string, GroupAggregate>;
  /** One aggregate per seed, same order as {@link seeds} (gate statistics). */
  perSeed: Record<string, GroupAggregate>[];
};

type AuditBot = Partial<Record<SumField, number>> & {
  enteredEnemyDoor?: boolean;
};

type AuditReport = {
  scenario: string;
  failed: boolean;
  issues: { severity: string }[];
  bots: AuditBot[];
};

type AuditJson = { seconds: number; reports: AuditReport[] };

/** `door-rush-easy-v2` → `door-rush-easy`; other scenario names unchanged. */
export function scenarioGroup(scenario: string): string {
  return scenario.replace(/-v\d+$/, "");
}

function emptyGroup(): GroupAggregate {
  const g = {
    scenarios: 0,
    failedScenarios: 0,
    highIssues: 0,
    bots: 0,
    doorEntries: 0,
  } as GroupAggregate;
  for (const f of SUM_FIELDS) g[f] = 0;
  return g;
}

export function aggregateAudits(
  audits: readonly AuditJson[],
): Record<string, GroupAggregate> {
  const groups: Record<string, GroupAggregate> = {};
  for (const audit of audits) {
    for (const r of audit.reports) {
      const key = scenarioGroup(r.scenario);
      const g = groups[key] ??= emptyGroup();
      g.scenarios += 1;
      if (r.failed) g.failedScenarios += 1;
      g.highIssues += r.issues.filter((i) => i.severity === "high").length;
      for (const b of r.bots) {
        g.bots += 1;
        if (b.enteredEnemyDoor) g.doorEntries += 1;
        for (const f of SUM_FIELDS) g[f] += b[f] ?? 0;
      }
    }
  }
  return groups;
}

/**
 * Proportional band (plus absolute per-run slack so tiny counts don't flap);
 * see {@link GATE_Z} for the noise test layered on top.
 */
type Rule =
  | { kind: "max"; field: keyof GroupAggregate; pct: number; slack: number }
  | { kind: "min"; field: keyof GroupAggregate; pct: number; slack: number }
  | {
    kind: "ratio";
    label: string;
    num: SumField;
    den: SumField;
    pct: number;
    groups: readonly string[];
  };

const COMBAT_GROUPS = ["team-easy", "team-medium", "team-hard"] as const;

export const GATE_RULES: readonly Rule[] = [
  { kind: "max", field: "stuckEvents", pct: 0.10, slack: 3 },
  { kind: "max", field: "wallRamEvents", pct: 0.10, slack: 2 },
  { kind: "max", field: "thrashEvents", pct: 0.10, slack: 2 },
  { kind: "min", field: "doorEntries", pct: 0.15, slack: 1 },
  { kind: "min", field: "scores", pct: 0.15, slack: 1 },
  {
    kind: "ratio",
    label: "hitRate",
    num: "hitsLanded",
    den: "shotsResolved",
    pct: 0.15,
    groups: COMBAT_GROUPS,
  },
  {
    kind: "ratio",
    label: "killsPerDeath",
    num: "kills",
    den: "deaths",
    pct: 0.15,
    groups: COMBAT_GROUPS,
  },
];

export type GateViolation = { group: string; rule: string; detail: string };

type Sample = { mean: number; variance: number; n: number };

function sample(values: readonly number[]): Sample | null {
  const n = values.length;
  if (n === 0) return null;
  const mean = values.reduce((a, v) => a + v, 0) / n;
  const variance = n > 1
    ? values.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1)
    : 0;
  return { mean, variance, n };
}

/** Welch z of `cur − base` on per-seed means; ±Infinity when both are noiseless. */
export function welchZ(base: Sample, cur: Sample): number {
  const se = Math.sqrt(base.variance / base.n + cur.variance / cur.n);
  const d = cur.mean - base.mean;
  if (se > 0) return d / se;
  return d === 0 ? 0 : d > 0 ? Infinity : -Infinity;
}

function ruleValues(
  perSeed: readonly Record<string, GroupAggregate>[],
  group: string,
  rule: Rule,
): number[] {
  const out: number[] = [];
  for (const seedGroups of perSeed) {
    const g = seedGroups[group];
    if (!g) continue;
    if (rule.kind === "ratio") {
      if (g[rule.den] > 0) out.push(g[rule.num] / g[rule.den]);
    } else {
      out.push(g[rule.field]);
    }
  }
  return out;
}

export function compareToBaseline(
  baseline: readonly Record<string, GroupAggregate>[],
  current: readonly Record<string, GroupAggregate>[],
  z: number = GATE_Z,
): GateViolation[] {
  const out: GateViolation[] = [];
  const groups = new Set(baseline.flatMap((s) => Object.keys(s)));
  for (const group of groups) {
    if (!current.some((s) => s[group])) {
      out.push({ group, rule: "present", detail: "group missing from run" });
      continue;
    }
    for (const rule of GATE_RULES) {
      if (rule.kind === "ratio" && !rule.groups.includes(group)) continue;
      const b = sample(ruleValues(baseline, group, rule));
      const c = sample(ruleValues(current, group, rule));
      if (!b || !c) continue;
      const zScore = welchZ(b, c);
      const stat = `z=${Number.isFinite(zScore) ? zScore.toFixed(2) : zScore}`;
      if (rule.kind === "ratio") {
        if (b.mean === 0) continue;
        const rel = c.mean / b.mean - 1;
        if (Math.abs(rel) > rule.pct && Math.abs(zScore) > z) {
          out.push({
            group,
            rule: rule.label,
            detail: `${c.mean.toFixed(3)} vs ${b.mean.toFixed(3)} (${pct(rel)}, ` +
              `limit ±${pct(rule.pct)}, ${stat})`,
          });
        }
        continue;
      }
      // Slack is per seed-run so the band scales with seed count.
      if (rule.kind === "max") {
        const limit = b.mean * (1 + rule.pct) + rule.slack;
        if (c.mean > limit && zScore > z) {
          out.push({
            group,
            rule: `${rule.field} max`,
            detail: `${c.mean.toFixed(2)}/seed > ${limit.toFixed(2)} ` +
              `(baseline ${b.mean.toFixed(2)}, ${stat})`,
          });
        }
      } else {
        const limit = b.mean * (1 - rule.pct) - rule.slack;
        if (c.mean < limit && zScore < -z) {
          out.push({
            group,
            rule: `${rule.field} min`,
            detail: `${c.mean.toFixed(2)}/seed < ${limit.toFixed(2)} ` +
              `(baseline ${b.mean.toFixed(2)}, ${stat})`,
          });
        }
      }
    }
  }
  return out;
}

function pct(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
}

async function runAudit(
  seed: number,
  outDir: string,
  extraArgs: readonly string[],
): Promise<AuditJson> {
  const jsonPath = `${outDir}/audit-seed-${seed}.json`;
  const cmd = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--node-modules-dir=manual",
      AUDIT_SCRIPT,
      "--seed",
      String(seed),
      "--json",
      jsonPath,
      ...extraArgs,
    ],
    stdout: "null",
    stderr: "piped",
  });
  const { code, stderr } = await cmd.output();
  if (code !== 0) {
    throw new Error(
      `simBotAudit seed=${seed} exited ${code}:\n${new TextDecoder().decode(stderr)}`,
    );
  }
  return JSON.parse(await Deno.readTextFile(jsonPath)) as AuditJson;
}

function printTable(
  current: Record<string, GroupAggregate>,
  baseline: Record<string, GroupAggregate> | null,
): void {
  const cols: (keyof GroupAggregate)[] = [
    "failedScenarios",
    "stuckEvents",
    "wallRamEvents",
    "thrashEvents",
    "doorEntries",
    "scores",
    "shotsResolved",
    "hitsLanded",
    "kills",
    "deaths",
    "slideStarts",
  ];
  for (const [group, g] of Object.entries(current)) {
    const b = baseline?.[group];
    const cells = cols.map((c) => {
      if (!b) return `${c}=${g[c]}`;
      const d = g[c] - b[c];
      return `${c}=${g[c]}(${d >= 0 ? "+" : ""}${d})`;
    });
    console.log(`${group.padEnd(16)} ${cells.join(" ")}`);
  }
}

function parseArgs(argv: string[]): {
  seeds: number[];
  write: string | null;
  compare: string | null;
  passthrough: string[];
} {
  let seeds = DEFAULT_SEEDS;
  let write: string | null = null;
  let compare: string | null = null;
  const passthrough: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--seeds" && argv[i + 1]) {
      seeds = argv[++i]!.split(",").filter((v) => v.trim() !== "").map(Number)
        .filter(Number.isFinite);
    } else if (a === "--write" && argv[i + 1]) write = argv[++i]!;
    else if (a === "--compare" && argv[i + 1]) compare = argv[++i]!;
    else if (
      (a === "--map" || a === "--type" || a === "--seconds" || a === "--bots") &&
      argv[i + 1]
    ) {
      passthrough.push(a, argv[++i]!);
    }
  }
  return { seeds, write, compare, passthrough };
}

async function main(): Promise<void> {
  const opts = parseArgs(Deno.args);
  if (!opts.write && !opts.compare) {
    console.error("pass --write <baseline.json> and/or --compare <baseline.json>");
    Deno.exit(2);
  }
  const outDir = await Deno.makeTempDir({ prefix: "bot-audit-gate-" });
  console.log(`Running simBotAudit for seeds ${opts.seeds.join(", ")} …`);
  const audits = await Promise.all(
    opts.seeds.map((s) => runAudit(s, outDir, opts.passthrough)),
  );
  const groups = aggregateAudits(audits);
  const perSeed = audits.map((a) => aggregateAudits([a]));

  let failed = false;
  if (opts.compare) {
    const baseline = JSON.parse(
      await Deno.readTextFile(opts.compare),
    ) as GateBaseline;
    if (!Array.isArray(baseline.perSeed)) {
      console.error("baseline has no perSeed aggregates — regenerate it with --write");
      Deno.exit(2);
    }
    printTable(groups, baseline.groups);
    const violations = compareToBaseline(baseline.perSeed, perSeed);
    if (violations.length === 0) {
      console.log("\nGATE PASS");
    } else {
      failed = true;
      console.log(`\nGATE FAIL (${violations.length})`);
      for (const v of violations) {
        console.log(`  ${v.group} ${v.rule}: ${v.detail}`);
      }
    }
  } else {
    printTable(groups, null);
  }

  if (opts.write) {
    const payload: GateBaseline = {
      generatedAt: new Date().toISOString(),
      seeds: opts.seeds,
      seconds: audits[0]?.seconds ?? null,
      groups,
      perSeed,
    };
    await Deno.writeTextFile(opts.write, JSON.stringify(payload, null, 2) + "\n");
    console.log(`\nWrote ${opts.write}`);
  }
  await Deno.remove(outDir, { recursive: true });
  if (failed) Deno.exit(1);
}

if (import.meta.main) {
  await main();
}
