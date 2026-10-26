/**
 * In-process open-admission jti anti-replay for official open runtimes.
 *
 * First successful consume admits a new human. The same jti may reclaim the
 * same subject (account or guest name) after disconnect without double-counting
 * a seat. A jti presented by a different subject is a replay and is rejected.
 */

export type OpenAdmissionConsumeResult =
  | "accepted"
  | "reclaim"
  | "replay";

type StoredAdmission = {
  subjectKey: string;
  exp: number;
  /** True once this jti has counted toward a new seat (not a reclaim). */
  seatConsumed: boolean;
};

const usedAdmissions = new Map<string, StoredAdmission>();
const PRUNE_EVERY = 64;
let ops = 0;

function prune(nowSec: number): void {
  ops += 1;
  if (ops % PRUNE_EVERY !== 0) return;
  for (const [jti, row] of usedAdmissions) {
    if (row.exp < nowSec) usedAdmissions.delete(jti);
  }
}

/** Stable subject key for account or guest admissions. */
export function openAdmissionSubjectKey(input: {
  accountUserId?: string | null;
  name: string;
}): string {
  const account = input.accountUserId?.trim();
  if (account) return `account:${account}`;
  return `guest:${input.name.trim().toLowerCase()}`;
}

/**
 * Consume or reclaim an open admission jti.
 * Call only after cryptographic verification and identity checks succeed.
 */
export function consumeOpenAdmissionJti(
  jti: string,
  exp: number,
  subjectKey: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): OpenAdmissionConsumeResult {
  const id = jti.trim();
  const subject = subjectKey.trim();
  if (!id || !subject) return "replay";
  prune(nowSec);
  if (exp < nowSec) return "replay";

  const existing = usedAdmissions.get(id);
  if (!existing) {
    usedAdmissions.set(id, {
      subjectKey: subject,
      exp,
      seatConsumed: true,
    });
    return "accepted";
  }
  if (existing.subjectKey !== subject) return "replay";
  // Same subject reconnect: do not count a second seat.
  existing.exp = Math.max(existing.exp, exp);
  return "reclaim";
}

/** Test helper: clear process-local admission state. */
export function resetOpenAdmissionJtisForTests(): void {
  usedAdmissions.clear();
  ops = 0;
}

/** Test helper: number of live jti entries. */
export function openAdmissionJtiCountForTests(): number {
  return usedAdmissions.size;
}
