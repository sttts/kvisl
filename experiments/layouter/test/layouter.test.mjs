import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { layout } from "../src/layout.mjs";
import { minimumHeadRun, normalizedHeads } from "../src/heads.mjs";
import { boundaryLabelStrips, regionGeometry } from "../src/mesh.mjs";
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

async function documentationDiagramFiles() {
  const root = path.join(repo, "docs", "diagrams");
  return (await readdir(root))
    .filter((file) => file.endsWith(".tsx"))
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

function assertNoReverseExcursion(routePoints, lineId) {
  for (let index = 1; index < routePoints.length - 1; index += 1) {
    const before = routePoints[index - 1];
    const middle = routePoints[index];
    const after = routePoints[index + 1];
    const horizontal = before.y === middle.y && middle.y === after.y;
    const vertical = before.x === middle.x && middle.x === after.x;
    if (!horizontal && !vertical) continue;
    const between = horizontal
      ? middle.x >= Math.min(before.x, after.x) && middle.x <= Math.max(before.x, after.x)
      : middle.y >= Math.min(before.y, after.y) && middle.y <= Math.max(before.y, after.y);
    assert.ok(between, `${lineId} immediately retraces a collinear segment at route point ${index}`);
  }
}

function longitudinalRouteLength(line, track) {
  const geometry = regionGeometry(track.region);
  let length = 0;
  for (let index = 1; index < line.route.length; index += 1) {
    const first = line.route[index - 1];
    const second = line.route[index];
    if (track.allocation.axis === "vertical"
      && first.x === second.x
      && Math.abs(first.x - track.allocation.coordinate) < 0.001) {
      const start = Math.max(Math.min(first.y, second.y), geometry.y);
      const end = Math.min(Math.max(first.y, second.y), geometry.y + geometry.height);
      length += Math.max(0, end - start);
    } else if (track.allocation.axis === "horizontal"
      && first.y === second.y
      && Math.abs(first.y - track.allocation.coordinate) < 0.001) {
      const start = Math.max(Math.min(first.x, second.x), geometry.x);
      const end = Math.min(Math.max(first.x, second.x), geometry.x + geometry.width);
      length += Math.max(0, end - start);
    }
  }
  return length;
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

test("every documentation diagram is executable by the local prototype", async () => {
  const files = await documentationDiagramFiles();
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
  }
});

test("a TSX port handle resolves to its bound component-internal named port", async () => {
  const entry = path.join(repo, "docs", "diagrams", "getting-started-reusable.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines[0];

  assert.equal(line.to.object.path, "system/checkout-service/api");
  assert.equal(line.to.port.id, "request");
  assert.equal(line.to.port.owner, line.to.object);
  assert.deepEqual(scene.diagnostics.filter((diagnostic) => diagnostic.severity === "error"), []);
});

test("layout orientation changes flow direction without rotating child geometry", async () => {
  const entry = path.join(repo, "docs", "diagrams", "orientation.tsx");
  const { scene } = await solveFile(entry);
  const horizontal = ["parse", "validate", "store"].map((id) => scene.objectByPath.get(`instances/horizontal/flow/${id}`));
  const vertical = ["parse", "validate", "store"].map((id) => scene.objectByPath.get(`instances/vertical/flow/${id}`));

  assert.deepEqual(vertical.map((object) => [object.box.width, object.box.height]),
    horizontal.map((object) => [object.box.width, object.box.height]));
  assert.ok(horizontal[0].box.x < horizontal[1].box.x && horizontal[1].box.x < horizontal[2].box.x);
  assert.ok(vertical[0].box.y < vertical[1].box.y && vertical[1].box.y < vertical[2].box.y);
  assert.ok(vertical.every((object) => Math.abs(object.box.x - vertical[0].box.x) < 0.01));
  assert.equal(vertical[0].ports.get("in").physicalSide, "top");
  assert.equal(vertical[0].ports.get("out").physicalSide, "bottom");
});

test("structured orientation depth remaps nested layouts without rotating their boxes", async () => {
  const defaultDepth = project({
    core: "diagram",
    props: { id: "orientation-depth" },
    children: [{
      core: "scope",
      props: { id: "outer", layout: "column", orientation: 90 },
      children: [{
        core: "row",
        props: { id: "inner" },
        children: [
          { core: "node", props: { id: "first", label: "first" }, children: [] },
          { core: "node", props: { id: "second", label: "second" }, children: [] },
        ],
      }],
    }],
  });
  layout(defaultDepth);
  assert.equal(defaultDepth.objectByPath.get("outer").effectiveLayout, "row");
  assert.equal(defaultDepth.objectByPath.get("outer/inner").effectiveLayout, "row");

  const entry = path.join(repo, "examples", "coverage", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const rotated = scene.objectByPath.get("system/rotated");
  const pipeline = scene.objectByPath.get("system/rotated/pipeline");
  const uprightStages = ["ingest", "transform", "publish"]
    .map((id) => scene.objectByPath.get(`system/upright/${id}`));
  const rotatedStages = ["ingest", "transform", "publish"]
    .map((id) => scene.objectByPath.get(`system/rotated/pipeline/${id}`));

  assert.equal(rotated.effectiveLayout, "row");
  assert.equal(pipeline.effectiveLayout, "column");
  assert.deepEqual(rotatedStages.map((object) => [object.box.width, object.box.height]),
    uprightStages.map((object) => [object.box.width, object.box.height]));
  assert.ok(rotatedStages[0].box.y < rotatedStages[1].box.y && rotatedStages[1].box.y < rotatedStages[2].box.y);
});

test("UML interaction routing keeps messages straight and lifelines equally deep", async () => {
  const entry = path.join(repo, "examples", "uml", "sequence-diagram.tsx");
  const { scene, svg } = await solveFile(entry);
  const messages = scene.lines.filter((line) => line.roles.includes("uml-message") || line.roles.includes("uml-reply"));
  assert.ok(messages.every((line) => line.route.length === 2),
    messages.filter((line) => line.route.length !== 2).map((line) => line.id).join(", "));
  const lifelines = scene.objects.filter((object) => object.roles.includes("uml-lifeline"));
  assert.equal(new Set(lifelines.map((object) => object.box.y + object.box.height)).size, 1);
  const spines = scene.lines.filter((line) => line.roles.includes("uml-lifeline-spine"));
  assert.ok(spines.every((line) => line.route.length === 2 && line.route[0].x === line.route[1].x),
    spines.filter((line) => line.route.length !== 2 || line.route[0].x !== line.route[1].x)
      .map((line) => line.from.object.parent.path).join(", "));
  assert.doesNotMatch(svg, /<circle[^>]+r="3"/);
  assert.equal(scene.lines.find((line) => line.id === "reserved").style.dash, "dashed");
  assert.match(svg, /data-uml-combined-fragment-tab="checkout-flow\/payment-retry"/);
});

test("UML endpoint labels stay grouped near their docks", async () => {
  const entry = path.join(repo, "examples", "uml", "class-diagram.tsx");
  const { scene } = await solveFile(entry);
  const association = scene.lines.find((line) => line.id === "customer-orders");
  for (const label of association.routeLabels.filter((candidate) => candidate.endpoint)) {
    const dock = label.endpoint.point;
    const distance = Math.abs(label.x - dock.x) + Math.abs(label.y - dock.y);
    assert.ok(distance < 100, `${label.text} is ${distance}px from its endpoint`);
  }
});

test("UML notations and actor associations use their visible geometry", async () => {
  const component = await solveFile(path.join(repo, "examples", "uml", "component-diagram.tsx"));
  const deployment = await solveFile(path.join(repo, "examples", "uml", "deployment-diagram.tsx"));
  const useCase = await solveFile(path.join(repo, "examples", "uml", "use-case-diagram.tsx"));

  assert.match(component.svg, /data-port-marker="required-interface"/);
  assert.match(component.svg, /data-port-marker="provided-interface"/);
  assert.match(deployment.svg, /«executionEnvironment»/);
  assert.match(deployment.svg, /«device»/);
  for (const line of useCase.scene.lines) {
    assertNoReverseExcursion(line.route, line.id);
    for (const endpoint of [line.from, line.to]) {
      if (!endpoint.object.roles.includes("uml-actor")) continue;
      assert.ok(endpoint.routingTarget, `${line.id} did not bind its actor figure`);
      const target = endpoint.routingTarget.box;
      const onHorizontalBoundary = endpoint.point.x === target.x || endpoint.point.x === target.x + target.width;
      const onVerticalBoundary = endpoint.point.y === target.y || endpoint.point.y === target.y + target.height;
      assert.ok(onHorizontalBoundary || onVerticalBoundary, `${line.id} missed its actor figure`);
    }
  }
});

test("UML routes do not contain immediate collinear retraces", async () => {
  const root = path.join(repo, "examples", "uml");
  const files = (await readdir(root)).filter((file) => file.endsWith("diagram.tsx")).sort();
  for (const file of files) {
    const { scene } = await solveFile(path.join(root, file));
    for (const line of scene.lines) assertNoReverseExcursion(line.route, `${file}:${line.id}`);
  }
});

test("a headed endpoint has a straight terminal run at least twice the head width", async () => {
  for (const file of await exampleFiles()) {
    const { scene } = await solveFile(file);
    for (const line of scene.lines) {
      const heads = normalizedHeads(line.heads);
      const terminalVectors = [
        { x: line.route[1].x - line.route[0].x, y: line.route[1].y - line.route[0].y },
        { x: line.route.at(-2).x - line.route.at(-1).x, y: line.route.at(-2).y - line.route.at(-1).y },
      ];
      const terminalRuns = [
        Math.abs(terminalVectors[0].x) + Math.abs(terminalVectors[0].y),
        Math.abs(terminalVectors[1].x) + Math.abs(terminalVectors[1].y),
      ];
      heads.forEach((head, endIndex) => {
        const minimum = minimumHeadRun(head);
        assert.ok(terminalRuns[endIndex] >= minimum,
          `${path.relative(repo, file)}:${line.id} end ${endIndex} has ${terminalRuns[endIndex]}px before its first bend; expected ${minimum}px`);
      });
      [line.from, line.to].forEach((endpoint, endIndex) => {
        const expected = endpoint.physicalSide === "left" ? { x: -1, y: 0 }
          : endpoint.physicalSide === "right" ? { x: 1, y: 0 }
            : endpoint.physicalSide === "top" ? { x: 0, y: -1 }
              : { x: 0, y: 1 };
        const actual = terminalVectors[endIndex];
        assert.ok(actual.x * expected.x + actual.y * expected.y > 0,
          `${path.relative(repo, file)}:${line.id} end ${endIndex} approaches its ${endpoint.physicalSide} port tangentially`);
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

test("boundary-title residents use the measured label width plus explicit clearance", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const control = scene.objectByPath.get("cluster/layers/control-and-storage/substrate-control");
  const resident = scene.channelResidents.find((candidate) => candidate.owner === control);
  const widths = control.renderLines
    .filter((line) => !line.divider && line.role === "label")
    .map((line) => line.measuredWidth);

  assert.ok(widths.every(Number.isFinite));
  assert.equal(resident.box.x, control.box.x + 8);
  assert.equal(resident.box.width, Math.max(...widths) + 8);
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

test("derived gap cells separate the facing track from canonical approach cells", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const gap = scene.channelMesh.find((cell) =>
    cell.key === "mesh:gap:cluster/layers/control-and-storage/substrate-control:0");
  assert.ok(gap.materialized);
  assert.equal("routingGeometry" in gap, false);
  const access = scene.channelMesh.filter((cell) => cell.key.startsWith(`${gap.key}:access-`));
  assert.equal(access.length, 2);
  assert.ok(Math.min(...access.map((cell) => cell.geometry.x)) < gap.geometry.x);
  assert.ok(Math.max(...access.map((cell) => cell.geometry.x + cell.geometry.width)) > gap.geometry.x + gap.geometry.width);
  assert.ok(gap.neighbors.some((key) => key.startsWith(`${gap.key}:access-`)));
});

test("sibling-gap cells cover the complete parent content cross-section", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const root = scene.root;
  const gap = scene.channelCellByKey.get("mesh:gap:$root:0");
  const cells = scene.channelMesh
    .filter((cell) => cell.slotKey === gap.slotKey)
    .sort((first, second) => first.geometry.x - second.geometry.x);
  const expectedStart = root.box.x + root.paddingBox.left;
  const expectedEnd = root.box.x + root.box.width - root.paddingBox.right;

  assert.equal(cells[0].geometry.x, expectedStart);
  assert.equal(cells.at(-1).geometry.x + cells.at(-1).geometry.width, expectedEnd);
  for (let index = 1; index < cells.length; index += 1) {
    assert.equal(cells[index - 1].geometry.x + cells[index - 1].geometry.width, cells[index].geometry.x);
  }
});

test("every reserved region binds to canonical mesh cells before routing", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  for (const region of scene.regions.values()) {
    assert.equal("geometry" in region, false, `${region.key} retained shadow geometry`);
    assert.ok(region.channelBinding, `${region.key} has no channel binding`);
    assert.ok(region.channelBinding.cellKeys.length > 0, `${region.key} has no channel cells`);
    for (const key of region.channelBinding.cellKeys) assert.ok(scene.channelCellByKey.has(key));
  }
  assert.deepEqual(scene.channelBindings.get("gap:cluster/layers:1").cellKeys,
    ["mesh:grid-column-gap:cluster/layers:1"]);
  assert.ok(scene.channelMesh.every((cell) => !("routingGeometry" in cell)));
});

test("track allocations stay inside the exact canonical cells painted by debug output", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  for (const allocation of scene.trackAllocations.values()) {
    const trackCell = scene.channelCellByKey.get(allocation.trackCellKey);
    assert.ok(trackCell);
    const low = allocation.axis === "vertical" ? trackCell.geometry.x : trackCell.geometry.y;
    const high = low + (allocation.axis === "vertical" ? trackCell.geometry.width : trackCell.geometry.height);
    assert.ok(allocation.coordinate >= low && allocation.coordinate <= high);
    assert.ok(allocation.spans.every((span) => scene.channelCellByKey.has(span.cellKey)));
  }
  const line = scene.lines.find((candidate) => candidate.id === "request-to-agent");
  const ingress = line.regionTracks.get("padding:ingress:right").allocation;
  const cluster = line.regionTracks.get("padding:cluster:right").allocation;
  assert.equal(ingress.runId, cluster.runId);
  assert.equal(ingress.coordinate, cluster.coordinate);
});

test("channel neighbors retain reciprocal positive-length portal intervals", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  for (const cell of scene.channelMesh) {
    for (const portal of cell.portals) {
      assert.ok(portal.end > portal.start, `${cell.key} has an empty portal to ${portal.to}`);
      const neighbor = scene.channelCellByKey.get(portal.to);
      assert.ok(neighbor);
      assert.ok(neighbor.portals.some((candidate) => candidate.to === cell.key
        && candidate.boundaryAxis === portal.boundaryAxis
        && candidate.coordinate === portal.coordinate
        && candidate.start === portal.start
        && candidate.end === portal.end
        && candidate.kind === portal.kind));
    }
  }
  const hierarchyPortals = scene.channelMesh.flatMap((cell) =>
    cell.portals.filter((portal) => portal.kind === "hierarchy").map((portal) => ({ cell, portal })));
  assert.ok(hierarchyPortals.length > 0);
  for (const { cell, portal } of hierarchyPortals) {
    if (cell.kind !== "corner") continue;
    const side = portal.boundaryAxis === "vertical"
      ? portal.coordinate === cell.geometry.x ? "left" : "right"
      : portal.coordinate === cell.geometry.y ? "top" : "bottom";
    assert.ok(cell.outwardSides.includes(side), `${cell.key} exits through ${side}`);
  }
});

test("solving the same diagram is deterministic", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const first = await solveFile(entry);
  const second = await solveFile(entry);
  assert.equal(first.svg, second.svg);
});

test("a CSS-style theme changes presentation without changing Modelplane geometry", async () => {
  const baseEntry = path.join(repo, "examples", "modelplane-fleet-inference", "diagram.tsx");
  const themedEntry = path.join(repo, "examples", "modelplane-fleet-inference", "neon-infrastructure.tsx");
  const base = await solveFile(baseEntry);
  const themed = await solveFile(themedEntry);
  const boxes = (scene) => scene.objects.map((object) => [object.path, object.box]);
  const routes = (scene) => scene.lines.map((line) => [line.id, line.route, line.routeLabels.map((label) => label.box)]);

  assert.equal(themed.scene.root.style.fill, "canvas");
  assert.equal(themed.scene.objectByPath.get("actors/client").style.fill, "surface");
  for (const path of ["fleet/cluster-a/locality", "fleet/external-targets/stubs", "footer"]) {
    assert.equal(themed.scene.objectByPath.get(path).style.fill, "surface");
  }
  assert.deepEqual(boxes(themed.scene), boxes(base.scene));
  assert.deepEqual(routes(themed.scene), routes(base.scene));
  assert.doesNotMatch(themed.svg, /id="routing-regions"/);
  assert.match(themed.svg, /<rect width="100%" height="100%" fill="#100d2e"\/>/);
  assert.match(themed.svg, /font-family="Inter, ui-sans-serif, system-ui, sans-serif"/);
});

test("Modelplane fixture centers its control-plane label and leaves the external port unmarked", async () => {
  const entry = path.join(repo, "examples", "modelplane-fleet-inference", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const controlPlane = scene.objectByPath.get("control-plane");
  const label = scene.objectByPath.get("control-plane/control-plane-label");
  const mlIntent = scene.lines.find((line) => line.fromRef === "actors/teams/ml-team.control");
  const endpoint = scene.objectByPath.get("fleet/external-targets/external-endpoint");
  const request = endpoint.ports.get("request");

  assert.equal(label.box.x + label.box.width / 2, controlPlane.box.x + controlPlane.box.width / 2);
  assert.equal(new Set(mlIntent.route.map((point) => point.x)).size, 1);
  assert.equal(request.marker, "none");
  assert.equal(request.physicalSide, "top");
});

test("a bundled terminal approach stays centered in its grid gutter", async () => {
  const entry = path.join(repo, "examples", "modelplane-fleet-inference", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines.find((candidate) => candidate.id === "cache-to-replica");
  const gutter = scene.channelCellByKey.get("mesh:grid-column-gap:fleet/cluster-a/serving-grid:0");
  const center = gutter.geometry.x + gutter.geometry.width / 2;
  const vertical = line.route.slice(1)
    .map((point, index) => ({ first: line.route[index], second: point }))
    .find(({ first, second }) => first.x === second.x && first.y !== second.y);

  assert.ok(vertical);
  assert.equal(vertical.first.x, center);
  assert.ok(line.route.slice(1).every((point, index) => {
    const previous = line.route[index];
    return point.x >= previous.x || point.y !== previous.y;
  }), "the centered approach must not backtrack before its terminal run");
});

test("authored corridor routing preserves its hard pins and a centered target dock", async () => {
  const entry = path.join(repo, "examples", "modelplane-fleet-inference", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines.find((candidate) => candidate.id === "place-cluster-a");
  const region = [...scene.regions.values()].find((candidate) =>
    candidate.kind === "gap" && candidate.owner === scene.root && candidate.entryLines.has(line));
  assert.ok(region);
  const track = line.regionTracks.get(region.key);
  const target = line.to.port.anchor;
  const originalCenter = target.box.x + target.box.width / 2;
  const corridorRun = line.route.slice(1)
    .map((point, index) => ({ first: line.route[index], second: point }))
    .find(({ first, second }) => first.y === second.y && first.y === track.allocation.coordinate
      && first.x !== second.x);

  assert.equal(line.to.point.x, originalCenter);
  assert.ok(corridorRun);
  assert.equal(corridorRun.second.x, line.to.point.x);
  assert.ok(line.requiredRoutePins.every((pin) => line.route.some((point) =>
    point.x === pin.x && point.y === pin.y)));
  const routeLength = line.route.slice(1).reduce((sum, point, index) =>
    sum + Math.abs(point.x - line.route[index].x) + Math.abs(point.y - line.route[index].y), 0);
  const directLength = Math.abs(line.route[0].x - line.route.at(-1).x)
    + Math.abs(line.route[0].y - line.route.at(-1).y);
  assert.equal(routeLength, directLength, "the cluster-A branch must not leave and re-enter its target column");
});

test("deep side ports reserve centered longitudinal tracks in adjacent sibling gaps", async () => {
  const entry = path.join(repo, "examples", "modelplane-fleet-inference", "diagram.tsx");
  const { scene } = await solveFile(entry);
  for (const [lineId, gapIndex] of [["request-cluster-a", 0], ["request-cluster-b", 1]]) {
    const line = scene.lines.find((candidate) => candidate.id === lineId);
    const region = scene.regions.get(`gap:fleet:${gapIndex}`);
    const track = line.regionTracks.get(region.key);
    const geometry = regionGeometry(region);
    const verticalRun = line.route.slice(1)
      .map((point, index) => ({ first: line.route[index], second: point }))
      .find(({ first, second }) => first.x === second.x && first.x === track.allocation.coordinate
        && first.y !== second.y);

    assert.equal(region.entries.find((entry) => entry.line === line).usage, "track");
    assert.equal(region.channelBinding.trackCell.materialized, true);
    assert.ok(region.owner.reserved.gaps[gapIndex] >= region.thickness);
    assert.ok(geometry.width >= region.thickness);
    assert.equal(track.crossing, false);
    assert.equal(track.allocation.coordinate, geometry.x + geometry.width / 2);
    assert.ok(verticalRun);
  }
  const placement = scene.lines.find((candidate) => candidate.id === "place-cluster-a");
  assert.equal(placement.regionTracks.has("gap:fleet:0"), false);
});

test("implicit package and use-case routes use the canonical centered grid gutter", async () => {
  const cases = [
    ["package-diagram.tsx", "checkout-shared", "grid-column-gap:packages:0"],
    ["use-case-diagram.tsx", "checkout-auth", "grid-column-gap:scene/store/cases:0"],
  ];
  for (const [file, lineId, regionKey] of cases) {
    const entry = path.join(repo, "examples", "uml", file);
    const { scene } = await solveFile(entry);
    const line = scene.lines.find((candidate) => candidate.id === lineId);
    const region = scene.regions.get(regionKey);
    const track = line.regionTracks.get(regionKey);
    const geometry = regionGeometry(region);

    assert.equal(region.gridAxis, "column");
    assert.equal(region.channelBinding.trackCell.key,
      `mesh:grid-column-gap:${region.owner.path}:${region.index}`);
    assert.ok(region.channelBinding.trackCell.regionKeys.includes(region.key));
    assert.equal(track.crossing, false);
    assert.equal(track.allocation.coordinate, geometry.x + geometry.width / 2);
    assert.ok(longitudinalRouteLength(line, track) > 0,
      `${lineId} reserves a canonical grid track without drawing on it`);
  }
});

test("implicit class-diagram lanes form centered physical blocks in every used grid gutter", async () => {
  const entry = path.join(repo, "examples", "uml", "class-diagram.tsx");
  const { scene } = await solveFile(entry);
  const firstRow = scene.regions.get("grid-row-gap:sales/model:0");
  const firstRowGeometry = regionGeometry(firstRow);
  const firstRowTracks = firstRow.entries
    .map((item) => item.line.regionTracks.get(firstRow.key))
    .filter((track) => !track.crossing)
    .sort((first, second) => first.allocation.coordinate - second.allocation.coordinate);

  assert.deepEqual(firstRow.entries.map((item) => item.line.id).sort(), ["order-payment", "repository-dependency"]);
  assert.equal((firstRowTracks[0].allocation.coordinate + firstRowTracks.at(-1).allocation.coordinate) / 2,
    firstRowGeometry.y + firstRowGeometry.height / 2);

  for (const region of scene.regions.values()) {
    if (!region.gridAxis) continue;
    const expectedCell = `mesh:grid-${region.gridAxis}-gap:${region.owner.path}:${region.index}`;
    assert.equal(region.channelBinding.trackCell.key, expectedCell);
    for (const item of region.entries) {
      const track = item.line.regionTracks.get(region.key);
      if (track.crossing) continue;
      assert.ok(longitudinalRouteLength(item.line, track) > 0,
        `${item.line.id} has a phantom allocation in ${region.key}`);
    }
  }
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
  const geometry = regionGeometry(track);
  assert.ok(geometry.y >= title.box.y + title.box.height);
  assert.ok(geometry.y > cluster.box.y + 3);
});

test("an authored padding route keeps its main run on the reserved track", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines.find((candidate) => candidate.id === "worker-pool-controller");
  const cluster = scene.objectByPath.get("cluster");
  const track = [...scene.regions.values()].find((region) =>
    region.kind === "padding" && region.owner === cluster && region.side === "top");
  const geometry = regionGeometry(track);
  const trackY = geometry.y + geometry.height / 2;
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
  const ingressGeometry = regionGeometry(ingressRight);
  const gapGeometry = regionGeometry(rootGap);
  const firstIngressPin = line.pinPoints.findIndex((point) => point.x >= ingressGeometry.x && point.x <= ingressGeometry.x + ingressGeometry.width);
  const firstGapPin = line.pinPoints.findIndex((point) => point.y >= gapGeometry.y && point.y <= gapGeometry.y + gapGeometry.height);
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
  const outerGeometry = regionGeometry(outerGap);
  const firstVertical = line.route.slice(1).map((point, index) => ({ first: line.route[index], second: point }))
    .find((segment) => segment.first.x === segment.second.x && segment.first.y !== segment.second.y);
  assert.ok(firstVertical.first.x >= outerGeometry.x && firstVertical.first.x <= outerGeometry.x + outerGeometry.width);
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
  const geometry = regionGeometry(region);
  const center = geometry.x + geometry.width / 2;
  const longitudinal = selfSuspend.route.slice(1)
    .map((point, index) => ({ first: selfSuspend.route[index], second: point }))
    .filter(({ first, second }) => first.x === second.x && first.y !== second.y)
    .find(({ first }) => first.x >= geometry.x && first.x <= geometry.x + geometry.width);
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

test("shared-port corridor branches stay direct and branch inside the authored gap", async () => {
  const entry = path.join(repo, "docs", "diagrams", "routing-corridors.tsx");
  const { scene } = await solveFile(entry);
  const geometry = regionGeometry(scene.regions.get("gap:system:0"));
  for (const line of scene.lines) {
    const routeLength = line.route.slice(1).reduce((sum, point, index) =>
      sum + Math.abs(point.x - line.route[index].x) + Math.abs(point.y - line.route[index].y), 0);
    const directLength = Math.abs(line.route[0].x - line.route.at(-1).x)
      + Math.abs(line.route[0].y - line.route.at(-1).y);
    assert.ok(Math.abs(routeLength - directLength) < 0.001, `${line.id} takes a non-monotone corridor detour`);
  }
  const requestLines = scene.lines.filter((line) => line.id.startsWith("request-"));
  const requestTracks = requestLines.map((line) => line.regionTracks.get("gap:system:0"));
  assert.equal(new Set(requestTracks.map((track) => track.trackKey)).size, 1,
    "one named request corridor was allocated as multiple physical tracks");
  const requestTrackCoordinate = requestTracks[0].allocation.coordinate;
  const requestHorizontals = requestLines.flatMap((line) => line.route.slice(1)
    .map((second, index) => ({ first: line.route[index], second }))
    .filter(({ first, second }) => first.y === second.y && first.x !== second.x));
  assert.ok(requestHorizontals.length >= 2);
  assert.ok(requestHorizontals.every(({ first }) => first.y === requestTrackCoordinate),
    "branches of one named request corridor use different horizontal track heights");
  const requestClusterB = scene.lines.find((line) => line.id === "request-cluster-b");
  const horizontal = requestClusterB.route.slice(1)
    .map((second, index) => ({ first: requestClusterB.route[index], second }))
    .filter(({ first, second }) => first.y === second.y && first.x !== second.x);
  assert.equal(requestClusterB.regionTracks.get("gap:system:0").crossing, false,
    "shared corridor member was reduced to a padding-to-padding crossing");
  assert.ok(horizontal.every(({ first }) => first.y >= geometry.y && first.y <= geometry.y + geometry.height),
    "request-cluster-b branches before entering its authored corridor");
});

test("a late named-port merge keeps one shared trunk until its corridor branches", async () => {
  const entry = path.join(repo, "examples", "vegvisir-voice-agents", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const members = scene.lines.filter((line) => line.from?.port?.id === "tools");
  assert.equal(members.length, 3);
  const group = members[0].shareMemberships[0].group;
  const padding = scene.regions.get("padding:system/user-owned:left");
  const geometry = regionGeometry(padding);
  const tracks = members.map((line) => line.regionTracks.get(padding.key));
  assert.equal(new Set(tracks.map((track) => track.trackKey)).size, 1,
    "the first common authored region split a terminal merge into separate tracks");
  const terminalHorizontals = members.map((line) => line.route.slice(1)
    .map((second, index) => ({ first: line.route[index], second }))
    .find(({ first, second }) => first.y === second.y
      && first.x !== second.x
      && Math.abs(first.y - members[0].from.point.y) <= 24));
  assert.ok(terminalHorizontals.every(Boolean));
  assert.equal(new Set(terminalHorizontals.map(({ first, second }) =>
    `${Math.min(first.x, second.x)}:${Math.max(first.x, second.x)}:${first.y}`)).size, 1,
  "compatible late-merge members use parallel terminal approaches instead of one shared horizontal run");
  const runs = members.map((line) => line.route.slice(1)
    .map((second, index) => ({ first: line.route[index], second }))
    .find(({ first, second }) => first.x === second.x
      && first.y !== second.y
      && first.x >= geometry.x
      && first.x <= geometry.x + geometry.width));
  assert.ok(runs.every(Boolean));
  assert.equal(new Set(runs.map((run) => run.first.x)).size, 1);
  const commonStart = Math.max(...runs.map((run) => Math.min(run.first.y, run.second.y)));
  const commonEnd = Math.min(...runs.map((run) => Math.max(run.first.y, run.second.y)));
  assert.ok(commonEnd - commonStart > 24, "late merge lacks a positive-length shared longitudinal trunk");
  assert.ok(group.allowedSharedRuns.some((run) => run.members.length === 3
    && Math.abs(run.first.x - run.second.x) + Math.abs(run.first.y - run.second.y) > 24),
  "tools fan-out branches before establishing a positive-length shared corridor trunk");
  assert.ok(group.allowedSharedRuns.some((run) => run.members.length === 3
    && run.first.y === run.second.y
    && Math.abs(run.first.x - run.second.x) > 24),
  "tools fan-out does not authorize its common horizontal terminal run");
});

test("longitudinal corridor tracks form a centered geometry-ordered bundle", async () => {
  const entry = path.join(repo, "examples", "coverage", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const region = scene.regions.get("gap:system:1");
  const entries = region.entries
    .map((entry) => ({ entry, track: entry.line.regionTracks.get(region.key) }))
    .filter(({ track }) => !track.crossing)
    .sort((first, second) => first.track.index - second.track.index);
  assert.deepEqual(entries.map(({ entry }) => entry.line.id), ["audit-upright", "audit-rotated"]);
  const projected = entries.map(({ entry }) => (entry.line.from.point.x + entry.line.to.point.x) / 2);
  assert.deepEqual(projected, [...projected].sort((first, second) => first - second));
  const geometry = regionGeometry(region);
  const coordinates = entries.map(({ track }) => track.allocation.coordinate);
  assert.equal((coordinates[0] + coordinates.at(-1)) / 2, geometry.x + geometry.width / 2);
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

test("an authored gap label keeps its region, longitudinal run, and 7px adjacency", async () => {
  const entry = path.join(repo, "examples", "agent-substrate", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const line = scene.lines.find((candidate) => candidate.id === "self-suspend");
  const label = line.routeLabels.find((candidate) => candidate.text.startsWith("api.ate-system"));
  const gap = scene.regions.get("gap:cluster/layers:1");
  const geometry = regionGeometry(gap);
  const routeSegments = line.route.slice(1)
    .map((point, index) => ({ index, first: line.route[index], second: point }));
  const authoredRuns = routeSegments.filter(({ first, second }) =>
    first.x === second.x
    && first.y !== second.y
    && first.x >= geometry.x
    && first.x <= geometry.x + geometry.width
    && Math.max(first.y, second.y) >= geometry.y
    && Math.min(first.y, second.y) <= geometry.y + geometry.height);
  assert.equal(label.authoredRegion, gap);
  assert.equal(authoredRuns.length, 1);
  assert.equal(label.authoredRun, authoredRuns[0].index);
  const segment = authoredRuns[0];
  const distance = segment.first.x === segment.second.x
    ? Math.min(Math.abs(label.box.x - segment.first.x), Math.abs(label.box.x + label.box.width - segment.first.x))
    : Math.min(Math.abs(label.box.y - segment.first.y), Math.abs(label.box.y + label.box.height - segment.first.y));
  assert.equal(label.authoredAxis, true);
  assert.equal(distance, 7);
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

test("an automatic named port merges compatible lines and bundles an incompatible style", async () => {
  const entry = path.join(repo, "examples", "machine-thought-os", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const scheduler = scene.objectByPath.get("kernel/execution/scheduler");
  const port = scheduler.ports.get("children");
  const lines = scene.lines.filter((line) => line.from?.port === port);
  assert.equal(lines.length, 3);
  const [first, second, independent] = lines;
  const firstMembership = first.shareMemberships.find((membership) => membership.group.source.port === port);
  const secondMembership = second.shareMemberships.find((membership) => membership.group.source.port === port);
  const independentMembership = independent.shareMemberships.find((membership) => membership.group.source.port === port);
  assert.equal(firstMembership.lane, secondMembership.lane);
  assert.notEqual(firstMembership.lane, independentMembership.lane);
  assert.ok(firstMembership.group.allowedSharedRuns.length > 0);
  assert.notDeepEqual(first.route[0], first.route[1]);
  assert.notDeepEqual(independent.route[0], first.route[0]);
});

test("a named bundle port allocates distinct physical slots under one canonical port", async () => {
  const entry = path.join(repo, "examples", "machine-thought-os", "diagram.tsx");
  const { scene } = await solveFile(entry);
  const state = scene.objectByPath.get("kernel/execution/shared-state");
  const port = state.ports.get("children");
  const lines = scene.lines.filter((line) => line.from?.port === port);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((line) => line.from.port === port));
  assert.equal(new Set(lines.map((line) => `${line.route[0].x},${line.route[0].y}`)).size, 3);
  assert.equal(port.terminalSlots.length, 3);
});

test("named-port sharing preserves terminal order without rectangular route excursions", async () => {
  const entry = path.join(repo, "docs", "diagrams", "port-sharing.tsx");
  const { scene } = await solveFile(entry);
  const byScope = (scope) => scene.lines.filter((line) => line.scope.path === `modes/${scope}`)
    .sort((first, second) => first.from.point.y - second.from.point.y);
  const assertMonotone = (line) => {
    for (const axis of ["x", "y"]) {
      const start = line.route[0][axis];
      const end = line.route.at(-1)[axis];
      const direction = Math.sign(end - start);
      for (let index = 1; index < line.route.length; index += 1) {
        const step = line.route[index][axis] - line.route[index - 1][axis];
        assert.ok(!direction || Math.sign(step) === 0 || Math.sign(step) === direction,
          `${line.scope.path}/${line.id} reverses on ${axis}`);
      }
    }
  };

  for (const line of scene.lines) assertMonotone(line);
  const merge = byScope("merge");
  assert.equal(new Set(merge.map((line) => `${line.to.point.x},${line.to.point.y}`)).size, 1);

  const bundle = byScope("bundle");
  const styleCohorts = byScope("style-cohorts");
  const separate = byScope("separate");
  const verticalApproach = (line) => line.route.slice(1).map((point, index) => [line.route[index], point])
    .find(([first, second]) => first.x === second.x && first.y !== second.y)?.[0].x;
  assert.equal(verticalApproach(merge[0]), verticalApproach(merge[2]));
  assert.equal(verticalApproach(bundle[0]), verticalApproach(bundle[2]));
  assert.equal(Math.abs(verticalApproach(styleCohorts[0]) - verticalApproach(styleCohorts[2])), 12);
  assert.deepEqual(bundle.map((line) => line.to.point.y), [...bundle.map((line) => line.to.point.y)].sort((a, b) => a - b));
  assert.deepEqual(separate.map((line) => line.to.point.y), [...separate.map((line) => line.to.point.y)].sort((a, b) => a - b));
  assert.equal(new Set(bundle.map((line) => line.to.point.y)).size, 3);
  assert.equal(new Set(separate.map((line) => line.to.point.y)).size, 3);
  assert.ok(separate[1].to.point.y - separate[0].to.point.y > bundle[1].to.point.y - bundle[0].to.point.y);
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
