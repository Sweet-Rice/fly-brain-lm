import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { ProtocolReceiver } from "../protocol.js";
import { RecordingSource } from "../playback.js";
import { buildGraph } from "../layout.js";
import { EdgeActivity } from "../activity.js";

test("real-model workflow reaches the shipped playback, layout and edge activity", { timeout: 10000 }, async t => {
  const path = process.env.FLYBRAIN_WORKFLOW_RECORDING
    || fileURLToPath(new URL("../../recordings/reference.ndjson", import.meta.url));
  const bytes = await readFile(path);
  const metadata = JSON.parse(await readFile(`${path}.metadata.json`, "utf8"));
  if (process.env.FLYBRAIN_WORKFLOW_RECORDING && process.env.FLYBRAIN_IMPL) {
    assert.equal(metadata.impl, process.env.FLYBRAIN_IMPL);
  }
  assert.equal(createHash("sha256").update(bytes).digest("hex"), metadata.recording_sha256);
  assert.equal(metadata.mode, "smoke");
  assert.equal(metadata.visualization_disabled_identical, true);
  assert.equal(metadata.network_dropped, 0);
  assert.equal(metadata.recording_dropped, 0);

  const receiver = new ProtocolReceiver();
  const epochs = [];
  let activity, status;
  const source = new RecordingSource(receiver, {
    onStatus: value => { status = value; },
    onEvent(event) {
      if (event.action === "replace_mapping") {
        const graph = buildGraph(receiver.mapping);
        assert.equal(graph.nodeCount, metadata.topology.nodes);
        assert.equal(graph.edgeCount, metadata.topology.edges);
        assert.equal(graph.labels.length, metadata.topology.groups);
        activity = new EdgeActivity(graph.edgePairs);
        assert.ok(activity.starts.every(time => time === -1));
        epochs.push([]);
      } else {
        assert.equal(event.action, "accept_fire");
        assert.deepEqual(event.dropped_pairs, []);
        assert.ok(event.pairs.length > 0);
        const now = metadata.steps + epochs.flat().length;
        assert.equal(activity.fire(event.pairs, now), true);
        for (const [src, dst] of event.pairs) {
          assert.equal(activity.starts[activity.indices.get(src).get(dst)], now);
        }
        assert.equal(activity.active(now), true);
        epochs.at(-1).push(event.t);
      }
    },
  });
  t.after(() => source.disconnect());
  // Exercise real playback with a short cadence; timing controls have separate tests.
  source.setSpeed(1000);
  await source.load(new Blob([bytes]));
  assert.equal(source.state, "finished", status?.message);
  const stepsPerRound = metadata.prompt_ids.length + metadata.generated_ids.length - 1;
  assert.equal(metadata.rounds, 4);
  assert.ok(stepsPerRound > 0);
  assert.deepEqual(epochs, [Array.from({ length: 3 * stepsPerRound }, (_, t) => t),
    Array.from({ length: stepsPerRound }, (_, t) => t)]);
  assert.equal(epochs.length, metadata.epochs);
  assert.equal(epochs.flat().length, metadata.steps);
  assert.equal(receiver.epoch, metadata.epochs - 1);
  assert.equal(receiver.lastT, metadata.last_epoch_steps - 1);
});
