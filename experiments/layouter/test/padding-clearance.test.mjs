import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { solveFile } from "../src/pipeline.mjs";
import { boundaryLabelStrips } from "../src/route.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(path.dirname(path.dirname(here)));

async function agentSubstrate() {
  return solveFile(path.join(repo, "examples", "agent-substrate", "diagram.tsx"));
}

test("implicit hierarchy crossings do not consume parallel padding tracks", async () => {
  const { scene } = await agentSubstrate();
  const control = scene.objectByPath.get("cluster/layers/control-and-storage/substrate-control");
  const top = scene.regions.get(`padding:${control.path}:top`);

  assert.deepEqual(top.entries.map((entry) => [entry.line.id, entry.usage]), [["ingress-control", "crossing"]]);
  assert.equal(top.clearance, 0);
  assert.equal(top.thickness, 16);
  assert.equal(control.reserved.padding.top, 16);
});

test("authored padding tracks reserve inner route clearance independently of content padding", async () => {
  const { scene } = await agentSubstrate();
  const cluster = scene.objectByPath.get("cluster");
  const layers = scene.objectByPath.get("cluster/layers");
  const top = scene.regions.get("padding:cluster:top");
  const title = boundaryLabelStrips(scene).find((strip) => strip.owner === cluster);
  const geometryBottom = top.geometry.y + top.geometry.height;

  assert.deepEqual(top.entries.map((entry) => [entry.line.id, entry.usage]), [
    ["ingress-control", "crossing"],
    ["worker-pool-controller", "track"],
  ]);
  assert.equal(top.thickness, 24, "only the authored line consumes a parallel track");
  assert.equal(top.clearance, 12);
  assert.equal(cluster.reserved.padding.top, top.thickness + top.clearance);
  assert.equal(cluster.paddingBox.top - cluster.reserved.padding.top, 22, "content padding remains independent");
  assert.ok(top.geometry.y >= title.box.y + title.box.height, "the track starts below the title strip");
  assert.equal(layers.box.y - geometryBottom, top.clearance, "the track ends before child content");
});
