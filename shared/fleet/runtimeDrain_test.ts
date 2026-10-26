import { assertEquals } from "jsr:@std/assert@1";
import {
  envRequestsDraining,
  isDrainFlagPresent,
  isRuntimeDraining,
  RUNTIME_DRAIN_FLAG_FILENAME,
} from "./runtimeDrain.ts";

Deno.test("envRequestsDraining only accepts truthy strict flags", () => {
  const map = (value: string | undefined) => ({
    get: (k: string) => (k === "DOORS_DRAINING" ? value : undefined),
  });
  assertEquals(envRequestsDraining(map("1")), true);
  assertEquals(envRequestsDraining(map("true")), true);
  assertEquals(envRequestsDraining(map("on")), true);
  assertEquals(envRequestsDraining(map("0")), false);
  assertEquals(envRequestsDraining(map("false")), false);
  assertEquals(envRequestsDraining(map(undefined)), false);
});

Deno.test("isDrainFlagPresent and isRuntimeDraining file path", () => {
  const tmp = Deno.makeTempDirSync({ prefix: "doors-drain-flag-" });
  try {
    assertEquals(isDrainFlagPresent(tmp), false);
    assertEquals(
      isRuntimeDraining({
        cwd: tmp,
        env: { get: () => undefined },
      }),
      false,
    );
    Deno.writeTextFileSync(`${tmp}/${RUNTIME_DRAIN_FLAG_FILENAME}`, "1\n");
    assertEquals(isDrainFlagPresent(tmp), true);
    assertEquals(
      isRuntimeDraining({
        cwd: tmp,
        env: { get: () => undefined },
      }),
      true,
    );
  } finally {
    try {
      Deno.removeSync(tmp, { recursive: true });
    } catch {
      // ignore
    }
  }
});
