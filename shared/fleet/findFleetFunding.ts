/**
 * Figures Find prints when no official seat is left.
 * Authority computes the credit bank. The client only formats these numbers.
 */

export type FindFleetFundingBlock =
  | null
  | "donation_ceiling"
  | "hard_cap"
  | "physical_cap"
  | "host_launch_failed";

export type FindFleetFunding = {
  collectedCentsAllTime: number;
  /** Cents still required for one more credit. A full unit when none is in progress. */
  centsUntilNextCredit: number;
  dollarsPerCredit: number;
  /** `dollarsPerCredit` in cents. Display only. */
  creditCents: number;
  creditsAvailable: number;
  /** Host-months past the credits earned. Zero when the bank covers them. */
  creditsOverdrawn: number;
  extraHostPeakThisMonth: number;
  hardCapHosts: number;
  /** Limit to print for a hard or physical cap. Already the tighter of the two. */
  capHosts: number;
  primaryHot: number;
  blockedBy: FindFleetFundingBlock;
  hostLaunchAllowed: boolean;
  /**
   * Reported usable cap is below preallocated slots (the old cap of 5).
   * Not a reason to ask for a payment.
   */
  operatorUsableCap: boolean;
};

function nonNegativeInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.trunc(n);
}

function blockOf(value: unknown): FindFleetFundingBlock | undefined {
  if (value == null) return null;
  if (
    value === "donation_ceiling" || value === "hard_cap" ||
    value === "physical_cap" || value === "host_launch_failed"
  ) {
    return value;
  }
  return undefined;
}

/** Accept a catalog or wait payload. Invalid shapes become null. */
export function parseFindFleetFunding(raw: unknown): FindFleetFunding | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const collectedCentsAllTime = nonNegativeInt(row.collectedCentsAllTime);
  const centsUntilNextCredit = nonNegativeInt(row.centsUntilNextCredit);
  const dollarsPerCredit = nonNegativeInt(row.dollarsPerCredit);
  const creditCents = nonNegativeInt(row.creditCents);
  const creditsAvailable = nonNegativeInt(row.creditsAvailable);
  const extraHostPeakThisMonth = nonNegativeInt(row.extraHostPeakThisMonth);
  const hardCapHosts = nonNegativeInt(row.hardCapHosts);
  const capHosts = nonNegativeInt(row.capHosts);
  const primaryHot = nonNegativeInt(row.primaryHot);
  const blockedBy = blockOf(row.blockedBy);
  if (
    collectedCentsAllTime == null || centsUntilNextCredit == null ||
    dollarsPerCredit == null || creditCents == null ||
    creditsAvailable == null || extraHostPeakThisMonth == null ||
    hardCapHosts == null || capHosts == null || primaryHot == null ||
    blockedBy === undefined
  ) {
    return null;
  }
  return {
    collectedCentsAllTime,
    centsUntilNextCredit,
    dollarsPerCredit,
    creditCents,
    creditsAvailable,
    creditsOverdrawn: nonNegativeInt(row.creditsOverdrawn) ?? 0,
    extraHostPeakThisMonth,
    hardCapHosts,
    capHosts,
    primaryHot,
    blockedBy,
    hostLaunchAllowed: row.hostLaunchAllowed === true,
    operatorUsableCap: row.operatorUsableCap === true,
  };
}
