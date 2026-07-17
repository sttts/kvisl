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
      const desiredSide = chooseSide(target.box, average);
      const localSide = port.allowedSides.includes(desiredSide) ? desiredSide : port.allowedSides[0];
      port.physicalSide = rotateSide(localSide, target.physicalOrientation ?? object.physicalOrientation ?? 0);
      const key = `${target.path}:${port.physicalSide}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ kind: "port", port, target, sort: port.orderIndex });
    }
  }

  for (const line of scene.lines) {
    for (const endpoint of [line.from, line.to]) {
      if (!endpoint || endpoint.port) continue;
      const target = endpoint.object;
      const side = chooseSide(target.box, remoteCenter(line, endpoint));
      endpoint.physicalSide = side;
      const key = `${target.path}:${side}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push({ kind: "owned", endpoint, target, sort: 100000 + line.order });
    }
  }

  for (const entries of buckets.values()) {
    entries.sort((first, second) => first.sort - second.sort);
    entries.forEach((entry, index) => {
      const fraction = (index + 1) / (entries.length + 1);
      const point = pointOnSide(entry.target.box, entry.kind === "port" ? entry.port.physicalSide : entry.endpoint.physicalSide, fraction);
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
      return siblings.every((point) => point === endpoint.point || Math.abs(point[axis] - target) >= 12);
    };
    if (!fits(from, fromSide) || !fits(to, toSide)) continue;
    from.point[axis] = target;
    to.point[axis] = target;
  }
}

function regionGeometry(region) {
  if (region.kind === "padding") {
    const box = region.owner.box;
    const thickness = Math.max(region.thickness, 12);
    if (region.side === "top") return { x: box.x, y: box.y, width: box.width, height: thickness, axis: "horizontal" };
    if (region.side === "bottom") return { x: box.x, y: box.y + box.height - thickness, width: box.width, height: thickness, axis: "horizontal" };
    if (region.side === "left") return { x: box.x, y: box.y, width: thickness, height: box.height, axis: "vertical" };
    return { x: box.x + box.width - thickness, y: box.y, width: thickness, height: box.height, axis: "vertical" };
  }
  const first = region.owner.children[region.index]?.box;
  const second = region.owner.children[region.index + 1]?.box;
  if (!first || !second) return { x: 0, y: 0, width: 0, height: 0, axis: "vertical" };
  const separatedX = first.x + first.width <= second.x || second.x + second.width <= first.x;
  if (separatedX) {
    const left = first.x < second.x ? first.x + first.width : second.x + second.width;
    const right = first.x < second.x ? second.x : first.x;
    return { x: left, y: Math.min(first.y, second.y), width: Math.max(0, right - left), height: Math.max(first.y + first.height, second.y + second.height) - Math.min(first.y, second.y), axis: "vertical" };
  }
  const top = first.y < second.y ? first.y + first.height : second.y + second.height;
  const bottom = first.y < second.y ? second.y : first.y;
  return { x: Math.min(first.x, second.x), y: top, width: Math.max(first.x + first.width, second.x + second.width) - Math.min(first.x, second.x), height: Math.max(0, bottom - top), axis: "horizontal" };
}

function trackPoint(track, start, end) {
  const geometry = track.region.geometry;
  const offset = (track.index - (track.total - 1) / 2) * track.region.spacing;
  if (geometry.axis === "vertical") {
    const x = geometry.x + geometry.width / 2 + offset;
    const y = Math.max(geometry.y, Math.min(geometry.y + geometry.height, (start.y + end.y) / 2));
    return { x, y, region: track.region };
  }
  const x = Math.max(geometry.x, Math.min(geometry.x + geometry.width, (start.x + end.x) / 2));
  const y = geometry.y + geometry.height / 2 + offset;
  return { x, y, region: track.region };
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

function segmentHitsBox(first, second, box) {
  const inset = 3;
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
      if (!ignored.has(object) && segmentHitsBox(first, second, object.box)) collisions += 1;
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

function rayClearance(scene, port, objectIndex) {
  const start = port.point;
  const side = port.physicalSide;
  const owner = port.anchor ?? port.owner;
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
    const x = geometry.x + geometry.width / 2 + offset;
    return [
      { x, y: Math.max(geometry.y, Math.min(geometry.y + geometry.height, start.y)), region: track.region },
      { x, y: Math.max(geometry.y, Math.min(geometry.y + geometry.height, end.y)), region: track.region },
    ];
  }
  const y = geometry.y + geometry.height / 2 + offset;
  return [
    { x: Math.max(geometry.x, Math.min(geometry.x + geometry.width, start.x)), y, region: track.region },
    { x: Math.max(geometry.x, Math.min(geometry.x + geometry.width, end.x)), y, region: track.region },
  ];
}

function hasAncestor(object, ancestor) {
  for (let current = object?.parent; current; current = current.parent) if (current === ancestor) return true;
  return false;
}

function orderedPins(line, start, end) {
  const tracks = [...(line.regionTracks?.values() ?? [])];
  const explicitPadding = new Set();
  for (const segment of line.segments) {
    if (segment.corridor) for (const track of tracks) if (track.region.kind === "padding" && track.region.corridors.includes(segment.corridor)) explicitPadding.add(track.region);
    if (segment.region?.kind === "padding") for (const track of tracks) if (track.region.kind === "padding" && track.region.owner === segment.region.container && track.region.side === segment.region.side) explicitPadding.add(track.region);
  }

  const pins = [];
  for (const track of tracks) {
    if (explicitPadding.has(track.region)) {
      pins.push(...paddingTrackPins(track, start, end));
      continue;
    }
    if ([...explicitPadding].some((region) => region.owner === track.region.owner && track.region.kind === "gap")) continue;
    // an implicit exit/entry band that contradicts the chosen dock side would
    // drag the route around the object; the reservation stays, the pin goes
    if (track.region.kind === "padding") {
      const endpoint = [line.from, line.to].find((item) => item && hasAncestor(item.object, track.region.owner));
      if (endpoint?.physicalSide && endpoint.physicalSide !== track.region.side) continue;
    }
    pins.push(trackPoint(track, start, end));
  }
  for (const segment of line.segments) if (segment.waypoint) pins.push(center(segment.waypoint.box));
  pins.sort((first, second) =>
    Math.abs(first.x - start.x) + Math.abs(first.y - start.y)
    - Math.abs(second.x - start.x) - Math.abs(second.y - start.y));
  for (const shared of line.sharedPins ?? []) {
    if (shared.endpoint === line.from) pins.unshift(shared.pin);
    else pins.push(shared.pin);
  }
  return pins;
}

function escapePoint(endpoint, distance = endpoint.escapeDistance ?? 14) {
  const vector = SIDE_VECTOR[endpoint.physicalSide] ?? { x: 0, y: 0 };
  return { x: endpoint.point.x + vector.x * distance, y: endpoint.point.y + vector.y * distance };
}

function endpointStub(endpoint) {
  const port = endpoint.port;
  if (port?.sharing?.mode !== "bundle" || port.attachments.length < 2) {
    return [endpoint.point, escapePoint(endpoint)];
  }
  const attachmentIndex = port.attachments.findIndex((attachment) => attachment.endpoint === endpoint);
  const offset = (attachmentIndex - (port.attachments.length - 1) / 2) * 8;
  const vector = SIDE_VECTOR[endpoint.physicalSide] ?? { x: 0, y: 0 };
  const perpendicular = { x: -vector.y, y: vector.x };
  const boundary = {
    x: endpoint.point.x + perpendicular.x * offset,
    y: endpoint.point.y + perpendicular.y * offset,
  };
  return [
    endpoint.point,
    boundary,
    { x: boundary.x + vector.x * 14, y: boundary.y + vector.y * 14 },
  ];
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
  const fromStub = endpointStub(line.from);
  const toStub = endpointStub(line.to);
  const start = fromStub.at(-1);
  const end = toStub.at(-1);
  const pins = orderedPins(line, start, end);
  // escape stubs count as pins so collapse keeps the perpendicular departure
  line.pinPoints = [...pins, ...fromStub.slice(1), ...toStub.slice(1)].map((pin) => ({ x: pin.x, y: pin.y }));
  const waypoints = [...fromStub, ...pins, ...toStub.reverse()];
  const route = [];
  for (let i = 1; i < waypoints.length; i += 1) {
    const ignored = ignoredObjects(line, index);
    const piece = orthogonal(waypoints[i - 1], waypoints[i], index, ignored, routeIndex, line);
    route.push(...(route.length ? piece.slice(1) : piece));
  }
  line.route = simplify(route);
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
  return result.sort((first, second) => second.length - first.length || first.index - second.index);
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

function segmentLabelCandidates(segment, label, size, rank) {
  const horizontal = segment.first.y === segment.second.y;
  const ratios = label.placement === "start" ? [0.2, 0.35]
    : label.placement === "end" ? [0.8, 0.65]
    : [0.5, 0.25, 0.75];
  const offsets = [7, 18, 32];
  const angle = label.orientation === "along" && !horizontal ? 90 : 0;
  const visualWidth = angle ? size.height : size.width;
  const visualHeight = angle ? size.width : size.height;
  return ratios.flatMap((ratio, ratioIndex) => offsets.flatMap((offset, offsetIndex) => {
    const point = positionAlong(segment, ratio);
    return [-1, 1].map((direction) => ({
      x: horizontal ? point.x - visualWidth / 2 : point.x + direction * (visualWidth / 2 + offset) - visualWidth / 2,
      y: horizontal ? point.y + direction * (visualHeight / 2 + offset) - visualHeight / 2 : point.y - visualHeight / 2,
      width: visualWidth,
      height: visualHeight,
      angle,
      rank: rank + ratioIndex * 0.05 + offsetIndex * 0.1,
    }));
  }));
}

function endpointLabelCandidates(endpoint, label, size, rank) {
  const side = endpoint.physicalSide ?? "right";
  const vector = SIDE_VECTOR[side];
  const perpendicular = { x: -vector.y, y: vector.x };
  const horizontalSide = side === "left" || side === "right";
  const alongExtent = horizontalSide ? size.width : size.height;
  const perpendicularExtent = horizontalSide ? size.height : size.width;
  return [8, 18, 32].flatMap((offset, offsetIndex) => [-1, 1].flatMap((direction) => [0, 1, 2].map((tier) => {
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
    if (segment.label != null) specs.push({ text: segment.label, placement: "auto", orientation: segment.labelOrientation ?? "upright", authoredSegment: segment });
  }
  for (const [end, labels] of line.endLabels.entries()) {
    for (const label of labels) specs.push({ placement: "auto", orientation: "upright", ...label, endpoint: end === 0 ? line.from : line.to });
  }
  return specs;
}

function labelCandidateScore(candidate, scene, objectIndex, labelIndex) {
  let score = candidate.rank * 40;
  if (candidate.x < 4 || candidate.y < 4 || candidate.x + candidate.width > scene.width - 4 || candidate.y + candidate.height > scene.height - 4) score += 100000;
  for (const object of objectIndex.queryBox(candidate)) if (boxesOverlap(candidate, object.box, 2)) score += 100000;
  for (const label of labelIndex.queryBox(candidate)) if (boxesOverlap(candidate, label.box, 4)) score += 150000;
  return score;
}

function placeAllLabels(scene, objectIndex) {
  const labelIndex = new SpatialIndex([]);
  for (const line of scene.lines) {
    line.routeLabels = [];
    const segments = routeSegments(line.route);
    for (const spec of labelSpecs(line)) {
      const size = labelSize(spec.text);
      const candidates = spec.endpoint
        ? endpointLabelCandidates(spec.endpoint, spec, size, 0)
        : segments.flatMap((segment, rank) => segmentLabelCandidates(segment, spec, size, rank));
      if (!candidates.length) continue;
      candidates.sort((first, second) => labelCandidateScore(first, scene, objectIndex, labelIndex) - labelCandidateScore(second, scene, objectIndex, labelIndex));
      const chosen = candidates[0];
      const placed = {
        ...spec,
        ...chosen,
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

export function route(scene) {
  placePorts(scene);
  alignFacingDocks(scene);
  for (const region of scene.regions.values()) region.geometry = regionGeometry(region);
  const obstacles = scene.objects.filter((object) => object.visible && object.children.length === 0 && !object.frame && !["title", "subtitle", "legend-item"].includes(object.kind));
  const index = new SpatialIndex(obstacles);
  sharedPins(scene, index);
  const routeIndex = new SpatialIndex([]);
  for (const line of scene.lines) {
    routeLine(line, index, routeIndex);
    indexRoute(routeIndex, line);
  }
  improveRoutes(scene, index);
  placeAllLabels(scene, index);
  return scene;
}
