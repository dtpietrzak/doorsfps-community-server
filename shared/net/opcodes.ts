/**
 * Gameplay binary protocol. Handshake auth stays JSON; Engine.IO
 * connect/disconnect stay named events.
 */

/** Bump when a packet layout is incompatible. */
export const GAME_PROTO = 4;

/**
 * Single Socket.IO event that carries encoded gameplay payloads.
 * Empty no-payload events stay on their NetEvents name (cheaper than a
 * binary-attachment envelope).
 */
export const GAME_PACKET_EVENT = "g";

export const NetOpcode = {
  Input: 1,
  Shoot: 2,
  Reload: 3,
  WeaponSwitch: 4,
  Ability: 5,
  SkillLoadout: 6,
  Ready: 7,
  Leave: 8,
  Pong: 9,
  RequestPoseHeartbeat: 10,
  ChangeTeam: 11,
  TeamRebalanceVote: 12,
  MatchReady: 13,
  MapVote: 14,
  AdminCommand: 15,
  Snapshot: 16,
  Welcome: 17,
  PlayerJoined: 18,
  PlayerLeft: 19,
  PlayerConnectionIssue: 20,
  PlayerConnectionRestored: 21,
  SessionReplaced: 22,
  Kicked: 23,
  CombatBurst: 24,
  PlayerRespawned: 25,
  TeamChanged: 26,
  ChangeTeamResult: 27,
  AutoTeamRebalanceNotice: 28,
  AutoTeamRebalanceCancel: 29,
  TeamRebalanceVoteResult: 30,
  TeamRebalanceVoteState: 31,
  Score: 32,
  GameOver: 33,
  MatchStart: 34,
  MapChange: 35,
  MapVoteState: 36,
  PrematchState: 37,
  MatchVoided: 38,
  MatchProgression: 39,
  Ping: 40,
  AdminCommandResult: 41,
  BotHeatmapTracking: 42,
  /** Pistol-whip request (client → server). Same payload shape as Shoot. */
  Melee: 43,
  /** Client finished building the map (client → server, empty). */
  MapLoaded: 44,
} as const;

export type NetOpcode = (typeof NetOpcode)[keyof typeof NetOpcode];

/** NetEvents string → opcode. Engine events are not listed. */
export const OPCODE_BY_EVENT: Readonly<Record<string, NetOpcode>> = {
  input: NetOpcode.Input,
  shoot: NetOpcode.Shoot,
  melee: NetOpcode.Melee,
  reload: NetOpcode.Reload,
  weaponSwitch: NetOpcode.WeaponSwitch,
  ability: NetOpcode.Ability,
  skillLoadout: NetOpcode.SkillLoadout,
  ready: NetOpcode.Ready,
  leave: NetOpcode.Leave,
  pong: NetOpcode.Pong,
  requestPoseHeartbeat: NetOpcode.RequestPoseHeartbeat,
  mapLoaded: NetOpcode.MapLoaded,
  changeTeam: NetOpcode.ChangeTeam,
  teamRebalanceVote: NetOpcode.TeamRebalanceVote,
  matchReady: NetOpcode.MatchReady,
  mapVote: NetOpcode.MapVote,
  adminCommand: NetOpcode.AdminCommand,
  snapshot: NetOpcode.Snapshot,
  welcome: NetOpcode.Welcome,
  playerJoined: NetOpcode.PlayerJoined,
  playerLeft: NetOpcode.PlayerLeft,
  playerConnectionIssue: NetOpcode.PlayerConnectionIssue,
  playerConnectionRestored: NetOpcode.PlayerConnectionRestored,
  sessionReplaced: NetOpcode.SessionReplaced,
  kicked: NetOpcode.Kicked,
  combatBurst: NetOpcode.CombatBurst,
  playerRespawned: NetOpcode.PlayerRespawned,
  teamChanged: NetOpcode.TeamChanged,
  changeTeamResult: NetOpcode.ChangeTeamResult,
  autoTeamRebalanceNotice: NetOpcode.AutoTeamRebalanceNotice,
  autoTeamRebalanceCancel: NetOpcode.AutoTeamRebalanceCancel,
  teamRebalanceVoteResult: NetOpcode.TeamRebalanceVoteResult,
  teamRebalanceVoteState: NetOpcode.TeamRebalanceVoteState,
  score: NetOpcode.Score,
  gameOver: NetOpcode.GameOver,
  matchStart: NetOpcode.MatchStart,
  mapChange: NetOpcode.MapChange,
  mapVoteState: NetOpcode.MapVoteState,
  prematchState: NetOpcode.PrematchState,
  matchVoided: NetOpcode.MatchVoided,
  matchProgression: NetOpcode.MatchProgression,
  ping: NetOpcode.Ping,
  adminCommandResult: NetOpcode.AdminCommandResult,
  botHeatmapTracking: NetOpcode.BotHeatmapTracking,
};

const EVENT_BY_OPCODE: string[] = [];
for (const [event, opcode] of Object.entries(OPCODE_BY_EVENT)) {
  EVENT_BY_OPCODE[opcode] = event;
}

export function eventToOpcode(event: string): NetOpcode | undefined {
  return OPCODE_BY_EVENT[event];
}

export function opcodeToEvent(opcode: number): string | undefined {
  return EVENT_BY_OPCODE[opcode];
}

export function isGameEvent(event: string): boolean {
  return event in OPCODE_BY_EVENT;
}

/**
 * Gameplay events that are a name with no payload today.
 * Sending them as a Socket.IO binary attachment is *larger* than
 * `42["reload"]` (~13B) because of the placeholder envelope + extra WS frame.
 * Keep these on their NetEvents name.
 */
export const EMPTY_GAME_EVENTS: ReadonlySet<string> = new Set([
  "reload",
  "ready",
  "leave",
  "requestPoseHeartbeat",
  "mapLoaded",
]);

export function isEmptyGameEvent(event: string): boolean {
  return EMPTY_GAME_EVENTS.has(event);
}
