import { headGeometry, minimumHeadRun, normalizedHeads } from "./heads.mjs";
import { buildChannelMesh, regionGeometry } from "./mesh.mjs";
import { rotateSide } from "./orientation.mjs";
import {
  authorizeSharedGeometry,
  buildShareGroups,
  segmentsMayShareGeometry,
} from "./sharing.mjs";

const CELL = 160;
const ROUTE_CLEARANCE = 12;
const CROSSING_PENALTY = 180;
const CROSSING_REFINEMENT_PENALTY = 600;
const SIDE_VECTOR = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

function center(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function chooseSide(box, remote) {
  const own = center(box);
  const dx = remote.x - own.x;
  const dy = remote.y - own.y;
  return Math.abs(dx) >= Math.abs(dy) ? dx >= 0 ? "right" : "left" : dy >= 0 ? "bottom" : "top";
}

function pointOnSide(box, side, fraction = 0.5) {
  if (side === "top") return { x: box.x + box.width * fraction, y: box.y };
  if (side === "right") return { x: box.x + box.width, y: box.y + box.height * fraction };
  if (side === "bottom") return { x: box.x + box.width * fraction, y: box.y + box.height };
  return { x: box.x, y: box.y + box.height * fraction };
}

function portTarget(endpoint) {
  return endpoint.routingTarget ?? endpoint.port?.anchor ?? endpoint.object;
}

function pointRoutingTarget(object, path, x, y) {
  return {
    path,
    box: { x, y, width: 0, height: 0 },
    physicalOrientation: object.physicalOrientation ?? 0,
  };
}

function bindTemporalRoutingTargets(scene) {
  const activations = scene.objects.filter((object) => object.roles.includes("uml-activation"));
  for (const line of scene.lines) {
    if (!line.roles.includes("uml-message") && !line.roles.includes("uml-reply")) continue;
    for (const endpoint of [line.from, line.to]) {
      const occurrence = endpoint?.object;
      if (!occurrence?.roles.includes("uml-occurrence")) continue;
      const center = {
        x: occurrence.box.x + occurrence.box.width / 2,
        y: occurrence.box.y + occurrence.box.height / 2,
      };
      endpoint.routingTarget = activations.find((activation) => activation.parent === occurrence.parent
        && center.x >= activation.box.x && center.x <= activation.box.x + activation.box.width
        && center.y >= activation.box.y && center.y <= activation.box.y + activation.box.height)
        ?? pointRoutingTarget(
          occurrence,
          `${occurrence.path}:lifeline`,
          occurrence.parent.box.x + occurrence.parent.box.width / 2,
          center.y,
        );
    }
  }
}

function bindActorRoutingTargets(scene) {
  for (const line of scene.lines) {
    for (const endpoint of [line.from, line.to]) {
      const actor = endpoint?.object;
      if (!actor?.roles.includes("uml-actor")) continue;
      actor.routingTarget ??= {
        path: `${actor.path}:figure`,
        box: {
          x: actor.box.x + actor.box.width / 2 - 17,
          y: actor.box.y + 8,
          width: 34,
          height: 61,
        },
        physicalOrientation: actor.physicalOrientation ?? 0,
      };
      endpoint.routingTarget = actor.routingTarget;
    }
  }
}

function remoteCenter(line, endpoint) {
  return center((endpoint === line.from ? portTarget(line.to) : portTarget(line.from)).box);
}

function paddingSideHint(line, endpoint) {
  const target = portTarget(endpoint);
  const segments = endpoint === line.from ? line.segments : [...line.segments].reverse();
  for (const segment of segments) {
    const container = segment.region?.kind === "padding" ? segment.region.container : segment.corridor?.container;
    const side = segment.region?.kind === "padding" ? segment.region.side : segment.corridor?.side;
    if (container && side && (target === container || hasAncestor(target, container))) return rotateSide(side, container.physicalOrientation ?? 0);
  }
  return null;
}

function desiredEndpointSide(line, endpoint, target) {
  return paddingSideHint(line, endpoint) ?? chooseSide(target.box, remoteCenter(line, endpoint));
}

function dockAxis(side) {
  return side === "top" || side === "bottom" ? "x" : "y";
}

function dockLaneVector(side) {
  return side === "top" || side === "bottom" ? { x: 1, y: 0 } : { x: 0, y: 1 };
}

function dockEntryProjection(entry) {
  const axis = dockAxis(entry.kind === "port" ? entry.port.physicalSide : entry.endpoint.physicalSide);
  if (entry.kind === "owned") return remoteCenter(entry.line, entry.endpoint)[axis];
  if (!entry.port.attachments.length) return center(entry.target.box)[axis];
  return entry.port.attachments.reduce((sum, { line, endpoint }) => sum + remoteCenter(line, endpoint)[axis], 0)
    / entry.port.attachments.length;
}

function compareDockEntries(first, second) {
  return first.projection - second.projection
    || first.sourceOrder - second.sourceOrder
    || first.identity.localeCompare(second.identity);
}

// Port groups are adjacency blocks. Geometry orders free/preferred members;
// only an explicit fixed policy is allowed to retain authored member order.
function orderDockEntries(entries) {
  const blocks = new Map();
  for (const entry of entries) {
    entry.projection = dockEntryProjection(entry);
    const group = entry.kind === "port" ? entry.port.group : null;
    const key = group ? group : entry;
    if (!blocks.has(key)) blocks.set(key, { group, entries: [] });
    blocks.get(key).entries.push(entry);
  }
  const orderedBlocks = [...blocks.values()].map((block) => {
    block.entries.sort(block.group?.order === "fixed"
      ? (first, second) => first.sourceOrder - second.sourceOrder || first.identity.localeCompare(second.identity)
      : compareDockEntries);
    block.projection = block.entries.reduce((sum, entry) => sum + entry.projection, 0) / block.entries.length;
    block.sourceOrder = Math.min(...block.entries.map((entry) => entry.sourceOrder));
    block.identity = block.entries.map((entry) => entry.identity).sort().join("\u0000");
    return block;
  });
  orderedBlocks.sort((first, second) => first.projection - second.projection
    || first.sourceOrder - second.sourceOrder
    || first.identity.localeCompare(second.identity));
  return orderedBlocks.flatMap((block) => block.entries);
}

function placePorts(scene) {
  const buckets = new Map();
  for (const object of scene.objects) {
    for (const port of object.ports.values()) port.attachments = [];
  }
  for (const line of scene.lines) {
    for (const endpoint of [line.from, line.to]) if (endpoint?.port) endpoint.port.attachments.push({ line, endpoint });
  }

  for (const object of scene.objects) {
    for (const port of object.ports.values()) {
      const target = port.anchor ?? object;
      const average = port.attachments.length
        ? port.attachments.map(({ line, endpoint }) => remoteCenter(line, endpoint)).reduce((sum, item) => ({ x: sum.x + item.x, y: sum.y + item.y }), { x: 0, y: 0 })
        : center(target.box);
      if (port.attachments.length) {
        average.x /= port.attachments.length;
        average.y /= port.attachments.length;
      }
      const hintedSides = port.attachments.map(({ line, endpoint }) => paddingSideHint(line, endpoint)).filter(Boolean);
      const desiredSide = hintedSides[0] ?? chooseSide(target.box, average);
      const localSide = port.allowedSides.includes(desiredSide) ? desiredSide : port.allowedSides[0];
      port.physicalSide = rotateSide(localSide, target.physicalOrientation ?? object.physicalOrientation ?? 0);
      const key = `${target.path}:${port.physicalSide}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({
        kind: "port",
        port,
        target,
        sourceOrder: port.orderIndex,
        identity: `port:${port.owner.path}.${port.id}`,
      });
    }
  }

  for (const line of scene.lines) {
    for (const endpoint of [line.from, line.to]) {
      if (!endpoint || endpoint.port) continue;
      const target = portTarget(endpoint);
      const side = desiredEndpointSide(line, endpoint, target);
      endpoint.physicalSide = side;
      const key = `${target.path}:${side}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({
        kind: "owned",
        endpoint,
        line,
        target,
        sourceOrder: 100000 + line.order,
        identity: `line:${line.id}:${endpoint.end}`,
      });
    }
  }

  for (const entries of buckets.values()) {
    const ordered = orderDockEntries(entries);
    ordered.forEach((entry, index) => {
      const side = entry.kind === "port" ? entry.port.physicalSide : entry.endpoint.physicalSide;
      const fraction = (index + 1) / (ordered.length + 1);
      const point = pointOnSide(entry.target.box, side, fraction);
      if (entry.kind === "port") entry.port.point = point;
      else {
        entry.endpoint.point = point;
        entry.endpoint.escapeDistance = 14 + index * 6;
      }
    });
  }

  for (const line of scene.lines) {
    for (const endpoint of [line.from, line.to]) {
      if (!endpoint) continue;
      endpoint.point = endpoint.port?.point ?? endpoint.point ?? center(endpoint.object.box);
      endpoint.physicalSide = endpoint.port?.physicalSide ?? endpoint.physicalSide;
    }
  }
}

function terminalHeadWidth(member) {
  if (!member.endpoint) return 0;
  const endIndex = member.endpoint === member.line.from ? 0 : 1;
  return headGeometry(normalizedHeads(member.line.heads)[endIndex]).width;
}

function terminalLaneGap(first, second, minimum) {
  const headGap = (terminalHeadWidth(first) + terminalHeadWidth(second)) / 2;
  const strokeGap = ((first.line.style?.strokeWidth ?? 2) + (second.line.style?.strokeWidth ?? 2)) / 2 + 4;
  return Math.max(8, minimum, headGap, strokeGap);
}

function terminalLaneOffsets(lanes, minimum = 0) {
  const positions = [0];
  for (let index = 1; index < lanes.length; index += 1) {
    const first = lanes[index - 1].members.reduce((widest, member) =>
      terminalHeadWidth(member) > terminalHeadWidth(widest) ? member : widest);
    const second = lanes[index].members.reduce((widest, member) =>
      terminalHeadWidth(member) > terminalHeadWidth(widest) ? member : widest);
    positions.push(positions.at(-1) + terminalLaneGap(first, second, minimum));
  }
  const center = (positions[0] + positions.at(-1)) / 2;
  return new Map(lanes.flatMap((lane, index) => lane.members.map((member) => [member, positions[index] - center])));
}

function orderNamedBundleLanes(group) {
  const port = group.source.port;
  const axis = dockAxis(port.physicalSide);
  const projection = (lane) => lane.members.reduce((sum, member) => sum + remoteCenter(member.line, member.endpoint)[axis], 0) / lane.members.length;
  group.bundle.lanes.sort((first, second) => projection(first) - projection(second)
    || first.members[0].line.order - second.members[0].line.order
    || first.id.localeCompare(second.id));
  group.bundle.lanes.forEach((lane, laneIndex) => {
    lane.laneIndex = laneIndex;
    lane.members.sort((first, second) => first.line.order - second.line.order || first.line.id.localeCompare(second.line.id));
    for (const member of lane.members) {
      member.laneIndex = laneIndex;
      member.membership.laneIndex = laneIndex;
      member.membership.laneCount = group.bundle.lanes.length;
    }
  });
  group.members = group.bundle.lanes.flatMap((lane) => lane.members);
  group.bundle.laneOrder = group.members.map((member) => member.line.id);
}

// A canonical named port keeps one semantic identity while bundle and
// separate policies receive collision-free physical approach slots. Bundle
// slots form the tightest possible lane block; separate slots use independent
// spacing because their positive-length paths may never coincide.
function allocateNamedPortTerminals(scene) {
  for (const group of buildShareGroups(scene).values()) {
    if (!["bundle", "separate"].includes(group.mode)) continue;
    if (group.mode === "bundle" && group.source.kind === "port") orderNamedBundleLanes(group);
    if (group.mode === "bundle" && group.source.kind !== "port") {
      group.bundle.offsetByMember = terminalLaneOffsets(group.bundle.lanes, 0);
      continue;
    }
    if (group.source.kind !== "port") continue;
    const lanes = group.mode === "bundle" ? group.bundle.lanes : group.members
        .sort((first, second) => {
          const axis = dockAxis(group.source.port.physicalSide);
          return remoteCenter(first.line, first.endpoint)[axis] - remoteCenter(second.line, second.endpoint)[axis]
            || first.line.order - second.line.order
            || first.line.id.localeCompare(second.line.id);
        })
        .map((member, laneIndex) => ({ id: `${group.id}:separate:${laneIndex}`, laneIndex, members: [member] }));
    const minimum = group.mode === "separate"
      ? Math.max(20, group.source.port.minSpacing ?? 0)
      : group.source.port.minSpacing ?? 0;
    const offsetByMember = terminalLaneOffsets(lanes, minimum);
    if (group.mode === "bundle") group.bundle.offsetByMember = offsetByMember;

    const port = group.source.port;
    const target = port.anchor ?? port.owner;
    const side = port.physicalSide;
    const laneVector = dockLaneVector(side);
    port.terminalSlots = [];
    for (const lane of lanes) {
      const offset = offsetByMember.get(lane.members[0]);
      const point = {
        x: port.point.x + laneVector.x * offset,
        y: port.point.y + laneVector.y * offset,
      };
      const slot = { group, port, lane, point, offset };
      port.terminalSlots.push(slot);
      for (const member of lane.members) {
        member.endpoint.point = point;
        member.endpoint.physicalSide = side;
        member.endpoint.terminalSlot = slot;
      }
    }

    const axis = dockAxis(side);
    const start = target.box[axis];
    const extent = target.box[axis === "x" ? "width" : "height"];
    const outside = port.terminalSlots.some((slot) => slot.point[axis] < start || slot.point[axis] > start + extent);
    if (outside) {
      scene.diagnostics.push({
        severity: "error",
        code: "terminal-slot-capacity",
        message: `named port '${port.owner.path}.${port.id}' cannot fit ${port.terminalSlots.length} required terminal slots on its ${side} side`,
      });
    }
  }
}

const OPPOSITE_SIDE = { left: "right", right: "left", top: "bottom", bottom: "top" };

function preservesDockOrder(siblings, current, axis, target, spacing = 12) {
  for (const sibling of siblings) {
    if (sibling === current) continue;
    if (sibling[axis] < current[axis] && target < sibling[axis] + spacing) return false;
    if (sibling[axis] > current[axis] && target > sibling[axis] - spacing) return false;
    if (sibling[axis] === current[axis] && Math.abs(target - sibling[axis]) < spacing) return false;
  }
  return true;
}

// A dock and the box it sits on; endpoint.point and port.point stay the same
// object identity, so mutating the point in place moves every reference.
function dockTarget(endpoint) {
  return endpoint.routingTarget ?? endpoint.port?.anchor ?? endpoint.port?.owner ?? endpoint.object;
}

// Snap the two docks of a line onto one shared coordinate when their sides
// face each other across free space. This is what turns the dominant
// neighbor-to-neighbor connections into straight single-segment lines.
function alignFacingDocks(scene) {
  const docks = new Map();
  const register = (target, side, point) => {
    const key = `${target.path}:${side}`;
    if (!docks.has(key)) docks.set(key, []);
    docks.get(key).push(point);
  };
  for (const object of scene.objects) {
    for (const port of object.ports.values()) {
      if (port.point) register(port.anchor ?? object, port.physicalSide, port.point);
    }
  }
  for (const line of scene.lines) {
    for (const endpoint of [line.from, line.to]) {
      if (endpoint && !endpoint.port && endpoint.point) register(dockTarget(endpoint), endpoint.physicalSide, endpoint.point);
    }
  }

  for (const line of scene.lines) {
    const from = line.from;
    const to = line.to;
    if (!from?.point || !to?.point) continue;
    // named ports with several attachments are join identities; leave them
    if ((from.port?.attachments.length ?? 1) > 1 || (to.port?.attachments.length ?? 1) > 1) continue;
    // A cohesive PortGroup owns an ordered terminal block. Its independent
    // member docks must not collapse to the compact lane spacing used only
    // after the lines have entered their shared bundle or trunk.
    if ([from.port?.group, to.port?.group].some((group) => group && ["merge", "bundle"].includes(group.affinity))) continue;
    const fromSide = from.physicalSide;
    const toSide = to.physicalSide;
    if (!fromSide || OPPOSITE_SIDE[fromSide] !== toSide) continue;
    const fromBox = dockTarget(from).box;
    const toBox = dockTarget(to).box;
    const horizontal = fromSide === "left" || fromSide === "right";
    const separation = horizontal
      ? fromSide === "right" ? toBox.x - (fromBox.x + fromBox.width) : fromBox.x - (toBox.x + toBox.width)
      : fromSide === "bottom" ? toBox.y - (fromBox.y + fromBox.height) : fromBox.y - (toBox.y + toBox.height);
    if (separation < 0) continue;
    const margin = 14;
    const axis = horizontal ? "y" : "x";
    const extent = horizontal ? "height" : "width";
    const low = Math.max(fromBox[axis], toBox[axis]) + margin;
    const high = Math.min(fromBox[axis] + fromBox[extent], toBox[axis] + toBox[extent]) - margin;
    if (low > high) continue;
    const target = Math.max(low, Math.min(high, (from.point[axis] + to.point[axis]) / 2));
    const fits = (endpoint, side) => {
      const siblings = docks.get(`${dockTarget(endpoint).path}:${side}`) ?? [];
      return preservesDockOrder(siblings, endpoint.point, axis, target);
    };
    if (!fits(from, fromSide) || !fits(to, toSide)) continue;
    from.point[axis] = target;
    to.point[axis] = target;
  }
}

function allocateRegionTracks(scene) {
  scene.trackAllocations = new Map();
  for (const region of scene.regions.values()) {
    const geometry = regionGeometry(region);
    const groups = new Map();
    for (const entry of region.entries) {
      const track = entry.line.regionTracks.get(region.key);
      if (!track) continue;
      const allocationKey = track.crossing ? `crossing:${entry.line.id}` : track.trackKey;
      const group = groups.get(allocationKey) ?? { key: allocationKey, tracks: [], lineIds: [] };
      group.tracks.push(track);
      group.lineIds.push(entry.line.id);
      groups.set(allocationKey, group);
    }
    for (const group of groups.values()) {
      const track = group.tracks[0];
      const offset = track.crossing ? 0 : (track.index - (track.total - 1) / 2) * region.spacing;
      const vertical = geometry.axis === "vertical";
      const cellKeys = track.crossing && region.kind === "gap"
        ? region.channelBinding.cellKeys
        : [region.channelBinding.trackCell.key];
      const allocation = {
        id: `${region.key}:${group.key}`,
        regionKey: region.key,
        trackKey: group.key,
        lineIds: [...group.lineIds].sort(),
        axis: geometry.axis,
        trackCellKey: region.channelBinding.trackCell.key,
        cellKeys,
        coordinate: (vertical ? geometry.x + geometry.width / 2 : geometry.y + geometry.height / 2) + offset,
        laneIndex: track.index,
        laneCount: track.total,
        laneOffset: offset,
        crossing: track.crossing,
        spans: cellKeys.map((cellKey) => {
          const box = scene.channelCellByKey.get(cellKey).geometry;
          return {
            cellKey,
            start: vertical ? box.y : box.x,
            end: vertical ? box.y + box.height : box.x + box.width,
          };
        }),
      };
      scene.trackAllocations.set(allocation.id, allocation);
      for (const member of group.tracks) member.allocation = allocation;
    }
  }
  preserveTrackContinuity(scene);
}

function allocationAlongBounds(allocation) {
  return [
    Math.min(...allocation.spans.map((span) => span.start)),
    Math.max(...allocation.spans.map((span) => span.end)),
  ];
}

function allocationInterval(scene, allocation) {
  const cell = scene.channelCellByKey.get(allocation.trackCellKey);
  if (!cell) throw new Error(`track allocation '${allocation.id}' has no canonical channel cell`);
  const box = cell.geometry;
  return allocation.axis === "vertical" ? [box.x, box.x + box.width] : [box.y, box.y + box.height];
}

function preserveTrackContinuity(scene) {
  const allocations = [...scene.trackAllocations.values()];
  const parent = new Map(allocations.map((allocation) => [allocation.id, allocation.id]));
  const bounds = new Map(allocations.map((allocation) => [allocation.id, allocationInterval(scene, allocation)]));
  const find = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    while (parent.get(id) !== id) {
      const next = parent.get(id);
      parent.set(id, root);
      id = next;
    }
    return root;
  };
  const join = (first, second) => {
    let firstRoot = find(first.id);
    let secondRoot = find(second.id);
    if (firstRoot === secondRoot) return;
    const firstBounds = bounds.get(firstRoot);
    const secondBounds = bounds.get(secondRoot);
    const low = Math.max(firstBounds[0], secondBounds[0]);
    const high = Math.min(firstBounds[1], secondBounds[1]);
    if (high <= low) return;
    if (secondRoot.localeCompare(firstRoot) < 0) [firstRoot, secondRoot] = [secondRoot, firstRoot];
    parent.set(secondRoot, firstRoot);
    bounds.set(firstRoot, [low, high]);
  };

  for (const line of [...scene.lines].sort((first, second) => first.id.localeCompare(second.id))) {
    const lineAllocations = [...new Set([...(line.regionTracks?.values() ?? [])].map((track) => track.allocation))]
      .sort((first, second) => first.axis.localeCompare(second.axis)
        || first.spans[0].start - second.spans[0].start
        || first.id.localeCompare(second.id));
    for (let index = 1; index < lineAllocations.length; index += 1) {
      const first = lineAllocations[index - 1];
      const second = lineAllocations[index];
      if (first.axis === second.axis) join(first, second);
    }
  }

  const components = new Map();
  for (const allocation of allocations) {
    const root = find(allocation.id);
    const members = components.get(root) ?? [];
    members.push(allocation);
    components.set(root, members);
  }
  for (const [root, members] of components) {
    if (members.length < 2) continue;
    const [low, high] = bounds.get(root);
    const center = (low + high) / 2;
    for (const allocation of members) {
      allocation.coordinate = Math.max(low, Math.min(high, center + allocation.laneOffset));
      allocation.runId = root;
    }
  }
}

function trackPoint(track, start, end) {
  const geometry = regionGeometry(track.region);
  const [alongStart, alongEnd] = allocationAlongBounds(track.allocation);
  if (geometry.axis === "vertical") {
    const x = track.allocation.coordinate;
    const y = Math.max(alongStart, Math.min(alongEnd, (start.y + end.y) / 2));
    return { x, y, region: track.region, allocation: track.allocation, soft: true, crossing: track.crossing };
  }
  const x = Math.max(alongStart, Math.min(alongEnd, (start.x + end.x) / 2));
  const y = track.allocation.coordinate;
  return { x, y, region: track.region, allocation: track.allocation, soft: true, crossing: track.crossing };
}

function indexLongitudinalSpans(scene) {
  const cellIndex = new SpatialIndex(scene.channelMesh.map((cell) => ({ cell, box: cell.geometry })));
  const spans = new Map();
  for (const line of scene.lines) {
    const lineSpans = new Map();
    spans.set(line, lineSpans);
    for (let index = 1; index < line.route.length; index += 1) {
      const first = line.route[index - 1];
      const second = line.route[index];
      const vertical = first.x === second.x;
      const horizontal = first.y === second.y;
      if (!vertical && !horizontal) continue;
      for (const indexed of cellIndex.querySegment(first, second)) {
        const cell = indexed.cell;
        const geometry = cell.geometry;
        let overlap = 0;
        if (vertical && geometry.axis === "vertical"
          && first.x >= geometry.x && first.x <= geometry.x + geometry.width) {
          const start = Math.max(Math.min(first.y, second.y), geometry.y);
          const end = Math.min(Math.max(first.y, second.y), geometry.y + geometry.height);
          overlap = Math.max(0, end - start);
        } else if (horizontal && geometry.axis === "horizontal"
          && first.y >= geometry.y && first.y <= geometry.y + geometry.height) {
          const start = Math.max(Math.min(first.x, second.x), geometry.x);
          const end = Math.min(Math.max(first.x, second.x), geometry.x + geometry.width);
          overlap = Math.max(0, end - start);
        }
        if (overlap <= 0) continue;
        for (const regionKey of cell.regionKeys ?? []) {
          lineSpans.set(regionKey, Math.max(lineSpans.get(regionKey) ?? 0, overlap));
        }
      }
    }
  }
  return spans;
}

function trackPreference(entries, region) {
  const axis = regionGeometry(region).axis === "vertical" ? "x" : "y";
  const along = axis === "x" ? "y" : "x";
  const endpointPoints = entries.flatMap(({ line }) => [line.from?.point, line.to?.point]).filter(Boolean);
  const mean = (key) => endpointPoints.reduce((sum, point) => sum + point[key], 0) / Math.max(1, endpointPoints.length);
  return {
    corridorRank: Math.min(...entries.map((entry) => entry.corridor?.rank ?? Number.MAX_SAFE_INTEGER)),
    normal: mean(axis),
    along: mean(along),
    identity: entries.map((entry) => entry.line.id).sort().join("\u0000"),
  };
}

function compareTrackPreference(first, second) {
  return first.preference.corridorRank - second.preference.corridorRank
    || first.preference.normal - second.preference.normal
    || first.preference.along - second.preference.along
    || first.preference.identity.localeCompare(second.preference.identity);
}

// A perpendicular crossing needs an intersection with a region, not a lane
// along it. Classify from a provisional route, then center only the intervals
// that actually occupy the region longitudinally. Geometric projection (and
// authored corridor rank) decides their order; identity is only a final tie.
function classifyRegionTracks(scene) {
  let changed = false;
  const longitudinalSpans = indexLongitudinalSpans(scene);
  for (const region of scene.regions.values()) {
    const authored = region.entries.filter((entry) => entry.usage !== "crossing");
    const groups = new Map();
    for (const entry of authored) {
      const key = entry.trackKey ?? `line:${entry.line.id}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    const threshold = Math.max(24, Math.min(48, region.thickness ?? 0));
    const longitudinal = [];
    for (const [key, entries] of groups) {
      const occupiesLane = entries.some((entry) => {
        const authoredRole = nestedAuthoredRole(entry.line, region);
        return authoredRole === "outer"
          || requiresSharedGapLane(entry.line, region)
          || authoredRole !== "nested" && (longitudinalSpans.get(entry.line)?.get(region.key) ?? 0) > threshold + 0.5;
      });
      if (occupiesLane) longitudinal.push({ key, entries, preference: trackPreference(entries, region) });
      for (const entry of entries) {
        const track = entry.line.regionTracks.get(region.key);
        if (!track) continue;
        const crossing = !occupiesLane;
        if (track.crossing !== crossing) changed = true;
        track.crossing = crossing;
      }
    }
    longitudinal.sort(compareTrackPreference);
    longitudinal.forEach((group, index) => {
      for (const entry of group.entries) {
        const track = entry.line.regionTracks.get(region.key);
        if (track.index !== index || track.total !== longitudinal.length) changed = true;
        track.index = index;
        track.total = longitudinal.length;
      }
    });
    for (const entries of groups.values()) {
      for (const entry of entries) {
        const track = entry.line.regionTracks.get(region.key);
        if (!track?.crossing) continue;
        if (track.index !== 0 || track.total !== 1) changed = true;
        track.index = 0;
        track.total = 1;
      }
    }
  }
  return changed;
}

function routeIntervalOnAllocation(line, allocation) {
  const vertical = allocation.axis === "vertical";
  const intervals = [];
  for (let index = 1; index < line.route.length; index += 1) {
    const first = line.route[index - 1];
    const second = line.route[index];
    const onTrack = vertical
      ? first.x === second.x && Math.abs(first.x - allocation.coordinate) < 0.001
      : first.y === second.y && Math.abs(first.y - allocation.coordinate) < 0.001;
    if (!onTrack) continue;
    const segmentStart = vertical ? Math.min(first.y, second.y) : Math.min(first.x, second.x);
    const segmentEnd = vertical ? Math.max(first.y, second.y) : Math.max(first.x, second.x);
    for (const span of allocation.spans) {
      const start = Math.max(segmentStart, span.start);
      const end = Math.min(segmentEnd, span.end);
      if (end - start > 0.001) intervals.push([start, end]);
    }
  }
  if (!intervals.length) return null;
  return [
    Math.min(...intervals.map((interval) => interval[0])),
    Math.max(...intervals.map((interval) => interval[1])),
  ];
}

function routeIntervalInAllocationCell(scene, line, allocation) {
  const cell = scene.channelCellByKey.get(allocation.trackCellKey);
  if (!cell) return null;
  const vertical = allocation.axis === "vertical";
  const crossStart = vertical ? cell.geometry.x : cell.geometry.y;
  const crossEnd = crossStart + (vertical ? cell.geometry.width : cell.geometry.height);
  const intervals = [];
  for (let index = 1; index < line.route.length; index += 1) {
    const first = line.route[index - 1];
    const second = line.route[index];
    const coordinate = vertical && first.x === second.x ? first.x
      : !vertical && first.y === second.y ? first.y : null;
    if (coordinate == null || coordinate < crossStart - 0.001 || coordinate > crossEnd + 0.001) continue;
    const segmentStart = vertical ? Math.min(first.y, second.y) : Math.min(first.x, second.x);
    const segmentEnd = vertical ? Math.max(first.y, second.y) : Math.max(first.x, second.x);
    for (const span of allocation.spans) {
      const start = Math.max(segmentStart, span.start);
      const end = Math.min(segmentEnd, span.end);
      if (end - start > 0.001) intervals.push([start, end]);
    }
  }
  if (!intervals.length) return null;
  return [
    Math.min(...intervals.map((interval) => interval[0])),
    Math.max(...intervals.map((interval) => interval[1])),
  ];
}

function nonOverlappingIntervalCohorts(entries) {
  const compare = (first, second) => first.end - second.end || first.id - second.id;
  const heap = [];
  const push = (cohort) => {
    heap.push(cohort);
    for (let index = heap.length - 1; index > 0;) {
      const parent = Math.floor((index - 1) / 2);
      if (compare(heap[parent], heap[index]) <= 0) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      index = parent;
    }
  };
  const pop = () => {
    const first = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let index = 0;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let next = index;
        if (left < heap.length && compare(heap[left], heap[next]) < 0) next = left;
        if (right < heap.length && compare(heap[right], heap[next]) < 0) next = right;
        if (next === index) break;
        [heap[index], heap[next]] = [heap[next], heap[index]];
        index = next;
      }
    }
    return first;
  };
  const cohorts = [];
  for (const entry of [...entries].sort((first, second) => first.interval[0] - second.interval[0]
    || first.interval[1] - second.interval[1]
    || first.line.id.localeCompare(second.line.id))) {
    const reusable = heap[0]?.end - entry.interval[0] <= 0.001 ? pop() : null;
    const cohort = reusable ?? { id: cohorts.length, end: Number.NEGATIVE_INFINITY, entries: [] };
    if (!reusable) cohorts.push(cohort);
    cohort.entries.push(entry);
    cohort.end = entry.interval[1];
    push(cohort);
  }
  return cohorts.map((cohort) => cohort.entries);
}

function freePortGroupAlignmentGroups(scene) {
  const groups = [];
  for (const object of scene.objects) {
    for (const portGroup of object.portGroups ?? []) {
      if (portGroup.affinity !== "free") continue;
      const members = portGroup.members.flatMap((port) => port.attachments ?? [])
        .filter((attachment) => attachment.line && attachment.endpoint);
      if (members.length < 2) continue;
      groups.push({
        id: `port-group-alignment:${object.path}:${portGroup.id}`,
        mode: "free",
        source: { kind: "port-group" },
        members,
      });
    }
  }
  return groups;
}

// A shared terminal topology does not imply shared routing tracks. It does,
// however, give compatible approach branches a common visual front: distinct
// allocations may use the same cross-axis coordinate when their occupied
// intervals are disjoint. A free PortGroup participates in this aesthetic
// alignment without gaining any sharing relation. This aligns equivalent
// bends without granting either line permission to overlap the other.
function alignShareApproachTracks(scene) {
  let changed = false;
  const groups = [...buildShareGroups(scene).values(), ...freePortGroupAlignmentGroups(scene)];
  for (const group of groups) {
    if (!["merge", "bundle", "free"].includes(group.mode)) continue;
    const dock = shareGroupDock(group);
    if (!dock) continue;
    const axis = dock.side === "left" || dock.side === "right" ? "vertical" : "horizontal";
    const normal = axis === "vertical" ? "x" : "y";
    const byRegion = new Map();
    for (const member of group.members) {
      const candidates = [...new Set([...(member.line.regionTracks?.values() ?? [])]
        .map((track) => track.allocation))]
        .filter((allocation) => allocation && allocation.axis === axis && !allocation.crossing && !allocation.runId)
        .map((allocation) => ({
          allocation,
          interval: routeIntervalOnAllocation(member.line, allocation)
            ?? (group.source.kind === "port-group"
              ? routeIntervalInAllocationCell(scene, member.line, allocation)
              : null),
        }))
        .filter((candidate) => candidate.interval)
        .sort((first, second) => Math.abs(first.allocation.coordinate - dock.point[normal])
          - Math.abs(second.allocation.coordinate - dock.point[normal])
          || first.allocation.id.localeCompare(second.allocation.id));
      if (!candidates.length) continue;
      const candidate = { ...candidates[0], line: member.line };
      const entries = byRegion.get(candidate.allocation.regionKey) ?? [];
      entries.push(candidate);
      byRegion.set(candidate.allocation.regionKey, entries);
    }
    for (const entries of byRegion.values()) {
      for (const cohort of nonOverlappingIntervalCohorts(entries)) {
        if (cohort.length < 2) continue;
        const legal = cohort.map((entry) => allocationInterval(scene, entry.allocation));
        const low = Math.max(...legal.map((interval) => interval[0]));
        const high = Math.min(...legal.map((interval) => interval[1]));
        if (high < low - 0.001) continue;
        const desired = cohort.reduce((sum, entry) => sum + entry.allocation.coordinate, 0) / cohort.length;
        const coordinate = Math.max(low, Math.min(high, desired));
        const alignmentKey = `${group.id}:${cohort[0].allocation.regionKey}:${axis}`;
        for (const entry of cohort) {
          if (Math.abs(entry.allocation.coordinate - coordinate) > 0.001) changed = true;
          entry.allocation.coordinate = coordinate;
          entry.allocation.alignmentKey = alignmentKey;
        }
      }
    }
  }
  return changed;
}

// Explicit bundles do not own a canonical port, so their corridor lanes and
// entity-only target docks are initially allocated independently. Preserve
// the incoming planar order across both allocations; otherwise two parallel
// lanes must braid at either the corridor bend or the terminal fan-in.
function alignExplicitBundleLaneOrder(scene) {
  let changed = false;
  for (const group of buildShareGroups(scene).values()) {
    if (group.mode !== "bundle" || group.source.kind !== "explicit" || group.members.length < 2) continue;
    const endpointGroups = new Map();
    for (const member of group.members) {
      for (const endpoint of [member.line.from, member.line.to]) {
        if (!endpoint?.point || endpoint.port) continue;
        const key = `${dockTarget(endpoint).path}:${endpoint.physicalSide}`;
        const entries = endpointGroups.get(key) ?? [];
        entries.push({ member, endpoint });
        endpointGroups.set(key, entries);
      }
    }
    const common = [...endpointGroups.values()].find((entries) => entries.length === group.members.length);
    if (!common) continue;
    const commonByLine = new Map(common.map((entry) => [entry.member.line, entry]));
    const firstAllocations = [...new Set([...(group.members[0].line.regionTracks?.values() ?? [])]
      .map((track) => track.allocation))].filter(Boolean);
    let records = null;
    for (const firstAllocation of firstAllocations) {
      const candidates = [];
      for (const member of group.members) {
        const allocation = [...new Set([...(member.line.regionTracks?.values() ?? [])]
          .map((track) => track.allocation))]
          .find((item) => item?.regionKey === firstAllocation.regionKey && item.axis === firstAllocation.axis && !item.crossing);
        if (!allocation) break;
        const endpoint = commonByLine.get(member.line)?.endpoint;
        const route = endpoint === member.line.to ? member.line.route : [...member.line.route].reverse();
        const normal = allocation.axis === "vertical" ? "x" : "y";
        const cross = allocation.axis === "vertical" ? "y" : "x";
        const entry = route.find((point) => Math.abs(point[normal] - allocation.coordinate) < 0.5);
        if (!entry) break;
        const remote = endpoint === member.line.to ? member.line.from : member.line.to;
        const remoteEscape = escapePoint(remote, remote.routeEscapeDistance);
        const turnsDirectlyOntoApproach = allocation.axis === "vertical"
          ? remote.physicalSide === "top" || remote.physicalSide === "bottom"
          : remote.physicalSide === "left" || remote.physicalSide === "right";
        candidates.push({
          member,
          endpoint,
          allocation,
          approach: turnsDirectlyOntoApproach ? remoteEscape[cross] : entry[cross],
        });
      }
      if (candidates.length === group.members.length) {
        records = candidates;
        break;
      }
    }
    if (!records) continue;
    records.sort((first, second) => first.approach - second.approach
      || first.member.line.order - second.member.line.order
      || first.member.line.id.localeCompare(second.member.line.id));
    const allocationCoordinates = records.map((record) => record.allocation.coordinate).sort((first, second) => first - second);
    const dockAxisName = dockAxis(records[0].endpoint.physicalSide);
    const dockCoordinates = records.map((record) => record.endpoint.point[dockAxisName]).sort((first, second) => first - second);
    for (const [index, record] of records.entries()) {
      if (Math.abs(record.allocation.coordinate - allocationCoordinates[index]) > 0.001) changed = true;
      if (Math.abs(record.endpoint.point[dockAxisName] - dockCoordinates[index]) > 0.001) changed = true;
      record.allocation.coordinate = allocationCoordinates[index];
      record.endpoint.point[dockAxisName] = dockCoordinates[index];
      record.member.laneIndex = index;
      record.member.membership.laneIndex = index;
      record.member.membership.laneCount = records.length;
    }
    const laneByMember = new Map(group.bundle.lanes.flatMap((lane) => lane.members.map((member) => [member, lane])));
    group.bundle.lanes = records.map((record, laneIndex) => {
      const lane = laneByMember.get(record.member);
      lane.laneIndex = laneIndex;
      return lane;
    });
    group.members = records.map((record) => record.member);
    group.bundle.laneOrder = group.members.map((member) => member.line.id);
    group.bundle.offsetByMember = terminalLaneOffsets(group.bundle.lanes, 0);
  }
  return changed;
}

function linesInRoutingOrder(scene) {
  const ordered = [...scene.lines];
  for (const group of buildShareGroups(scene).values()) {
    if (group.mode !== "bundle" || group.source.kind !== "explicit") continue;
    const positions = group.members.map((member) => ordered.indexOf(member.line)).sort((first, second) => first - second);
    const members = [...group.members].sort((first, second) => first.laneIndex - second.laneIndex
      || first.line.order - second.line.order
      || first.line.id.localeCompare(second.line.id));
    positions.forEach((position, index) => { ordered[position] = members[index].line; });
  }
  return ordered;
}

class SpatialIndex {
  constructor(objects) {
    this.objects = objects;
    this.cells = new Map();
    for (const object of objects) this.insert(object);
  }

  key(x, y) {
    return `${x},${y}`;
  }

  insert(object) {
    const box = object.box;
    const left = Math.floor(box.x / CELL);
    const right = Math.floor((box.x + box.width) / CELL);
    const top = Math.floor(box.y / CELL);
    const bottom = Math.floor((box.y + box.height) / CELL);
    for (let x = left; x <= right; x += 1) {
      for (let y = top; y <= bottom; y += 1) {
        const key = this.key(x, y);
        if (!this.cells.has(key)) this.cells.set(key, []);
        this.cells.get(key).push(object);
      }
    }
  }

  querySegment(first, second) {
    const left = Math.floor((Math.min(first.x, second.x) - 2) / CELL);
    const right = Math.floor((Math.max(first.x, second.x) + 2) / CELL);
    const top = Math.floor((Math.min(first.y, second.y) - 2) / CELL);
    const bottom = Math.floor((Math.max(first.y, second.y) + 2) / CELL);
    const result = new Set();
    for (let x = left; x <= right; x += 1) {
      for (let y = top; y <= bottom; y += 1) {
        for (const object of this.cells.get(this.key(x, y)) ?? []) result.add(object);
      }
    }
    return result;
  }

  queryBox(box) {
    const left = Math.floor(box.x / CELL);
    const right = Math.floor((box.x + box.width) / CELL);
    const top = Math.floor(box.y / CELL);
    const bottom = Math.floor((box.y + box.height) / CELL);
    const result = new Set();
    for (let x = left; x <= right; x += 1) {
      for (let y = top; y <= bottom; y += 1) {
        for (const object of this.cells.get(this.key(x, y)) ?? []) result.add(object);
      }
    }
    return result;
  }
}

function segmentHitsBox(first, second, box, inset = 0) {
  const left = box.x + inset;
  const right = box.x + box.width - inset;
  const top = box.y + inset;
  const bottom = box.y + box.height - inset;
  if (first.x === second.x) return first.x > left && first.x < right && Math.max(first.y, second.y) > top && Math.min(first.y, second.y) < bottom;
  if (first.y === second.y) return first.y > top && first.y < bottom && Math.max(first.x, second.x) > left && Math.min(first.x, second.x) < right;
  return false;
}

function pointInsideBox(point, box) {
  return point.x > box.x && point.x < box.x + box.width
    && point.y > box.y && point.y < box.y + box.height;
}

function containerHitPattern(points, container) {
  return points.slice(1).map((second, index) => segmentHitsBox(points[index], second, container.box));
}

function prefixOnly(hits) {
  let leftInterior = false;
  for (const hit of hits) {
    if (!hit) leftInterior = true;
    else if (leftInterior) return false;
  }
  return true;
}

function suffixOnly(hits) {
  let enteredInterior = false;
  for (const hit of hits) {
    if (hit) enteredInterior = true;
    else if (enteredInterior) return false;
  }
  return true;
}

// A candidate may leave a source container once or enter a target container
// once. It may not use either endpoint exception to enter, leave, and re-enter
// that container, and it may never enter an unrelated container at all.
function containerTopologyViolation(points, index, line) {
  const containers = new Set();
  for (let pointIndex = 1; pointIndex < points.length; pointIndex += 1) {
    for (const object of index.querySegment(points[pointIndex - 1], points[pointIndex])) {
      if (isTransitBarrierContainer(object)) containers.add(object);
    }
  }
  for (const container of containers) {
    const hits = containerHitPattern(points, container);
    if (!hits.some(Boolean)) continue;
    const containsSource = insideOrSelf(line.from?.object, container);
    const containsTarget = insideOrSelf(line.to?.object, container);
    if (containsSource && containsTarget) continue;
    if (!containsSource && !containsTarget) return container;
    if (containsSource) {
      if (!pointInsideBox(points[0], container.box) || !prefixOnly(hits)) return container;
    } else if (!pointInsideBox(points.at(-1), container.box) || !suffixOnly(hits)) return container;
  }
  return null;
}

function simplify(points, protectedPoints = []) {
  const protectedPins = Array.isArray(protectedPoints) ? protectedPoints : [];
  const unique = points.filter((item, index) => index === 0 || item.x !== points[index - 1].x || item.y !== points[index - 1].y);
  const result = [];
  for (const item of unique) {
    result.push({ x: item.x, y: item.y });
    while (result.length >= 3) {
      const before = result.at(-3);
      const previous = result.at(-2);
      const current = result.at(-1);
      const collinear = before.y === previous.y && previous.y === current.y
        || before.x === previous.x && previous.x === current.x;
      const protectedPoint = protectedPins.some((pin) => samePoint(pin, previous));
      if (!collinear || protectedPoint) break;
      result.splice(-2, 1);
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
    return Math.min(firstEnd, secondEnd) - Math.max(firstStart, secondStart) > 2 ? "overlap" : null;
  }
  const horizontal = firstHorizontal ? first : second;
  const vertical = firstHorizontal ? second : first;
  const x = vertical.first.x;
  const y = horizontal.first.y;
  const insideHorizontal = x > Math.min(horizontal.first.x, horizontal.second.x)
    && x < Math.max(horizontal.first.x, horizontal.second.x);
  const insideVertical = y > Math.min(vertical.first.y, vertical.second.y)
    && y < Math.max(vertical.first.y, vertical.second.y);
  return insideHorizontal && insideVertical ? "crossing" : null;
}

// Boundary titles are residents of the channel mesh, but a perpendicular
// crossing is a soft visual cost rather than an obstacle. Keep every routing
// phase on the same classification so a candidate is not accepted by scoring
// and then expanded around the complete container during collision repair.
function obstacleInteraction(first, second, object) {
  if (!segmentHitsBox(first, second, object.box)) return null;
  if (object.kind === "boundary-label" && first.x === second.x) return "soft";
  return "blocked";
}

function candidateScore(points, index, ignored, routeIndex, line) {
  let score = (points.length - 2) * 18;
  let collisions = 0;
  if (containerTopologyViolation(points, index, line)) collisions += 1;
  for (let i = 1; i < points.length; i += 1) {
    const first = points[i - 1];
    const second = points[i];
    score += Math.abs(first.x - second.x) + Math.abs(first.y - second.y);
    for (const object of index.querySegment(first, second)) {
      if (ignored.has(object)) continue;
      const interaction = obstacleInteraction(first, second, object);
      if (interaction === "soft") score += 40;
      else if (interaction === "blocked") collisions += 1;
    }
    const candidate = { first, second };
    for (const routed of routeIndex.querySegment(first, second)) {
      if (routed.line === line || line.space === "overlay" || routed.line.space === "overlay") continue;
      const clearance = bundleLaneClearance(line, routed.line);
      if (clearance && parallelBundleLanesTooClose(candidate, routed, clearance)) score += 50000;
      const interaction = segmentInteraction(candidate, routed);
      if (interaction === "overlap" && !segmentsMayShareGeometry(line, routed.line, candidate, routed)) score += 50000;
      if (interaction === "crossing") score += CROSSING_PENALTY;
    }
  }
  return score + collisions * 100000;
}

function orthogonal(first, second, index, ignored, routeIndex, line) {
  const middleX = (first.x + second.x) / 2;
  const middleY = (first.y + second.y) / 2;
  const detour = 24;
  const nearby = [...index.querySegment(first, second)].filter((object) => !ignored.has(object));
  const obstacleTop = nearby.length ? Math.min(...nearby.map((object) => object.box.y)) - detour : Math.min(first.y, second.y) - detour;
  const obstacleBottom = nearby.length ? Math.max(...nearby.map((object) => object.box.y + object.box.height)) + detour : Math.max(first.y, second.y) + detour;
  const obstacleLeft = nearby.length ? Math.min(...nearby.map((object) => object.box.x)) - detour : Math.min(first.x, second.x) - detour;
  const obstacleRight = nearby.length ? Math.max(...nearby.map((object) => object.box.x + object.box.width)) + detour : Math.max(first.x, second.x) + detour;
  const candidates = [
    ...(first.x === second.x || first.y === second.y ? [[first, second]] : []),
    [first, { x: second.x, y: first.y }, second],
    [first, { x: first.x, y: second.y }, second],
    [first, { x: middleX, y: first.y }, { x: middleX, y: second.y }, second],
    [first, { x: first.x, y: middleY }, { x: second.x, y: middleY }, second],
    [first, { x: obstacleLeft, y: first.y }, { x: obstacleLeft, y: second.y }, second],
    [first, { x: obstacleRight, y: first.y }, { x: obstacleRight, y: second.y }, second],
    [first, { x: first.x, y: obstacleTop }, { x: second.x, y: obstacleTop }, second],
    [first, { x: first.x, y: obstacleBottom }, { x: second.x, y: obstacleBottom }, second],
  ].map(simplify);
  const score = (candidate) => candidateScore(candidate, index, ignored, routeIndex, line);
  candidates.sort((a, b) => score(a) - score(b));
  let best = candidates[0];
  // when the best route still hits an obstacle or shares a run with an
  // unrelated line, try targeted repairs; two bounded levels, no open search
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const obstacle = collidingObstacle(best, index, ignored, line);
    let repairs = [];
    if (obstacle) {
      repairs = aroundCandidates(first, second, obstacle.box, detour);
    } else {
      const run = overlappingRun(best, routeIndex, line);
      if (!run) break;
      const offsets = [10, -10, 22, -22];
      repairs = run.first.x === run.second.x
        ? offsets.map((offset) => [first, { x: run.first.x + offset, y: first.y }, { x: run.first.x + offset, y: second.y }, second])
        : offsets.map((offset) => [first, { x: first.x, y: run.first.y + offset }, { x: second.x, y: run.first.y + offset }, second]);
    }
    const challenger = repairs.map(simplify).sort((a, b) => score(a) - score(b))[0];
    if (!challenger || score(challenger) >= score(best)) break;
    best = challenger;
  }
  return best;
}

function overlappingRun(points, routeIndex, line) {
  for (let i = 1; i < points.length; i += 1) {
    const candidate = { first: points[i - 1], second: points[i] };
    for (const routed of routeIndex.querySegment(candidate.first, candidate.second)) {
      if (routed.line === line || line.space === "overlay" || routed.line.space === "overlay") continue;
      if (segmentInteraction(candidate, routed) === "overlap"
        && !segmentsMayShareGeometry(line, routed.line, candidate, routed)) return candidate;
    }
  }
  return null;
}

function collidingObstacle(points, index, ignored, line) {
  const container = containerTopologyViolation(points, index, line);
  if (container) return container;
  for (let i = 1; i < points.length; i += 1) {
    for (const object of index.querySegment(points[i - 1], points[i])) {
      if (!ignored.has(object) && obstacleInteraction(points[i - 1], points[i], object) === "blocked") return object;
    }
  }
  return null;
}

function aroundCandidates(first, second, box, detour) {
  const left = box.x - detour;
  const right = box.x + box.width + detour;
  const top = box.y - detour;
  const bottom = box.y + box.height + detour;
  return [
    [first, { x: left, y: first.y }, { x: left, y: second.y }, second],
    [first, { x: right, y: first.y }, { x: right, y: second.y }, second],
    [first, { x: first.x, y: top }, { x: second.x, y: top }, second],
    [first, { x: first.x, y: bottom }, { x: second.x, y: bottom }, second],
  ];
}

function rayClearanceAt(scene, start, side, owner, objectIndex) {
  let clearance = Number.POSITIVE_INFINITY;
  const end = {
    x: side === "left" ? 0 : side === "right" ? scene.width : start.x,
    y: side === "top" ? 0 : side === "bottom" ? scene.height : start.y,
  };
  for (const object of objectIndex.querySegment(start, end)) {
    if (object === owner || !object.visible || object.children.length || ["title", "subtitle", "note", "legend-item"].includes(object.kind)) continue;
    const box = object.box;
    if (side === "right" && box.x >= start.x && start.y >= box.y && start.y <= box.y + box.height) clearance = Math.min(clearance, box.x - start.x);
    if (side === "left" && box.x + box.width <= start.x && start.y >= box.y && start.y <= box.y + box.height) clearance = Math.min(clearance, start.x - (box.x + box.width));
    if (side === "bottom" && box.y >= start.y && start.x >= box.x && start.x <= box.x + box.width) clearance = Math.min(clearance, box.y - start.y);
    if (side === "top" && box.y + box.height <= start.y && start.x >= box.x && start.x <= box.x + box.width) clearance = Math.min(clearance, start.y - (box.y + box.height));
  }
  return clearance;
}

function shareGroupDock(group) {
  if (group.source.kind === "port") {
    const port = group.source.port;
    return {
      point: port.point,
      side: port.physicalSide,
      owner: port.anchor ?? port.owner,
      minSpacing: port.minSpacing ?? 0,
    };
  }
  if (group.source.kind !== "port-group") return null;
  const ports = group.members.map((member) => member.endpoint?.port).filter(Boolean);
  const side = ports[0]?.physicalSide;
  if (!side || ports.some((port) => port.physicalSide !== side)) return null;
  return {
    point: {
      x: ports.reduce((sum, port) => sum + port.point.x, 0) / ports.length,
      y: ports.reduce((sum, port) => sum + port.point.y, 0) / ports.length,
    },
    side,
    owner: ports[0].anchor ?? ports[0].owner,
    minSpacing: Math.max(0, ...ports.map((port) => port.minSpacing ?? 0)),
  };
}

function adjacentGridGutterDistance(scene, dock) {
  const owner = dock.owner;
  const parent = owner?.parent;
  if (parent?.layout?.kind !== "grid") return null;
  const members = parent.children.filter((child) => !child.anchor && !child.frame);
  const index = members.indexOf(owner);
  if (index < 0) return null;
  const columns = Math.max(1, Math.min(parent.layoutData?.columns ?? parent.columns ?? 1, members.length));
  const column = index % columns;
  const row = Math.floor(index / columns);
  let key;
  if (dock.side === "left" && column > 0) key = `mesh:grid-column-gap:${parent.path || "$root"}:${column - 1}`;
  if (dock.side === "right" && column < columns - 1) key = `mesh:grid-column-gap:${parent.path || "$root"}:${column}`;
  if (dock.side === "top" && row > 0) key = `mesh:grid-row-gap:${parent.path || "$root"}:${row - 1}`;
  const rows = Math.ceil(members.length / columns);
  if (dock.side === "bottom" && row < rows - 1) key = `mesh:grid-row-gap:${parent.path || "$root"}:${row}`;
  const cell = key ? scene.channelCellByKey.get(key) : null;
  if (!cell) return null;
  const center = {
    x: cell.geometry.x + cell.geometry.width / 2,
    y: cell.geometry.y + cell.geometry.height / 2,
  };
  const vector = SIDE_VECTOR[dock.side];
  const distance = (center.x - dock.point.x) * vector.x + (center.y - dock.point.y) * vector.y;
  return distance > 0 ? distance : null;
}

function sharingPins(scene, objectIndex) {
  for (const line of scene.lines) {
    line.sharedPins = [];
    line.bundlePins = [];
  }
  for (const group of buildShareGroups(scene).values()) {
    group.allowedSharedRuns = [];
    if (group.mode === "separate") continue;
    const dock = shareGroupDock(group);
    if (!dock) continue;
    const attachments = group.members;
    const start = dock.point;
    const side = dock.side;
    const vector = SIDE_VECTOR[side];
    const distances = attachments.map(({ line, endpoint }) => {
      const remote = remoteCenter(line, endpoint);
      return (remote.x - start.x) * vector.x + (remote.y - start.y) * vector.y;
    }).filter((distance) => distance > 0);
    const trackDistances = attachments.flatMap(({ line }) => [...(line.regionTracks?.values() ?? [])].map((track) => {
      const geometry = regionGeometry(track.region);
      const location = geometry.axis === "vertical"
        ? { x: track.allocation.coordinate, y: start.y }
        : { x: start.x, y: track.allocation.coordinate };
      return (location.x - start.x) * vector.x + (location.y - start.y) * vector.y;
    })).filter((distance) => distance > 18);
    const preference = group.branch?.preference ?? "late";
    const factor = preference === "early" ? 0.18 : preference === "balanced" ? 0.45 : 0.72;
    const desired = Math.min(160, (distances.length ? Math.min(...distances) : 48) * factor);
    const trackLimit = trackDistances.length
      ? Math.min(...trackDistances) - (group.mode === "merge" && group.source.kind === "port-group" ? 0 : ROUTE_CLEARANCE)
      : Number.POSITIVE_INFINITY;
    const obstacleLimit = rayClearanceAt(scene, start, side, dock.owner, objectIndex) - 8;
    const terminalDistance = Math.max(ROUTE_CLEARANCE, ...attachments.map(({ line, endpoint }) => {
      const endIndex = endpoint === line.from ? 0 : 1;
      return Math.max(endpoint.escapeDistance ?? ROUTE_CLEARANCE, minimumHeadRun(normalizedHeads(line.heads)[endIndex]));
    }));
    const minimumDistance = group.mode === "merge" && group.source.kind === "port-group"
      ? terminalDistance + ROUTE_CLEARANCE
      : 8;
    const gutterDistance = group.mode === "bundle" && !group.branch
      ? adjacentGridGutterDistance(scene, dock)
      : null;
    const preferredDistance = gutterDistance != null && gutterDistance >= terminalDistance
      ? gutterDistance
      : Math.max(desired, minimumDistance);
    const distance = Math.max(8, Math.min(preferredDistance, trackLimit, obstacleLimit));
    if (group.mode === "merge") {
      const pin = { x: start.x + vector.x * distance, y: start.y + vector.y * distance };
      if (group.source.kind === "port-group") {
        const convergenceDistance = Math.min(distance, terminalDistance);
        const convergence = {
          x: start.x + vector.x * convergenceDistance,
          y: start.y + vector.y * convergenceDistance,
        };
        group.merge = { convergence, pin };
        group.allowedSharedRuns.push({
          first: convergence,
          second: pin,
          members: attachments.map((attachment) => attachment.line),
        });
        for (const { line, endpoint } of attachments) {
          line.sharedPins.push({ endpoint, pin: convergence, group, sequence: 0 });
          line.sharedPins.push({ endpoint, pin, group, sequence: 1 });
        }
      } else {
        group.merge = { pin };
        group.allowedSharedRuns.push({
          first: start,
          second: pin,
          members: attachments.map((attachment) => attachment.line),
        });
        for (const { line, endpoint } of attachments) line.sharedPins.push({ endpoint, pin, group, sequence: 0 });
      }
      continue;
    }

    const laneVector = dockLaneVector(side);
    group.bundle.branchDistance = distance;
    group.bundle.pinByLine = new Map();
    for (const member of attachments) {
      const offset = group.bundle.offsetByMember?.get(member)
        ?? (member.laneIndex - (attachments.length - 1) / 2) * Math.max(8, dock.minSpacing);
      const pin = {
        x: start.x + vector.x * distance + laneVector.x * offset,
        y: start.y + vector.y * distance + laneVector.y * offset,
      };
      member.line.bundlePins.push({ endpoint: member.endpoint, pin, group });
      group.bundle.pinByLine.set(member.line, pin);
    }
    if (group.source.kind === "port") {
      for (const lane of group.bundle.lanes) {
        if (lane.members.length < 2) continue;
        const slot = lane.members[0].endpoint.terminalSlot;
        const pin = group.bundle.pinByLine.get(lane.members[0].line);
        if (slot && pin) group.allowedSharedRuns.push({
          first: slot.point,
          second: pin,
          members: lane.members.map((member) => member.line),
        });
      }
    }
  }
}

function longitudinalTrackPins(track, start, end) {
  const geometry = regionGeometry(track.region);
  const [alongStart, alongEnd] = allocationAlongBounds(track.allocation);
  if (geometry.axis === "vertical") {
    const x = track.allocation.coordinate;
    return [
      { x, y: Math.max(alongStart, Math.min(alongEnd, start.y)), region: track.region, allocation: track.allocation },
      { x, y: Math.max(alongStart, Math.min(alongEnd, end.y)), region: track.region, allocation: track.allocation },
    ];
  }
  const y = track.allocation.coordinate;
  return [
    { x: Math.max(alongStart, Math.min(alongEnd, start.x)), y, region: track.region, allocation: track.allocation },
    { x: Math.max(alongStart, Math.min(alongEnd, end.x)), y, region: track.region, allocation: track.allocation },
  ];
}

function hasAncestor(object, ancestor) {
  for (let current = object?.parent; current; current = current.parent) if (current === ancestor) return true;
  return false;
}

// A visible semantic container is a topological boundary. Layout-only rows,
// columns, and grids have no painted boundary, while frames deliberately do
// not own the objects they enclose and therefore cannot define containment.
function isTransitBarrierContainer(object) {
  return object?.visible
    && object.children.length > 0
    && !object.frame
    && object.style.stroke !== "transparent"
    && !object.roles.includes("uml-interaction")
    && !object.roles.includes("uml-lifeline")
    && !["diagram", "row", "column", "grid", "legend"].includes(object.kind);
}

export function transitBarrierContainers(scene) {
  return scene.objects.filter(isTransitBarrierContainer);
}

function ancestorDistance(object, ancestor) {
  let distance = 0;
  for (let current = object; current; current = current.parent) {
    if (current === ancestor) return distance;
    distance += 1;
  }
  return Number.POSITIVE_INFINITY;
}

function distanceToBox(point, box) {
  const dx = point.x < box.x ? box.x - point.x : point.x > box.x + box.width ? point.x - (box.x + box.width) : 0;
  const dy = point.y < box.y ? box.y - point.y : point.y > box.y + box.height ? point.y - (box.y + box.height) : 0;
  return dx + dy;
}

function pinDistance(pin, start) {
  return pin.region
    ? distanceToBox(start, regionGeometry(pin.region))
    : Math.abs(pin.x - start.x) + Math.abs(pin.y - start.y);
}

function explicitSegmentOwner(segment) {
  if (segment.region?.kind === "padding") return segment.region.container;
  if (segment.region?.kind === "gap") return segment.region.between?.[0]?.parent ?? null;
  if (segment.corridor?.container) return segment.corridor.container;
  return segment.corridor?.between?.[0]?.parent ?? null;
}

function branchBelow(ancestor, object) {
  let current = object;
  while (current?.parent && current.parent !== ancestor) current = current.parent;
  return current?.parent === ancestor ? current : null;
}

function isDirectGapCrossing(line, region) {
  if (region.kind !== "gap") return false;
  // An explicit share group needs a longitudinal track block even when one
  // member could cross the gap directly; otherwise its bundle topology would
  // disagree with the other members.
  if (line.share?.group) return false;
  const joinedPort = [line.from, line.to].some((endpoint) => {
    const port = endpoint?.port;
    const mode = port?.sharing?.mode ?? "auto";
    return port?.attachments.length > 1 && (mode === "merge" || mode === "auto");
  });
  if (joinedPort) return false;
  const explicitRegions = line.segments.filter((segment) => segment.region || segment.corridor);
  if (explicitRegions.length !== 1) return false;
  const fromBranch = branchBelow(region.owner, line.from?.object);
  const toBranch = branchBelow(region.owner, line.to?.object);
  if (!fromBranch || !toBranch || fromBranch === toBranch) return false;
  const start = Math.min(fromBranch.layoutIndex, toBranch.layoutIndex);
  const end = Math.max(fromBranch.layoutIndex, toBranch.layoutIndex);
  return region.index >= start && region.index < end;
}

function requiresSharedGapLane(line, region) {
  if (region.kind !== "gap") return false;
  const authorsRegion = line.segments.some((segment) => segment.corridor
    ? region.corridors.includes(segment.corridor)
    : segment.region?.kind === "gap" && physicalGapContains(segment.region, region));
  if (!authorsRegion) return false;
  return (line.shareMemberships ?? []).some((membership) =>
    membership.group.mode === "merge" || membership.group.mode === "bundle");
}

function insideOrSelf(object, ancestor) {
  return object === ancestor || hasAncestor(object, ancestor);
}

function orderedPins(line, start, end) {
  const tracks = [...(line.regionTracks?.values() ?? [])];
  const explicitIndexByRegion = new Map();
  const setExplicitIndex = (key, index) => explicitIndexByRegion.set(key,
    Math.min(explicitIndexByRegion.get(key) ?? Number.POSITIVE_INFINITY, index));
  line.segments.forEach((segment, index) => {
    if (segment.region?.kind === "padding") {
      setExplicitIndex(`padding:${segment.region.container.path || "$root"}:${segment.region.side}`, index);
    } else if (segment.region?.kind === "gap") {
      const [first, second] = segment.region.between;
      if (first?.parent && first.parent === second?.parent) {
        const startIndex = Math.min(first.layoutIndex, second.layoutIndex);
        const endIndex = Math.max(first.layoutIndex, second.layoutIndex);
        for (let gap = startIndex; gap < endIndex; gap += 1) {
          setExplicitIndex(`gap:${first.parent.path || "$root"}:${gap}`, index);
        }
      }
    } else if (segment.corridor) {
      for (const track of tracks) if (track.region.corridors.includes(segment.corridor)) setExplicitIndex(track.region.key, index);
    }
  });
  const explicitPadding = new Set(tracks
    .filter((track) => track.region.kind === "padding" && explicitIndexByRegion.has(track.region.key))
    .map((track) => track.region));
  const explicitPaddingOwners = new Set([...explicitPadding].map((region) => region.owner));
  const authoredOwners = line.segments.map((segment, index) => ({ index, owner: explicitSegmentOwner(segment) }))
    .filter((entry) => entry.owner);

  const groups = [];
  for (const track of tracks) {
    const explicitIndex = explicitIndexByRegion.get(track.region.key) ?? -1;
    const approachEndpoint = line.approachRegions?.get(track.region.key);
    if (approachEndpoint) {
      const fromSide = approachEndpoint === line.from;
      groups.push({
        phase: fromSide ? 1 : 3,
        rank: ancestorDistance(approachEndpoint.object, track.region.owner),
        pins: longitudinalTrackPins(track, start, end).map((pin) => ({ ...pin, required: true })),
      });
      continue;
    }
    if (explicitPadding.has(track.region)) {
      groups.push({
        phase: 2,
        rank: explicitIndex,
        pins: longitudinalTrackPins(track, start, end).map((pin) => ({ ...pin, required: true })),
      });
      continue;
    }
    if (track.region.kind === "gap" && explicitPaddingOwners.has(track.region.owner)) continue;
    if (track.region.gridAxis && !track.crossing) {
      const pin = { ...trackPoint(track, start, end), required: true };
      groups.push({ phase: 1, rank: pinDistance(pin, start), pins: [pin] });
      continue;
    }
    if (explicitIndex >= 0) {
      const pin = trackPoint(track, start, end);
      // A sole authored gap between the endpoint branches is a crossing, not
      // a request to travel along the gap. Keep its cross-axis coordinate and
      // let routing choose the along-axis intersection from the endpoints.
      if (isDirectGapCrossing(line, track.region)) pin.crossing = true;
      pin.required = true;
      groups.push({ phase: 2, rank: explicitIndex, pins: [pin] });
      continue;
    }
    // an implicit exit/entry band that contradicts the chosen dock side would
    // drag the route around the object; the reservation stays, the pin goes.
    // matching bands are pass-through: the route crosses them, but lateral
    // travel belongs to the gap corridors, not to a container's exit band
    if (track.region.kind === "padding") {
      const endpoint = [line.from, line.to].find((item) => item && (item.object === track.region.owner || hasAncestor(item.object, track.region.owner)));
      if (endpoint?.physicalSide && endpoint.physicalSide !== track.region.side) continue;
      const fromSide = endpoint === line.from;
      const distance = ancestorDistance(endpoint.object, track.region.owner);
      const containedExplicit = authoredOwners.filter((entry) => insideOrSelf(entry.owner, track.region.owner));

      // Explicit regions inside a container occur before its source-side exit
      // padding and after its target-side entry padding. Interleave those
      // bands with authored segments instead of placing every source padding
      // before every explicit pin, which would force hierarchy backtracking.
      if (containedExplicit.length) {
        const authoredIndex = fromSide
          ? Math.max(...containedExplicit.map((entry) => entry.index)) + 0.25 + distance * 0.001
          : Math.min(...containedExplicit.map((entry) => entry.index)) - 0.25 - distance * 0.001;
        groups.push({
          phase: 2,
          rank: authoredIndex,
          pins: [{ ...trackPoint(track, start, end), passThrough: true, endpoint }],
        });
        continue;
      }
      groups.push({
        phase: fromSide ? 0 : 4,
        rank: fromSide ? distance : -distance,
        pins: [{ ...trackPoint(track, start, end), passThrough: true, endpoint }],
      });
      continue;
    }
    const pin = trackPoint(track, start, end);
    groups.push({ phase: 1, rank: pinDistance(pin, start), pins: [pin] });
  }
  line.segments.forEach((segment, index) => {
    if (segment.waypoint) groups.push({ phase: 2, rank: index, pins: [center(segment.waypoint.box)] });
  });
  groups.sort((first, second) => first.phase - second.phase || first.rank - second.rank);
  const pins = groups.flatMap((group) => group.pins);
  const sharingPins = [...(line.sharedPins ?? []), ...(line.bundlePins ?? [])];
  const fromPins = sharingPins
    .filter((sharingPin) => sharingPin.endpoint === line.from)
    .sort((first, second) => (first.sequence ?? 0) - (second.sequence ?? 0))
    .map((sharingPin) => ({ ...sharingPin.pin, sharingGroup: sharingPin.group }));
  const toPins = sharingPins
    .filter((sharingPin) => sharingPin.endpoint !== line.from)
    .sort((first, second) => (second.sequence ?? 0) - (first.sequence ?? 0))
    .map((sharingPin) => ({ ...sharingPin.pin, sharingGroup: sharingPin.group }));
  const alignRegionPin = (pin, anchor) => {
    if (!pin?.region || !pin.allocation || !anchor) return;
    const geometry = regionGeometry(pin.region);
    const [alongStart, alongEnd] = allocationAlongBounds(pin.allocation);
    if (geometry.axis === "vertical") pin.y = Math.max(alongStart, Math.min(alongEnd, anchor.y));
    else pin.x = Math.max(alongStart, Math.min(alongEnd, anchor.x));
  };
  alignRegionPin(pins[0], fromPins.at(-1));
  alignRegionPin(pins.at(-1), toPins[0]);
  pins.unshift(...fromPins);
  pins.push(...toPins);
  return pins;
}

function physicalGapContains(reference, region) {
  return reference.between?.[0]?.parent === region.owner
    && reference.between?.[1]?.parent === region.owner
    && region.index >= Math.min(reference.between[0].layoutIndex, reference.between[1].layoutIndex)
    && region.index < Math.max(reference.between[0].layoutIndex, reference.between[1].layoutIndex);
}

function objectDepth(object) {
  let depth = 0;
  for (let current = object; current?.parent; current = current.parent) depth += 1;
  return depth;
}

function authoredRegionOwner(segment) {
  if (segment.region?.kind === "padding") return segment.region.container;
  if (segment.region?.kind === "gap") return segment.region.between?.[0]?.parent ?? null;
  if (segment.corridor?.container) return segment.corridor.container;
  return segment.corridor?.between?.[0]?.parent ?? null;
}

function segmentAuthorsRegion(segment, region) {
  if (segment.region?.kind === "padding") {
    return region.kind === "padding" && region.owner === segment.region.container && region.side === segment.region.side;
  }
  if (segment.region?.kind === "gap") return region.kind === "gap" && physicalGapContains(segment.region, region);
  return segment.corridor ? region.corridors.includes(segment.corridor) : false;
}

// A multi-region route crosses nested bands to reach its outer corridor. The
// shallowest authored region is longitudinal; deeper authored regions are
// crossings. A single authored region keeps provisional geometric inference.
function nestedAuthoredRole(line, region) {
  const owners = line.segments.map(authoredRegionOwner).filter(Boolean);
  if (owners.length < 2 || !line.segments.some((segment) => segmentAuthorsRegion(segment, region))) return null;
  const shallowest = Math.min(...owners.map(objectDepth));
  return objectDepth(region.owner) === shallowest ? "outer" : "nested";
}

function escapePoint(endpoint, distance = endpoint.routeEscapeDistance ?? endpoint.escapeDistance ?? ROUTE_CLEARANCE) {
  const vector = SIDE_VECTOR[endpoint.physicalSide] ?? { x: 0, y: 0 };
  return { x: endpoint.point.x + vector.x * distance, y: endpoint.point.y + vector.y * distance };
}

function endpointStub(line, endpoint) {
  const endIndex = endpoint === line.from ? 0 : 1;
  const minimumRun = minimumHeadRun(normalizedHeads(line.heads)[endIndex]);
  const escapeDistance = Math.max(endpoint.escapeDistance ?? ROUTE_CLEARANCE, minimumRun);
  endpoint.routeEscapeDistance = escapeDistance;
  return [endpoint.point, escapePoint(endpoint, escapeDistance)];
}

function terminalRunIsValid(endpoint, adjacent) {
  const vector = SIDE_VECTOR[endpoint.physicalSide] ?? { x: 0, y: 0 };
  const delta = { x: adjacent.x - endpoint.point.x, y: adjacent.y - endpoint.point.y };
  const normal = delta.x * vector.x + delta.y * vector.y;
  const tangent = delta.x * vector.y - delta.y * vector.x;
  return Math.abs(tangent) <= 0.001 && normal >= (endpoint.routeEscapeDistance ?? ROUTE_CLEARANCE) - 0.001;
}

function terminalNormalDistance(endpoint, point) {
  const vector = SIDE_VECTOR[endpoint.physicalSide] ?? { x: 0, y: 0 };
  return (point.x - endpoint.point.x) * vector.x + (point.y - endpoint.point.y) * vector.y;
}

function terminalBridge(first, second, side, escapeAtStart) {
  if (first.x === second.x || first.y === second.y) return [first, second];
  const horizontalNormal = side === "left" || side === "right";
  const corner = horizontalNormal
    ? escapeAtStart ? { x: second.x, y: first.y } : { x: first.x, y: second.y }
    : escapeAtStart ? { x: first.x, y: second.y } : { x: second.x, y: first.y };
  return [first, corner, second];
}

// The interior router may find an equal-cost L path that visits a dock before
// its authored escape point. Loop removal must not turn that path into a
// tangential arrival along the object edge. Rebuild only the terminal bridge;
// all interior routing and authored pins remain untouched.
function enforceTerminalStubs(line) {
  for (const [endpoint, fromEnd] of [[line.from, true], [line.to, false]]) {
    const adjacent = fromEnd ? line.route[1] : line.route.at(-2);
    if (!endpoint?.point || !adjacent || terminalRunIsValid(endpoint, adjacent)) continue;
    const escape = escapePoint(endpoint, endpoint.routeEscapeDistance);
    if (fromEnd) {
      let nextIndex = 1;
      while (nextIndex < line.route.length - 1 && terminalNormalDistance(endpoint, line.route[nextIndex]) <= 0.001) nextIndex += 1;
      const next = line.route[nextIndex];
      const bridge = terminalBridge(escape, next, endpoint.physicalSide, true);
      line.route = simplify([endpoint.point, ...bridge, ...line.route.slice(nextIndex + 1)], [escape]);
    } else {
      let previousIndex = line.route.length - 2;
      while (previousIndex > 0 && terminalNormalDistance(endpoint, line.route[previousIndex]) <= 0.001) previousIndex -= 1;
      const previous = line.route[previousIndex];
      const bridge = terminalBridge(previous, escape, endpoint.physicalSide, false);
      line.route = simplify([...line.route.slice(0, previousIndex), ...bridge, endpoint.point], [escape]);
    }
  }
}

// Docks sit on the box edge and stubs leave outward, so the endpoint boxes
// need no exemption: a route doubling back across its own source is a real
// collision the score should see.
function ignoredObjects(line, index) {
  if (line.space === "overlay") return new Set(index.objects);
  const ignored = new Set(line.segments.map((segment) => segment.waypoint).filter(Boolean));
  for (const endpoint of [line.from, line.to]) {
    if (endpoint?.routingTarget && endpoint.routingTarget !== endpoint.object) ignored.add(endpoint.object);
    // The route may start in or terminate in any semantic container on an
    // endpoint's containment chain. Every other visible container remains a
    // hard obstacle, so it cannot be used as transit whitespace.
    for (let current = endpoint?.object; current; current = current.parent) {
      if (isTransitBarrierContainer(current)) ignored.add(current);
    }
  }
  return ignored;
}

function routeLine(line, index, routeIndex) {
  if (!line.from || !line.to) return;
  const fromStub = endpointStub(line, line.from);
  const toStub = endpointStub(line, line.to);
  const start = fromStub.at(-1);
  const end = toStub.at(-1);
  // a track pin is hard across its region but soft along it: expand it into
  // an entry point at the incoming coordinate and an exit point toward the
  // next target, so the lateral travel happens inside the reserved region —
  // that is what the corridor's space was reserved for
  const ordered = orderedPins(line, start, end);
  const rawPins = ordered.filter((pin, pinIndex) => {
    if (!pin.soft || pin.required) return true;
    const previous = pinIndex ? ordered[pinIndex - 1] : start;
    const next = ordered[pinIndex + 1];
    if (!next?.sharingGroup) return true;
    const horizontal = previous.y === pin.y && pin.y === next.y
      && pin.x >= Math.min(previous.x, next.x) && pin.x <= Math.max(previous.x, next.x);
    const vertical = previous.x === pin.x && pin.x === next.x
      && pin.y >= Math.min(previous.y, next.y) && pin.y <= Math.max(previous.y, next.y);
    return !horizontal && !vertical;
  });
  const nextTravelByIndex = new Array(rawPins.length);
  let followingTravel = end;
  for (let index = rawPins.length - 1; index >= 0; index -= 1) {
    nextTravelByIndex[index] = followingTravel;
    if (!rawPins[index].passThrough) followingTravel = rawPins[index];
  }
  const pins = [];
  let cursor = start;
  for (let index = 0; index < rawPins.length; index += 1) {
    const pin = rawPins[index];
    const geometry = pin.region ? regionGeometry(pin.region) : null;
    if (pin.soft && geometry) {
      const nextTravel = nextTravelByIndex[index];
      const [alongStart, alongEnd] = pin.allocation ? allocationAlongBounds(pin.allocation)
        : geometry.axis === "vertical"
          ? [geometry.y, geometry.y + geometry.height]
          : [geometry.x, geometry.x + geometry.width];
      if (geometry.axis === "vertical") {
        const clamp = (value) => Math.max(alongStart, Math.min(alongEnd, value));
        if (pin.passThrough) {
          const escape = escapePoint(pin.endpoint);
          const vector = SIDE_VECTOR[pin.endpoint.physicalSide];
          const x = vector.x > 0 ? Math.max(pin.x, escape.x) : vector.x < 0 ? Math.min(pin.x, escape.x) : pin.x;
          pins.push({ x, y: clamp(cursor.y), required: pin.required });
        } else if (pin.crossing) {
          const fromSide = cursor.x === start.x && cursor.y === start.y ? line.from?.physicalSide : null;
          const toSide = nextTravel === end ? line.to?.physicalSide : null;
          const y = fromSide === "left" || fromSide === "right"
            ? cursor.y
            : toSide === "left" || toSide === "right" ? nextTravel.y : cursor.y;
          // Move along the endpoint branch before entering the gap. Without
          // this point, two equal-length L candidates can choose a vertical
          // run inside a gap that is meant to be crossed once.
          if (cursor.y !== y) pins.push({ x: cursor.x, y: clamp(y), required: pin.required });
          pins.push({ x: pin.x, y: clamp(y), required: pin.required });
        } else {
          const nextY = nextTravel.soft && nextTravel.region && regionGeometry(nextTravel.region).axis === "vertical" ? cursor.y : nextTravel.y;
          const entryRequired = pin.required && !(pin.region.kind === "gap" && line.share?.group
            && requiresSharedGapLane(line, pin.region));
          pins.push(
            { x: pin.x, y: clamp(cursor.y), required: entryRequired },
            { x: pin.x, y: clamp(nextY), required: pin.required },
          );
        }
      } else {
        const clamp = (value) => Math.max(alongStart, Math.min(alongEnd, value));
        if (pin.passThrough) {
          const escape = escapePoint(pin.endpoint);
          const vector = SIDE_VECTOR[pin.endpoint.physicalSide];
          const y = vector.y > 0 ? Math.max(pin.y, escape.y) : vector.y < 0 ? Math.min(pin.y, escape.y) : pin.y;
          pins.push({ x: clamp(cursor.x), y, required: pin.required });
        } else if (pin.crossing) {
          const fromSide = cursor.x === start.x && cursor.y === start.y ? line.from?.physicalSide : null;
          const toSide = nextTravel === end ? line.to?.physicalSide : null;
          const x = fromSide === "top" || fromSide === "bottom"
            ? cursor.x
            : toSide === "top" || toSide === "bottom" ? nextTravel.x : cursor.x;
          if (cursor.x !== x) pins.push({ x: clamp(x), y: cursor.y, required: pin.required });
          pins.push({ x: clamp(x), y: pin.y, required: pin.required });
        } else {
          const nextX = nextTravel.soft && nextTravel.region && regionGeometry(nextTravel.region).axis === "horizontal" ? cursor.x : nextTravel.x;
          const entryRequired = pin.required && !(pin.region.kind === "gap" && line.share?.group
            && requiresSharedGapLane(line, pin.region));
          pins.push(
            { x: clamp(cursor.x), y: pin.y, required: entryRequired },
            { x: clamp(nextX), y: pin.y, required: pin.required },
          );
        }
      }
      cursor = pins.at(-1);
    } else {
      pins.push(pin);
      cursor = pin;
    }
  }
  // Keep authored and region pins explicit; terminal legality is enforced by
  // the minimum normal-run invariant instead of freezing the escape bend.
  line.requiredRoutePins = pins.filter((pin) => pin.required).map((pin) => ({ x: pin.x, y: pin.y }));
  // Region and sharing pins constrain route geometry. Terminal escape points
  // only express a minimum straight run; a longer collinear approach may
  // replace them and must not freeze an otherwise removable staircase.
  line.pinPoints = pins.map((pin) => ({ x: pin.x, y: pin.y }));
  const waypoints = [start, ...pins, end];
  const interiorRoute = [];
  for (let i = 1; i < waypoints.length; i += 1) {
    const ignored = ignoredObjects(line, index);
    const piece = orthogonal(waypoints[i - 1], waypoints[i], index, ignored, routeIndex, line);
    for (let pieceIndex = 1; pieceIndex < piece.length; pieceIndex += 1) {
      const candidate = { first: piece[pieceIndex - 1], second: piece[pieceIndex] };
      for (const routed of routeIndex.querySegment(candidate.first, candidate.second)) {
        if (routed.line !== line) authorizeSharedGeometry(line, routed.line, candidate, routed);
      }
    }
    interiorRoute.push(...(interiorRoute.length ? piece.slice(1) : piece));
  }
  const route = [fromStub[0], ...interiorRoute, toStub[0]];
  const required = line.requiredRoutePins ?? [];
  const terminalPins = [...fromStub.slice(1), ...toStub.slice(1)];
  const protectedPins = [...required, ...terminalPins];
  const loopFree = [];
  for (const routePoint of route) {
    const previousIndex = loopFree.findLastIndex((candidate) => samePoint(candidate, routePoint));
    const loopContainsProtectedPin = previousIndex >= 0 && loopFree.slice(previousIndex + 1)
      .some((candidate) => protectedPins.some((pin) => samePoint(candidate, pin)));
    if (previousIndex >= 0 && !loopContainsProtectedPin) loopFree.splice(previousIndex + 1);
    else loopFree.push(routePoint);
  }
  // A collinear escape needs no explicit vertex: the longer straight run
  // already satisfies the terminal constraint. Non-collinear escapes survive
  // simplification as bends and remain protected by line.pinPoints later.
  line.route = simplify(loopFree, required);
  enforceTerminalStubs(line);
  materializeSharedPins(line);
}

function materializeSharedPins(line) {
  for (const shared of line.sharedPins ?? []) {
    const pinIndex = line.route.findIndex((point) => point.x === shared.pin.x && point.y === shared.pin.y);
    if (pinIndex >= 0) continue;
    for (let routeIndex = 1; routeIndex < line.route.length; routeIndex += 1) {
      const first = line.route[routeIndex - 1];
      const second = line.route[routeIndex];
      const onHorizontal = first.y === second.y && shared.pin.y === first.y && shared.pin.x >= Math.min(first.x, second.x) && shared.pin.x <= Math.max(first.x, second.x);
      const onVertical = first.x === second.x && shared.pin.x === first.x && shared.pin.y >= Math.min(first.y, second.y) && shared.pin.y <= Math.max(first.y, second.y);
      if (onHorizontal || onVertical) {
        line.route.splice(routeIndex, 0, { ...shared.pin });
        break;
      }
    }
  }
}

function samePoint(first, second) {
  return Math.abs(first.x - second.x) < 0.001 && Math.abs(first.y - second.y) < 0.001;
}

function terminalPath(member) {
  return member.endpoint === member.line.from ? member.line.route : [...member.line.route].reverse();
}

function nextWalkerSegment(walker) {
  while (walker.index < walker.points.length - 1 && samePoint(walker.current, walker.points[walker.index + 1])) {
    walker.index += 1;
  }
  if (walker.index >= walker.points.length - 1) return null;
  const next = walker.points[walker.index + 1];
  const dx = next.x - walker.current.x;
  const dy = next.y - walker.current.y;
  return {
    direction: { x: Math.sign(dx), y: Math.sign(dy) },
    distance: Math.abs(dx) + Math.abs(dy),
  };
}

function sameMembers(first, second) {
  return first.length === second.length && first.every((member) => second.includes(member));
}

function appendSharedRun(runs, first, second, members) {
  if (samePoint(first, second)) return;
  const previous = runs.at(-1);
  const sameHorizontal = previous && previous.first.y === previous.second.y && first.y === second.y
    && Math.abs(previous.second.y - first.y) < 0.001;
  const sameVertical = previous && previous.first.x === previous.second.x && first.x === second.x
    && Math.abs(previous.second.x - first.x) < 0.001;
  if (previous && sameMembers(previous.members, members)
    && samePoint(previous.second, first) && (sameHorizontal || sameVertical)) previous.second = second;
  else runs.push({ first, second, members });
}

// The planned branch pin is only a lower bound. Once routes are solved, the
// canonical state records their actual maximal common terminal prefix. Any
// coincidence after the first divergence remains unauthorized, so a later
// split/rejoin is still reported as an overlap.
function commonTerminalRuns(members) {
  if (members.length < 2) return [];
  const walkers = members.map((member) => {
    const points = terminalPath(member);
    return { member, points, index: 0, current: points[0] };
  });
  if (walkers.some((walker) => !walker.current || !samePoint(walker.current, walkers[0].current))) return [];
  const runs = [];
  const pending = [walkers];
  while (pending.length) {
    const cohort = pending.pop();
    const byDirection = new Map();
    for (const walker of cohort) {
      const segment = nextWalkerSegment(walker);
      if (!segment) continue;
      const key = `${segment.direction.x},${segment.direction.y}`;
      const branch = byDirection.get(key) ?? { direction: segment.direction, walkers: [], distances: [] };
      branch.walkers.push(walker);
      branch.distances.push(segment.distance);
      byDirection.set(key, branch);
    }
    for (const branch of byDirection.values()) {
      if (branch.walkers.length < 2) continue;
      const first = { ...branch.walkers[0].current };
      if (branch.walkers.some((walker) => !samePoint(walker.current, first))) continue;
      const distance = Math.min(...branch.distances);
      if (distance <= 0.001) continue;
      const second = {
        x: first.x + branch.direction.x * distance,
        y: first.y + branch.direction.y * distance,
      };
      appendSharedRun(runs, first, second, branch.walkers.map((walker) => walker.member.line));
      for (const walker of branch.walkers) {
        walker.current = {
          x: walker.current.x + branch.direction.x * distance,
          y: walker.current.y + branch.direction.y * distance,
        };
        if (samePoint(walker.current, walker.points[walker.index + 1])) walker.index += 1;
      }
      pending.push(branch.walkers);
    }
  }
  return runs;
}

function materializeAuthorizedSharedRuns(scene) {
  for (const group of scene.shareGroups?.values?.() ?? []) {
    if (group.source.kind !== "port") continue;
    const lanes = group.mode === "merge"
      ? [{ members: group.members }]
      : group.mode === "bundle" ? group.bundle.lanes : [];
    group.allowedSharedRuns = lanes.flatMap((lane) => commonTerminalRuns(lane.members));
  }
}

function indexRoute(routeIndex, line) {
  if (line.space === "overlay") return;
  for (let index = 1; index < line.route.length; index += 1) {
    const first = line.route[index - 1];
    const second = line.route[index];
    routeIndex.insert({
      line,
      first,
      second,
      box: {
        x: Math.min(first.x, second.x) - 2,
        y: Math.min(first.y, second.y) - 2,
        width: Math.abs(first.x - second.x) + 4,
        height: Math.abs(first.y - second.y) + 4,
      },
    });
  }
}

function isPinPoint(line, point) {
  return (line.pinPoints ?? []).some((pin) => Math.abs(pin.x - point.x) < 0.5 && Math.abs(pin.y - point.y) < 0.5);
}

function routeContainsPoint(points, point) {
  return points.slice(1).some((second, index) => {
    const first = points[index];
    const onHorizontal = first.y === second.y && point.y === first.y
      && point.x >= Math.min(first.x, second.x) && point.x <= Math.max(first.x, second.x);
    const onVertical = first.x === second.x && point.x === first.x
      && point.y >= Math.min(first.y, second.y) && point.y <= Math.max(first.y, second.y);
    return onHorizontal || onVertical;
  });
}

// Like simplify, but keeps collinear pin points: a shared branch point stays
// an explicit route vertex even when the straightened route runs through it.
function simplifyKeepingPins(line, points) {
  const unique = points.filter((item, index) => index === 0 || item.x !== points[index - 1].x || item.y !== points[index - 1].y);
  const result = [];
  for (const item of unique) {
    result.push({ x: item.x, y: item.y });
    while (result.length >= 3) {
      const before = result.at(-3);
      const previous = result.at(-2);
      const current = result.at(-1);
      const horizontal = before.y === previous.y && previous.y === current.y;
      const vertical = before.x === previous.x && previous.x === current.x;
      if (!horizontal && !vertical) break;
      const between = horizontal
        ? previous.x >= Math.min(before.x, current.x) && previous.x <= Math.max(before.x, current.x)
        : previous.y >= Math.min(before.y, current.y) && previous.y <= Math.max(before.y, current.y);
      const required = (line.requiredRoutePins ?? []).some((pin) => samePoint(pin, previous));
      if (required || between && isPinPoint(line, previous)) break;
      result.splice(-2, 1);
    }
  }
  return result;
}

function pinProgress(points, pin) {
  let progress = 0;
  for (let index = 1; index < points.length; index += 1) {
    const first = points[index - 1];
    const second = points[index];
    const length = Math.abs(first.x - second.x) + Math.abs(first.y - second.y);
    const horizontal = first.y === second.y && pin.y === first.y
      && pin.x >= Math.min(first.x, second.x) && pin.x <= Math.max(first.x, second.x);
    const vertical = first.x === second.x && pin.x === first.x
      && pin.y >= Math.min(first.y, second.y) && pin.y <= Math.max(first.y, second.y);
    if (horizontal || vertical) return progress + Math.abs(pin.x - first.x) + Math.abs(pin.y - first.y);
    progress += length;
  }
  return Number.POSITIVE_INFINITY;
}

function hasImmediateReverse(points) {
  for (let index = 1; index < points.length - 1; index += 1) {
    const before = points[index - 1];
    const middle = points[index];
    const after = points[index + 1];
    const horizontal = before.y === middle.y && middle.y === after.y;
    const vertical = before.x === middle.x && middle.x === after.x;
    if (!horizontal && !vertical) continue;
    const between = horizontal
      ? middle.x >= Math.min(before.x, after.x) && middle.x <= Math.max(before.x, after.x)
      : middle.y >= Math.min(before.y, after.y) && middle.y <= Math.max(before.y, after.y);
    if (!between) return true;
  }
  return false;
}

// Replace zig-zag stretches with the best bounded candidate between the same
// two route points. Pins and shared-branch points are never removed; a
// replacement is accepted only when its full score strictly improves, so the
// pass is monotone and cannot introduce new collisions or unrelated runs.
function collapseJogs(line, index, routeIndex) {
  if (!line.from || !line.to || line.route.length < 4) return false;
  const ignored = ignoredObjects(line, index);
  // Soft allocation pins may already have been relaxed by collision routing.
  // Preserve the ones the accepted route actually uses, but do not resurrect
  // a discarded pin at the cost of a loop or an unauthorized shared run.
  const geometricPins = (line.pinPoints ?? []).filter((pin) => routeContainsPoint(line.route, pin));
  let improved = false;
  for (let windowSize = Math.min(line.route.length - 1, 6); windowSize >= 2; windowSize -= 1) {
    let start = 0;
    while (start + windowSize < line.route.length) {
      const end = start + windowSize;
      const first = line.route[start];
      const second = line.route[end];
      const current = line.route.slice(start, end + 1);
      const pinsInWindow = geometricPins
        .filter((pin) => !samePoint(pin, first) && !samePoint(pin, second) && routeContainsPoint(current, pin))
        .sort((left, right) => pinProgress(current, left) - pinProgress(current, right));
      const viaPins = [first];
      for (const waypoint of [...pinsInWindow, second]) {
        const piece = orthogonal(viaPins.at(-1), waypoint, index, ignored, routeIndex, line);
        viaPins.push(...piece.slice(1));
      }
      const terminalAware = [first];
      for (const waypoint of [...pinsInWindow, second]) {
        const cursor = terminalAware.at(-1);
        const atTarget = waypoint === second && end === line.route.length - 1;
        const horizontalArrival = atTarget && ["left", "right"].includes(line.to.physicalSide);
        const verticalArrival = atTarget && ["top", "bottom"].includes(line.to.physicalSide);
        const piece = cursor.x === waypoint.x || cursor.y === waypoint.y
          ? [cursor, waypoint]
          : horizontalArrival
            ? [cursor, { x: cursor.x, y: waypoint.y }, waypoint]
            : verticalArrival
              ? [cursor, { x: waypoint.x, y: cursor.y }, waypoint]
              : orthogonal(cursor, waypoint, index, ignored, routeIndex, line);
        terminalAware.push(...piece.slice(1));
      }
      const replacements = [
        orthogonal(first, second, index, ignored, routeIndex, line),
        simplify([first, { x: first.x, y: second.y }, second]),
        simplify([first, { x: second.x, y: first.y }, second]),
        simplifyKeepingPins(line, viaPins),
        simplifyKeepingPins(line, terminalAware),
      ];
      const currentScore = candidateScore(line.route, index, ignored, routeIndex, line);
      let bestRoute = line.route;
      let bestScore = currentScore;
      for (const replacement of replacements) {
        const candidate = { ...line };
        candidate.route = simplifyKeepingPins(line, [
          ...line.route.slice(0, start),
          ...replacement,
          ...line.route.slice(end + 1),
        ]);
        enforceTerminalStubs(candidate);
        materializeSharedPins(candidate);
        const missingGeometry = geometricPins.some((pin) => !routeContainsPoint(candidate.route, pin));
        if (missingGeometry || !routeContainsRequiredPins(line, candidate.route)
          || !preservesExistingSharedTerminalRuns(line, candidate.route)
          || hasImmediateReverse(candidate.route)) continue;
        const score = candidateScore(candidate.route, index, ignored, routeIndex, line);
        if (score < bestScore - 0.5) {
          bestRoute = candidate.route;
          bestScore = score;
        }
      }
      if (bestRoute !== line.route) {
        line.route = bestRoute;
        improved = true;
      } else {
        start += 1;
      }
    }
  }
  return improved;
}

// Docks follow the route: a lateral jog right after the escape stub slides
// the dock along its side instead — an off-center dock beats a staircase.
// Named ports with several attachments keep their join identity untouched.
function slideDocks(scene, index) {
  let changed = false;
  const sideDocks = new Map();
  const register = (target, side, point) => {
    const key = `${target.path}:${side}`;
    if (!sideDocks.has(key)) sideDocks.set(key, []);
    sideDocks.get(key).push(point);
  };
  for (const object of scene.objects) {
    for (const port of object.ports.values()) if (port.point) register(port.anchor ?? object, port.physicalSide, port.point);
  }
  for (const line of scene.lines) {
    for (const endpoint of [line.from, line.to]) {
      if (endpoint && !endpoint.port && endpoint.point) register(dockTarget(endpoint), endpoint.physicalSide, endpoint.point);
    }
  }

  for (const line of scene.lines) {
    if (line.route.length < 3) continue;
    for (const end of ["from", "to"]) {
      const endpoint = line[end];
      if (!endpoint?.point || (endpoint.port?.attachments.length ?? 1) > 1) continue;
      if (endpoint.port?.group && ["merge", "bundle"].includes(endpoint.port.group.affinity)) continue;
      const side = endpoint.physicalSide;
      if (!side) continue;
      const fromEnd = end === "from";
      const route = line.route;
      const dock = fromEnd ? route[0] : route.at(-1);
      const escape = fromEnd ? route[1] : route.at(-2);
      const beyond = fromEnd ? route[2] : route.at(-3);
      if (!beyond) continue;
      const lateralAxis = side === "top" || side === "bottom" ? "x" : "y";
      const normalAxis = lateralAxis === "x" ? "y" : "x";
      // the stub must be normal to the side and the next run purely lateral
      if (escape[lateralAxis] !== dock[lateralAxis] || beyond[normalAxis] !== escape[normalAxis]) continue;
      const target = beyond[lateralAxis];
      const box = dockTarget(endpoint).box;
      const low = (lateralAxis === "x" ? box.x : box.y) + 10;
      const high = (lateralAxis === "x" ? box.x + box.width : box.y + box.height) - 10;
      if (target < low || target > high) continue;
      const siblings = sideDocks.get(`${dockTarget(endpoint).path}:${side}`) ?? [];
      if (!preservesDockOrder(siblings, endpoint.point, lateralAxis, target)) continue;
      // the new stub column must not clip an obstacle
      const movedDock = { ...dock, [lateralAxis]: target };
      const movedEscape = { ...escape, [lateralAxis]: target };
      const ignored = ignoredObjects(line, index);
      const blocked = [...index.querySegment(movedDock, movedEscape)]
        .some((object) => !ignored.has(object) && segmentHitsBox(movedDock, movedEscape, object.box));
      if (blocked) continue;
      dock[lateralAxis] = target;
      escape[lateralAxis] = target;
      endpoint.point[lateralAxis] = target;
      line.route = simplifyKeepingPins(line, route);
      changed = true;
    }
  }
  return changed;
}

// Bounded aesthetics sweeps after every line is routed. The route index is
// rebuilt per pass; accepted improvements are inserted immediately, and stale
// entries of a changed line only over-penalize, never hide a conflict.
function improveRoutes(scene, index) {
  for (let pass = 0; pass < 2; pass += 1) {
    const routeIndex = new SpatialIndex([]);
    for (const line of scene.lines) indexRoute(routeIndex, line);
    let improved = false;
    for (const line of scene.lines) {
      if (collapseJogs(line, index, routeIndex)) {
        indexRoute(routeIndex, line);
        improved = true;
      }
    }
    if (!improved) break;
  }
}

function routeSegmentIndex(scene) {
  const index = new SpatialIndex([]);
  for (const line of scene.lines) {
    if (line.space === "overlay") continue;
    for (let segmentIndex = 1; segmentIndex < line.route.length; segmentIndex += 1) {
      const first = line.route[segmentIndex - 1];
      const second = line.route[segmentIndex];
      index.insert({
        line,
        segmentIndex: segmentIndex - 1,
        first,
        second,
        box: {
          x: Math.min(first.x, second.x) - 2,
          y: Math.min(first.y, second.y) - 2,
          width: Math.abs(first.x - second.x) + 4,
          height: Math.abs(first.y - second.y) + 4,
        },
      });
    }
  }
  return index;
}

function bundleLaneClearance(firstLine, secondLine) {
  for (const membership of firstLine.shareMemberships ?? []) {
    if (membership.group.mode !== "bundle") continue;
    const other = (secondLine.shareMemberships ?? [])
      .find((candidate) => candidate.group === membership.group);
    if (!other || other.laneIndex === membership.laneIndex) continue;
    const firstPin = membership.group.bundle?.pinByLine?.get(firstLine);
    const secondPin = membership.group.bundle?.pinByLine?.get(secondLine);
    if (firstPin && secondPin) return Math.max(4, Math.hypot(firstPin.x - secondPin.x, firstPin.y - secondPin.y));
    return ROUTE_CLEARANCE;
  }
  return 0;
}

function parallelBundleLanesTooClose(first, second, clearance) {
  const firstHorizontal = first.first.y === first.second.y;
  const secondHorizontal = second.first.y === second.second.y;
  if (firstHorizontal !== secondHorizontal) return false;
  if (firstHorizontal) {
    const overlap = Math.min(Math.max(first.first.x, first.second.x), Math.max(second.first.x, second.second.x))
      - Math.max(Math.min(first.first.x, first.second.x), Math.min(second.first.x, second.second.x));
    return overlap > 2 && Math.abs(first.first.y - second.first.y) < clearance - 0.001;
  }
  const overlap = Math.min(Math.max(first.first.y, first.second.y), Math.max(second.first.y, second.second.y))
    - Math.max(Math.min(first.first.y, first.second.y), Math.min(second.first.y, second.second.y));
  return overlap > 2 && Math.abs(first.first.x - second.first.x) < clearance - 0.001;
}

function crossingDetails(line, points, routeIndex) {
  const crossings = new Map();
  let unexpectedOverlap = false;
  for (let index = 1; index < points.length; index += 1) {
    const candidate = { first: points[index - 1], second: points[index] };
    const nearby = routeIndex.queryBox({
      x: Math.min(candidate.first.x, candidate.second.x) - ROUTE_CLEARANCE,
      y: Math.min(candidate.first.y, candidate.second.y) - ROUTE_CLEARANCE,
      width: Math.abs(candidate.first.x - candidate.second.x) + ROUTE_CLEARANCE * 2,
      height: Math.abs(candidate.first.y - candidate.second.y) + ROUTE_CLEARANCE * 2,
    });
    for (const routed of nearby) {
      if (routed.line === line || line.space === "overlay" || routed.line.space === "overlay") continue;
      const clearance = bundleLaneClearance(line, routed.line);
      if (clearance && parallelBundleLanesTooClose(candidate, routed, clearance)) unexpectedOverlap = true;
      const interaction = segmentInteraction(candidate, routed);
      if (interaction === "overlap" && !segmentsMayShareGeometry(line, routed.line, candidate, routed)) {
        unexpectedOverlap = true;
      }
      if (interaction !== "crossing") continue;
      const horizontal = candidate.first.y === candidate.second.y ? candidate : routed;
      const vertical = horizontal === candidate ? routed : candidate;
      const x = vertical.first.x;
      const y = horizontal.first.y;
      crossings.set(`${routed.line.id}:${routed.segmentIndex}:${Math.round(x * 1000)}:${Math.round(y * 1000)}`, {
        line: routed.line,
        segment: routed,
        x,
        y,
      });
    }
  }
  return { crossings: [...crossings.values()], unexpectedOverlap };
}

function routeLengthAndBends(points) {
  let length = 0;
  let bends = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.abs(points[index].x - points[index - 1].x) + Math.abs(points[index].y - points[index - 1].y);
    if (index < 2) continue;
    const previousHorizontal = points[index - 2].y === points[index - 1].y;
    const currentHorizontal = points[index - 1].y === points[index].y;
    if (previousHorizontal !== currentHorizontal) bends += 1;
  }
  return { length, bends };
}

function boundedRefinementCoordinates(values, preferred, limit = 18) {
  const sorted = [...new Set(values.filter(Number.isFinite).map((value) => Math.round(value * 2) / 2))]
    .sort((first, second) => Math.abs(first - preferred) - Math.abs(second - preferred) || first - second);
  if (sorted.length <= limit) return sorted;
  const extremes = [...sorted].sort((first, second) => first - second);
  return [...new Set([...sorted.slice(0, limit - 4), ...extremes.slice(0, 2), ...extremes.slice(-2)])];
}

function commonAncestor(first, second) {
  const firstAncestors = new Set();
  for (let current = first; current; current = current.parent) firstAncestors.add(current);
  for (let current = second; current; current = current.parent) if (firstAncestors.has(current)) return current;
  return null;
}

function refinementCandidate(points, line) {
  const required = line.requiredRoutePins ?? [];
  return simplify(points, required);
}

function crossingRefinementCandidates(scene, line, objectIndex, routeIndex, currentCrossings) {
  const start = escapePoint(line.from, line.from.routeEscapeDistance);
  const end = escapePoint(line.to, line.to.routeEscapeDistance);
  const lca = commonAncestor(line.from.object, line.to.object) ?? scene.root;
  const searchBox = {
    x: Math.min(...line.route.map((point) => point.x)) - 96,
    y: Math.min(...line.route.map((point) => point.y)) - 96,
    width: Math.max(...line.route.map((point) => point.x)) - Math.min(...line.route.map((point) => point.x)) + 192,
    height: Math.max(...line.route.map((point) => point.y)) - Math.min(...line.route.map((point) => point.y)) + 192,
  };
  const nearby = [...objectIndex.queryBox(searchBox)].filter((object) => !ignoredObjects(line, objectIndex).has(object));
  const xValues = [start.x, end.x, ...line.route.map((point) => point.x)];
  const yValues = [start.y, end.y, ...line.route.map((point) => point.y)];
  for (const crossing of currentCrossings) {
    xValues.push(crossing.segment.first.x - 8, crossing.segment.first.x + 8, crossing.segment.second.x - 8, crossing.segment.second.x + 8);
    yValues.push(crossing.segment.first.y - 8, crossing.segment.first.y + 8, crossing.segment.second.y - 8, crossing.segment.second.y + 8);
    for (const point of crossing.line.route) {
      xValues.push(point.x - ROUTE_CLEARANCE, point.x + ROUTE_CLEARANCE);
      yValues.push(point.y - ROUTE_CLEARANCE, point.y + ROUTE_CLEARANCE);
    }
  }
  for (const object of nearby) {
    xValues.push(object.box.x - ROUTE_CLEARANCE, object.box.x + object.box.width + ROUTE_CLEARANCE);
    yValues.push(object.box.y - ROUTE_CLEARANCE, object.box.y + object.box.height + ROUTE_CLEARANCE);
  }
  if (lca?.box) {
    xValues.push(lca.box.x - ROUTE_CLEARANCE, lca.box.x + lca.box.width + ROUTE_CLEARANCE);
    yValues.push(lca.box.y - ROUTE_CLEARANCE, lca.box.y + lca.box.height + ROUTE_CLEARANCE);
  }
  const xs = boundedRefinementCoordinates(xValues, (start.x + end.x) / 2);
  const ys = boundedRefinementCoordinates(yValues, (start.y + end.y) / 2);
  const candidates = [];
  const compose = (interior) => candidates.push(refinementCandidate([
    line.from.point,
    start,
    ...interior,
    end,
    line.to.point,
  ], line));
  for (const x of xs) compose([{ x, y: start.y }, { x, y: end.y }]);
  for (const y of ys) compose([{ x: start.x, y }, { x: end.x, y }]);

  const allocations = [...new Set([...(line.regionTracks?.values() ?? [])].map((track) => track.allocation))].filter(Boolean);
  const vertical = allocations.filter((allocation) => allocation.axis === "vertical").map((allocation) => allocation.coordinate);
  const horizontal = allocations.filter((allocation) => allocation.axis === "horizontal").map((allocation) => allocation.coordinate);
  const sourceX = [...vertical].sort((first, second) => Math.abs(first - start.x) - Math.abs(second - start.x))[0];
  const targetX = [...vertical].sort((first, second) => Math.abs(first - end.x) - Math.abs(second - end.x))[0];
  const sourceY = [...horizontal].sort((first, second) => Math.abs(first - start.y) - Math.abs(second - start.y))[0];
  const targetY = [...horizontal].sort((first, second) => Math.abs(first - end.y) - Math.abs(second - end.y))[0];
  if (sourceX != null && targetX != null) {
    for (const y of ys) compose([
      { x: sourceX, y: start.y },
      { x: sourceX, y },
      { x: targetX, y },
      { x: targetX, y: end.y },
    ]);
    if (lca?.box) {
      for (const y of [lca.box.y - ROUTE_CLEARANCE, lca.box.y + lca.box.height + ROUTE_CLEARANCE]) {
        for (const x of [lca.box.x - ROUTE_CLEARANCE, lca.box.x + lca.box.width + ROUTE_CLEARANCE]) {
          compose([
            { x: sourceX, y: start.y },
            { x: sourceX, y },
            { x, y },
            { x, y: end.y },
          ]);
        }
      }
    }
  }
  if (sourceY != null && targetY != null) {
    for (const x of xs) compose([
      { x: start.x, y: sourceY },
      { x, y: sourceY },
      { x, y: targetY },
      { x: end.x, y: targetY },
    ]);
  }
  return candidates;
}

function candidateHitsObstacle(points, objectIndex, ignored, line) {
  if (containerTopologyViolation(points, objectIndex, line)) return true;
  for (let index = 1; index < points.length; index += 1) {
    for (const object of objectIndex.querySegment(points[index - 1], points[index])) {
      if (!ignored.has(object)
        && obstacleInteraction(points[index - 1], points[index], object) === "blocked") return true;
    }
  }
  return false;
}

function hasConstrainedRefinementTopology(line) {
  const authoredSegments = line.segments.filter((segment) => segment.region || segment.corridor || segment.waypoint);
  if (authoredSegments.length > 1 || (line.requiredRoutePins?.length ?? 0) > 1) return true;
  return (line.shareMemberships ?? []).some((membership) => ["merge", "bundle"].includes(membership.group.mode));
}

function refinementGridCoordinates(scene, line, objectIndex, routeIndex, currentCrossings, start, end) {
  const lca = commonAncestor(line.from.object, line.to.object) ?? scene.root;
  const ignored = ignoredObjects(line, objectIndex);
  const xValues = [start.x, end.x, ...line.route.map((point) => point.x)];
  const yValues = [start.y, end.y, ...line.route.map((point) => point.y)];
  const crossingXValues = [];
  const crossingYValues = [];
  const bundleXValues = [];
  const bundleYValues = [];
  for (const crossing of currentCrossings) {
    for (const point of crossing.line.route) {
      xValues.push(point.x - ROUTE_CLEARANCE, point.x + ROUTE_CLEARANCE);
      yValues.push(point.y - ROUTE_CLEARANCE, point.y + ROUTE_CLEARANCE);
      crossingXValues.push(point.x - ROUTE_CLEARANCE, point.x + ROUTE_CLEARANCE);
      crossingYValues.push(point.y - ROUTE_CLEARANCE, point.y + ROUTE_CLEARANCE);
    }
  }
  const search = lca?.box ?? {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(start.x - end.x),
    height: Math.abs(start.y - end.y),
  };
  for (const object of objectIndex.queryBox(search)) {
    if (ignored.has(object)) continue;
    xValues.push(object.box.x - ROUTE_CLEARANCE, object.box.x + object.box.width + ROUTE_CLEARANCE);
    yValues.push(object.box.y - ROUTE_CLEARANCE, object.box.y + object.box.height + ROUTE_CLEARANCE);
  }
  for (const routed of routeIndex.queryBox(search)) {
    if (!bundleLaneClearance(line, routed.line)) continue;
    for (const point of [routed.first, routed.second]) {
      bundleXValues.push(point.x - ROUTE_CLEARANCE, point.x + ROUTE_CLEARANCE);
      bundleYValues.push(point.y - ROUTE_CLEARANCE, point.y + ROUTE_CLEARANCE);
    }
  }
  for (const track of line.regionTracks?.values() ?? []) {
    const allocation = track.allocation;
    if (!allocation) continue;
    if (allocation.axis === "vertical") xValues.push(allocation.coordinate);
    else yValues.push(allocation.coordinate);
  }
  if (lca?.box) {
    xValues.push(lca.box.x - ROUTE_CLEARANCE, lca.box.x + lca.box.width + ROUTE_CLEARANCE);
    yValues.push(lca.box.y - ROUTE_CLEARANCE, lca.box.y + lca.box.height + ROUTE_CLEARANCE);
  }
  const preferredX = (start.x + end.x) / 2;
  const preferredY = (start.y + end.y) / 2;
  return {
    start,
    end,
    xs: [...new Set([...boundedRefinementCoordinates(xValues, preferredX, 28),
      ...boundedRefinementCoordinates(crossingXValues, preferredX, 16),
      ...boundedRefinementCoordinates(bundleXValues, preferredX, 16), start.x, end.x])]
      .sort((first, second) => first - second),
    ys: [...new Set([...boundedRefinementCoordinates(yValues, preferredY, 28),
      ...boundedRefinementCoordinates(crossingYValues, preferredY, 16),
      ...boundedRefinementCoordinates(bundleYValues, preferredY, 16), start.y, end.y])]
      .sort((first, second) => first - second),
  };
}

function segmentWithinSharedRun(first, second, run) {
  const horizontal = first.y === second.y;
  if (horizontal !== (run.first.y === run.second.y)) return false;
  if (horizontal) {
    return first.y === run.first.y
      && Math.min(first.x, second.x) >= Math.min(run.first.x, run.second.x)
      && Math.max(first.x, second.x) <= Math.max(run.first.x, run.second.x);
  }
  return first.x === run.first.x
    && Math.min(first.y, second.y) >= Math.min(run.first.y, run.second.y)
    && Math.max(first.y, second.y) <= Math.max(run.first.y, run.second.y);
}

function existingSharedTerminalPath(line, endpoint) {
  const runs = (line.shareMemberships ?? []).filter((membership) => membership.group.mode === "merge")
    .flatMap((membership) => membership.group.allowedSharedRuns ?? [])
    .filter((run) => (run.members ?? []).includes(line));
  if (!runs.length) return null;
  const points = endpoint === line.from ? line.route : [...line.route].reverse();
  const shared = [points[0]];
  for (let index = 1; index < points.length; index += 1) {
    if (!runs.some((run) => segmentWithinSharedRun(points[index - 1], points[index], run))) break;
    shared.push(points[index]);
  }
  return shared.length > 1 ? shared : null;
}

function pushRefinementState(heap, state) {
  heap.push(state);
  for (let index = heap.length - 1; index > 0;) {
    const parent = Math.floor((index - 1) / 2);
    if ((heap[parent].priority ?? heap[parent].cost) <= (heap[index].priority ?? heap[index].cost)) break;
    [heap[parent], heap[index]] = [heap[index], heap[parent]];
    index = parent;
  }
}

function popRefinementState(heap) {
  const first = heap[0];
  const last = heap.pop();
  if (heap.length) {
    heap[0] = last;
    for (let index = 0;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let next = index;
      if (left < heap.length && (heap[left].priority ?? heap[left].cost) < (heap[next].priority ?? heap[next].cost)) next = left;
      if (right < heap.length && (heap[right].priority ?? heap[right].cost) < (heap[next].priority ?? heap[next].cost)) next = right;
      if (next === index) break;
      [heap[index], heap[next]] = [heap[next], heap[index]];
      index = next;
    }
  }
  return first;
}

function pointInsideChannelCell(point, cell) {
  const box = cell.geometry;
  return point.x >= box.x - 0.001 && point.x <= box.x + box.width + 0.001
    && point.y >= box.y - 0.001 && point.y <= box.y + box.height + 0.001;
}

function channelOwnerSet(line) {
  const owners = new Set();
  for (const endpoint of [line.from, line.to]) {
    for (let object = endpoint.object; object; object = object.parent) owners.add(object);
  }
  return owners;
}

function channelCellsAtPoint(scene, point, owners) {
  return scene.channelMesh.filter((cell) => owners.has(cell.owner) && pointInsideChannelCell(point, cell))
    .sort((first, second) => first.geometry.width * first.geometry.height - second.geometry.width * second.geometry.height
      || first.key.localeCompare(second.key));
}

function channelCellSpine(scene, line, cell) {
  for (const track of line.regionTracks?.values() ?? []) {
    const allocation = track.allocation;
    if (!allocation) continue;
    const trackCell = scene.channelCellByKey.get(allocation.trackCellKey);
    if (trackCell?.slotKey === cell.slotKey && allocation.axis === cell.geometry.axis) return allocation.coordinate;
  }
  if (cell.geometry.axis === "vertical") return cell.geometry.x + cell.geometry.width / 2;
  if (cell.geometry.axis === "horizontal") return cell.geometry.y + cell.geometry.height / 2;
  return null;
}

function channelPortalPoint(scene, line, first, second, portal) {
  const values = [];
  if (portal.boundaryAxis === "vertical") {
    if (first.geometry.axis === "horizontal") values.push(channelCellSpine(scene, line, first));
    if (second.geometry.axis === "horizontal") values.push(channelCellSpine(scene, line, second));
    const coordinate = values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : (portal.start + portal.end) / 2;
    return { x: portal.coordinate, y: Math.max(portal.start, Math.min(portal.end, coordinate)) };
  }
  if (first.geometry.axis === "vertical") values.push(channelCellSpine(scene, line, first));
  if (second.geometry.axis === "vertical") values.push(channelCellSpine(scene, line, second));
  const coordinate = values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : (portal.start + portal.end) / 2;
  return { x: Math.max(portal.start, Math.min(portal.end, coordinate)), y: portal.coordinate };
}

function channelCellInteriorRoute(scene, line, cell, start, end) {
  if (samePoint(start, end)) return [start];
  if (start.x === end.x || start.y === end.y) return [start, end];
  const spine = channelCellSpine(scene, line, cell);
  if (cell.geometry.axis === "vertical") {
    return [start, { x: spine, y: start.y }, { x: spine, y: end.y }, end];
  }
  if (cell.geometry.axis === "horizontal") {
    return [start, { x: start.x, y: spine }, { x: end.x, y: spine }, end];
  }
  const horizontalFirst = [start, { x: end.x, y: start.y }, end];
  const verticalFirst = [start, { x: start.x, y: end.y }, end];
  return routeLengthAndBends(horizontalFirst).bends <= routeLengthAndBends(verticalFirst).bends
    ? horizontalFirst : verticalFirst;
}

function channelRouteDirection(first, second) {
  if (samePoint(first, second)) return null;
  return first.y === second.y ? "horizontal" : "vertical";
}

function channelRouteCost(points, incomingDirection = null) {
  const normalized = simplify(points);
  const geometry = routeLengthAndBends(normalized);
  let firstDirection = null;
  let lastDirection = incomingDirection;
  for (let index = 1; index < normalized.length; index += 1) {
    const direction = channelRouteDirection(normalized[index - 1], normalized[index]);
    if (!direction) continue;
    firstDirection ??= direction;
    lastDirection = direction;
  }
  const entryBend = incomingDirection && firstDirection && incomingDirection !== firstDirection ? 1 : 0;
  return {
    cost: geometry.length + (geometry.bends + entryBend) * 18,
    lastDirection,
    points: normalized,
  };
}

function channelGraphStateKey(cellKey, point, direction) {
  return `${cellKey}:${Math.round(point.x * 1000)}:${Math.round(point.y * 1000)}:${direction ?? "none"}`;
}

// Select the coarse itinerary on the canonical sparse channel mesh. A search
// state is an exact cell-entry point plus the incoming route direction. Every
// transition is costed using the same centered in-cell geometry that will be
// emitted, so the graph cannot prefer a detour hidden by cell-center proxies.
function channelGraphPiece(scene, line, start, end) {
  const owners = channelOwnerSet(line);
  const starts = channelCellsAtPoint(scene, start, owners);
  const ends = channelCellsAtPoint(scene, end, owners);
  if (!starts.length || !ends.length) return null;
  const endKeys = new Set(ends.map((cell) => cell.key));
  const states = new Map();
  const heap = [];
  for (const cell of starts) {
    const key = channelGraphStateKey(cell.key, start, null);
    const state = {
      key,
      cellKey: cell.key,
      entryPoint: start,
      direction: null,
      cost: 0,
      previous: null,
      routeFromPrevious: null,
      throughCellKey: null,
    };
    state.priority = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
    if (states.get(key)?.cost <= state.cost) continue;
    states.set(key, state);
    pushRefinementState(heap, state);
  }
  let result = null;
  while (heap.length) {
    const current = popRefinementState(heap);
    if (states.get(current.key) !== current) continue;
    if (current.terminal) {
      result = current;
      break;
    }
    const cell = scene.channelCellByKey.get(current.cellKey);
    if (endKeys.has(cell.key)) {
      const terminalRoute = channelRouteCost(
        channelCellInteriorRoute(scene, line, cell, current.entryPoint, end),
        current.direction,
      );
      const terminal = {
        key: `terminal:${current.key}`,
        terminal: true,
        cost: current.cost + terminalRoute.cost,
        priority: current.cost + terminalRoute.cost,
        previous: current,
        routeFromPrevious: terminalRoute.points,
        throughCellKey: cell.key,
      };
      states.set(terminal.key, terminal);
      pushRefinementState(heap, terminal);
    }
    for (const portal of cell.portals) {
      const neighbor = scene.channelCellByKey.get(portal.to);
      if (!neighbor || !owners.has(neighbor.owner)) continue;
      const exitPoint = channelPortalPoint(scene, line, cell, neighbor, portal);
      const localRoute = channelRouteCost(
        channelCellInteriorRoute(scene, line, cell, current.entryPoint, exitPoint),
        current.direction,
      );
      const cost = current.cost + localRoute.cost;
      const key = channelGraphStateKey(neighbor.key, exitPoint, localRoute.lastDirection);
      if (states.get(key)?.cost <= cost) continue;
      const next = {
        key,
        cellKey: neighbor.key,
        entryPoint: exitPoint,
        direction: localRoute.lastDirection,
        cost,
        priority: cost + Math.abs(end.x - exitPoint.x) + Math.abs(end.y - exitPoint.y),
        previous: current,
        routeFromPrevious: localRoute.points,
        throughCellKey: cell.key,
      };
      states.set(key, next);
      pushRefinementState(heap, next);
    }
  }
  if (!result) return null;
  const transitions = [];
  for (let state = result; state?.previous; state = state.previous) transitions.push(state);
  transitions.reverse();
  const points = [start];
  const cellKeys = [];
  for (const transition of transitions) {
    points.push(...transition.routeFromPrevious.slice(1));
    if (cellKeys.at(-1) !== transition.throughCellKey) cellKeys.push(transition.throughCellKey);
  }
  const route = refinementCandidate(points, line);
  route.channelCellPath = cellKeys;
  return route;
}

function channelGraphRoute(scene, line) {
  const fromShared = existingSharedTerminalPath(line, line.from);
  const toShared = existingSharedTerminalPath(line, line.to);
  const fromFixed = fromShared ?? [line.from.point, escapePoint(line.from, line.from.routeEscapeDistance)];
  const toFixed = toShared ? [...toShared].reverse() : [escapePoint(line.to, line.to.routeEscapeDistance), line.to.point];
  const required = (line.requiredRoutePins ?? []).filter((pin) =>
    !routeContainsPoint(fromFixed, pin) && !routeContainsPoint(toFixed, pin));
  const waypoints = [fromFixed.at(-1), ...required, toFixed[0]]
    .filter((point, index, points) => index === 0 || !samePoint(point, points[index - 1]));
  const interior = [waypoints[0]];
  const cellPath = [];
  for (let index = 1; index < waypoints.length; index += 1) {
    const piece = channelGraphPiece(scene, line, waypoints[index - 1], waypoints[index]);
    if (!piece) return null;
    interior.push(...piece.slice(1));
    cellPath.push(...piece.channelCellPath.filter((key, cellIndex) =>
      !cellPath.length || cellIndex > 0 || cellPath.at(-1) !== key));
  }
  const route = refinementCandidate([...fromFixed, ...interior.slice(1), ...toFixed.slice(1)], line);
  route.channelCellPath = cellPath;
  return route;
}

function refinementGridPiece(scene, line, objectIndex, routeIndex, currentCrossings, start, end) {
  const { xs, ys } = refinementGridCoordinates(scene, line, objectIndex, routeIndex, currentCrossings, start, end);
  const startX = xs.indexOf(start.x);
  const startY = ys.indexOf(start.y);
  const endX = xs.indexOf(end.x);
  const endY = ys.indexOf(end.y);
  if (startX < 0 || startY < 0 || endX < 0 || endY < 0) return null;
  const ignored = ignoredObjects(line, objectIndex);
  const key = (x, y, direction) => `${x}:${y}:${direction}`;
  const states = new Map();
  const heap = [];
  const initial = { x: startX, y: startY, direction: 0, cost: 0, previous: null };
  states.set(key(initial.x, initial.y, initial.direction), initial);
  pushRefinementState(heap, initial);
  let result = null;
  while (heap.length) {
    const current = popRefinementState(heap);
    if (states.get(key(current.x, current.y, current.direction)) !== current) continue;
    if (current.x === endX && current.y === endY) {
      result = current;
      break;
    }
    for (const [deltaX, deltaY, direction] of [[-1, 0, 1], [1, 0, 1], [0, -1, 2], [0, 1, 2]]) {
      const x = current.x + deltaX;
      const y = current.y + deltaY;
      if (x < 0 || x >= xs.length || y < 0 || y >= ys.length) continue;
      const first = { x: xs[current.x], y: ys[current.y] };
      const second = { x: xs[x], y: ys[y] };
      if (candidateHitsObstacle([first, second], objectIndex, ignored, line)) continue;
      const details = crossingDetails(line, [first, second], routeIndex);
      if (details.unexpectedOverlap) continue;
      const bend = current.direction && current.direction !== direction ? 18 : 0;
      const length = Math.abs(first.x - second.x) + Math.abs(first.y - second.y);
      const cost = current.cost + details.crossings.length * CROSSING_REFINEMENT_PENALTY + bend + length;
      const stateKey = key(x, y, direction);
      if (states.get(stateKey)?.cost <= cost) continue;
      const next = { x, y, direction, cost, previous: current };
      states.set(stateKey, next);
      pushRefinementState(heap, next);
    }
  }
  if (!result) return null;
  const points = [];
  for (let current = result; current; current = current.previous) points.push({ x: xs[current.x], y: ys[current.y] });
  points.reverse();
  return points;
}

// Find one bounded visibility-grid route through coordinates derived from the
// current route, crossed routes, local obstacles, and the common ancestor.
// Required corridor pins split the search into independently bounded pieces;
// this preserves authored topology without disabling collision repair.
function refinementGridRoute(scene, line, objectIndex, routeIndex, currentCrossings) {
  const fromShared = existingSharedTerminalPath(line, line.from);
  const toShared = existingSharedTerminalPath(line, line.to);
  const fromFixed = fromShared ?? [line.from.point, escapePoint(line.from, line.from.routeEscapeDistance)];
  const toFixed = toShared ? [...toShared].reverse() : [escapePoint(line.to, line.to.routeEscapeDistance), line.to.point];
  const required = (line.requiredRoutePins ?? []).filter((pin) =>
    !routeContainsPoint(fromFixed, pin) && !routeContainsPoint(toFixed, pin));
  const waypoints = [fromFixed.at(-1), ...required, toFixed[0]]
    .filter((point, index, points) => index === 0 || !samePoint(point, points[index - 1]));
  const interior = [waypoints[0]];
  for (let index = 1; index < waypoints.length; index += 1) {
    const piece = refinementGridPiece(scene, line, objectIndex, routeIndex, currentCrossings,
      waypoints[index - 1], waypoints[index]);
    if (!piece) return null;
    interior.push(...piece.slice(1));
  }
  return refinementCandidate([...fromFixed, ...interior.slice(1), ...toFixed.slice(1)], line);
}

function routeContainsRequiredPins(line, points) {
  return (line.requiredRoutePins ?? []).every((pin) => routeContainsPoint(points, pin));
}

function routeContainsSharedRun(points, run) {
  const horizontal = run.first.y === run.second.y;
  return points.slice(1).some((second, index) => {
    const first = points[index];
    if (horizontal) {
      return first.y === second.y && first.y === run.first.y
        && Math.min(first.x, second.x) <= Math.min(run.first.x, run.second.x)
        && Math.max(first.x, second.x) >= Math.max(run.first.x, run.second.x);
    }
    return first.x === second.x && first.x === run.first.x
      && Math.min(first.y, second.y) <= Math.min(run.first.y, run.second.y)
      && Math.max(first.y, second.y) >= Math.max(run.first.y, run.second.y);
  });
}

function preservesExistingSharedTerminalRuns(line, points) {
  for (const membership of line.shareMemberships ?? []) {
    if (membership.group.mode !== "merge") continue;
    for (const run of membership.group.allowedSharedRuns ?? []) {
      if ((run.members ?? []).includes(line) && !routeContainsSharedRun(points, run)) return false;
    }
  }
  return true;
}

function normalizedRefinementCandidate(line, points) {
  const candidate = { ...line, route: points.map((point) => ({ ...point })) };
  // Repairing the target bridge can invalidate the source bridge when the
  // candidate approaches the target from behind it. A second fixed pass
  // produces the same terminal geometry that will be committed later.
  enforceTerminalStubs(candidate);
  enforceTerminalStubs(candidate);
  materializeSharedPins(candidate);
  return candidate.route;
}

// A route is refined against already committed geometry before it enters the
// route index. This preserves a planar lane that is available now instead of
// letting a later bundle member occupy it and turn a local repair into a
// coupled multi-line search.
function refineIncrementalRoute(scene, line, objectIndex, routeIndex) {
  const explicitBundle = (line.shareMemberships ?? []).some((membership) =>
    membership.group.mode === "bundle" && membership.group.source.kind === "explicit");
  if (!explicitBundle) return false;
  const ignored = ignoredObjects(line, objectIndex);
  const current = crossingDetails(line, line.route, routeIndex);
  const currentHitsObstacle = candidateHitsObstacle(line.route, objectIndex, ignored, line);
  if (!currentHitsObstacle && !current.unexpectedOverlap && !current.crossings.length) return false;

  let best = line.route;
  let bestHitsObstacle = currentHitsObstacle;
  let bestUnexpectedOverlap = current.unexpectedOverlap;
  let bestCrossings = current.crossings.length;
  let bestGeometry = routeLengthAndBends(best);
  const candidates = crossingRefinementCandidates(scene, line, objectIndex, routeIndex, current.crossings);
  const graph = channelGraphRoute(scene, line);
  if (graph) line.coarseCellPath = graph.channelCellPath;
  const normalizedGraph = graph ? normalizedRefinementCandidate(line, graph) : null;
  const graphBlocked = normalizedGraph && (hasImmediateReverse(normalizedGraph)
    || candidateHitsObstacle(normalizedGraph, objectIndex, ignored, line));
  const grid = !graph || graphBlocked
    ? refinementGridRoute(scene, line, objectIndex, routeIndex, current.crossings)
    : null;
  if (grid) candidates.unshift(grid);
  if (graph) candidates.unshift(graph);
  for (const rawCandidate of candidates) {
    const candidate = normalizedRefinementCandidate(line, rawCandidate);
    if (!routeContainsRequiredPins(line, candidate)
      || !preservesExistingSharedTerminalRuns(line, candidate)
      || hasImmediateReverse(candidate)
      || candidateHitsObstacle(candidate, objectIndex, ignored, line)) continue;
    const details = crossingDetails(line, candidate, routeIndex);
    if (details.unexpectedOverlap) continue;
    const geometry = routeLengthAndBends(candidate);
    const better = bestHitsObstacle
      || bestUnexpectedOverlap
      || details.crossings.length < bestCrossings
      || details.crossings.length === bestCrossings
        && geometry.length + geometry.bends * 18 < bestGeometry.length + bestGeometry.bends * 18 - 0.5;
    if (!better) continue;
    best = candidate;
    bestHitsObstacle = false;
    bestUnexpectedOverlap = false;
    bestCrossings = details.crossings.length;
    bestGeometry = geometry;
  }
  const improvesValidity = currentHitsObstacle && !bestHitsObstacle
    || current.unexpectedOverlap && !bestUnexpectedOverlap;
  if (!improvesValidity && bestCrossings >= current.crossings.length) return false;
  line.route = best;
  enforceTerminalStubs(line);
  materializeSharedPins(line);
  return true;
}

// Every route without a nested authored itinerary receives a bounded shortest-
// path pass. A formally valid but unnecessarily long fallback route must not
// bypass the same visibility-grid search used for collision repair. The grid
// is local and coordinate-bounded; this is not a pixel scan or a document-wide
// route graph.
function refineRouteCrossings(scene, objectIndex) {
  for (let pass = 0; pass < 2; pass += 1) {
    let changed = false;
    const initialIndex = routeSegmentIndex(scene);
    const affected = scene.lines.map((line, order) => {
      const details = crossingDetails(line, line.route, initialIndex);
      const hitsObstacle = candidateHitsObstacle(line.route, objectIndex, ignoredObjects(line, objectIndex), line);
      return { line, order, details, hitsObstacle };
    }).filter((entry) => entry.line.space !== "overlay" && !hasConstrainedRefinementTopology(entry.line))
      .sort((first, second) => Number(second.hitsObstacle) - Number(first.hitsObstacle)
        || Number(second.details.unexpectedOverlap) - Number(first.details.unexpectedOverlap)
        || second.details.crossings.length - first.details.crossings.length
        || second.line.route.length - first.line.route.length
        || second.order - first.order);
    for (const entry of affected) {
      const routeIndex = routeSegmentIndex(scene);
      const current = crossingDetails(entry.line, entry.line.route, routeIndex);
      let best = entry.line.route;
      let bestHitsObstacle = candidateHitsObstacle(best, objectIndex, ignoredObjects(entry.line, objectIndex), entry.line);
      let bestUnexpectedOverlap = current.unexpectedOverlap;
      let bestCrossings = current.crossings.length;
      let bestGeometry = routeLengthAndBends(best);
      let bestCost = bestGeometry.length + bestGeometry.bends * 18 + bestCrossings * CROSSING_REFINEMENT_PENALTY;
      const currentCost = bestCost;
      const ignored = ignoredObjects(entry.line, objectIndex);
      const graph = channelGraphRoute(scene, entry.line);
      if (graph) entry.line.coarseCellPath = graph.channelCellPath;
      const normalizedGraph = graph ? normalizedRefinementCandidate(entry.line, graph) : null;
      const graphBlocked = normalizedGraph && (hasImmediateReverse(normalizedGraph)
        || candidateHitsObstacle(normalizedGraph, objectIndex, ignored, entry.line));
      const grid = !graph || graphBlocked
        ? refinementGridRoute(scene, entry.line, objectIndex, routeIndex, current.crossings)
        : null;
      const candidates = crossingRefinementCandidates(scene, entry.line, objectIndex, routeIndex, current.crossings);
      if (grid) candidates.unshift(grid);
      if (graph) candidates.unshift(graph);
      for (const rawCandidate of candidates) {
        const candidate = normalizedRefinementCandidate(entry.line, rawCandidate);
        const pins = routeContainsRequiredPins(entry.line, candidate);
        const shared = preservesExistingSharedTerminalRuns(entry.line, candidate);
        const reversed = hasImmediateReverse(candidate);
        const obstacle = candidateHitsObstacle(candidate, objectIndex, ignored, entry.line);
        if (!pins || !shared || reversed || obstacle) continue;
        const details = crossingDetails(entry.line, candidate, routeIndex);
        if (details.unexpectedOverlap) continue;
        const geometry = routeLengthAndBends(candidate);
        const cost = geometry.length + geometry.bends * 18 + details.crossings.length * CROSSING_REFINEMENT_PENALTY;
        const better = bestHitsObstacle
          || bestUnexpectedOverlap
          || details.crossings.length <= bestCrossings && cost < bestCost - 0.5;
        if (!better) continue;
        best = candidate;
        bestHitsObstacle = false;
        bestUnexpectedOverlap = false;
        bestCrossings = details.crossings.length;
        bestGeometry = geometry;
        bestCost = cost;
      }
      const improvesValidity = entry.hitsObstacle && !bestHitsObstacle
        || current.unexpectedOverlap && !bestUnexpectedOverlap;
      if (!improvesValidity && bestCost >= currentCost - 0.5) continue;
      entry.line.route = best;
      enforceTerminalStubs(entry.line);
      materializeSharedPins(entry.line);
      changed = true;
    }
    if (!changed) break;
  }
}

function endpointRouteExcursion(line, endpoint) {
  const points = endpoint === line.from ? line.route : [...line.route].reverse();
  const axis = endpoint.physicalSide === "left" || endpoint.physicalSide === "right" ? "y" : "x";
  for (const point of points) {
    const delta = point[axis] - endpoint.point[axis];
    if (Math.abs(delta) > 0.5) return Math.sign(delta);
  }
  return 0;
}

// When equal remote projections leave same-side docks tied, the first route
// excursion provides the missing planar order: upward/leftward routes precede
// direct routes, which precede downward/rightward routes. Only crossing-
// involved, independent docks participate; authored PortGroup order is kept.
function repairCrossingDockOrder(scene) {
  const crossingIndex = routeSegmentIndex(scene);
  const crossingLines = new Set(scene.lines.filter((line) => crossingDetails(line, line.route, crossingIndex).crossings.length));
  const groups = new Map();
  for (const [lineOrder, line] of scene.lines.entries()) {
    for (const endpoint of [line.from, line.to]) {
      if (!crossingLines.has(line) || !endpoint?.point || endpoint.port?.group) continue;
      if ((endpoint.port?.attachments.length ?? 1) > 1) continue;
      const target = dockTarget(endpoint);
      const key = `${target.path}:${endpoint.physicalSide}`;
      const entries = groups.get(key) ?? [];
      entries.push({ line, lineOrder, endpoint, target });
      groups.set(key, entries);
    }
  }
  let changed = false;
  for (const entries of groups.values()) {
    if (entries.length < 2) continue;
    const axis = entries[0].endpoint.physicalSide === "left" || entries[0].endpoint.physicalSide === "right" ? "y" : "x";
    const slots = entries.map((entry) => entry.endpoint.point[axis]).sort((first, second) => first - second);
    const desired = [...entries].sort((first, second) => endpointRouteExcursion(first.line, first.endpoint) - endpointRouteExcursion(second.line, second.endpoint)
      || remoteCenter(first.line, first.endpoint)[axis] - remoteCenter(second.line, second.endpoint)[axis]
      || first.lineOrder - second.lineOrder
      || first.line.id.localeCompare(second.line.id));
    desired.forEach((entry, index) => {
      const coordinate = slots[index];
      if (Math.abs(entry.endpoint.point[axis] - coordinate) <= 0.5) return;
      entry.endpoint.point[axis] = coordinate;
      if (entry.endpoint.port) entry.endpoint.port.point[axis] = coordinate;
      changed = true;
    });
  }
  return changed;
}

function routeSegments(route) {
  const result = [];
  for (let index = 1; index < route.length; index += 1) {
    const first = route[index - 1];
    const second = route[index];
    const length = Math.abs(first.x - second.x) + Math.abs(first.y - second.y);
    if (length > 0) result.push({ first, second, length, index: index - 1 });
  }
  // a horizontal run reads better under a label than a vertical one; prefer
  // it whenever it offers meaningful room
  const tier = (segment) => segment.first.y === segment.second.y && segment.length > 30 ? 0 : 1;
  return result.sort((first, second) => tier(first) - tier(second) || second.length - first.length || first.index - second.index);
}

function displayedLabelText(label) {
  return label.role === "uml-keyword" ? `«${label.text}»` : label.text;
}

function labelSize(label) {
  const lines = String(displayedLabelText(label)).split("\n");
  return { width: Math.max(...lines.map((line) => line.length)) * 7.4 + 10, height: lines.length * 16 + 6 };
}

function boxesOverlap(first, second, padding = 0) {
  return first.x < second.x + second.width + padding
    && first.x + first.width + padding > second.x
    && first.y < second.y + second.height + padding
    && first.y + first.height + padding > second.y;
}

function positionAlong(segment, ratio) {
  return {
    x: segment.first.x + (segment.second.x - segment.first.x) * ratio,
    y: segment.first.y + (segment.second.y - segment.first.y) * ratio,
  };
}

function labelAngles(horizontal, label) {
  if (horizontal || label.orientation === "upright") return [0];
  if (label.orientation === "along") return [90];
  return [90, 0];
}

function pointLabelCandidates(point, horizontal, label, size, rank, directionalOffsets = new Map(), angle = 0) {
  const baseOffsets = [2, 10, 18, 32, 48, 72, 96];
  const visualWidth = angle ? size.height : size.width;
  const visualHeight = angle ? size.width : size.height;
  return [-1, 1].flatMap((direction) => {
    const offsets = [...new Set([...baseOffsets, ...(directionalOffsets.get(direction) ?? [])])].sort((first, second) => first - second);
    return offsets.map((offset, offsetIndex) => ({
      x: horizontal ? point.x - visualWidth / 2 : point.x + direction * (visualWidth / 2 + offset) - visualWidth / 2,
      y: horizontal ? point.y + direction * (visualHeight / 2 + offset) - visualHeight / 2 : point.y - visualHeight / 2,
      width: visualWidth,
      height: visualHeight,
      angle,
      textAnchor: angle || horizontal ? "middle" : direction < 0 ? "end" : "start",
      perpendicularDistance: offset,
      routeAnchor: point,
      routeHorizontal: horizontal,
      rank: rank + offsetIndex * 0.1,
    }));
  });
}

function boundedLocalValues(values, limit, preferred) {
  const unique = [...new Set(values.map((value) => Math.round(value * 10000) / 10000))]
    .sort((first, second) => Math.abs(first - preferred) - Math.abs(second - preferred) || first - second);
  if (unique.length <= limit) return unique;
  const central = unique.slice(0, limit - 4);
  const extremes = [...unique].sort((first, second) => first - second);
  return [...new Set([...central, ...extremes.slice(0, 2), ...extremes.slice(-2)])];
}

// A dense row may occupy every short perpendicular label offset. Query only
// a bounded local band, then add the exact offsets that clear nearby boxes;
// this stays deterministic and avoids a canvas-wide candidate search.
function localLabelOptions(segment, label, size, objectIndex, angle = 0) {
  const horizontal = segment.first.y === segment.second.y;
  const visualWidth = angle ? size.height : size.width;
  const visualHeight = angle ? size.width : size.height;
  const radius = Math.max(128, Math.min(320, Math.max(visualWidth, visualHeight) * 5));
  const left = Math.min(segment.first.x, segment.second.x);
  const right = Math.max(segment.first.x, segment.second.x);
  const top = Math.min(segment.first.y, segment.second.y);
  const bottom = Math.max(segment.first.y, segment.second.y);
  const nearby = objectIndex.queryBox({
    x: left - radius,
    y: top - radius,
    width: right - left + radius * 2,
    height: bottom - top + radius * 2,
  });
  const offsets = new Map([[-1, []], [1, []]]);
  const ratios = [];
  const clearance = 8;
  for (const object of nearby) {
    const box = object.box;
    if (horizontal) {
      if (box.x + box.width < left - visualWidth / 2 || box.x > right + visualWidth / 2) continue;
      const aboveDistance = segment.first.y - (box.y + box.height);
      const belowDistance = box.y - segment.first.y;
      if (aboveDistance >= 0 && aboveDistance <= radius) offsets.get(-1).push(segment.first.y - box.y + clearance);
      if (belowDistance >= 0 && belowDistance <= radius) offsets.get(1).push(box.y + box.height - segment.first.y + clearance);
      const delta = segment.second.x - segment.first.x;
      if (delta !== 0) {
        ratios.push((box.x - visualWidth / 2 - clearance - segment.first.x) / delta);
        ratios.push((box.x + box.width + visualWidth / 2 + clearance - segment.first.x) / delta);
      }
    } else {
      if (box.y + box.height < top - visualHeight / 2 || box.y > bottom + visualHeight / 2) continue;
      const leftDistance = segment.first.x - (box.x + box.width);
      const rightDistance = box.x - segment.first.x;
      if (leftDistance >= 0 && leftDistance <= radius) offsets.get(-1).push(segment.first.x - box.x + clearance);
      if (rightDistance >= 0 && rightDistance <= radius) offsets.get(1).push(box.x + box.width - segment.first.x + clearance);
      const delta = segment.second.y - segment.first.y;
      if (delta !== 0) {
        ratios.push((box.y - visualHeight / 2 - clearance - segment.first.y) / delta);
        ratios.push((box.y + box.height + visualHeight / 2 + clearance - segment.first.y) / delta);
      }
    }
  }
  for (const direction of [-1, 1]) {
    offsets.set(direction, boundedLocalValues(offsets.get(direction), 16, 0));
  }
  const boundedRatios = boundedLocalValues(ratios.filter((ratio) => ratio > 0 && ratio < 1), 16, 0.5);
  return { offsets, ratios: boundedRatios };
}

function segmentLabelCandidates(segment, label, size, rank, objectIndex) {
  const horizontal = segment.first.y === segment.second.y;
  const baseRatios = label.placement === "start" ? [0.2, 0.35]
    : label.placement === "end" ? [0.8, 0.65]
    : [0.5, 0.35, 0.65, 0.25, 0.75, 0.15, 0.85];
  return labelAngles(horizontal, label).flatMap((angle, angleIndex) => {
    const local = localLabelOptions(segment, label, size, objectIndex, angle);
    const ratios = label.placement === "start" || label.placement === "end"
      ? baseRatios
      : [...baseRatios, ...local.ratios];
    return ratios.flatMap((ratio, ratioIndex) =>
      pointLabelCandidates(positionAlong(segment, ratio), horizontal, label, size,
        rank + angleIndex * 0.75 + ratioIndex * 0.05, local.offsets, angle));
  });
}

function authoredSegmentRegions(scene, authored) {
  return [...scene.regions.values()].filter((region) => {
    if (authored.region?.kind === "padding") {
      return region.kind === "padding" && region.owner === authored.region.container && region.side === authored.region.side;
    }
    if (authored.region?.kind === "gap") return region.kind === "gap" && physicalGapContains(authored.region, region);
    if (authored.corridor) return region.corridors.includes(authored.corridor);
    return false;
  });
}

function segmentRegionPoint(segment, geometry) {
  if (segment.first.y === segment.second.y) {
    if (segment.first.y < geometry.y || segment.first.y > geometry.y + geometry.height) return null;
    const start = Math.max(Math.min(segment.first.x, segment.second.x), geometry.x);
    const end = Math.min(Math.max(segment.first.x, segment.second.x), geometry.x + geometry.width);
    return start <= end ? { x: (start + end) / 2, y: segment.first.y } : null;
  }
  if (segment.first.x < geometry.x || segment.first.x > geometry.x + geometry.width) return null;
  const start = Math.max(Math.min(segment.first.y, segment.second.y), geometry.y);
  const end = Math.min(Math.max(segment.first.y, segment.second.y), geometry.y + geometry.height);
  return start <= end ? { x: segment.first.x, y: (start + end) / 2 } : null;
}

function authoredRunPoints(segment, geometry, anchor, size, angle) {
  const horizontal = segment.first.y === segment.second.y;
  const start = horizontal ? Math.min(segment.first.x, segment.second.x) : Math.min(segment.first.y, segment.second.y);
  const end = horizontal ? Math.max(segment.first.x, segment.second.x) : Math.max(segment.first.y, segment.second.y);
  const alongExtent = horizontal ? angle ? size.height : size.width : angle ? size.width : size.height;
  const half = alongExtent / 2;
  // The label center belongs to the solved run; its box may overhang a short
  // run into adjacent free space. Requiring the whole label to fit between
  // the bends is what previously inflated narrow structural gaps.
  const low = start;
  const high = end;
  const regionStart = horizontal ? geometry.x : geometry.y;
  const regionEnd = regionStart + (horizontal ? geometry.width : geometry.height);
  const anchorValue = horizontal ? anchor.x : anchor.y;
  const clamp = (value) => Math.max(low, Math.min(high, value));
  const values = [
    anchorValue,
    regionStart,
    regionEnd,
    regionStart - half - 8,
    regionEnd + half + 8,
    (anchorValue + low) / 2,
    (anchorValue + high) / 2,
    low + half + 16,
    high - half - 16,
    low,
    high,
  ].map(clamp);
  const unique = [...new Set(values.map((value) => Math.round(value * 2) / 2))]
    .sort((first, second) => Math.abs(first - anchorValue) - Math.abs(second - anchorValue) || first - second);
  return unique.map((value) => horizontal ? { x: value, y: anchor.y } : { x: anchor.x, y: value });
}

function authoredSegmentLabelCandidates(scene, line, label, size, objectIndex) {
  const regions = authoredSegmentRegions(scene, label.authoredSegment);
  if (!regions.length) return [];
  const candidates = [];
  const routed = routeSegments(line.route);
  const lastIndex = Math.max(0, line.route.length - 2);
  for (const [prominence, segment] of routed.entries()) {
    for (const region of regions) {
      for (const cell of region.channelBinding.cells) {
        const geometry = cell.geometry;
        const segmentHorizontal = segment.first.y === segment.second.y;
        const followsRegionAxis = geometry.axis === "horizontal" ? segmentHorizontal : !segmentHorizontal;
        const routeRank = label.placement === "start" ? segment.index
          : label.placement === "end" ? lastIndex - segment.index
          : label.placement === "center" ? followsRegionAxis ? 0 : 1 + prominence
          : followsRegionAxis ? prominence : 2 + prominence;
        const point = segmentRegionPoint(segment, geometry);
        if (point) {
          for (const [angleIndex, angle] of labelAngles(segmentHorizontal, label).entries()) {
            const directionalOffsets = localLabelOptions(segment, label, size, objectIndex, angle).offsets;
            for (const [rank, runPoint] of authoredRunPoints(segment, geometry, point, size, angle).entries()) {
              candidates.push(...pointLabelCandidates(runPoint, segmentHorizontal, label, size,
                -4 + routeRank * 0.2 + angleIndex * 0.75 + rank * 0.02, directionalOffsets, angle)
                .map((candidate) => ({
                  ...candidate,
                  authoredRegion: region,
                  authoredCell: cell,
                  authoredRun: segment.index,
                  authoredAxis: followsRegionAxis,
                })));
            }
          }
        }
      }
    }
  }
  return candidates;
}

function endpointLabelCandidates(endpoint, label, size, rank) {
  const side = endpoint.physicalSide ?? "right";
  const vector = SIDE_VECTOR[side];
  const perpendicular = { x: -vector.y, y: vector.x };
  const horizontalSide = side === "left" || side === "right";
  const alongExtent = horizontalSide ? size.width : size.height;
  const perpendicularExtent = horizontalSide ? size.height : size.width;
  return [8, 18, 32].flatMap((offset, offsetIndex) => [-1, 1].flatMap((direction) => [0, 1, 2, 3, 4].map((tier) => {
    const perpendicularDistance = perpendicularExtent / 2 + 4 + tier * (perpendicularExtent + 6);
    const center = {
      x: endpoint.point.x + vector.x * (alongExtent / 2 + offset) + perpendicular.x * direction * perpendicularDistance,
      y: endpoint.point.y + vector.y * (alongExtent / 2 + offset) + perpendicular.y * direction * perpendicularDistance,
    };
    return {
      x: center.x - size.width / 2,
      y: center.y - size.height / 2,
      width: size.width,
      height: size.height,
      angle: 0,
      rank: rank + offsetIndex * 0.1 + tier * 0.05,
    };
  })));
}

function labelSpecs(line) {
  const specs = [];
  if (line.label != null) specs.push({ text: line.label, placement: "auto", orientation: "auto" });
  specs.push(...line.labels.map((label) => ({ placement: "auto", orientation: "auto", ...label })));
  for (const segment of line.segments) {
    if (segment.label != null) specs.push({
      text: segment.label,
      placement: segment.labelPlacement ?? "auto",
      orientation: segment.labelOrientation ?? "auto",
      authoredSegment: segment,
    });
  }
  for (const [end, labels] of line.endLabels.entries()) {
    for (const label of labels) specs.push({ placement: "auto", orientation: "upright", ...label, endpoint: end === 0 ? line.from : line.to });
  }
  return specs;
}

function labelRouteIndex(scene) {
  const index = new SpatialIndex([]);
  for (const line of scene.lines) {
    for (let segmentIndex = 1; segmentIndex < line.route.length; segmentIndex += 1) {
      const first = line.route[segmentIndex - 1];
      const second = line.route[segmentIndex];
      index.insert({
        line,
        first,
        second,
        box: {
          x: Math.min(first.x, second.x) - 2,
          y: Math.min(first.y, second.y) - 2,
          width: Math.abs(first.x - second.x) + 4,
          height: Math.abs(first.y - second.y) + 4,
        },
      });
    }
  }
  return index;
}

function labelCoversAuthorizedSharedRun(candidate, line, segment) {
  if (!segmentHitsBox(segment.first, segment.second, candidate, 1)) return false;
  for (let index = 1; index < line.route.length; index += 1) {
    const own = { first: line.route[index - 1], second: line.route[index] };
    if (segmentHitsBox(own.first, own.second, candidate, 1)
      && segmentsMayShareGeometry(line, segment.line, own, segment)) return true;
  }
  return false;
}

function labelContainerAtPoint(scene, point) {
  let result = null;
  let depth = -1;
  for (const object of scene.objects) {
    if (!object.visible || ["diagram", "row", "column", "grid", "legend"].includes(object.kind)) continue;
    if (object.children.length === 0 && !object.frame) continue;
    const box = object.box;
    if (point.x <= box.x + 1 || point.x >= box.x + box.width - 1
      || point.y <= box.y + 1 || point.y >= box.y + box.height - 1) continue;
    let objectDepth = 0;
    for (let parent = object.parent; parent; parent = parent.parent) objectDepth += 1;
    if (objectDepth > depth) {
      result = object;
      depth = objectDepth;
    }
  }
  return result;
}

function labelSharesRouteContainer(candidate, scene) {
  if (!candidate.routeAnchor) return true;
  const labelCenter = { x: candidate.x + candidate.width / 2, y: candidate.y + candidate.height / 2 };
  return labelContainerAtPoint(scene, labelCenter) === labelContainerAtPoint(scene, candidate.routeAnchor);
}

function labelFitsAuthoredRegion(candidate) {
  if (!candidate.authoredRegion) return true;
  const geometry = regionGeometry(candidate.authoredRegion);
  const clearance = 2;
  return geometry.axis === "vertical"
    ? candidate.x >= geometry.x + clearance
      && candidate.x + candidate.width <= geometry.x + geometry.width - clearance
    : candidate.y >= geometry.y + clearance
      && candidate.y + candidate.height <= geometry.y + geometry.height - clearance;
}

function labelCandidateScore(candidate, line, scene, objectIndex, labelIndex, borderIndex, routeIndex) {
  // A label belongs to a line before it belongs to an empty pocket elsewhere.
  // Make perpendicular displacement expensive enough that a nearby fallback
  // segment beats a remotely cleared candidate from an otherwise preferred
  // authored run.
  let score = candidate.rank * 40 + (candidate.perpendicularDistance ?? 0) * 8;
  if (!labelSharesRouteContainer(candidate, scene)) score += 500000;
  if (!labelFitsAuthoredRegion(candidate)) score += 500000;
  if (candidate.x < 4 || candidate.y < 4 || candidate.x + candidate.width > scene.width - 4 || candidate.y + candidate.height > scene.height - 4) score += 100000;
  for (const object of objectIndex.queryBox(candidate)) if (boxesOverlap(candidate, object.box, 2)) score += 100000;
  for (const label of labelIndex.queryBox(candidate)) if (boxesOverlap(candidate, label.box, 4)) score += 150000;
  // sitting on a container border stroke is noise even where the interior is
  // free; weighted below a real object overlap so it stays the lesser evil
  for (const ring of borderIndex.queryBox(candidate)) {
    if (boxesOverlap(candidate, ring.box, 2) && !labelMayCrossContainerBorder(candidate, ring)) score += 60000;
  }
  for (const segment of routeIndex.queryBox(candidate)) {
    if (segment.line !== line && segmentHitsBox(segment.first, segment.second, candidate, 1)
      && !labelCoversAuthorizedSharedRun(candidate, line, segment)) {
      score += 120000;
    }
  }
  return score;
}

// Object-aware label generation already derives exact clearances from nearby
// leaf boxes. Add the equivalent bounded candidates for container borders so
// a valid layout shift cannot strand the best label directly on a frame.
function borderClearingCandidates(candidates, borderIndex) {
  const result = [...candidates];
  const clearance = 4;
  for (const candidate of candidates) {
    for (const ring of borderIndex.queryBox(candidate)) {
      if (!boxesOverlap(candidate, ring.box, 2) || labelMayCrossContainerBorder(candidate, ring)) continue;
      const shifts = ring.side === "left" || ring.side === "right"
        ? [
            { x: ring.box.x - clearance - candidate.width, y: candidate.y },
            { x: ring.box.x + ring.box.width + clearance, y: candidate.y },
          ]
        : [
            { x: candidate.x, y: ring.box.y - clearance - candidate.height },
            { x: candidate.x, y: ring.box.y + ring.box.height + clearance },
          ];
      result.push(...shifts.map((shift, index) => {
        const shifted = {
          ...candidate,
          ...shift,
          rank: candidate.rank + 0.02 + index * 0.01,
        };
        if (candidate.routeAnchor) {
          shifted.perpendicularDistance = candidate.routeHorizontal
            ? Math.min(Math.abs(shifted.y - candidate.routeAnchor.y), Math.abs(shifted.y + shifted.height - candidate.routeAnchor.y))
            : Math.min(Math.abs(shifted.x - candidate.routeAnchor.x), Math.abs(shifted.x + shifted.width - candidate.routeAnchor.x));
          if (!candidate.angle && !candidate.routeHorizontal) {
            shifted.textAnchor = shifted.x >= candidate.routeAnchor.x ? "start"
              : shifted.x + shifted.width <= candidate.routeAnchor.x ? "end"
              : "middle";
          }
        }
        return shifted;
      }));
    }
  }
  return result;
}

function placeAllLabels(scene, objectIndex) {
  const labelIndex = new SpatialIndex([]);
  const borderIndex = new SpatialIndex(containerBorderRings(scene));
  const routeIndex = labelRouteIndex(scene);
  for (const line of scene.lines) {
    line.routeLabels = [];
    const segments = routeSegments(line.route);
    const grouped = [];
    const groupByKey = new Map();
    for (const spec of labelSpecs(line)) {
      const endpointIndex = spec.endpoint === line.from ? 0 : spec.endpoint === line.to ? 1 : null;
      const centerGroup = endpointIndex == null && spec.placement === "center" && !spec.authoredSegment;
      const key = endpointIndex == null ? centerGroup ? "center" : Symbol("label") : `endpoint:${endpointIndex}`;
      if (!groupByKey.has(key)) {
        const group = [];
        groupByKey.set(key, group);
        grouped.push(group);
      }
      groupByKey.get(key).push(spec);
    }

    for (const specs of grouped) {
      const spec = specs[0];
      const sizes = specs.map(labelSize);
      const size = {
        width: Math.max(...sizes.map((item) => item.width)),
        height: sizes.reduce((sum, item) => sum + item.height, 0) + Math.max(0, sizes.length - 1) * 4,
      };
      const initialCandidates = spec.endpoint
        ? endpointLabelCandidates(spec.endpoint, spec, size, 0)
        : [
            ...(spec.authoredSegment ? authoredSegmentLabelCandidates(scene, line, spec, size, objectIndex) : []),
            ...segments.flatMap((segment, rank) => segmentLabelCandidates(segment, spec, size, rank + 4, objectIndex)),
          ];
      const candidates = borderClearingCandidates(initialCandidates, borderIndex);
      if (!candidates.length) continue;
      candidates.sort((first, second) =>
        labelCandidateScore(first, line, scene, objectIndex, labelIndex, borderIndex, routeIndex)
        - labelCandidateScore(second, line, scene, objectIndex, labelIndex, borderIndex, routeIndex));
      const chosen = candidates[0];
      chosen.outsideAuthoredRegion = !labelFitsAuthoredRegion(chosen);
      const authoredAxisCandidates = spec.placement === "center" && !chosen.authoredAxis
        ? candidates.filter((candidate) => candidate.authoredRegion && candidate.authoredAxis)
        : [];

      // Prefer a rejected candidate whose obstruction belongs to a locally
      // managed row/column gap. Feeding that concrete pocket back to the
      // solver avoids widening a remote corridor merely to move the same
      // candidate past the obstruction.
      const locallyBlocked = authoredAxisCandidates.find((candidate) =>
        [...borderIndex.queryBox(candidate)].some((ring) => {
          const layout = ring.owner?.parent?.layout?.kind;
          return (layout === "row" || layout === "column") && boxesOverlap(candidate, ring.box, 2);
        }));
      const rejectedAuthoredCandidate = locallyBlocked ?? authoredAxisCandidates[0] ?? null;
      let cursorX = chosen.x;
      let cursorY = chosen.y;
      specs.forEach((item, index) => {
        const itemSize = sizes[index];
        const visualSize = chosen.angle
          ? { width: itemSize.height, height: itemSize.width }
          : itemSize;
        const box = {
          x: chosen.angle ? cursorX : chosen.x + (chosen.width - visualSize.width) / 2,
          y: chosen.angle ? chosen.y + (chosen.height - visualSize.height) / 2 : cursorY,
          width: visualSize.width,
          height: visualSize.height,
        };
        const textAnchor = chosen.textAnchor ?? "middle";
        const textX = textAnchor === "start" ? box.x + 5
          : textAnchor === "end" ? box.x + box.width - 5
          : box.x + box.width / 2;
        const placed = {
          ...item,
          ...chosen,
          rejectedAuthoredCandidate,
          x: textX,
          y: box.y + box.height / 2,
          textAnchor,
          box,
        };
        line.routeLabels.push(placed);
        labelIndex.insert({ box, line, label: placed });
        if (chosen.angle) cursorX += itemSize.height + 4;
        else cursorY += itemSize.height + 4;
      });
    }
  }
  scene.labelIndex = labelIndex;
}

// thin strips along a drawn container boundary; a line label sitting on a
// border stroke reads as noise even where the interior is free
export function containerBorderRings(scene) {
  const rings = [];
  const thickness = 3;
  for (const object of scene.objects) {
    if (!object.visible || ["diagram", "row", "column", "grid", "legend"].includes(object.kind)) continue;
    if (object.children.length === 0 && !object.frame) continue;
    const box = object.box;
    rings.push(
      { kind: "container-border", side: "top", owner: object, box: { x: box.x, y: box.y, width: box.width, height: thickness } },
      { kind: "container-border", side: "bottom", owner: object, box: { x: box.x, y: box.y + box.height - thickness, width: box.width, height: thickness } },
      { kind: "container-border", side: "left", owner: object, box: { x: box.x, y: box.y, width: thickness, height: box.height } },
      { kind: "container-border", side: "right", owner: object, box: { x: box.x + box.width - thickness, y: box.y, width: thickness, height: box.height } },
    );
  }
  return rings;
}

export function labelMayCrossContainerBorder(label, ring) {
  return false;
}

export function route(scene) {
  bindTemporalRoutingTargets(scene);
  bindActorRoutingTargets(scene);
  const leafObstacles = scene.objects.filter((object) => object.visible
    && object.children.length === 0
    && !object.frame
    && !object.roles.includes("uml-occurrence")
    && !object.roles.includes("uml-lifeline-end")
    && !["title", "subtitle", "legend-item"].includes(object.kind));
  const obstacles = [...leafObstacles, ...transitBarrierContainers(scene)];
  placePorts(scene);
  alignFacingDocks(scene);
  buildShareGroups(scene);
  allocateNamedPortTerminals(scene);
  buildChannelMesh(scene);
  const index = new SpatialIndex([...obstacles, ...scene.channelResidents]);
  allocateRegionTracks(scene);
  sharingPins(scene, index);
  const routeAll = () => {
    const routeIndex = new SpatialIndex([]);
    for (const line of linesInRoutingOrder(scene)) {
      routeLine(line, index, routeIndex);
      refineIncrementalRoute(scene, line, index, routeIndex);
      indexRoute(routeIndex, line);
    }
  };
  routeAll();
  if (classifyRegionTracks(scene)) {
    allocateRegionTracks(scene);
    sharingPins(scene, index);
    routeAll();
  }
  if (alignShareApproachTracks(scene)) {
    sharingPins(scene, index);
    routeAll();
  }
  if (alignExplicitBundleLaneOrder(scene)) {
    sharingPins(scene, index);
    routeAll();
  }
  improveRoutes(scene, index);
  if (repairCrossingDockOrder(scene)) {
    routeAll();
    improveRoutes(scene, index);
  }
  // Sliding a dock changes the endpoint geometry from which all soft corridor
  // pins were derived. Rebuild routes after every bounded slide pass instead
  // of leaving the old dock coordinate behind as a protected pin.
  for (let pass = 0; pass < 2 && slideDocks(scene, index); pass += 1) {
    routeAll();
    improveRoutes(scene, index);
  }
  // The first fixed sweep may change a merge's actual terminal prefix. Record
  // that topology before the second sweep so compatible merge members can be
  // refined without weakening their canonical shared run.
  for (let sweep = 0; sweep < 2; sweep += 1) {
    refineRouteCrossings(scene, index);
    if (alignExplicitBundleLaneOrder(scene)) {
      sharingPins(scene, index);
      routeAll();
    }
    for (const line of scene.lines) {
      enforceTerminalStubs(line);
      materializeSharedPins(line);
    }
    materializeAuthorizedSharedRuns(scene);
  }
  for (const line of scene.lines) {
    enforceTerminalStubs(line);
    materializeSharedPins(line);
  }
  materializeAuthorizedSharedRuns(scene);
  for (const line of scene.lines) {
    const container = containerTopologyViolation(line.route, index, line);
    if (!container) continue;
    scene.diagnostics.push({
      severity: "error",
      code: "route-container-transit",
      message: `line '${line.id}' cannot satisfy its itinerary without non-monotone transit through '${container.path}'`,
    });
  }
  const labelObstacles = scene.objects.filter((object) => object.visible
    && !object.frame
    && (object.children.length === 0 || ["title", "subtitle", "legend-item"].includes(object.kind)));
  placeAllLabels(scene, new SpatialIndex(labelObstacles));
  return scene;
}
