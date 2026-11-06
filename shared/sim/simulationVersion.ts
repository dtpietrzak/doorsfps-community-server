/**
 * Simulation version recorded on a replay (epic 17.2).
 *
 * This is the deterministic ruleset that produced the match. It is not the
 * wire protocol (`GAME_PROTO`), the git build (`buildSha`), the map file
 * version, or the replay file format (`REPLAY_FORMAT_VERSION`).
 *
 * Bump when the same recorded inputs and authoritative events would
 * produce different authoritative state. Presentation, packet layout, and
 * map content do not bump this.
 *
 * The live sim does not branch on this value. An omitted stamp plays on
 * this ruleset and stays unnumbered (17.4). A catalogued older ruleset is
 * a historical simulation and is not played here. Loading a file that
 * would resimulate under this version and come out wrong fails
 * (`replay-incompatible`, 17.5).
 */
export const SIMULATION_VERSION = 1 as const;

export type SimulationVersion = typeof SIMULATION_VERSION;
