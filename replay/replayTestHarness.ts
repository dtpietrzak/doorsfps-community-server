/**
 * Shared recorder wiring for community unit tests.
 * Uses InMemoryReplayLifecycleClient — never opens replays.sqlite.
 */

import {
  InMemoryReplayLifecycleClient,
  type ReplayLifecycleClient,
} from "./replayLifecycleClient.ts";
import {
  LocalReplayBlobStore,
  type ReplayBlobStore,
} from "./ReplayBlobStore.ts";
import { ReplayRecorder } from "./ReplayRecorder.ts";
import type { ReplayIntegrationSink } from "./replayIntegration.ts";

export type WireRecorderOptions = {
  blobStore?: ReplayBlobStore;
  lifecycle?: ReplayLifecycleClient;
  serializeSession?: ConstructorParameters<
    typeof ReplayRecorder
  >[0]["serializeSession"];
  captureCheckpointState?: ConstructorParameters<
    typeof ReplayRecorder
  >[0]["captureCheckpointState"];
  onCheckpointCaptured?: ConstructorParameters<
    typeof ReplayRecorder
  >[0]["onCheckpointCaptured"];
  captureStartState?: ConstructorParameters<
    typeof ReplayRecorder
  >[0]["captureStartState"];
  checkpointIntervalSeconds?: number;
  bufferCaps?: ConstructorParameters<typeof ReplayRecorder>[0]["bufferCaps"];
  bufferBeforeCommit?: () => void;
};

export function wireReplayRecorder(
  hooks: {
    attachSink: (sink: ReplayIntegrationSink) => void;
    detachSink: () => void;
  },
  opts: WireRecorderOptions = {},
): {
  recorder: ReplayRecorder;
  lifecycle: InMemoryReplayLifecycleClient | ReplayLifecycleClient;
  blobDir: string | null;
  blobStore: ReplayBlobStore | null;
} {
  const blobDir = opts.blobStore
    ? null
    : Deno.makeTempDirSync({ prefix: "replay-blob-" });
  const blobStore = opts.blobStore ??
    (blobDir ? new LocalReplayBlobStore(blobDir) : null);
  const lifecycle = opts.lifecycle ??
    new InMemoryReplayLifecycleClient({
      blobStore: blobStore ?? undefined,
    });
  const recorder = new ReplayRecorder({
    lifecycle,
    attachSink: hooks.attachSink,
    detachSink: hooks.detachSink,
    serializeSession: opts.serializeSession,
    captureCheckpointState: opts.captureCheckpointState,
    onCheckpointCaptured: opts.onCheckpointCaptured,
    captureStartState: opts.captureStartState,
    checkpointIntervalSeconds: opts.checkpointIntervalSeconds,
    bufferCaps: opts.bufferCaps,
    bufferBeforeCommit: opts.bufferBeforeCommit,
  });
  recorder.ensureAttached();
  return { recorder, lifecycle, blobDir, blobStore };
}

/** Await lifecycle persistence after match-start / end / fail. */
export async function settleRecorder(recorder: ReplayRecorder): Promise<void> {
  await recorder.whenIdle();
}
