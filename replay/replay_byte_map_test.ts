/**
 * Epic 16.5 — byte-offset sidecar.
 *
 * Run from server-community/:
 *   deno test -A replay/replay_byte_map_test.ts
 */

import { assertEquals } from "@std/assert";
import { encodeCatalogFixture } from "./replayCatalogFixture.ts";
import {
  deriveReplayByteMap,
  type ReplayTickByteOffset,
} from "./replayByteMap.ts";
import type { ReplayContainer } from "./replayContainer.ts";

function takeJsonValue(text: string): string {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (c === "\\") {
        esc = true;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return text.slice(0, i + 1);
    }
  }
  throw new Error("no json value");
}

function valueAt(bytes: Uint8Array, offset: number): unknown {
  const tail = new TextDecoder().decode(bytes.subarray(offset));
  return JSON.parse(takeJsonValue(tail));
}

function bytePrefix(text: string, end: number): number {
  return new TextEncoder().encode(text.slice(0, end)).length;
}

Deno.test("16.5 byte map: section spans round-trip a real container", () => {
  const { container, bytes } = encodeCatalogFixture({ rosterName: "café € 😀" });
  const map = deriveReplayByteMap(bytes);
  if (!map) throw new Error("byte map was null");
  assertEquals(map.version, 1);
  assertEquals(map.fileSizeBytes, bytes.byteLength);
  const text = new TextDecoder().decode(bytes);
  assertEquals(text.includes("byteOffset"), false);

  for (const key of Object.keys(container) as (keyof ReplayContainer)[]) {
    const span = map.sections[key];
    if (!span) throw new Error(`missing section ${key}`);
    const slice = new TextDecoder().decode(bytes.subarray(span.start, span.end));
    assertEquals(JSON.parse(slice), container[key]);
  }

  assertEquals(
    map.checkpoints.map((row) => row.tick),
    [12],
  );
  assertEquals(valueAt(bytes, map.checkpoints[0]!.byteOffset), container.checkpoints[0]);
  assertEquals(map.inputs.map((row) => row.tick), [12]);
  assertEquals(
    (valueAt(bytes, map.inputs[0]!.byteOffset) as { tick: number }).tick,
    12,
  );
});

Deno.test("16.5 byte map: no checkpoints keeps only the first input row", () => {
  const { bytes } = encodeCatalogFixture({ checkpoints: false });
  const map = deriveReplayByteMap(bytes);
  if (!map) throw new Error("byte map was null");
  assertEquals(map.checkpoints, []);
  assertEquals(map.inputs.map((row) => row.tick), [10]);
});

Deno.test("16.5 byte map: synthetic offsets match an independent UTF-8 count", () => {
  const label = "café € 😀 \\ \" \\\\";
  const body = {
    label,
    inputStream: [
      { tick: 1, name: label },
      { tick: 5 },
      { tick: 9 },
    ],
    checkpoints: [{ tick: 0 }, { tick: 4 }, { tick: 8 }],
  };
  const text = JSON.stringify(body);
  const bytes = new TextEncoder().encode(text);
  const map = deriveReplayByteMap(bytes);
  if (!map) throw new Error("byte map was null");
  assertEquals(map.fileSizeBytes, bytes.byteLength);

  const valueStart = (key: string) => {
    const marker = `"${key}":`;
    const at = text.indexOf(marker);
    return bytePrefix(text, at + marker.length);
  };
  assertEquals(map.sections.label?.start, valueStart("label"));
  assertEquals(map.sections.inputStream?.start, valueStart("inputStream"));
  assertEquals(map.sections.checkpoints?.start, valueStart("checkpoints"));
  assertEquals(
    JSON.parse(
      new TextDecoder().decode(
        bytes.subarray(map.sections.label!.start, map.sections.label!.end),
      ),
    ),
    label,
  );

  const cpTextStart = text.indexOf(`"checkpoints":`) + `"checkpoints":`.length;
  const expectedCp: ReplayTickByteOffset[] = [];
  const needle = '{"tick":';
  let from = cpTextStart;
  while (from < text.length) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    expectedCp.push({
      tick: Number(text.slice(at + needle.length).match(/^-?\d+/)?.[0]),
      byteOffset: bytePrefix(text, at),
    });
    from = at + needle.length;
  }
  assertEquals(map.checkpoints, expectedCp);
  // tick 0 is before every input, so the anchor is the first input row.
  // tick 4 anchors on tick 1. tick 8 anchors on tick 5.
  assertEquals(map.inputs.map((row) => row.tick), [1, 5]);
});

Deno.test("16.5 byte map: malformed bytes are null", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  assertEquals(deriveReplayByteMap(enc("{")), null);
  assertEquals(deriveReplayByteMap(enc("[]")), null);
  assertEquals(deriveReplayByteMap(enc('{"a":')), null);
  assertEquals(deriveReplayByteMap(enc('{"a":"unterminated}')), null);
  assertEquals(deriveReplayByteMap(new Uint8Array([0xff, 0xfe])), null);
  const empty = deriveReplayByteMap(enc("{}"));
  assertEquals(empty?.fileSizeBytes, 2);
  assertEquals(empty?.checkpoints, []);
  assertEquals(empty?.inputs, []);
});
