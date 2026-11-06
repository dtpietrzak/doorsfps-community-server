import { assertEquals } from "@std/assert";
import {
  type BotAdmissionReconcileReport,
  OPEN_ADMISSION_BOT_RECONCILE_MS,
} from "../bots/BotManager.ts";
import {
  AdmissionBotWave,
  type AdmissionBotWaveBots,
  type AdmissionBotWavePlayers,
} from "./admissionBotWave.ts";

const emptyReport: BotAdmissionReconcileReport = {
  botsEvicted: 0,
  fillBotCount: 0,
  balanceBot: false,
  balanceBotTeam: null,
  teamCounts: { A: 0, B: 0 },
  humanCount: 0,
  humanTeamCounts: { A: 0, B: 0 },
};

function harness(opts?: {
  maxPlayers?: number;
  nonAgents?: number;
  partySeated?: number;
}) {
  let partySeated = opts?.partySeated ?? 0;
  let batchActive = false;
  const finishes: string[] = [];
  const joined: number[] = [];
  const evictions: number[] = [];
  let evictResult = 0;
  const players: AdmissionBotWavePlayers = {
    nonAgentCount: () => opts?.nonAgents ?? 0,
    listPartyMembers: () => Array.from({ length: partySeated }),
  };
  const bots: AdmissionBotWaveBots = {
    onHumanJoined(maxPlayers) {
      joined.push(maxPlayers);
    },
    startAdmissionBatch() {
      batchActive = true;
    },
    noteAdmissionEvictions(n) {
      evictions.push(n);
    },
    isAdmissionBatchActive: () => batchActive,
    finishAdmissionBatch() {
      batchActive = false;
      return emptyReport;
    },
    tryEvict() {
      return evictResult;
    },
  };
  const wave = new AdmissionBotWave({
    players,
    bots,
    maxPlayers: () => opts?.maxPlayers ?? 8,
  });
  return {
    wave,
    finishes,
    joined,
    evictions,
    setPartySeated(n: number) {
      partySeated = n;
    },
    setEvictResult(n: number) {
      evictResult = n;
    },
    setBatchActive(on: boolean) {
      batchActive = on;
    },
    noteFinish(reason: string) {
      finishes.push(reason);
    },
  };
}

function waveWithFinishLog(opts?: Parameters<typeof harness>[0]) {
  const box = harness(opts);
  const original = box.wave.finish.bind(box.wave);
  box.wave.finish = (reason) => {
    box.noteFinish(reason);
    original(reason);
  };
  return box;
}

Deno.test("a solo snaps fill and does not arm the settle timer", () => {
  const { wave, joined, finishes } = waveWithFinishLog();
  wave.onHumanSeated({ partyId: null, partySize: 1 });
  assertEquals(joined, [8]);
  assertEquals(wave.admissionBotReconcileTimer, null);
  assertEquals(wave.admissionBotPendingParties.size, 0);
  assertEquals(wave.isActive(), false);
  assertEquals(finishes, []);
});

Deno.test("the first party member arms the timer and cancel does not reconcile", async () => {
  const { wave, joined, finishes } = waveWithFinishLog();
  wave.onHumanSeated({ partyId: "party-1", partySize: 2, botsEvicted: 1 });
  assertEquals(joined, [8]);
  assertEquals(wave.admissionBotPendingParties.get("party-1")?.partySize, 2);
  assertEquals(wave.admissionBotReconcileTimer != null, true);
  assertEquals(wave.isActive(), true);

  wave.cancel();
  assertEquals(wave.admissionBotReconcileTimer, null);
  assertEquals(wave.admissionBotPendingParties.size, 0);
  assertEquals(finishes, []);

  await new Promise((resolve) =>
    setTimeout(resolve, OPEN_ADMISSION_BOT_RECONCILE_MS + 40)
  );
  assertEquals(finishes, []);
});

Deno.test("a fully seated party finishes without waiting for the timer", () => {
  const box = waveWithFinishLog();
  box.setPartySeated(1);
  box.wave.onHumanSeated({ partyId: "party-1", partySize: 2 });
  assertEquals(box.finishes, []);
  assertEquals(box.wave.admissionBotReconcileTimer != null, true);

  box.setPartySeated(2);
  box.wave.onHumanSeated({
    partyId: "party-1",
    partySize: 2,
    botsEvicted: 2,
  });
  assertEquals(box.finishes, ["party_complete"]);
  assertEquals(box.evictions, [2]);
  assertEquals(box.wave.admissionBotReconcileTimer, null);
  assertEquals(box.wave.admissionBotPendingParties.size, 0);
  assertEquals(box.joined, [8, 8]);
});

Deno.test("remaining party seats and slot eviction", () => {
  const box = harness({ maxPlayers: 4, nonAgents: 4 });
  assertEquals(box.wave.remainingPartySeats({ partyId: null, partySize: 4 }), 1);
  assertEquals(
    box.wave.remainingPartySeats({ partyId: "p", partySize: 1 }),
    1,
  );
  box.setPartySeated(1);
  assertEquals(
    box.wave.remainingPartySeats({ partyId: "p", partySize: 4 }),
    3,
  );
  box.setPartySeated(4);
  assertEquals(
    box.wave.remainingPartySeats({ partyId: "p", partySize: 2 }),
    1,
  );

  assertEquals(box.wave.ensureHumanJoinSlots(2, "A"), { ok: false, evicted: 0 });
  box.setEvictResult(1);
  assertEquals(box.wave.ensureHumanJoinSlots(2, "B"), { ok: true, evicted: 1 });

  const open = harness({ maxPlayers: 8, nonAgents: 2 });
  assertEquals(open.wave.ensureHumanJoinSlots(2), { ok: true, evicted: 0 });
});
