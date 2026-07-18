import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { layout } from "../src/layout.mjs";
import { minimumHeadRun, normalizedHeads } from "../src/heads.mjs";
import { boundaryLabelStrips } from "../src/mesh.mjs";
import { solveFile } from "../src/pipeline.mjs";
import { project } from "../src/project.mjs";
import { analyzeScene } from "../src/quality.mjs";
import { route } from "../src/route.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(path.dirname(path.dirname(here)));

async function exampleFiles() {
  const root = path.join(repo, "examples");
  return (await readdir(root, { recursive: true }))
    .filter((file) => file.endsWith("diagram.tsx"))
    .sort()
    .map((file) => path.join(root, file));
}

function assertOrthogonal(routePoints, lineId) {
  for (let index = 1; index < routePoints.length; index += 1) {
    const first = routePoints[index - 1];
    const second = routePoints[index];
    assert.ok(first.x === second.x || first.y === second.y, `${lineId} has a non-orthogonal segment`);
  }
}

test("every repository diagram produces a finite orthogonal SVG preview", async () => {
  const files = await exampleFiles();
  assert.equal(files.length, 14);
  for (const file of files) {
    const { scene, svg } = await solveFile(file);
    const errors = scene.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    assert.deepEqual(errors, [], `${path.relative(repo, file)} has projection or solve errors`);
    assert.ok(Number.isFinite(scene.width) && scene.width > 0);
    assert.ok(Number.isFinite(scene.height) && scene.height > 0);
    assert.match(svg, /^<\?xml version="1\.0"/);
    for (const line of scene.lines) {
      assert.ok(line.route.length >= 2, `${path.relative(repo, file)} did not route ${line.id}`);
      assertOrthogonal(line.route, line.id);
    }
    const quality = analyzeScene(scene);
    assert.deepEqual(
      quality.layoutContractViolations.map((item) => `${item.kind}:${item.container?.path ?? "$root"}:${item.child?.path ?? ""}`),
      [],
      `${path.relative(repo, file)} violates a declarative layout contract`,
    );
    assert.deepEqual(
      quality.unexpectedObjectOverlaps.map((item) => `${item.first.path}<->${item.second.path}`),
      [],
      `${path.relative(repo, file)} overlaps unrelated rendered objects`,
    );
    assert.deepEqual(
      quality.routeObjectIntersections.map((item) => `${item.line.id}->${item.object.path}`),
      [],
      `${path.relative(repo, file)} routes through rendered objects`,
    );
    assert.deepEqual(
      quality.labelObjectOverlaps.map((item) => `${item.line.id}:${item.label.text}->${item.object.path}`),
      [],
      `${path.relative(repo, file)} places line labels over rendered objects`,
    );
    assert.deepEqual(
      quality.labelLabelOverlaps.map((item) => `${item.line.id}:${item.label.text}<->${item.otherLine.id}:${item.otherLabel.text}`),
      [],
      `${path.relative(repo, file)} overlaps line labels`,
    );
    assert.deepEqual(
      quality.labelRouteOverlaps.map((item) => `${item.line.id}:${item.label.text}<->${item.otherLine.id}`),
      [],
      `${path.relative(repo, file)} places a line label over an unrelated route`,
    );
    assert.deepEqual(
      quality.unexpectedRouteOverlaps.map((item) => `${item.first.line.id}<->${item.second.line.id}`),
      [],
      `${path.relative(repo, file)} gives unrelated lines a shared run`,
    );
    assert.deepEqual(
      quality.routeTitleCrossings.map((item) => `${item.line.id}->${item.object.owner.path}`),
      [],
      `${path.relative(repo, file)} runs a line along a container title`,
    );
    assert.deepEqual(
      quality.labelDecorOverlaps.map((item) => `${item.line.id}:${item.label.text}->${item.object.owner?.path ?? item.object.kind}`),
      [],
      `${path.relative(repo, file)} places line labels on container decor`,
    );
  }
});

test("a headed endpoint has a straight terminal run at least twice the head width", async () => {
  for (const file of await exampleFiles()) {
    const { scene } = await solveFile(file);
    for (const line of scene.lines) {
      const heads = normalizedHeads(line.heads);
      const terminalRuns = [
        Math.abs(line.route[1].x - line.route[0].x) + Math.abs(line.route[1].y - line.route[0].y),
        Math.abs(line.route.at(-1).x - line.route.at(-2).x) + Math.abs(line.route.at(-1).y - line.route.at(-2).y),
      ];
      heads.forEach((head, endIndex) => {
        const minimum = minimumHeadRun(head);
        assert.ok(terminalRuns[endIndex] >= minimum,
          `${path.relative(repo, file)}:${line.id} end ${endIndex} has ${terminalRuns[endIndex]}px before its first bend; expected ${minimum}px`);
      });
    }
  }
});

test("the solved channel mesh includes unused padding sides, sibling gaps, and corner junctions", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const keys = new Set(scene.channelMesh.map((cell) => cell.key));
  assert.ok(keys.has("mesh:padding:cluster:bottom"));
  assert.ok([...keys].some((key) => key.startsWith("mesh:corner:cluster:top-left")));
  assert.ok(keys.has("mesh:corner:cluster:bottom-right"));
  assert.deepEqual(scene.channelMesh.find((cell) => cell.key.startsWith("mesh:corner:cluster:top-left")).outwardSides, ["top", "left"]);
  assert.ok(keys.has("mesh:grid-column-gap:cluster/layers:0"));
  assert.ok(scene.channelMesh.some((cell) => cell.kind === "gap" && !cell.materialized));
});

test("boundary titles partition only their local top-channel cells", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const cluster = scene.objectByPath.get("cluster");
  const title = scene.channelResidents.find((resident) => resident.owner === cluster);
  const cells = scene.channelMesh.filter((cell) => cell.owner === cluster);
  const overlaps = (first, second) => first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;

  assert.ok(title);
  assert.ok(cells.every((cell) => !overlaps(cell.geometry, title.box)));
  const upperRight = cells.find((cell) => cell.side === "top" && cell.geometry.y === cluster.box.y
    && cell.geometry.x + cell.geometry.width > title.box.x + title.box.width);
  assert.equal(upperRight.geometry.y, cluster.box.y, "the title must not push the entire top channel down");
});

test("each side has one boundary-reaching padding band whose corners use the same dimensions", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const runtime = scene.objectByPath.get("cluster/layers/runtime");
  const cells = new Map(scene.channelMesh.filter((cell) => cell.owner === runtime).map((cell) => [cell.key, cell]));
  const left = cells.get("mesh:padding:cluster/layers/runtime:left");
  const right = cells.get("mesh:padding:cluster/layers/runtime:right");
  assert.equal(left.geometry.x, runtime.box.x);
  assert.equal(right.geometry.x + right.geometry.width, runtime.box.x + runtime.box.width);
  assert.ok(![...cells.keys()].some((key) => key.includes("left-access") || key.includes("right-access")));

  for (const [vertical, horizontal] of [["top", "right"], ["bottom", "left"], ["bottom", "right"]]) {
    const corner = cells.get(`mesh:corner:cluster/layers/runtime:${vertical}-${horizontal}`);
    const horizontalBand = cells.get(`mesh:padding:cluster/layers/runtime:${horizontal}`);
    const verticalHeight = vertical === "top"
      ? runtime.contentHeight + runtime.paddingBox.top
      : runtime.paddingBox.bottom;
    assert.equal(corner.geometry.height, verticalHeight);
    assert.equal(corner.geometry.width, horizontalBand.geometry.width);
  }
});

test("derived gap cells use facing overlap while active routing keeps its larger approach geometry", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const gap = scene.channelMesh.find((cell) =>
    cell.key === "mesh:gap:cluster/layers/control-and-storage/substrate-control:0");
  assert.ok(gap.materialized);
  assert.ok(gap.geometry.x > gap.routingGeometry.x);
  assert.ok(gap.geometry.x + gap.geometry.width < gap.routingGeometry.x + gap.routingGeometry.width);
  const access = scene.channelMesh.filter((cell) => cell.key.startsWith(`${gap.key}:access-`));
  assert.equal(access.length, 2);
  assert.ok(gap.neighbors.some((key) => key.startsWith(`${gap.key}:access-`)));
});

test("solving the same diagram is deterministic", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const first = await solveFile(entry);
  const second = await solveFile(entry);
  assert.equal(first.svg, second.svg);
});

test("route-aware alignment preserves declared space-between distribution", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const ingress = scene.objectByPath.get("ingress");
  const members = ingress.children.filter((child) => !child.anchor && !child.frame);
  const gaps = members.slice(1).map((member, index) =>
    member.box.x - (members[index].box.x + members[index].box.width));
  assert.ok(Math.max(...gaps) - Math.min(...gaps) < 1, `space-between gaps differ: ${gaps.join(", ")}`);
});

test("an automatic dock follows the nearest explicit ancestor padding", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines.find((candidate) => candidate.id === "worker-pool-controller");
  assert.equal(line.to.physicalSide, "top");
  assert.equal(line.to.point.y, line.to.object.box.y);
});

test("single-attachment docks stay centered when no local constraint requires displacement", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const midpoint = (endpoint) => {
    const target = endpoint.port?.anchor ?? endpoint.port?.owner ?? endpoint.object;
    const horizontalSide = endpoint.physicalSide === "top" || endpoint.physicalSide === "bottom";
    return horizontalSide
      ? target.box.x + target.box.width / 2
      : target.box.y + target.box.height / 2;
  };
  const lateralPosition = (endpoint) => endpoint.physicalSide === "top" || endpoint.physicalSide === "bottom"
    ? endpoint.point.x
    : endpoint.point.y;
  const stateLine = scene.lines.find((line) => line.from?.port?.id === "state");
  const sandboxLine = scene.lines.find((line) => line.from?.port?.id === "sandbox");
  const controllerLine = scene.lines.find((line) => line.id === "worker-pool-controller");
  const endpoints = [
    stateLine.from,
    stateLine.to,
    sandboxLine.from,
    sandboxLine.to,
    controllerLine.from,
    controllerLine.to,
  ];
  for (const endpoint of endpoints) assert.equal(lateralPosition(endpoint), midpoint(endpoint));
});

test("nested padding pins are ordered by their regions instead of provisional midpoints", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines.find((candidate) => candidate.id === "worker-pool-controller");
  assert.ok(line.pinPoints[0].y > line.pinPoints[1].y, "the inner top padding should precede the outer top padding");
});

test("padding tracks occupy reserved inner padding instead of a container border or title", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const cluster = scene.objectByPath.get("cluster");
  const track = [...scene.regions.values()].find((region) => region.kind === "padding" && region.owner === cluster && region.side === "top");
  const title = boundaryLabelStrips(scene).find((strip) => strip.owner === cluster);
  assert.ok(track.geometry.y >= title.box.y + title.box.height);
  assert.ok(track.geometry.y > cluster.box.y + 3);
});

test("an authored padding route keeps its main run on the reserved track", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines.find((candidate) => candidate.id === "worker-pool-controller");
  const cluster = scene.objectByPath.get("cluster");
  const track = [...scene.regions.values()].find((region) =>
    region.kind === "padding" && region.owner === cluster && region.side === "top");
  const trackY = track.geometry.y + track.geometry.height / 2;
  const horizontal = line.route.slice(1)
    .map((point, index) => ({ first: line.route[index], second: point }))
    .find((segment) => segment.first.y === segment.second.y && segment.first.y === trackY);
  assert.deepEqual(line.route[0], line.from.point);
  assert.deepEqual(line.route.at(-1), line.to.point);
  assert.equal(horizontal.first.x, line.from.point.x);
  assert.equal(horizontal.second.x, line.to.point.x);
});

test("routing reservations predict the approach side selected from an explicit ancestor corridor", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const runtime = scene.objectByPath.get("cluster/layers/runtime");
  const top = [...scene.regions.values()].find((region) => region.kind === "padding" && region.owner === runtime && region.side === "top");
  assert.ok(top?.entryLines.has(scene.lines.find((line) => line.id === "worker-pool-controller")));
});

test("hierarchical route itinerary leaves a source before crossing its parent gap", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines.find((candidate) => candidate.id === "request-to-agent");
  const ingressRight = [...scene.regions.values()].find((region) => region.kind === "padding" && region.owner.path === "ingress" && region.side === "right");
  const rootGap = [...scene.regions.values()].find((region) => region.kind === "gap" && region.owner === scene.root && region.entryLines.has(line));
  const firstIngressPin = line.pinPoints.findIndex((point) => point.x >= ingressRight.geometry.x && point.x <= ingressRight.geometry.x + ingressRight.geometry.width);
  const firstGapPin = line.pinPoints.findIndex((point) => point.y >= rootGap.geometry.y && point.y <= rootGap.geometry.y + rootGap.geometry.height);
  assert.ok(firstIngressPin >= 0 && firstIngressPin < firstGapPin);
});

test("aligned single padding tracks do not introduce a cosmetic jog", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines.find((candidate) => candidate.id === "request-to-agent");
  const interiorRuns = line.route.slice(1, -1).map((point, index) => ({ first: line.route[index], second: point }));
  assert.equal(interiorRuns.some((segment) => {
    const length = Math.abs(segment.first.x - segment.second.x) + Math.abs(segment.first.y - segment.second.y);
    return length > 0 && length < 12;
  }), false);
});

test("declared distribution is not replaced by cross-container endpoint alignment", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const forward = scene.objectByPath.get("ingress/worker-forward");
  const sandbox = scene.objectByPath.get("cluster/layers/runtime/worker-stack/worker-pod/sandbox");
  const centerX = (object) => object.box.x + object.box.width / 2;
  assert.ok(Math.abs(centerX(forward) - centerX(sandbox)) > 1);
});

test("nested explicit segment regions remain monotone from source to target", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines.find((candidate) => candidate.id === "self-suspend");
  for (let index = 1; index < line.route.length; index += 1) {
    assert.ok(line.route[index].x <= line.route[index - 1].x, "self-suspend backtracks across an authored region");
  }
  const outerGap = [...scene.regions.values()].find((region) => region.key === "gap:cluster/layers:1");
  const firstVertical = line.route.slice(1).map((point, index) => ({ first: line.route[index], second: point }))
    .find((segment) => segment.first.x === segment.second.x && segment.first.y !== segment.second.y);
  assert.ok(firstVertical.first.x >= outerGap.geometry.x && firstVertical.first.x <= outerGap.geometry.x + outerGap.geometry.width);
});

test("perpendicular crossings do not displace a longitudinal corridor track from center", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const region = scene.regions.get("gap:cluster/layers:1");
  const selfSuspend = scene.lines.find((line) => line.id === "self-suspend");
  const checkpoint = scene.lines.find((line) => line.id === "checkpoint-transfer");
  const resume = scene.lines.find((line) => line.id === "resume-actor");
  const selfTrack = selfSuspend.regionTracks.get(region.key);
  assert.equal(selfTrack.crossing, false);
  assert.equal(selfTrack.total, 1);
  assert.equal(checkpoint.regionTracks.get(region.key).crossing, true);
  assert.equal(resume.regionTracks.get(region.key).crossing, true);
  const center = region.geometry.x + region.geometry.width / 2;
  const longitudinal = selfSuspend.route.slice(1)
    .map((point, index) => ({ first: selfSuspend.route[index], second: point }))
    .filter(({ first, second }) => first.x === second.x && first.y !== second.y)
    .find(({ first }) => first.x >= region.geometry.x && first.x <= region.geometry.x + region.geometry.width);
  assert.equal(longitudinal.first.x, center);
});

test("a sole explicit gap crossing does not create an avoidable longitudinal detour", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines.find((candidate) => candidate.id === "checkpoint-transfer");
  const runtime = scene.objectByPath.get("cluster/layers/runtime");
  const gap = scene.regions.get("gap:cluster/layers:1");
  const runtimeLeft = [...scene.regions.values()].find((region) =>
    region.kind === "padding" && region.owner === runtime && region.side === "left");
  const runtimeBottom = [...scene.regions.values()].find((region) =>
    region.kind === "padding" && region.owner === runtime && region.side === "bottom" && region.entryLines.has(line));
  const routeLength = line.route.slice(1).reduce((sum, point, index) =>
    sum + Math.abs(point.x - line.route[index].x) + Math.abs(point.y - line.route[index].y), 0);
  const directLength = Math.abs(line.route[0].x - line.route.at(-1).x)
    + Math.abs(line.route[0].y - line.route.at(-1).y);
  assert.ok(runtimeLeft?.entryLines.has(line));
  assert.equal(runtimeBottom, undefined);
  assert.equal(line.regionTracks.get(gap.key).crossing, true);
  assert.equal(routeLength, directLength);
});

test("longitudinal corridor tracks form a centered geometry-ordered bundle", async () => {
  const entry = path.join(repo, "examples", "coverage", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const region = scene.regions.get("gap:system:1");
  const entries = region.entries
    .map((entry) => ({ entry, track: entry.line.regionTracks.get(region.key) }))
    .filter(({ track }) => !track.crossing)
    .sort((first, second) => first.track.index - second.track.index);
  assert.deepEqual(entries.map(({ entry }) => entry.line.id), ["probe-upright", "audit-upright", "audit-rotated"]);
  const projected = entries.map(({ entry }) => (entry.line.from.point.x + entry.line.to.point.x) / 2);
  assert.deepEqual(projected, [...projected].sort((first, second) => first - second));
  const coordinates = entries.map(({ track }) =>
    region.geometry.x + region.geometry.width / 2
      + (track.index - (track.total - 1) / 2) * region.spacing);
  assert.equal((coordinates[0] + coordinates.at(-1)) / 2, region.geometry.x + region.geometry.width / 2);
});

test("authored run candidates avoid label-driven grid inflation", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const grid = scene.objectByPath.get("cluster/layers");
  assert.ok(grid.layoutData.columnGaps[1] <= 64);
  assert.ok(scene.lines.flatMap((line) => line.routeLabels).filter((label) => label.authoredSegment)
    .every((label) => label.authoredRegion));
  assert.equal(analyzeScene(scene).labelObjectOverlaps.length, 0);
  assert.equal(analyzeScene(scene).labelLabelOverlaps.length, 0);
});

test("a segment label stays anchored at the authored routing region", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines.find((candidate) => candidate.id === "resume-actor");
  const gap = [...scene.regions.values()].find((region) => region.kind === "gap" && region.entryLines.has(line));
  const label = line.routeLabels[0];
  assert.equal(label.authoredRegion, gap);
  const segment = line.route.slice(1).map((point, index) => ({ first: line.route[index], second: point }))[label.authoredRun];
  const horizontal = segment.first.y === segment.second.y;
  assert.ok(horizontal
    ? label.x >= Math.min(segment.first.x, segment.second.x) && label.x <= Math.max(segment.first.x, segment.second.x)
    : label.y >= Math.min(segment.first.y, segment.second.y) && label.y <= Math.max(segment.first.y, segment.second.y));
});

test("a gap label may hug the branch-facing border without moving away from its line", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines.find((candidate) => candidate.id === "self-suspend");
  const label = line.routeLabels.find((candidate) => candidate.text.startsWith("api.ate-system"));
  const segment = line.route.slice(1)
    .map((point, index) => ({ first: line.route[index], second: point }))[label.authoredRun];
  const distance = segment.first.x === segment.second.x
    ? Math.min(Math.abs(label.box.x - segment.first.x), Math.abs(label.box.x + label.box.width - segment.first.x))
    : Math.min(Math.abs(label.box.y - segment.first.y), Math.abs(label.box.y + label.box.height - segment.first.y));
  assert.equal(label.authoredAxis, true);
  assert.ok(distance <= 8, `gap label is ${distance}px from its authored run`);
});

test("column near-miss stretching and final-width alignment match the reference composition", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const workerPod = scene.objectByPath.get("cluster/layers/runtime/worker-stack/worker-pod");
  const helper = scene.objectByPath.get(`${workerPod.path}/ateom-visor`);
  const sandbox = scene.objectByPath.get(`${workerPod.path}/sandbox`);
  const storage = scene.objectByPath.get("cluster/layers/control-and-storage/snapshot-storage");
  const checkpoint = scene.objectByPath.get(`${storage.path}/checkpoint`);
  assert.equal(helper.box.width, sandbox.box.width);
  assert.equal(helper.box.x, sandbox.box.x);
  assert.equal(checkpoint.box.x + checkpoint.box.width / 2, storage.box.x + storage.box.width / 2);
});

test("explicit padding pins reserve a physical routing band", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const cluster = scene.objectByPath.get("cluster");
  const line = scene.lines.find((candidate) => candidate.id === "request-to-agent");
  const region = [...scene.regions.values()].find((candidate) => candidate.kind === "padding" && candidate.owner === cluster && candidate.side === "right");
  assert.ok(region);
  assert.ok(region.thickness > 0);
  assert.ok(line.regionTracks.has(region.key));
  assert.ok(cluster.reserved.padding.right >= region.thickness);
});

test("a named merge port produces one shared positive-length prefix", async () => {
  const entry = path.join(repo, "examples", "machine-thought-os", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const scheduler = scene.objectByPath.get("kernel/execution/scheduler");
  const port = scheduler.ports.get("children");
  const lines = scene.lines.filter((line) => line.from?.port === port);
  assert.equal(lines.length, 3);
  const prefixes = lines.map((line) => line.route.slice(0, 2));
  assert.deepEqual(prefixes[1], prefixes[0]);
  assert.deepEqual(prefixes[2], prefixes[0]);
  assert.notDeepEqual(prefixes[0][0], prefixes[0][1]);
});

test("a named bundle port keeps separate adjacent strokes after the dock", async () => {
  const entry = path.join(repo, "examples", "machine-thought-os", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const state = scene.objectByPath.get("kernel/execution/shared-state");
  const port = state.ports.get("children");
  const lines = scene.lines.filter((line) => line.from?.port === port);
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[1].route[0], lines[0].route[0]);
  assert.deepEqual(lines[2].route[0], lines[0].route[0]);
  assert.equal(new Set(lines.map((line) => `${line.route[1].x},${line.route[1].y}`)).size, 3);
});

test("an explicit same-size constraint equalizes the referenced boxes", async () => {
  const entry = path.join(repo, "examples", "coverage", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const upright = scene.objectByPath.get("system/upright");
  const monitor = scene.objectByPath.get("system/monitor");
  assert.equal(Math.round(monitor.box.height), Math.round(upright.box.height));
});

function primitive(core, props = {}, children = []) {
  return { core, props, children };
}

function portOrderingDiagram(groupOrder = null) {
  const portMembers = ["bottom", "middle", "top"]
    .map((id) => primitive("port", { id, side: "left" }));
  const targetChildren = groupOrder
    ? [primitive("port-group", { id: "inputs", order: groupOrder }, portMembers)]
    : portMembers;
  const remotes = ["top", "middle", "bottom"].map((id) => primitive("node", { id, label: id }, [
    primitive("port", { id: "out", side: "right" }),
  ]));
  const lines = ["top", "middle", "bottom"]
    .map((id) => primitive("line", { id, from: `remotes/${id}.out`, to: `target.${id}` }));
  return primitive("diagram", { id: "dock-order" }, [
    primitive("row", { id: "system", gap: 100, align: "center" }, [
      primitive("column", { id: "remotes", gap: 80 }, remotes),
      primitive("node", { id: "target", label: "target", style: { minHeight: 300 } }, targetChildren),
      ...lines,
    ]),
  ]);
}

test("free same-side docks follow remote endpoint projection without crossings", () => {
  const scene = project(portOrderingDiagram());
  layout(scene);
  route(scene);
  const target = scene.objectByPath.get("system/target");
  const y = (id) => target.ports.get(id).point.y;
  assert.ok(y("top") < y("middle") && y("middle") < y("bottom"));
  for (const line of scene.lines) assert.equal(line.route.length, 2, `${line.id} should be a direct run`);
});

test("a fixed port-group order overrides geometric dock ordering", () => {
  const scene = project(portOrderingDiagram("fixed"));
  layout(scene);
  route(scene);
  const target = scene.objectByPath.get("system/target");
  const y = (id) => target.ports.get(id).point.y;
  assert.ok(y("bottom") < y("middle") && y("middle") < y("top"));
  assert.equal(target.ports.get("bottom").group, target.ports.get("middle").group);
  assert.equal(target.ports.get("middle").group, target.ports.get("top").group);
});

test("geometric dock ordering retains collision-free labels in a dense neighbor row", async () => {
  const entry = path.join(repo, "examples", "uml", "use-case-diagram.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines.find((candidate) => candidate.id === "refund-checkout");
  const quality = analyzeScene(scene);
  const objectOverlaps = quality.labelObjectOverlaps.filter((item) => item.line === line);
  const decorOverlaps = quality.labelDecorOverlaps.filter((item) => item.line === line);
  assert.deepEqual(objectOverlaps.map((item) => `${item.label.text}->${item.object.path}`), []);
  assert.deepEqual(decorOverlaps.map((item) => `${item.label.text}->${item.object.owner.path}`), []);
});

function sparsePipeline(size) {
  const nodes = Array.from({ length: size }, (_, index) => primitive("node", { id: `n${index}`, label: `Node ${index}` }, [
    primitive("port", { id: "in", side: "left" }),
    primitive("port", { id: "out", side: "right" }),
  ]));
  const lines = Array.from({ length: size - 1 }, (_, index) => primitive("line", { id: `l${index}`, from: `nodes/n${index}.out`, to: `nodes/n${index + 1}.in` }));
  return primitive("diagram", { id: "scale" }, [primitive("column", { id: "nodes", gap: "small" }, nodes), ...lines]);
}

test("a large sparse model completes within bounded prototype work", () => {
  const started = performance.now();
  const scene = project(sparsePipeline(600));
  layout(scene);
  route(scene);
  const elapsed = performance.now() - started;
  assert.equal(scene.objects.length, 602);
  assert.equal(scene.lines.length, 599);
  assert.ok(elapsed < 5000, `sparse 600-object solve took ${Math.round(elapsed)}ms`);
});
