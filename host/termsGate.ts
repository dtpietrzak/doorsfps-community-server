/**
 * Terms of Use acceptance at boot (TERMS.md Section 3).
 *
 * A terminal is asked every start. A service / pipe accepts with
 * `--accept-terms` or `DOORS_ACCEPT_TERMS=1`; otherwise the process exits.
 * server-game sets the env var for official runtimes it spawns.
 */

/** Keep in sync with the "Version" line at the top of TERMS.md. */
export const TERMS_VERSION = "2026-10-26";

export const TERMS_ACCEPT_FLAG = "--accept-terms";
export const TERMS_ACCEPT_ENV = "DOORS_ACCEPT_TERMS";

export type TermsAcceptance = "flag" | "env" | "prompt";

export function isTruthyAcceptEnv(value: string | undefined): boolean {
  const v = value?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** Typed answers that count as acceptance at the prompt. */
export function isAcceptAnswer(answer: string | null): boolean {
  const a = answer?.trim().toLowerCase();
  return a === "accept" || a === "i accept" || a === "yes" || a === "y";
}

/** Acceptance given up front (flag or env), before any prompt. */
export function presetTermsAcceptance(
  args: readonly string[],
  envValue: string | undefined,
): TermsAcceptance | null {
  if (args.includes(TERMS_ACCEPT_FLAG)) return "flag";
  if (isTruthyAcceptEnv(envValue)) return "env";
  return null;
}

function termsNotice(): string {
  return `
DoorsFPS Community Server Terms of Use (version ${TERMS_VERSION})

The full text is TERMS.md next to this server (or in the source package).
In short, by running this server you agree that:
  - You may change and run this software as the MIT License allows.
  - You will not attack, break into, cheat on, or impersonate official
    DoorsFPS servers or services, or abuse other players.
  - You are responsible for your server, its files, and any player data.
  - Violations can lead to permanent bans and IP / network blocks from
    official DoorsFPS services.
`;
}

/**
 * Resolve acceptance or exit the process. Call before the server binds.
 * Returns how the Terms were accepted so main can log it.
 */
export function requireTermsAcceptance(
  args: readonly string[],
): TermsAcceptance {
  const preset = presetTermsAcceptance(args, Deno.env.get(TERMS_ACCEPT_ENV));
  if (preset) return preset;

  if (!Deno.stdin.isTerminal()) {
    console.error(termsNotice());
    console.error(
      `No terminal to accept the Terms. Re-run with ${TERMS_ACCEPT_FLAG} ` +
        `or set ${TERMS_ACCEPT_ENV}=1 to accept them.`,
    );
    Deno.exit(1);
  }

  console.log(termsNotice());
  const answer = prompt('Type "accept" to agree and start the server:');
  if (!isAcceptAnswer(answer)) {
    console.error("Terms not accepted. The server will not start.");
    Deno.exit(1);
  }
  return "prompt";
}
