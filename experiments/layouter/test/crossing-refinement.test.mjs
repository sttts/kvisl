import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { solveFile } from "../src/pipeline.mjs";
import { analyzeScene } from "../src/quality.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(path.dirname(path.dirname(here)));

async function solveExample(relativePath) {
  return solveFile(path.join(repo, "examples", relativePath));
}

function crossingPairs(scene) {
  return analyzeScene(scene).routeCrossings.map((crossing) =>
    [crossing.first.line.id, crossing.second.line.id].sort().join("<->"));
}

function hasImmediateAxisReversal(points) {
  return points.slice(2).some((point, index) => {
    const first = points[index];
    const middle = points[index + 1];
    const horizontal = first.y === middle.y && middle.y === point.y;
    const vertical = first.x === middle.x && middle.x === point.x;
    if (!horizontal && !vertical) return false;
    const before = horizontal ? middle.x - first.x : middle.y - first.y;
    const after = horizontal ? point.x - middle.x : point.y - middle.y;
    return before * after < 0;
  });
}

test("coverage refinement avoids route crossings and rendered objects", async () => {
  const { scene } = await solveExample("coverage/diagram.tsx");
  const quality = analyzeScene(scene);

  assert.deepEqual(quality.routeCrossings, []);
  assert.deepEqual(quality.routeObjectIntersections, []);
  const probe = scene.lines.find((line) => line.id === "probe-upright");
  const horizontalDeltas = probe.route.slice(1)
    .map((point, index) => point.x - probe.route[index].x)
    .filter((delta) => delta !== 0);
  assert.ok(horizontalDeltas.every((delta) => delta < 0),
    "the probe route contains an unnecessary lateral branch or reversal");
  const audits = scene.lines.filter((line) => line.id.startsWith("audit-"));
  assert.ok(audits.every((line) => !hasImmediateAxisReversal(line.route)),
    "a bundle lane doubles back before reaching its target");
  assert.ok(audits.every((line) => line.route.slice(1)
    .map((point, index) => point.x - line.route[index].x)
    .filter((delta) => delta !== 0)
    .every((delta) => delta > 0)), "a bundle lane contains a horizontal return loop");
});

test("class refinement preserves the merge trunk and the structured repository itinerary", async () => {
  const { scene } = await solveExample("uml/class-diagram.tsx");

  assert.deepEqual(crossingPairs(scene), ["paypal-generalization<->repository-dependency"]);
  const paypal = scene.lines.find((line) => line.id === "paypal-generalization");
  const creditCard = scene.lines.find((line) => line.id === "credit-card-generalization");
  const target = paypal.to.point;
  const paypalTerminal = paypal.route.at(-2);
  const creditCardTerminal = creditCard.route.at(-2);
  assert.equal(paypalTerminal.x, target.x);
  assert.equal(creditCardTerminal.x, target.x);
});

test("component refinement orders same-side checkout docks without a crossing", async () => {
  const { scene } = await solveExample("uml/component-diagram.tsx");
  const payment = scene.lines.find((line) => line.id === "checkout-payment");
  const inventory = scene.lines.find((line) => line.id === "checkout-inventory");

  assert.deepEqual(crossingPairs(scene), []);
  assert.ok(payment.from.point.y < inventory.from.point.y);
});

test("activity refinement removes avoidable crossings and leaves only the facing-side K2,2 pair", async () => {
  const { scene } = await solveExample("uml/activity-diagram.tsx");

  assert.deepEqual(crossingPairs(scene), ["fork-prepare<->reserve-join"]);
});
