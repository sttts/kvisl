const SIDES = ["top", "right", "bottom", "left"];

function flowChildren(object) {
  return object.children.filter((child) => !child.anchor && !child.frame);
}

function layoutKind(object) {
  const kind = object.layout?.kind ?? (["scope", "diagram"].includes(object.kind) ? "column" : object.kind);
  if (Math.abs(object.physicalOrientation ?? 0) % 180 !== 90) return kind;
  if (kind === "row") return "column";
  if (kind === "column") return "row";
  return kind;
}

function geometry(x, y, width, height, axis) {
  return { x, y, width: Math.max(0, width), height: Math.max(0, height), axis };
}

// Container titles are measured residents of the top padding mesh.
export function boundaryLabelStrips(scene) {
  return scene.objects
    .filter((object) => object.visible && object.children.length > 0 && object.label)
    .map((object) => {
      const titleLines = object.renderLines?.filter((line) => !line.divider && line.role === "label") ?? [];
      const longest = titleLines.length ? Math.max(...titleLines.map((line) => line.text.length)) : String(object.label).length;
      return {
        kind: "boundary-label",
        visible: true,
        children: [],
        roles: [],
        classes: [],
        owner: object,
        box: {
          x: object.box.x + 8,
          y: object.box.y + 4,
          width: Math.max(0, Math.min(object.box.width - 16, longest * (object.fontSize ?? 15) * 0.62 + 16)),
          height: Math.max(1, titleLines.length) * (object.fontSize ?? 15) * 1.6,
        },
      };
    });
}

function reservedRegionEnvelope(region) {
  if (region.kind === "padding") {
    const box = region.owner.box;
    const clearance = region.clearance ?? 0;
    const padding = region.owner.paddingBox ?? { top: 12, right: 12, bottom: 12, left: 12 };
    const thickness = region.thickness > 0 ? region.thickness : padding[region.side];
    const contentHeight = region.owner.contentHeight ?? 0;
    if (region.side === "top") {
      return geometry(box.x, box.y + padding.top + contentHeight - clearance - thickness, box.width, thickness, "horizontal");
    }
    if (region.side === "bottom") {
      return geometry(box.x, box.y + box.height - padding.bottom + clearance, box.width, thickness, "horizontal");
    }
    if (region.side === "left") {
      return geometry(box.x + padding.left - clearance - thickness, box.y, thickness, box.height, "vertical");
    }
    return geometry(box.x + box.width - padding.right + clearance, box.y, thickness, box.height, "vertical");
  }
  const first = region.owner.children[region.index]?.box;
  const second = region.owner.children[region.index + 1]?.box;
  if (!first || !second) return geometry(0, 0, 0, 0, "vertical");
  const separatedX = first.x + first.width <= second.x || second.x + second.width <= first.x;
  if (separatedX) {
    const left = first.x < second.x ? first.x + first.width : second.x + second.width;
    const right = first.x < second.x ? second.x : first.x;
    return geometry(left, Math.min(first.y, second.y), right - left,
      Math.max(first.y + first.height, second.y + second.height) - Math.min(first.y, second.y), "vertical");
  }
  const top = first.y < second.y ? first.y + first.height : second.y + second.height;
  const bottom = first.y < second.y ? second.y : first.y;
  return geometry(Math.min(first.x, second.x), top,
    Math.max(first.x + first.width, second.x + second.width) - Math.min(first.x, second.x), bottom - top, "horizontal");
}

function gapBetween(first, second, axis) {
  if (axis === "vertical") {
    const top = Math.max(first.y, second.y);
    const bottom = Math.min(first.y + first.height, second.y + second.height);
    return geometry(first.x + first.width, top, second.x - first.x - first.width, bottom - top, "vertical");
  }
  const left = Math.max(first.x, second.x);
  const right = Math.min(first.x + first.width, second.x + second.width);
  return geometry(left, first.y + first.height, right - left, second.y - first.y - first.height, "horizontal");
}

function intersects(first, second) {
  return first.x < second.x + second.width
    && first.x + first.width > second.x
    && first.y < second.y + second.height
    && first.y + first.height > second.y;
}

function subtractGeometry(source, obstacle) {
  if (!intersects(source, obstacle)) return [source];
  const left = Math.max(source.x, obstacle.x);
  const right = Math.min(source.x + source.width, obstacle.x + obstacle.width);
  const top = Math.max(source.y, obstacle.y);
  const bottom = Math.min(source.y + source.height, obstacle.y + obstacle.height);
  return [
    geometry(source.x, source.y, source.width, top - source.y, source.axis),
    geometry(source.x, bottom, source.width, source.y + source.height - bottom, source.axis),
    geometry(source.x, top, left - source.x, bottom - top, source.axis),
    geometry(right, top, source.x + source.width - right, bottom - top, source.axis),
  ].filter((part) => part.width > 0 && part.height > 0);
}

function subtractBox(cell, resident) {
  const parts = subtractGeometry(cell.geometry, resident.box);
  if (parts.length === 1 && parts[0] === cell.geometry) return [cell];
  return parts.map((part, index) => ({
    ...cell,
    key: `${cell.key}:part-${index}`,
    geometry: part,
    residents: [...(cell.residents ?? []), resident],
  }));
}

function subtractResidents(cells, residents) {
  return residents.reduce((parts, resident) => parts.flatMap((cell) => subtractBox(cell, resident)), cells);
}

// Keep the facing overlap as the track and split larger approach geometry into access cells.
function siblingGapCells(object, index, first, second, axis, active) {
  const key = `mesh:gap:${object.path || "$root"}:${index}`;
  const core = gapBetween(first.box, second.box, axis);
  const envelope = reservedRegionEnvelope(active ?? { kind: "gap", owner: object, index });
  const common = {
    kind: "gap",
    owner: object,
    index,
    slotKey: key,
    corridors: active?.corridors ?? [],
    regionKeys: active ? [active.key] : [],
  };
  const cells = [{
    ...common,
    key,
    zone: "track",
    materialized: Boolean(active),
    geometry: core,
  }];
  if (!intersects(envelope, core)) return cells;
  const access = subtractGeometry(envelope, core).map((part, partIndex) => ({
    ...common,
    key: `${key}:access-${partIndex}`,
    zone: "access",
    materialized: false,
    geometry: part,
  }));
  return [...cells, ...access];
}

// Positive-length shared boundaries form the local, sparse cell adjacency graph.
function connectBoundary(first, second, firstStart, firstEnd, secondStart, secondEnd,
  boundaryAxis, coordinate, kind = "local", allowed = () => true) {
  const starts = [...first].sort((a, b) => firstStart(a) - firstStart(b));
  const ends = [...second].sort((a, b) => secondStart(a) - secondStart(b));
  let begin = 0;
  for (const source of starts) {
    while (begin < ends.length && secondEnd(ends[begin]) <= firstStart(source)) begin += 1;
    for (let index = begin; index < ends.length && secondStart(ends[index]) < firstEnd(source); index += 1) {
      const target = ends[index];
      if (source === target || !allowed(source, target)) continue;
      source.neighbors.add(target.key);
      target.neighbors.add(source.key);
      const start = Math.max(firstStart(source), secondStart(target));
      const end = Math.min(firstEnd(source), secondEnd(target));
      source.portals.push({ to: target.key, boundaryAxis, coordinate, start, end, kind });
      target.portals.push({ to: source.key, boundaryAxis, coordinate, start, end, kind });
    }
  }
}

function allowsOutward(cell, side) {
  return cell.kind === "padding" && cell.side === side
    || cell.kind === "corner" && cell.outwardSides.includes(side);
}

function connectHierarchyCells(cells) {
  const left = new Map();
  const right = new Map();
  const top = new Map();
  const bottom = new Map();
  for (const cell of cells) {
    const box = cell.geometry;
    const add = (map, key) => map.set(key, [...(map.get(key) ?? []), cell]);
    add(left, box.x);
    add(right, box.x + box.width);
    add(top, box.y);
    add(bottom, box.y + box.height);
  }
  const related = (sourceSide, targetSide) => (source, target) =>
    source.owner !== target.owner && (source.owner.parent === target.owner && allowsOutward(source, sourceSide)
      || target.owner.parent === source.owner && allowsOutward(target, targetSide));
  for (const [coordinate, ending] of right) {
    const starting = left.get(coordinate);
    if (starting) connectBoundary(ending, starting,
      (cell) => cell.geometry.y, (cell) => cell.geometry.y + cell.geometry.height,
      (cell) => cell.geometry.y, (cell) => cell.geometry.y + cell.geometry.height,
      "vertical", coordinate, "hierarchy", related("right", "left"));
  }
  for (const [coordinate, ending] of bottom) {
    const starting = top.get(coordinate);
    if (starting) connectBoundary(ending, starting,
      (cell) => cell.geometry.x, (cell) => cell.geometry.x + cell.geometry.width,
      (cell) => cell.geometry.x, (cell) => cell.geometry.x + cell.geometry.width,
      "horizontal", coordinate, "hierarchy", related("bottom", "top"));
  }
}

function connectChannelCells(cells) {
  const cellsByOwner = new Map();
  for (const cell of cells) {
    cell.neighbors = new Set();
    cell.portals = [];
    const ownerCells = cellsByOwner.get(cell.owner) ?? [];
    ownerCells.push(cell);
    cellsByOwner.set(cell.owner, ownerCells);
  }
  for (const ownerCells of cellsByOwner.values()) {
    const left = new Map();
    const right = new Map();
    const top = new Map();
    const bottom = new Map();
    for (const cell of ownerCells) {
      const box = cell.geometry;
      const add = (map, key) => map.set(key, [...(map.get(key) ?? []), cell]);
      add(left, box.x);
      add(right, box.x + box.width);
      add(top, box.y);
      add(bottom, box.y + box.height);
    }
    for (const [coordinate, ending] of right) {
      const starting = left.get(coordinate);
      if (starting) connectBoundary(ending, starting,
        (cell) => cell.geometry.y, (cell) => cell.geometry.y + cell.geometry.height,
        (cell) => cell.geometry.y, (cell) => cell.geometry.y + cell.geometry.height,
        "vertical", coordinate);
    }
    for (const [coordinate, ending] of bottom) {
      const starting = top.get(coordinate);
      if (starting) connectBoundary(ending, starting,
        (cell) => cell.geometry.x, (cell) => cell.geometry.x + cell.geometry.width,
        (cell) => cell.geometry.x, (cell) => cell.geometry.x + cell.geometry.width,
        "horizontal", coordinate);
    }
  }
  connectHierarchyCells(cells);
  for (const cell of cells) {
    cell.neighbors = [...cell.neighbors].sort();
    cell.portals.sort((first, second) => first.to.localeCompare(second.to)
      || first.start - second.start || first.end - second.end);
  }
}

function matchingGridRegions(activeGaps, cellGeometry) {
  return activeGaps.filter((region) => {
    const routeGeometry = reservedRegionEnvelope(region);
    return routeGeometry?.axis === cellGeometry.axis
      && routeGeometry.x === cellGeometry.x
      && routeGeometry.y === cellGeometry.y
      && routeGeometry.width === cellGeometry.width
      && routeGeometry.height === cellGeometry.height;
  });
}

function gridGutters(object, members, activeGaps) {
  const columns = Math.max(1, Math.min(object.layoutData?.columns ?? object.columns ?? 1, members.length));
  const rows = Math.ceil(members.length / columns);
  const cells = [];
  const columnMembers = Array.from({ length: columns }, () => []);
  const rowMembers = Array.from({ length: rows }, () => []);
  members.forEach((member, index) => {
    columnMembers[index % columns].push(member);
    rowMembers[Math.floor(index / columns)].push(member);
  });
  const top = Math.min(...members.map((member) => member.box.y));
  const bottom = Math.max(...members.map((member) => member.box.y + member.box.height));
  const left = Math.min(...members.map((member) => member.box.x));
  const right = Math.max(...members.map((member) => member.box.x + member.box.width));
  for (let column = 0; column < columns - 1; column += 1) {
    const before = columnMembers[column];
    const after = columnMembers[column + 1];
    const start = Math.max(...before.map((member) => member.box.x + member.box.width));
    const end = Math.min(...after.map((member) => member.box.x));
    const cellGeometry = geometry(start, top, end - start, bottom - top, "vertical");
    const regions = matchingGridRegions(activeGaps, cellGeometry);
    cells.push({
      key: `mesh:grid-column-gap:${object.path || "$root"}:${column}`,
      slotKey: `mesh:grid-column-gap:${object.path || "$root"}:${column}`,
      kind: "gap",
      owner: object,
      zone: "track",
      materialized: regions.length > 0,
      corridors: regions.flatMap((region) => region.corridors),
      regionKeys: regions.map((region) => region.key),
      geometry: cellGeometry,
    });
  }
  for (let row = 0; row < rows - 1; row += 1) {
    const before = rowMembers[row];
    const after = rowMembers[row + 1];
    const start = Math.max(...before.map((member) => member.box.y + member.box.height));
    const end = Math.min(...after.map((member) => member.box.y));
    const cellGeometry = geometry(left, start, right - left, end - start, "horizontal");
    const regions = matchingGridRegions(activeGaps, cellGeometry);
    cells.push({
      key: `mesh:grid-row-gap:${object.path || "$root"}:${row}`,
      slotKey: `mesh:grid-row-gap:${object.path || "$root"}:${row}`,
      kind: "gap",
      owner: object,
      zone: "track",
      materialized: regions.length > 0,
      corridors: regions.flatMap((region) => region.corridors),
      regionKeys: regions.map((region) => region.key),
      geometry: cellGeometry,
    });
  }
  return cells;
}

function paddingCells(object, activePadding, residents) {
  const sides = Object.fromEntries(SIDES.map((side) => {
    const active = activePadding.get(`${object.path || "$root"}:${side}`);
    const region = active ?? { kind: "padding", owner: object, side, thickness: 0, clearance: 0, corridors: [] };
    return [side, { region }];
  }));
  const box = object.box;
  const path = object.path || "$root";
  const padding = object.paddingBox ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const leftWidth = Math.max(0, padding.left - (sides.left.region.clearance ?? 0));
  const rightWidth = Math.max(0, padding.right - (sides.right.region.clearance ?? 0));
  const topHeight = Math.max(0, (object.contentHeight ?? 0) + padding.top - (sides.top.region.clearance ?? 0));
  const bottomHeight = Math.max(0, padding.bottom - (sides.bottom.region.clearance ?? 0));
  const horizontalWidth = Math.max(0, box.width - leftWidth - rightWidth);
  const verticalHeight = Math.max(0, box.height - topHeight - bottomHeight);
  const sideCells = [
    { side: "top", geometry: geometry(box.x + leftWidth, box.y, horizontalWidth, topHeight, "horizontal") },
    { side: "right", geometry: geometry(box.x + box.width - rightWidth, box.y + topHeight, rightWidth, verticalHeight, "vertical") },
    { side: "bottom", geometry: geometry(box.x + leftWidth, box.y + box.height - bottomHeight, horizontalWidth, bottomHeight, "horizontal") },
    { side: "left", geometry: geometry(box.x, box.y + topHeight, leftWidth, verticalHeight, "vertical") },
  ].map((cell) => ({
    key: `mesh:padding:${path}:${cell.side}`,
    slotKey: `mesh:padding:${path}:${cell.side}`,
    kind: "padding",
    owner: object,
    side: cell.side,
    zone: "band",
    materialized: Boolean(activePadding.get(`${path}:${cell.side}`)),
    corridors: sides[cell.side].region.corridors ?? [],
    regionKeys: activePadding.has(`${path}:${cell.side}`) ? [sides[cell.side].region.key] : [],
    geometry: cell.geometry,
  }));
  const cornerCells = [
    { corner: "top-left", outwardSides: ["top", "left"], geometry: geometry(box.x, box.y, leftWidth, topHeight, "junction") },
    { corner: "top-right", outwardSides: ["top", "right"], geometry: geometry(box.x + box.width - rightWidth, box.y, rightWidth, topHeight, "junction") },
    { corner: "bottom-right", outwardSides: ["bottom", "right"], geometry: geometry(box.x + box.width - rightWidth, box.y + box.height - bottomHeight, rightWidth, bottomHeight, "junction") },
    { corner: "bottom-left", outwardSides: ["bottom", "left"], geometry: geometry(box.x, box.y + box.height - bottomHeight, leftWidth, bottomHeight, "junction") },
  ].map((cell) => ({
    key: `mesh:corner:${path}:${cell.corner}`,
    slotKey: `mesh:corner:${path}:${cell.corner}`,
    kind: "corner",
    owner: object,
    corner: cell.corner,
    zone: "band",
    outwardSides: cell.outwardSides,
    regionKeys: [],
    materialized: true,
    geometry: cell.geometry,
  }));
  return subtractResidents([...sideCells, ...cornerCells], residents);
}

function normalExtent(cell) {
  return cell.geometry.axis === "vertical" ? cell.geometry.width : cell.geometry.height;
}

function alongExtent(cell) {
  return cell.geometry.axis === "vertical" ? cell.geometry.height : cell.geometry.width;
}

// A title can split a padding band. The track uses the surviving free cell
// nearest the content; gaps use their facing core rather than an approach cell.
function compareTrackCells(region, first, second) {
  const innerEdge = (cell) => {
    const box = cell.geometry;
    if (region.side === "top") return box.y + box.height;
    if (region.side === "bottom") return -box.y;
    if (region.side === "left") return box.x + box.width;
    if (region.side === "right") return -box.x;
    return 0;
  };
  return innerEdge(second) - innerEdge(first)
    || alongExtent(second) - alongExtent(first)
    || normalExtent(second) - normalExtent(first)
    || first.key.localeCompare(second.key);
}

function bindRegions(scene) {
  const cellsByRegion = new Map();
  for (const cell of scene.channelMesh) {
    for (const regionKey of cell.regionKeys ?? []) {
      const regionCells = cellsByRegion.get(regionKey) ?? [];
      regionCells.push(cell.key);
      cellsByRegion.set(regionKey, regionCells);
    }
  }
  scene.channelBindings = new Map();
  for (const region of scene.regions.values()) {
    const cellKeys = [...new Set(cellsByRegion.get(region.key) ?? [])].sort();
    const cells = cellKeys.map((key) => scene.channelCellByKey.get(key));
    const coreCells = cells.filter((cell) => cell.zone === "track" || cell.zone === "band");
    const trackCell = [...coreCells].sort((first, second) => compareTrackCells(region, first, second))[0] ?? null;
    const binding = {
      key: region.key,
      region,
      axis: trackCell?.geometry.axis ?? null,
      cellKeys,
      cells,
      coreCellKeys: coreCells.map((cell) => cell.key),
      accessCellKeys: cells.filter((cell) => cell.zone === "access").map((cell) => cell.key),
      trackCell,
    };
    region.channelBinding = binding;
    scene.channelBindings.set(region.key, binding);
  }
}

export function regionGeometry(region) {
  const geometry = region.channelBinding?.trackCell?.geometry;
  if (!geometry) throw new Error(`routing region '${region.key}' is not bound to a channel-mesh cell`);
  return geometry;
}

export function buildChannelMesh(scene) {
  const cells = [];
  const residents = boundaryLabelStrips(scene);
  const residentsByOwner = new Map();
  for (const resident of residents) {
    const ownerResidents = residentsByOwner.get(resident.owner) ?? [];
    ownerResidents.push(resident);
    residentsByOwner.set(resident.owner, ownerResidents);
  }
  const activePadding = new Map();
  const activeGaps = new Map();
  for (const region of scene.regions.values()) {
    if (region.kind === "padding") activePadding.set(`${region.owner.path || "$root"}:${region.side}`, region);
    if (region.kind === "gap") activeGaps.set(`${region.owner.path || "$root"}:${region.index}`, region);
  }
  for (const object of scene.objects) {
    const members = flowChildren(object);
    if (!members.length) continue;
    cells.push(...paddingCells(object, activePadding, residentsByOwner.get(object) ?? []));
    const layout = layoutKind(object);
    if (layout === "grid") {
      const gaps = [...activeGaps.values()].filter((region) => region.owner === object);
      cells.push(...gridGutters(object, members, gaps));
    } else if (layout === "row" || layout === "column") {
      for (let index = 1; index < members.length; index += 1) {
        const first = members[index - 1];
        const second = members[index];
        const axis = layout === "row" ? "vertical" : "horizontal";
        const active = activeGaps.get(`${object.path || "$root"}:${first.siblingIndex}`);
        cells.push(...siblingGapCells(object, index - 1, first, second, axis, active));
      }
    }
  }
  scene.channelResidents = residents;
  scene.channelMesh = cells.filter((cell) => cell.geometry.width > 0 && cell.geometry.height > 0);
  scene.channelCellByKey = new Map(scene.channelMesh.map((cell) => [cell.key, cell]));
  connectChannelCells(scene.channelMesh);
  bindRegions(scene);
  return scene.channelMesh;
}
