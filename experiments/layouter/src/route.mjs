import { minimumHeadRun, normalizedHeads } from "./heads.mjs";
import { boundaryLabelStrips, buildChannelMesh, regionGeometry } from "./mesh.mjs";

const CELL = 160;
const SIDE_VECTOR = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};
const SIDE_ORDER = ["top", "right", "bottom", "left"];

function center(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function rotateSide(side, degrees) {
  if (side === "auto") return side;
  const turns = ((degrees % 360) + 360) % 360 / 90;
  return SIDE_ORDER[(SIDE_ORDER.indexOf(side) + turns) % 4];
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
  return endpoint.port?.anchor ?? endpoint.object;
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
      const target = endpoint.object;
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
  return endpoint.port?.anchor ?? endpoint.port?.owner ?? endpoint.object;
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
      if (endpoint && !endpoint.port && endpoint.point) register(endpoint.object, endpoint.physicalSide, endpoint.point);
    }
  }

  for (const line of scene.lines) {
    const from = line.from;
    const to = line.to;
    if (!from?.point || !to?.point) continue;
    // named ports with several attachments are join identities; leave them
    if ((from.port?.attachments.length ?? 1) > 1 || (to.port?.attachments.length ?? 1) > 1) continue;
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

function trackPoint(track, start, end) {
  const geometry = track.region.geometry;
  const offset = (track.index - (track.total - 1) / 2) * track.region.spacing;
  if (geometry.axis === "vertical") {
    const x = geometry.x + geometry.width / 2 + offset;
    const y = Math.max(geometry.y, Math.min(geometry.y + geometry.height, (start.y + end.y) / 2));
    return { x, y, region: track.region, soft: true, crossing: track.crossing };
  }
  const x = Math.max(geometry.x, Math.min(geometry.x + geometry.width, (start.x + end.x) / 2));
  const y = geometry.y + geometry.height / 2 + offset;
  return { x, y, region: track.region, soft: true, crossing: track.crossing };
}

function longitudinalSpan(line, region) {
  const geometry = region.geometry;
  let longest = 0;
  for (let index = 1; index < line.route.length; index += 1) {
    const first = line.route[index - 1];
    const second = line.route[index];
    if (geometry.axis === "vertical") {
      if (first.x !== second.x || first.x < geometry.x || first.x > geometry.x + geometry.width) continue;
      const top = Math.max(Math.min(first.y, second.y), geometry.y);
      const bottom = Math.min(Math.max(first.y, second.y), geometry.y + geometry.height);
      longest = Math.max(longest, bottom - top);
    } else {
      if (first.y !== second.y || first.y < geometry.y || first.y > geometry.y + geometry.height) continue;
      const left = Math.max(Math.min(first.x, second.x), geometry.x);
      const right = Math.min(Math.max(first.x, second.x), geometry.x + geometry.width);
      longest = Math.max(longest, right - left);
    }
  }
  return longest;
}

function trackPreference(entries, region) {
  const axis = region.geometry.axis === "vertical" ? "x" : "y";
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
      const occupiesLane = entries.some((entry) => longitudinalSpan(entry.line, region) > threshold + 0.5);
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

function segmentHitsBox(first, second, box, inset = 3) {
  const left = box.x + inset;
  const right = box.x + box.width - inset;
  const top = box.y + inset;
  const bottom = box.y + box.height - inset;
  if (first.x === second.x) return first.x > left && first.x < right && Math.max(first.y, second.y) > top && Math.min(first.y, second.y) < bottom;
  if (first.y === second.y) return first.y > top && first.y < bottom && Math.max(first.x, second.x) > left && Math.min(first.x, second.x) < right;
  return false;
}

function simplify(points) {
  const unique = points.filter((item, index) => index === 0 || item.x !== points[index - 1].x || item.y !== points[index - 1].y);
  const result = [];
  for (const item of unique) {
    const previous = result.at(-1);
    const before = result.at(-2);
    const horizontalMiddle = before && previous && before.y === previous.y && previous.y === item.y
      && previous.x >= Math.min(before.x, item.x) && previous.x <= Math.max(before.x, item.x);
    const verticalMiddle = before && previous && before.x === previous.x && previous.x === item.x
      && previous.y >= Math.min(before.y, item.y) && previous.y <= Math.max(before.y, item.y);
    if (horizontalMiddle || verticalMiddle) result.pop();
    result.push({ x: item.x, y: item.y });
  }
  return result;
}

function linesMayShare(first, second) {
  if (first.share?.group && first.share.group === second.share?.group) {
    const mode = first.share.mode ?? second.share.mode ?? "auto";
    if (mode === "merge" || mode === "auto") return true;
  }
  const firstPorts = [first.from?.port, first.to?.port].filter(Boolean);
  const secondPorts = new Set([second.from?.port, second.to?.port].filter(Boolean));
  return firstPorts.some((port) => {
    const mode = port.sharing?.mode ?? "auto";
    return secondPorts.has(port) && (mode === "merge" || mode === "auto");
  });
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

function candidateScore(points, index, ignored, routeIndex, line) {
  let score = (points.length - 2) * 18;
  let collisions = 0;
  for (let i = 1; i < points.length; i += 1) {
    const first = points[i - 1];
    const second = points[i];
    score += Math.abs(first.x - second.x) + Math.abs(first.y - second.y);
    for (const object of index.querySegment(first, second)) {
      if (ignored.has(object) || !segmentHitsBox(first, second, object.box)) continue;
      // a run parallel to a title strip cuts through the text line; a quick
      // perpendicular crossing merely nicks it
      if (object.kind === "boundary-label" && first.x === second.x) {
        const authoredPadding = line.segments.some((segment) =>
          segment.region?.kind === "padding" || segment.corridor?.side);
        score += authoredPadding ? 40 : 800;
      }
      else collisions += 1;
    }
    const candidate = { first, second };
    for (const routed of routeIndex.querySegment(first, second)) {
      if (routed.line === line) continue;
      const interaction = segmentInteraction(candidate, routed);
      if (interaction === "overlap" && !linesMayShare(line, routed.line)) score += 50000;
      if (interaction === "crossing") score += 180;
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
    const obstacle = collidingObstacle(best, index, ignored);
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
      if (routed.line === line) continue;
      if (segmentInteraction(candidate, routed) === "overlap" && !linesMayShare(line, routed.line)) return candidate;
    }
  }
  return null;
}

function collidingObstacle(points, index, ignored) {
  for (let i = 1; i < points.length; i += 1) {
    for (const object of index.querySegment(points[i - 1], points[i])) {
      if (!ignored.has(object) && segmentHitsBox(points[i - 1], points[i], object.box)) return object;
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

function rayClearance(scene, port, objectIndex) {
  return rayClearanceAt(scene, port.point, port.physicalSide, port.anchor ?? port.owner, objectIndex);
}

function sharedPins(scene, objectIndex) {
  const groups = new Map();
  for (const line of scene.lines) {
    for (const endpoint of [line.from, line.to]) {
      if (!endpoint?.port || endpoint.port.attachments.length < 2) continue;
      const mode = endpoint.port.sharing?.mode ?? "auto";
      if (mode === "separate" || mode === "bundle") continue;
      if (!groups.has(endpoint.port)) groups.set(endpoint.port, endpoint.port.attachments);
    }
  }
  for (const [port, attachments] of groups) {
    const start = port.point;
    const side = port.physicalSide;
    const vector = SIDE_VECTOR[side];
    const distances = attachments.map(({ line, endpoint }) => {
      const remote = remoteCenter(line, endpoint);
      return (remote.x - start.x) * vector.x + (remote.y - start.y) * vector.y;
    }).filter((distance) => distance > 0);
    const trackDistances = attachments.flatMap(({ line }) => [...(line.regionTracks?.values() ?? [])].map((track) => {
      const geometry = track.region.geometry;
      const location = geometry.axis === "vertical"
        ? { x: geometry.x + geometry.width / 2, y: start.y }
        : { x: start.x, y: geometry.y + geometry.height / 2 };
      return (location.x - start.x) * vector.x + (location.y - start.y) * vector.y;
    })).filter((distance) => distance > 18);
    const preference = port.sharing?.branch?.preference ?? "late";
    const factor = preference === "early" ? 0.18 : preference === "balanced" ? 0.45 : 0.72;
    const desired = Math.min(160, (distances.length ? Math.min(...distances) : 48) * factor);
    const trackLimit = trackDistances.length ? Math.min(...trackDistances) - 12 : Number.POSITIVE_INFINITY;
    const obstacleLimit = rayClearance(scene, port, objectIndex) - 8;
    const distance = Math.max(8, Math.min(desired, trackLimit, obstacleLimit));
    const pin = { x: start.x + vector.x * distance, y: start.y + vector.y * distance };
    for (const { line, endpoint } of attachments) {
      line.sharedPins ??= [];
      line.sharedPins.push({ endpoint, pin });
    }
  }
}

function paddingTrackPins(track, start, end) {
  const geometry = track.region.geometry;
  const offset = (track.index - (track.total - 1) / 2) * track.region.spacing;
  if (geometry.axis === "vertical") {
    const centered = geometry.x + geometry.width / 2 + offset;
    const reusable = track.total === 1
      ? [start.x, end.x].find((value) => value >= geometry.x && value <= geometry.x + geometry.width)
      : null;
    const x = reusable ?? centered;
    return [
      { x, y: Math.max(geometry.y, Math.min(geometry.y + geometry.height, start.y)), region: track.region },
      { x, y: Math.max(geometry.y, Math.min(geometry.y + geometry.height, end.y)), region: track.region },
    ];
  }
  const centered = geometry.y + geometry.height / 2 + offset;
  const reusable = track.total === 1
    ? [start.y, end.y].find((value) => value >= geometry.y && value <= geometry.y + geometry.height)
    : null;
  const y = reusable ?? centered;
  return [
    { x: Math.max(geometry.x, Math.min(geometry.x + geometry.width, start.x)), y, region: track.region },
    { x: Math.max(geometry.x, Math.min(geometry.x + geometry.width, end.x)), y, region: track.region },
  ];
}

function hasAncestor(object, ancestor) {
  for (let current = object?.parent; current; current = current.parent) if (current === ancestor) return true;
  return false;
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
  return pin.region?.geometry
    ? distanceToBox(start, pin.region.geometry)
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
  const explicitRegions = line.segments.filter((segment) => segment.region || segment.corridor);
  if (explicitRegions.length !== 1) return false;
  const fromBranch = branchBelow(region.owner, line.from?.object);
  const toBranch = branchBelow(region.owner, line.to?.object);
  if (!fromBranch || !toBranch || fromBranch === toBranch) return false;
  const start = Math.min(fromBranch.siblingIndex, toBranch.siblingIndex);
  const end = Math.max(fromBranch.siblingIndex, toBranch.siblingIndex);
  return region.index >= start && region.index < end;
}

function insideOrSelf(object, ancestor) {
  return object === ancestor || hasAncestor(object, ancestor);
}

function orderedPins(line, start, end) {
  const tracks = [...(line.regionTracks?.values() ?? [])];
  const explicitPadding = new Set();
  for (const segment of line.segments) {
    if (segment.corridor) for (const track of tracks) if (track.region.kind === "padding" && track.region.corridors.includes(segment.corridor)) explicitPadding.add(track.region);
    if (segment.region?.kind === "padding") for (const track of tracks) if (track.region.kind === "padding" && track.region.owner === segment.region.container && track.region.side === segment.region.side) explicitPadding.add(track.region);
  }

  const groups = [];
  for (const track of tracks) {
    const explicitIndex = line.segments.findIndex((segment) =>
      segment.region?.kind === "padding"
        ? track.region.kind === "padding" && track.region.owner === segment.region.container && track.region.side === segment.region.side
        : segment.region?.kind === "gap"
          ? track.region.kind === "gap" && physicalGapContains(segment.region, track.region)
          : segment.corridor
            ? track.region.corridors.includes(segment.corridor)
            : false);
    if (explicitPadding.has(track.region)) {
      groups.push({
        phase: 2,
        rank: explicitIndex,
        pins: paddingTrackPins(track, start, end).map((pin) => ({ ...pin, required: true })),
      });
      continue;
    }
    if ([...explicitPadding].some((region) => region.owner === track.region.owner && track.region.kind === "gap")) continue;
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
      const containedExplicit = line.segments
        .map((segment, index) => ({ index, owner: explicitSegmentOwner(segment) }))
        .filter((entry) => entry.owner && insideOrSelf(entry.owner, track.region.owner));

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
  for (const shared of line.sharedPins ?? []) {
    if (shared.endpoint === line.from) pins.unshift(shared.pin);
    else pins.push(shared.pin);
  }
  return pins;
}

function physicalGapContains(reference, region) {
  return reference.between?.[0]?.parent === region.owner
    && reference.between?.[1]?.parent === region.owner
    && region.index >= Math.min(reference.between[0].siblingIndex, reference.between[1].siblingIndex)
    && region.index < Math.max(reference.between[0].siblingIndex, reference.between[1].siblingIndex);
}

function escapePoint(endpoint, distance = endpoint.routeEscapeDistance ?? endpoint.escapeDistance ?? 14) {
  const vector = SIDE_VECTOR[endpoint.physicalSide] ?? { x: 0, y: 0 };
  return { x: endpoint.point.x + vector.x * distance, y: endpoint.point.y + vector.y * distance };
}

function endpointStub(line, endpoint) {
  const endIndex = endpoint === line.from ? 0 : 1;
  const minimumRun = minimumHeadRun(normalizedHeads(line.heads)[endIndex]);
  const escapeDistance = Math.max(endpoint.escapeDistance ?? 14, minimumRun);
  endpoint.routeEscapeDistance = escapeDistance;
  const port = endpoint.port;
  if (port?.sharing?.mode !== "bundle" || port.attachments.length < 2) {
    return [endpoint.point, escapePoint(endpoint, escapeDistance)];
  }
  const attachmentIndex = port.attachments.findIndex((attachment) => attachment.endpoint === endpoint);
  const offset = (attachmentIndex - (port.attachments.length - 1) / 2) * 8;
  const vector = SIDE_VECTOR[endpoint.physicalSide] ?? { x: 0, y: 0 };
  const perpendicular = { x: -vector.y, y: vector.x };
  if (minimumRun === 0) {
    const boundary = {
      x: endpoint.point.x + perpendicular.x * offset,
      y: endpoint.point.y + perpendicular.y * offset,
    };
    return [
      endpoint.point,
      boundary,
      { x: boundary.x + vector.x * escapeDistance, y: boundary.y + vector.y * escapeDistance },
    ];
  }
  const escape = escapePoint(endpoint, escapeDistance);
  const branch = {
    x: escape.x + perpendicular.x * offset,
    y: escape.y + perpendicular.y * offset,
  };
  return offset === 0 ? [endpoint.point, escape] : [endpoint.point, escape, branch];
}

// Docks sit on the box edge and stubs leave outward, so the endpoint boxes
// need no exemption: a route doubling back across its own source is a real
// collision the score should see.
function ignoredObjects(line, index) {
  return line.space === "overlay"
    ? new Set(index.objects)
    : new Set(line.segments.map((segment) => segment.waypoint).filter(Boolean));
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
  const rawPins = orderedPins(line, start, end);
  const pins = [];
  let cursor = start;
  for (let index = 0; index < rawPins.length; index += 1) {
    const pin = rawPins[index];
    const geometry = pin.region?.geometry;
    if (pin.soft && geometry) {
      const nextTravel = rawPins.slice(index + 1).find((candidate) => !candidate.passThrough) ?? end;
      if (geometry.axis === "vertical") {
        const clamp = (value) => Math.max(geometry.y, Math.min(geometry.y + geometry.height, value));
        if (pin.passThrough) {
          const escape = escapePoint(pin.endpoint);
          const vector = SIDE_VECTOR[pin.endpoint.physicalSide];
          const x = vector.x > 0 ? Math.max(pin.x, escape.x) : vector.x < 0 ? Math.min(pin.x, escape.x) : pin.x;
          pins.push({ x, y: clamp(cursor.y) });
        } else if (pin.crossing) {
          const fromSide = cursor.x === start.x && cursor.y === start.y ? line.from?.physicalSide : null;
          const toSide = nextTravel === end ? line.to?.physicalSide : null;
          const y = fromSide === "left" || fromSide === "right"
            ? cursor.y
            : toSide === "left" || toSide === "right" ? nextTravel.y : cursor.y;
          // Move along the endpoint branch before entering the gap. Without
          // this point, two equal-length L candidates can choose a vertical
          // run inside a gap that is meant to be crossed once.
          if (cursor.y !== y) pins.push({ x: cursor.x, y: clamp(y) });
          pins.push({ x: pin.x, y: clamp(y) });
        } else {
          const nextY = nextTravel.soft && nextTravel.region?.geometry?.axis === "vertical" ? cursor.y : nextTravel.y;
          pins.push({ x: pin.x, y: clamp(cursor.y) }, { x: pin.x, y: clamp(nextY) });
        }
      } else {
        const clamp = (value) => Math.max(geometry.x, Math.min(geometry.x + geometry.width, value));
        if (pin.passThrough) {
          const escape = escapePoint(pin.endpoint);
          const vector = SIDE_VECTOR[pin.endpoint.physicalSide];
          const y = vector.y > 0 ? Math.max(pin.y, escape.y) : vector.y < 0 ? Math.min(pin.y, escape.y) : pin.y;
          pins.push({ x: clamp(cursor.x), y });
        } else if (pin.crossing) {
          const fromSide = cursor.x === start.x && cursor.y === start.y ? line.from?.physicalSide : null;
          const toSide = nextTravel === end ? line.to?.physicalSide : null;
          const x = fromSide === "top" || fromSide === "bottom"
            ? cursor.x
            : toSide === "top" || toSide === "bottom" ? nextTravel.x : cursor.x;
          if (cursor.x !== x) pins.push({ x: clamp(x), y: cursor.y });
          pins.push({ x: clamp(x), y: pin.y });
        } else {
          const nextX = nextTravel.soft && nextTravel.region?.geometry?.axis === "horizontal" ? cursor.x : nextTravel.x;
          pins.push({ x: clamp(cursor.x), y: pin.y }, { x: clamp(nextX), y: pin.y });
        }
      }
      cursor = pins.at(-1);
    } else {
      pins.push(pin);
      cursor = pin;
    }
  }
  // escape stubs count as pins so collapse keeps the perpendicular departure
  line.requiredRoutePins = pins.filter((pin) => pin.required).map((pin) => ({ x: pin.x, y: pin.y }));
  line.pinPoints = [...pins, ...fromStub.slice(1), ...toStub.slice(1)].map((pin) => ({ x: pin.x, y: pin.y }));
  const waypoints = [...fromStub, ...pins, ...toStub.reverse()];
  const route = [];
  for (let i = 1; i < waypoints.length; i += 1) {
    const ignored = ignoredObjects(line, index);
    const piece = orthogonal(waypoints[i - 1], waypoints[i], index, ignored, routeIndex, line);
    route.push(...(route.length ? piece.slice(1) : piece));
  }
  line.route = simplify(route);
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

function indexRoute(routeIndex, line) {
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
    const previous = result.at(-1);
    const before = result.at(-2);
    const horizontalMiddle = before && previous && before.y === previous.y && previous.y === item.y
      && previous.x >= Math.min(before.x, item.x) && previous.x <= Math.max(before.x, item.x);
    const verticalMiddle = before && previous && before.x === previous.x && previous.x === item.x
      && previous.y >= Math.min(before.y, item.y) && previous.y <= Math.max(before.y, item.y);
    if ((horizontalMiddle || verticalMiddle) && !isPinPoint(line, previous)) result.pop();
    result.push({ x: item.x, y: item.y });
  }
  return result;
}

// Replace zig-zag stretches with the best bounded candidate between the same
// two route points. Pins and shared-branch points are never removed; a
// replacement is accepted only when its full score strictly improves, so the
// pass is monotone and cannot introduce new collisions or unrelated runs.
function collapseJogs(line, index, routeIndex) {
  if (!line.from || !line.to || line.route.length < 4) return false;
  const ignored = ignoredObjects(line, index);
  let improved = false;
  for (let windowSize = Math.min(line.route.length - 1, 6); windowSize >= 2; windowSize -= 1) {
    let start = 0;
    while (start + windowSize < line.route.length) {
      const end = start + windowSize;
      const interior = line.route.slice(start + 1, end);
      if (interior.some((point) => isPinPoint(line, point))) {
        start += 1;
        continue;
      }
      const current = line.route.slice(start, end + 1);
      const replacement = orthogonal(line.route[start], line.route[end], index, ignored, routeIndex, line);
      const requiredPins = (line.requiredRoutePins ?? []).filter((pin) => routeContainsPoint(current, pin));
      if (requiredPins.some((pin) => !routeContainsPoint(replacement, pin))) {
        start += 1;
        continue;
      }
      const currentScore = candidateScore(current, index, ignored, routeIndex, line);
      const replacementScore = candidateScore(replacement, index, ignored, routeIndex, line);
      if (replacementScore < currentScore - 0.5) {
        line.route.splice(start, windowSize + 1, ...replacement);
        line.route = simplifyKeepingPins(line, line.route);
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
      if (endpoint && !endpoint.port && endpoint.point) register(endpoint.object, endpoint.physicalSide, endpoint.point);
    }
  }

  for (const line of scene.lines) {
    if (line.route.length < 3) continue;
    for (const end of ["from", "to"]) {
      const endpoint = line[end];
      if (!endpoint?.point || (endpoint.port?.attachments.length ?? 1) > 1) continue;
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
      const blocked = [...index.querySegment(movedDock, movedEscape)]
        .some((object) => segmentHitsBox(movedDock, movedEscape, object.box));
      if (blocked) continue;
      dock[lateralAxis] = target;
      escape[lateralAxis] = target;
      endpoint.point[lateralAxis] = target;
      line.route = simplifyKeepingPins(line, route);
    }
  }
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

function labelSize(text) {
  const lines = String(text).split("\n");
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

function pointLabelCandidates(point, horizontal, label, size, rank, directionalOffsets = new Map()) {
  const baseOffsets = [7, 18, 32, 48, 72, 96];
  const angle = label.orientation === "along" && !horizontal ? 90 : 0;
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
function localLabelOptions(segment, label, size, objectIndex) {
  const horizontal = segment.first.y === segment.second.y;
  const angle = label.orientation === "along" && !horizontal ? 90 : 0;
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
  const local = localLabelOptions(segment, label, size, objectIndex);
  const ratios = label.placement === "start" || label.placement === "end"
    ? baseRatios
    : [...baseRatios, ...local.ratios];
  return ratios.flatMap((ratio, ratioIndex) =>
    pointLabelCandidates(positionAlong(segment, ratio), horizontal, label, size, rank + ratioIndex * 0.05, local.offsets));
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

function authoredRunPoints(segment, geometry, anchor, label, size) {
  const horizontal = segment.first.y === segment.second.y;
  const start = horizontal ? Math.min(segment.first.x, segment.second.x) : Math.min(segment.first.y, segment.second.y);
  const end = horizontal ? Math.max(segment.first.x, segment.second.x) : Math.max(segment.first.y, segment.second.y);
  const alongExtent = horizontal ? size.width : label.orientation === "along" ? size.width : size.height;
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
  ].map(clamp).concat([start - half - 8, end + half + 8]);
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
      const segmentHorizontal = segment.first.y === segment.second.y;
      const followsRegionAxis = region.geometry.axis === "horizontal" ? segmentHorizontal : !segmentHorizontal;
      const routeRank = label.placement === "start" ? segment.index
        : label.placement === "end" ? lastIndex - segment.index
        : label.placement === "center" ? followsRegionAxis ? 0 : 1 + prominence
        : prominence;
      const point = segmentRegionPoint(segment, region.geometry);
      if (point) {
        const directionalOffsets = localLabelOptions(segment, label, size, objectIndex).offsets;
        for (const [rank, runPoint] of authoredRunPoints(segment, region.geometry, point, label, size).entries()) {
          candidates.push(...pointLabelCandidates(runPoint, segmentHorizontal, label, size, -4 + routeRank * 0.2 + rank * 0.02, directionalOffsets)
            .map((candidate) => ({
              ...candidate,
              authoredRegion: region,
              authoredRun: segment.index,
              authoredAxis: followsRegionAxis,
            })));
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
  if (line.label != null) specs.push({ text: line.label, placement: "auto", orientation: "upright" });
  specs.push(...line.labels.map((label) => ({ placement: "auto", orientation: "upright", ...label })));
  for (const segment of line.segments) {
    if (segment.label != null) specs.push({
      text: segment.label,
      placement: segment.labelPlacement ?? "auto",
      orientation: segment.labelOrientation ?? "upright",
      authoredSegment: segment,
    });
  }
  for (const [end, labels] of line.endLabels.entries()) {
    for (const label of labels) specs.push({ placement: "auto", orientation: "upright", ...label, endpoint: end === 0 ? line.from : line.to });
  }
  return specs;
}

function labelGeometryMayShare(first, second) {
  if (first.share?.group && first.share.group === second.share?.group) {
    const mode = first.share.mode ?? second.share.mode ?? "auto";
    if (mode === "merge" || mode === "auto") return true;
  }
  const firstPorts = [first.from?.port, first.to?.port].filter(Boolean);
  const secondPorts = new Set([second.from?.port, second.to?.port].filter(Boolean));
  return firstPorts.some((port) => {
    const mode = port.sharing?.mode ?? "auto";
    return secondPorts.has(port) && (mode === "merge" || mode === "auto");
  });
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

function labelCandidateScore(candidate, line, scene, objectIndex, labelIndex, borderIndex, routeIndex) {
  let score = candidate.rank * 40;
  if (candidate.x < 4 || candidate.y < 4 || candidate.x + candidate.width > scene.width - 4 || candidate.y + candidate.height > scene.height - 4) score += 100000;
  for (const object of objectIndex.queryBox(candidate)) if (boxesOverlap(candidate, object.box, 2)) score += 100000;
  for (const label of labelIndex.queryBox(candidate)) if (boxesOverlap(candidate, label.box, 4)) score += 150000;
  // sitting on a container border stroke is noise even where the interior is
  // free; weighted below a real object overlap so it stays the lesser evil
  for (const ring of borderIndex.queryBox(candidate)) {
    if (boxesOverlap(candidate, ring.box, 2) && !labelMayCrossContainerBorder(candidate, ring)) score += 60000;
  }
  for (const segment of routeIndex.queryBox(candidate)) {
    if (segment.line !== line && !labelGeometryMayShare(line, segment.line) && segmentHitsBox(segment.first, segment.second, candidate, 1)) {
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
      result.push(...shifts.map((shift, index) => ({
        ...candidate,
        ...shift,
        rank: candidate.rank + 0.02 + index * 0.01,
      })));
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
    for (const spec of labelSpecs(line)) {
      const size = labelSize(spec.text);
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
      const placed = {
        ...spec,
        ...chosen,
        rejectedAuthoredCandidate,
        x: chosen.x + chosen.width / 2,
        y: chosen.y + chosen.height / 2,
        box: { x: chosen.x, y: chosen.y, width: chosen.width, height: chosen.height },
      };
      line.routeLabels.push(placed);
      labelIndex.insert({ box: placed.box, line, label: placed });
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
  const region = label.authoredRegion;
  if (ring.kind !== "container-border" || region?.kind !== "gap") return false;
  const members = region.owner.children.filter((child) => !child.anchor && !child.frame);
  const left = members[region.index];
  const right = members[region.index + 1];
  const inside = (object, branch) => object === branch || hasAncestor(object, branch);
  return ring.side === "right" && left && inside(ring.owner, left)
    || ring.side === "left" && right && inside(ring.owner, right);
}

export function route(scene) {
  const obstacles = scene.objects.filter((object) => object.visible && object.children.length === 0 && !object.frame && !["title", "subtitle", "legend-item"].includes(object.kind));
  const index = new SpatialIndex([...obstacles, ...boundaryLabelStrips(scene)]);
  placePorts(scene);
  alignFacingDocks(scene);
  for (const region of scene.regions.values()) region.geometry = regionGeometry(region);
  sharedPins(scene, index);
  const routeAll = () => {
    const routeIndex = new SpatialIndex([]);
    for (const line of scene.lines) {
      routeLine(line, index, routeIndex);
      indexRoute(routeIndex, line);
    }
  };
  routeAll();
  if (classifyRegionTracks(scene)) {
    routeAll();
  }
  improveRoutes(scene, index);
  slideDocks(scene, index);
  improveRoutes(scene, index);
  for (const line of scene.lines) materializeSharedPins(line);
  placeAllLabels(scene, index);
  buildChannelMesh(scene);
  return scene;
}
