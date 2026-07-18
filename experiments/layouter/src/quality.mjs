import { effectiveLayout, lineLabelDemand } from "./layout.mjs";
import { boundaryLabelStrips } from "./mesh.mjs";
import { containerBorderRings, labelMayCrossContainerBorder } from "./route.mjs";
import { buildShareGroups, segmentsMayShareGeometry } from "./sharing.mjs";

const CELL = 160;

function boxesOverlap(first, second, padding = 0) {
  return first.x < second.x + second.width + padding
    && first.x + first.width + padding > second.x
    && first.y < second.y + second.height + padding
    && first.y + first.height + padding > second.y;
}

function segmentHitsBox(first, second, box) {
  const inset = 0;
  const left = box.x + inset;
  const right = box.x + box.width - inset;
  const top = box.y + inset;
  const bottom = box.y + box.height - inset;
  if (first.x === second.x) {
    return first.x > left && first.x < right
      && Math.max(first.y, second.y) > top
      && Math.min(first.y, second.y) < bottom;
  }
  if (first.y === second.y) {
    return first.y > top && first.y < bottom
      && Math.max(first.x, second.x) > left
      && Math.min(first.x, second.x) < right;
  }
  return false;
}

class BoxIndex {
  constructor(items = []) {
    this.cells = new Map();
    for (const item of items) this.insert(item);
  }

  keys(box) {
    const keys = [];
    const left = Math.floor(box.x / CELL);
    const right = Math.floor((box.x + box.width) / CELL);
    const top = Math.floor(box.y / CELL);
    const bottom = Math.floor((box.y + box.height) / CELL);
    for (let x = left; x <= right; x += 1) {
      for (let y = top; y <= bottom; y += 1) keys.push(`${x},${y}`);
    }
    return keys;
  }

  insert(item) {
    for (const key of this.keys(item.box)) {
      if (!this.cells.has(key)) this.cells.set(key, []);
      this.cells.get(key).push(item);
    }
  }

  query(box) {
    const result = new Set();
    for (const key of this.keys(box)) {
      for (const item of this.cells.get(key) ?? []) result.add(item);
    }
    return result;
  }
}

function segmentBox(first, second) {
  return {
    x: Math.min(first.x, second.x) - 2,
    y: Math.min(first.y, second.y) - 2,
    width: Math.abs(first.x - second.x) + 4,
    height: Math.abs(first.y - second.y) + 4,
  };
}

function obstacleObjects(scene) {
  return scene.objects.filter((object) => object.visible
    && object.children.length === 0
    && !object.frame
    && !object.roles.includes("uml-occurrence")
    && !object.roles.includes("uml-lifeline-end")
    && !["title", "subtitle", "legend-item"].includes(object.kind));
}

function routeObjectIntersections(scene, objects) {
  const index = new BoxIndex(objects);
  const result = [];
  for (const line of scene.lines) {
    if (line.space === "overlay") continue;
    const ignored = new Set([
      line.from?.object,
      line.to?.object,
      line.from?.routingTarget,
      line.to?.routingTarget,
      ...line.segments.map((segment) => segment.waypoint).filter(Boolean),
    ]);
    for (let segmentIndex = 1; segmentIndex < line.route.length; segmentIndex += 1) {
      const first = line.route[segmentIndex - 1];
      const second = line.route[segmentIndex];
      for (const object of index.query(segmentBox(first, second))) {
        if (!ignored.has(object) && segmentHitsBox(first, second, object.box)) {
          result.push({ line, object, segmentIndex: segmentIndex - 1 });
        }
      }
    }
  }
  return result;
}

function objectOverlapAllowed(first, second) {
  const activation = (object) => object.roles.includes("uml-activation");
  const occurrence = (object) => object.roles.includes("uml-occurrence") || object.roles.includes("uml-lifeline-end");
  return activation(first) && occurrence(second) || activation(second) && occurrence(first);
}

function unexpectedObjectOverlaps(objects) {
  const index = new BoxIndex();
  const result = [];
  for (const object of objects) {
    for (const previous of index.query(object.box)) {
      if (boxesOverlap(object.box, previous.box) && !objectOverlapAllowed(object, previous)) {
        result.push({ first: previous, second: object });
      }
    }
    index.insert(object);
  }
  return result;
}

function labelObjectOverlaps(scene, objects) {
  const index = new BoxIndex(objects);
  const result = [];
  for (const line of scene.lines) {
    for (const label of line.routeLabels) {
      for (const object of index.query(label.box)) {
        if (boxesOverlap(label.box, object.box, 2)) result.push({ line, label, object });
      }
    }
  }
  return result;
}

function labelLabelOverlaps(scene) {
  const index = new BoxIndex();
  const result = [];
  for (const line of scene.lines) {
    for (const label of line.routeLabels) {
      for (const previous of index.query(label.box)) {
        if (boxesOverlap(label.box, previous.label.box, 4)) result.push({ line, label, otherLine: previous.line, otherLabel: previous.label });
      }
      index.insert({ box: label.box, line, label });
    }
  }
  return result;
}

function segmentInteraction(first, second) {
  const firstHorizontal = first.first.y === first.second.y;
  const secondHorizontal = second.first.y === second.second.y;
  if (firstHorizontal === secondHorizontal) {
    const sameAxis = firstHorizontal ? first.first.y === second.first.y : first.first.x === second.first.x;
    if (!sameAxis) return null;
    const firstStart = firstHorizontal ? Math.min(first.first.x, first.second.x) : Math.min(first.first.y, first.second.y);
    const firstEnd = firstHorizontal ? Math.max(first.first.x, first.second.x) : Math.max(first.first.y, first.second.y);
    const secondStart = firstHorizontal ? Math.min(second.first.x, second.second.x) : Math.min(second.first.y, second.second.y);
    const secondEnd = firstHorizontal ? Math.max(second.first.x, second.second.x) : Math.max(second.first.y, second.second.y);
    const length = Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart);
    return length > 2 ? { kind: "overlap", length } : null;
  }
  const horizontal = firstHorizontal ? first : second;
  const vertical = firstHorizontal ? second : first;
  const x = vertical.first.x;
  const y = horizontal.first.y;
  const insideHorizontal = x > Math.min(horizontal.first.x, horizontal.second.x)
    && x < Math.max(horizontal.first.x, horizontal.second.x);
  const insideVertical = y > Math.min(vertical.first.y, vertical.second.y)
    && y < Math.max(vertical.first.y, vertical.second.y);
  return insideHorizontal && insideVertical ? { kind: "crossing", x, y } : null;
}

function routeRouteInteractions(scene) {
  const index = new BoxIndex();
  const crossings = [];
  const unexpectedOverlaps = [];
  for (const line of scene.lines) {
    for (let segmentIndex = 1; segmentIndex < line.route.length; segmentIndex += 1) {
      const segment = {
        line,
        segmentIndex: segmentIndex - 1,
        first: line.route[segmentIndex - 1],
        second: line.route[segmentIndex],
      };
      segment.box = segmentBox(segment.first, segment.second);
      for (const previous of index.query(segment.box)) {
        if (previous.line === line) continue;
        const interaction = segmentInteraction(segment, previous);
        if (interaction?.kind === "crossing") crossings.push({ ...interaction, first: previous, second: segment });
        if (interaction?.kind === "overlap"
          && !segmentsMayShareGeometry(previous.line, line, previous, segment)) {
          unexpectedOverlaps.push({ ...interaction, first: previous, second: segment });
        }
      }
      index.insert(segment);
    }
  }
  return { crossings, unexpectedOverlaps };
}

function clusterCount(values, tolerance = 2.5) {
  const sorted = [...values].sort((first, second) => first - second);
  let count = 0;
  let previous = Number.NEGATIVE_INFINITY;
  for (const value of sorted) {
    if (value - previous > tolerance) count += 1;
    previous = value;
  }
  return count;
}

function coefficientOfVariation(values) {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) return null;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function pointSegmentDistance(point, first, second) {
  const dx = second.x - first.x;
  const dy = second.y - first.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((point.x - first.x) * dx + (point.y - first.y) * dy) / lengthSquared)) : 0;
  return Math.hypot(point.x - (first.x + t * dx), point.y - (first.y + t * dy));
}

function flowMembers(object) {
  return object.children.filter((child) => !child.anchor && !child.frame);
}

const LAYOUT_TOLERANCE = 0.75;

function primaryVector(layout, orientation = 0) {
  const turns = (((orientation % 360) + 360) % 360) / 90;
  const rowVectors = [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }];
  const columnVectors = [{ x: 0, y: 1 }, { x: -1, y: 0 }, { x: 0, y: -1 }, { x: 1, y: 0 }];
  return (layout === "row" ? rowVectors : columnVectors)[turns] ?? null;
}

function projectedInterval(box, vector) {
  const values = [
    box.x * vector.x + box.y * vector.y,
    (box.x + box.width) * vector.x + box.y * vector.y,
    box.x * vector.x + (box.y + box.height) * vector.y,
    (box.x + box.width) * vector.x + (box.y + box.height) * vector.y,
  ];
  return { start: Math.min(...values), end: Math.max(...values) };
}

function childInsideParent(child, parent, tolerance = LAYOUT_TOLERANCE) {
  return child.box.x >= parent.box.x - tolerance
    && child.box.y >= parent.box.y - tolerance
    && child.box.x + child.box.width <= parent.box.x + parent.box.width + tolerance
    && child.box.y + child.box.height <= parent.box.y + parent.box.height + tolerance;
}

function constraintManagedObjects(scene) {
  const managed = new Set();
  for (const constraint of scene.constraints ?? []) {
    if (constraint.itemObject) managed.add(constraint.itemObject);
    if (constraint.containerObject) managed.add(constraint.containerObject);
    for (const object of constraint.memberObjects ?? []) managed.add(object);
  }
  return managed;
}

function valuesEqual(values, tolerance = LAYOUT_TOLERANCE) {
  if (values.length < 2) return true;
  return Math.max(...values) - Math.min(...values) <= tolerance;
}

function distributionViolations(container, intervals, actualGaps, minimumGaps, vector) {
  const distribution = container.distribute ?? "start";
  if (distribution === "start" || intervals.length < 2) return [];
  const residuals = actualGaps.map((gap, index) => gap - (minimumGaps[index] ?? 0));
  const violations = [];
  if ((distribution === "space-between" || distribution === "space-around") && !valuesEqual(residuals)) {
    violations.push({
      container,
      kind: "distribution",
      distribution,
      expected: "equal-residual-gaps",
      actual: residuals,
    });
  }

  const parent = projectedInterval(container.box, vector);
  const padding = container.paddingBox ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const row = effectiveLayout(container) === "row";
  const startPadding = row ? padding.left : padding.top + (container.contentHeight ?? 0);
  const endPadding = row ? padding.right : padding.bottom;
  const leading = intervals[0].start - (parent.start + startPadding);
  const trailing = parent.end - endPadding - intervals.at(-1).end;
  const residual = residuals.length ? residuals.reduce((sum, value) => sum + value, 0) / residuals.length : 0;
  const balanced = (first, second) => Math.abs(first - second) <= LAYOUT_TOLERANCE;

  if (distribution === "space-around" && (!balanced(leading, trailing) || !balanced(leading * 2, residual))) {
    violations.push({
      container,
      kind: "distribution",
      distribution,
      expected: "half-residual-outer-slack",
      actual: { leading, trailing, residual },
    });
  } else if (distribution === "center" && (!balanced(leading, trailing) || residuals.some((value) => Math.abs(value) > LAYOUT_TOLERANCE))) {
    violations.push({
      container,
      kind: "distribution",
      distribution,
      expected: "balanced-outer-slack",
      actual: { leading, trailing, residuals },
    });
  } else if (distribution === "end" && (Math.abs(trailing) > LAYOUT_TOLERANCE || residuals.some((value) => Math.abs(value) > LAYOUT_TOLERANCE))) {
    violations.push({
      container,
      kind: "distribution",
      distribution,
      expected: "trailing-edge",
      actual: { leading, trailing, residuals },
    });
  }
  return violations;
}

// Layout contracts are checked independently from the solver that produced
// the boxes. This catches a later soft pass silently undoing source order,
// containment, reserved minimum gaps, or an explicit distribution mode.
export function layoutContractViolations(scene) {
  const violations = [];
  const managed = constraintManagedObjects(scene);
  for (const container of scene.objects) {
    const layout = effectiveLayout(container);
    const members = flowMembers(container);
    if (!layout || !members.length) continue;

    for (const member of members) {
      const temporal = member.roles.includes("uml-occurrence") || member.roles.includes("uml-lifeline-end");
      if (!managed.has(member) && !temporal && !childInsideParent(member, container)) {
        violations.push({ container, member, kind: "containment" });
      }
    }

    if (layout === "grid" && container.layoutData) {
      const { columns, columnGaps = [], rowGaps = [] } = container.layoutData;
      const columnVector = primaryVector("row");
      const rowVector = primaryVector("column");
      for (let index = 0; index < members.length; index += 1) {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const right = members[index + 1];
        if (right && column + 1 < columns && !managed.has(members[index]) && !managed.has(right)) {
          const firstInterval = projectedInterval(members[index].box, columnVector);
          const secondInterval = projectedInterval(right.box, columnVector);
          const gap = secondInterval.start - firstInterval.end;
          if (gap < -LAYOUT_TOLERANCE) violations.push({ container, first: members[index], second: right, kind: "source-order", actual: gap });
          if (gap + LAYOUT_TOLERANCE < (columnGaps[column] ?? 0)) {
            violations.push({ container, first: members[index], second: right, kind: "minimum-gap", expected: columnGaps[column] ?? 0, actual: gap });
          }
        }
        const below = members[index + columns];
        if (below && !managed.has(members[index]) && !managed.has(below)) {
          const firstInterval = projectedInterval(members[index].box, rowVector);
          const secondInterval = projectedInterval(below.box, rowVector);
          const gap = secondInterval.start - firstInterval.end;
          if (gap < -LAYOUT_TOLERANCE) violations.push({ container, first: members[index], second: below, kind: "source-order", actual: gap });
          if (gap + LAYOUT_TOLERANCE < (rowGaps[row] ?? 0)) {
            violations.push({ container, first: members[index], second: below, kind: "minimum-gap", expected: rowGaps[row] ?? 0, actual: gap });
          }
        }
      }
      continue;
    }

    if (layout !== "row" && layout !== "column") continue;
    const vector = primaryVector(layout);
    if (!vector) continue;
    const intervals = members.map((member) => projectedInterval(member.box, vector));
    const minimumGaps = container.gapSizes ?? [];
    const actualGaps = [];
    for (let index = 1; index < members.length; index += 1) {
      const first = members[index - 1];
      const second = members[index];
      const gap = intervals[index].start - intervals[index - 1].end;
      actualGaps.push(gap);
      if (managed.has(first) || managed.has(second)) continue;
      if (gap < -LAYOUT_TOLERANCE) violations.push({ container, first, second, kind: "source-order", actual: gap });
      if (gap + LAYOUT_TOLERANCE < (minimumGaps[index - 1] ?? 0)) {
        violations.push({ container, first, second, kind: "minimum-gap", expected: minimumGaps[index - 1] ?? 0, actual: gap });
      }
    }
    if (!members.some((member) => managed.has(member))) {
      violations.push(...distributionViolations(container, intervals, actualGaps, minimumGaps, vector));
    }
  }
  return violations;
}

function segmentCrossesLabel(first, second, box) {
  const inset = 1;
  const left = box.x + inset;
  const right = box.x + box.width - inset;
  const top = box.y + inset;
  const bottom = box.y + box.height - inset;
  if (first.x === second.x) {
    return first.x > left && first.x < right
      && Math.max(first.y, second.y) > top && Math.min(first.y, second.y) < bottom;
  }
  if (first.y === second.y) {
    return first.y > top && first.y < bottom
      && Math.max(first.x, second.x) > left && Math.min(first.x, second.x) < right;
  }
  return false;
}

function labelCoversAuthorizedSharedRun(line, segment, box) {
  for (let index = 1; index < line.route.length; index += 1) {
    const own = { first: line.route[index - 1], second: line.route[index] };
    if (segmentCrossesLabel(own.first, own.second, box)
      && segmentsMayShareGeometry(line, segment.line, own, segment)) return true;
  }
  return false;
}

// Labels may cover their own stroke, and explicitly shareable lines may run
// together. Every other route remains readable instead of disappearing under
// another line's opaque label background.
export function labelRouteOverlaps(scene) {
  const index = new BoxIndex();
  for (const line of scene.lines) {
    for (let segmentIndex = 1; segmentIndex < line.route.length; segmentIndex += 1) {
      const first = line.route[segmentIndex - 1];
      const second = line.route[segmentIndex];
      index.insert({ box: segmentBox(first, second), line, segmentIndex: segmentIndex - 1, first, second });
    }
  }

  const overlaps = [];
  for (const line of scene.lines) {
    for (const label of line.routeLabels) {
      for (const segment of index.query(label.box)) {
        if (segment.line === line || !segmentCrossesLabel(segment.first, segment.second, label.box)) continue;
        if (labelCoversAuthorizedSharedRun(line, segment, label.box)) continue;
        overlaps.push({ line, label, otherLine: segment.line, segmentIndex: segment.segmentIndex });
      }
    }
  }
  return overlaps;
}

// Soft drawing-quality measures a human perceives at a glance. They are
// reported alongside the hard conflict gate and guide the aesthetics passes.
export function perceptionMetrics(scene) {
  let bendTotal = 0;
  let maxBends = 0;
  let routeLength = 0;
  let manhattan = 0;
  let backtrack = 0;
  let routedLines = 0;
  for (const line of scene.lines) {
    if (line.route.length < 2) continue;
    routedLines += 1;
    bendTotal += line.route.length - 2;
    maxBends = Math.max(maxBends, line.route.length - 2);
    const start = line.route[0];
    const end = line.route.at(-1);
    const spanX = end.x - start.x;
    const spanY = end.y - start.y;
    manhattan += Math.abs(spanX) + Math.abs(spanY);
    for (let index = 1; index < line.route.length; index += 1) {
      const dx = line.route[index].x - line.route[index - 1].x;
      const dy = line.route[index].y - line.route[index - 1].y;
      const length = Math.abs(dx) + Math.abs(dy);
      routeLength += length;
      if (dx !== 0 && spanX !== 0 && Math.sign(dx) !== Math.sign(spanX)) backtrack += Math.abs(dx);
      if (dy !== 0 && spanY !== 0 && Math.sign(dy) !== Math.sign(spanY)) backtrack += Math.abs(dy);
    }
  }

  const boxes = obstacleObjects(scene).map((object) => object.box);
  const xs = boxes.flatMap((box) => [box.x, box.x + box.width / 2, box.x + box.width]);
  const ys = boxes.flatMap((box) => [box.y, box.y + box.height / 2, box.y + box.height]);

  const peerCVs = [];
  const gapCVs = [];
  for (const container of scene.objects) {
    const members = flowMembers(container).filter((child) => child.visible);
    if (members.length >= 2) {
      const leafPeers = members.filter((child) => child.children.length === 0);
      const widthCV = coefficientOfVariation(leafPeers.map((child) => child.box.width));
      const heightCV = coefficientOfVariation(leafPeers.map((child) => child.box.height));
      if (widthCV != null) peerCVs.push(widthCV);
      if (heightCV != null) peerCVs.push(heightCV);
    }
    if (members.length >= 3) {
      const layout = container.layout?.kind;
      const horizontal = layout === "row";
      if (layout === "row" || layout === "column") {
        const gaps = [];
        for (let index = 1; index < members.length; index += 1) {
          const previous = members[index - 1].box;
          const current = members[index].box;
          gaps.push(horizontal ? current.x - (previous.x + previous.width) : current.y - (previous.y + previous.height));
        }
        const gapCV = coefficientOfVariation(gaps.filter((value) => value >= 0));
        if (gapCV != null) gapCVs.push(gapCV);
      }
    }
  }

  const displacements = [];
  for (const line of scene.lines) {
    for (const label of line.routeLabels) {
      let nearest = Number.POSITIVE_INFINITY;
      for (let index = 1; index < line.route.length; index += 1) {
        nearest = Math.min(nearest, pointSegmentDistance({ x: label.x, y: label.y }, line.route[index - 1], line.route[index]));
      }
      if (Number.isFinite(nearest)) displacements.push(nearest);
    }
  }

  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return {
    routedLines,
    bendTotal,
    bendsPerLine: routedLines ? bendTotal / routedLines : 0,
    maxBends,
    detourFactor: manhattan > 0 ? routeLength / manhattan : 1,
    backtrackRatio: routeLength > 0 ? backtrack / routeLength : 0,
    guidesX: clusterCount(xs),
    guidesY: clusterCount(ys),
    boxCount: boxes.length,
    peerSizeCV: average(peerCVs),
    gapCV: average(gapCVs),
    labelDisplacement: average(displacements),
  };
}

// Labels that provably found no free spot escalate their line's corridor
// reservation; the pipeline re-solves with the wider corridor. Bumps are
// incremental (overlap depth, capped at the full label demand) so corridors
// end as narrow as the labels allow. Returns true when a reservation grew.
export function escalateLabelReservations(scene, reservations) {
  const quality = analyzeScene(scene);
  const proposals = new Map();
  const raise = (key, value) => {
    if (!key) return;
    proposals.set(key, Math.max(proposals.get(key) ?? 0, value));
  };
  const raiseAdjacentGap = (box, owner) => {
    const parent = owner?.parent;
    const layout = parent ? effectiveLayout(parent) : null;
    if (!owner || (layout !== "row" && layout !== "column")) return false;
    const extent = layout === "column" ? "height" : "width";
    const need = box[extent] + 16;
    for (const index of [owner.layoutIndex - 1, owner.layoutIndex]) {
      if (index < 0 || index >= flowMembers(parent).length - 1) continue;
      const key = `gap:${parent.path || "$root"}:${index}`;
      raise(key, Math.max(need, (reservations.get(key) ?? 0) + 16));
    }
    return true;
  };

  // A center-placed label prefers the run along its authored region. If a
  // collision-free fallback on an entry/exit run won instead, apply pressure
  // to the concrete adjacent pocket that blocked the preferred solved box.
  const rings = containerBorderRings(scene);
  for (const line of scene.lines) {
    for (const label of line.routeLabels) {
      const rejected = label.rejectedAuthoredCandidate;
      if (!rejected) continue;
      const owners = new Set(rings.filter((ring) => boxesOverlap(rejected, ring.box, 2)).map((ring) => ring.owner));
      let localized = false;
      for (const owner of owners) localized = raiseAdjacentGap(rejected, owner) || localized;
      if (localized) continue;
      const target = label.authoredSegment?.labelReservation ?? line.labelReservation;
      if (!target) continue;
      const current = reservations.get(target.key) ?? 0;
      const cap = lineLabelDemand(line, target.axis, label.text);
      raise(target.key, Math.min(cap, current + 32));
    }
  }

  // A collision-free fallback is still a failed placement when an authored
  // segment label could not stay at its declared region. Treat that rejected
  // preferred candidate as pressure on the same reserving corridor.
  for (const line of scene.lines) {
    for (const label of line.routeLabels) {
      const target = label.authoredSegment?.labelReservation ?? line.labelReservation;
      if (!label.authoredSegment || label.authoredRegion || !target) continue;
      const current = reservations.get(target.key) ?? 0;
      const cap = lineLabelDemand(line, target.axis, label.text);
      raise(target.key, Math.min(cap, current + 32));
    }
  }
  for (const item of [...quality.labelObjectOverlaps, ...quality.labelDecorOverlaps, ...quality.labelLabelOverlaps]) {
    // a label pressed against container decor is squeezed in a pocket next
    // to that container — widening the adjacent sibling gaps is the targeted
    // fix, so it replaces the corridor bump for these offenders
    const owner = item.object?.owner;
    if (raiseAdjacentGap(item.label.box, owner)) continue;
    const target = item.label.authoredSegment?.labelReservation ?? item.line.labelReservation;
    if (!target) continue;
    const current = reservations.get(target.key) ?? 0;
    const cap = lineLabelDemand(item.line, target.axis, item.label.text);
    const other = item.object?.box ?? item.otherLabel.box;
    const overlap = target.axis === "horizontal"
      ? Math.min(item.label.box.x + item.label.box.width, other.x + other.width) - Math.max(item.label.box.x, other.x)
      : Math.min(item.label.box.y + item.label.box.height, other.y + other.height) - Math.max(item.label.box.y, other.y);
    // thin decor rings understate the shortfall, so steps have a floor
    raise(target.key, Math.min(cap, current + Math.max(32, overlap + 8)));
  }
  let changed = false;
  for (const [key, value] of proposals) {
    if (value <= (reservations.get(key) ?? 0) + 0.5) continue;
    reservations.set(key, value);
    changed = true;
  }
  return changed;
}

export function analyzeScene(scene) {
  buildShareGroups(scene);
  const objects = obstacleObjects(scene);
  const routeInteractions = routeRouteInteractions(scene);
  const titleStrips = boundaryLabelStrips(scene);
  const documentText = scene.objects.filter((object) => ["title", "subtitle", "legend-item"].includes(object.kind));
  return {
    layoutContractViolations: layoutContractViolations(scene),
    unexpectedObjectOverlaps: unexpectedObjectOverlaps(objects),
    routeObjectIntersections: routeObjectIntersections(scene, objects),
    labelObjectOverlaps: labelObjectOverlaps(scene, objects),
    labelLabelOverlaps: labelLabelOverlaps(scene),
    labelRouteOverlaps: labelRouteOverlaps(scene),
    routeCrossings: routeInteractions.crossings,
    unexpectedRouteOverlaps: routeInteractions.unexpectedOverlaps,
    // decor readability: runs parallel to a container title's text line,
    // and labels on titles or border strokes; perpendicular crossings of a
    // title strip are tolerated
    routeTitleCrossings: routeObjectIntersections(scene, titleStrips).filter((hit) =>
      hit.line.route[hit.segmentIndex].y === hit.line.route[hit.segmentIndex + 1].y),
    labelDecorOverlaps: labelObjectOverlaps(scene, [...documentText, ...titleStrips, ...containerBorderRings(scene)])
      .filter((item) => !labelMayCrossContainerBorder(item.label, item.object)),
  };
}
