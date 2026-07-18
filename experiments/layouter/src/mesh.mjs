const SIDES = ["top", "right", "bottom", "left"];

function flowChildren(object) {
  return object.children.filter((child) => !child.anchor && !child.frame);
}

function layoutKind(object) {
  return object.layout?.kind ?? (["scope", "diagram"].includes(object.kind) ? "column" : object.kind);
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

export function regionGeometry(region) {
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
  const common = {
    kind: "gap",
    owner: object,
    index,
    corridors: active?.corridors ?? [],
    routingGeometry: active?.geometry ?? null,
  };
  const cells = [{
    ...common,
    key,
    zone: "track",
    materialized: Boolean(active),
    geometry: core,
  }];
  if (!active?.geometry || !intersects(active.geometry, core)) return cells;
  const access = subtractGeometry(active.geometry, core).map((part, partIndex) => ({
    ...common,
    key: `${key}:access-${partIndex}`,
    zone: "access",
    materialized: false,
    geometry: part,
  }));
  return [...cells, ...access];
}

// Positive-length shared boundaries form the local, sparse cell adjacency graph.
function connectBoundary(first, second, firstStart, firstEnd, secondStart, secondEnd) {
  const starts = [...first].sort((a, b) => firstStart(a) - firstStart(b));
  const ends = [...second].sort((a, b) => secondStart(a) - secondStart(b));
  let begin = 0;
  for (const source of starts) {
    while (begin < ends.length && secondEnd(ends[begin]) <= firstStart(source)) begin += 1;
    for (let index = begin; index < ends.length && secondStart(ends[index]) < firstEnd(source); index += 1) {
      const target = ends[index];
      if (source === target) continue;
      source.neighbors.add(target.key);
      target.neighbors.add(source.key);
    }
  }
}

function connectChannelCells(cells) {
  const cellsByOwner = new Map();
  for (const cell of cells) {
    cell.neighbors = new Set();
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
        (cell) => cell.geometry.y, (cell) => cell.geometry.y + cell.geometry.height);
    }
    for (const [coordinate, ending] of bottom) {
      const starting = top.get(coordinate);
      if (starting) connectBoundary(ending, starting,
        (cell) => cell.geometry.x, (cell) => cell.geometry.x + cell.geometry.width,
        (cell) => cell.geometry.x, (cell) => cell.geometry.x + cell.geometry.width);
    }
  }
  for (const cell of cells) cell.neighbors = [...cell.neighbors].sort();
}

function gridGutters(object, members) {
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
    cells.push({
      key: `mesh:grid-column-gap:${object.path || "$root"}:${column}`,
      kind: "gap",
      owner: object,
      materialized: false,
      geometry: geometry(start, top, end - start, bottom - top, "vertical"),
    });
  }
  for (let row = 0; row < rows - 1; row += 1) {
    const before = rowMembers[row];
    const after = rowMembers[row + 1];
    const start = Math.max(...before.map((member) => member.box.y + member.box.height));
    const end = Math.min(...after.map((member) => member.box.y));
    cells.push({
      key: `mesh:grid-row-gap:${object.path || "$root"}:${row}`,
      kind: "gap",
      owner: object,
      materialized: false,
      geometry: geometry(left, start, right - left, end - start, "horizontal"),
    });
  }
  return cells;
}

function paddingCells(object, activePadding, residents) {
  const sides = Object.fromEntries(SIDES.map((side) => {
    const active = activePadding.get(`${object.path || "$root"}:${side}`);
    const region = active ?? { kind: "padding", owner: object, side, thickness: 0, clearance: 0, corridors: [] };
    return [side, { region, geometry: active?.geometry ?? regionGeometry(region) }];
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
    kind: "padding",
    owner: object,
    side: cell.side,
    zone: "band",
    materialized: Boolean(activePadding.get(`${path}:${cell.side}`)),
    corridors: sides[cell.side].region.corridors ?? [],
    routingGeometry: sides[cell.side].geometry,
    geometry: cell.geometry,
  }));
  const cornerCells = [
    { corner: "top-left", outwardSides: ["top", "left"], geometry: geometry(box.x, box.y, leftWidth, topHeight, "junction") },
    { corner: "top-right", outwardSides: ["top", "right"], geometry: geometry(box.x + box.width - rightWidth, box.y, rightWidth, topHeight, "junction") },
    { corner: "bottom-right", outwardSides: ["bottom", "right"], geometry: geometry(box.x + box.width - rightWidth, box.y + box.height - bottomHeight, rightWidth, bottomHeight, "junction") },
    { corner: "bottom-left", outwardSides: ["bottom", "left"], geometry: geometry(box.x, box.y + box.height - bottomHeight, leftWidth, bottomHeight, "junction") },
  ].map((cell) => ({
    key: `mesh:corner:${path}:${cell.corner}`,
    kind: "corner",
    owner: object,
    corner: cell.corner,
    zone: "band",
    outwardSides: cell.outwardSides,
    materialized: true,
    geometry: cell.geometry,
  }));
  return subtractResidents([...sideCells, ...cornerCells], residents);
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
      cells.push(...gridGutters(object, members));
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
  connectChannelCells(scene.channelMesh);
  return scene.channelMesh;
}
