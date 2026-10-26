export { msToTicks, TICK_HZ } from "../../../shared/sim/game.ts";

export type TeamId = "A" | "B";

export type PlayerInput = {
  sequence: number;
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  yaw: number;
  pitch: number;
};

