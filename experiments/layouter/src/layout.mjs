const SIDES = ["top", "right", "bottom", "left"];
const SPACING = { none: 0, tiny: 6, small: 12, medium: 20, large: 32, xlarge: 48 };
const ROUTE_CLEARANCE = 12;
const BOUNDARY_CROSSING_BAND = 16;

function length(value, fallback, tokens) {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    if (typeof tokens[value] === "number") return tokens[value];
    if (value in SPACING) return SPACING[value];
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function boxLengths(value, fallback, tokens) {
  if (value == null || typeof value !== "object") {
    const size = length(value, fallback, tokens);
    return { top: size, right: size, bottom: size, left: size };
  }
  return Object.fromEntries(SIDES.map((side) => [side, length(value[side], fallback, tokens)]));
}

function ancestors(object) {
  const result = [];
  for (let current = object; current; current = current.parent) result.push(current);
  return result;
}

function leastCommonAncestor(first, second) {
  const firstAncestors = new Set(ancestors(first));
  for (let current = second; current; current = current.parent) {
    if (firstAncestors.has(current)) return current;
  }
  return null;
}

function branchBelow(ancestor, object) {
  let current = object;
  while (current?.parent && current.parent !== ancestor) current = current.parent;
  return current?.parent === ancestor ? current : null;
}

function regionKey(type, owner, slot) {
  return `${type}:${owner.path || "$root"}:${slot}`;
}

export function effectiveLayout(object) {
  return object.layout?.kind ?? (object.kind === "scope" || object.kind === "diagram" ? "column" : null);
}

function directionToward(owner, fromBranch, toBranch) {
  const layout = effectiveLayout(owner);
  const from = fromBranch.siblingIndex;
  const to = toBranch.siblingIndex;
  if (layout === "row" || layout === "grid") return from <= to ? "right" : "left";
  return from <= to ? "bottom" : "top";
}

function addUniqueLine(region, line, corridor = null, usage = "track") {
  if (region.entryLines.has(line)) {
    const entry = region.entries.find((candidate) => candidate.line === line);
    // An authored corridor upgrades an implicit boundary crossing. The same
    // line still occupies only one physical entry in the region.
    if (entry && usage === "track") {
      entry.usage = "track";
      entry.corridor = corridor ?? entry.corridor;
    }
    return;
  }
  region.entryLines.add(line);
  region.entries.push({ line, corridor, usage });
}

function lineLabelTexts(line) {
  const texts = [];
  if (line.label != null) texts.push(line.label);
  for (const label of line.labels) if (label?.text != null) texts.push(label.text);
  for (const segment of line.segments) if (segment.label != null) texts.push(segment.label);
  for (const labels of line.endLabels) for (const label of labels) if (label?.text != null) texts.push(label.text);
  return texts.map(String);
}

// lines that join at a named merge/auto port or share an explicit merge/auto
// group travel on ONE track per region — sharing their run at full length
// instead of riding adjacent tracks
function lineShareKey(line) {
  if (line.share?.group != null) {
    const mode = line.share.mode ?? "auto";
    if (mode === "merge" || mode === "auto") return `group:${line.share.group}`;
  }
  for (const endpoint of [line.from, line.to]) {
    const port = endpoint?.port;
    if (!port) continue;
    const mode = port.sharing?.mode ?? "auto";
    if (mode === "merge" || mode === "auto") return `port:${(port.anchor ?? port.owner)?.path ?? ""}:${port.id}`;
  }
  return null;
}

export function lineLabelDemand(line, axis, text = null) {
  const texts = text == null ? lineLabelTexts(line) : [String(text)];
  if (!texts.length) return 0;
  if (axis === "horizontal") return Math.max(...texts.map((text) => Math.max(...text.split("\n").map((part) => part.length)) * 7.4 + 34));
  return Math.max(...texts.map((text) => text.split("\n").length * 16 + 12));
}

function physicalGapRegions(first, second, regions, options = {}) {
  if (!first || !second || first.parent !== second.parent) return [];
  const owner = first.parent;
  if (options.implicit && effectiveLayout(owner) === "grid") return [];
  const firstIndex = first.siblingIndex;
  const secondIndex = second.siblingIndex;
  const start = Math.min(firstIndex, secondIndex);
  const end = Math.max(firstIndex, secondIndex);
  const result = [];
  for (let index = start; index < end; index += 1) {
    const key = regionKey("gap", owner, index);
    if (!regions.has(key)) regions.set(key, { key, kind: "gap", owner, index, entries: [], entryLines: new Set(), corridors: [] });
    result.push(regions.get(key));
  }
  return result;
}

// a gap corridor runs vertically when it separates same-row neighbors —
// labels riding it need horizontal room, not vertical
function gapRunsVertically(region) {
  const layout = effectiveLayout(region.owner);
  if (layout === "grid") {
    const members = region.owner.children.filter((child) => !child.anchor && !child.frame);
    const columns = Math.max(1, Math.min(region.owner.columns ?? 1, members.length));
    return Math.floor(region.index / columns) === Math.floor((region.index + 1) / columns);
  }
  return layout === "row";
}

function paddingRegion(container, side, regions) {
  if (!container || !SIDES.includes(side)) return null;
  const key = regionKey("padding", container, side);
  if (!regions.has(key)) regions.set(key, { key, kind: "padding", owner: container, side, entries: [], entryLines: new Set(), corridors: [] });
  return regions.get(key);
}

function regionsForCorridor(corridor, regions) {
  if (corridor.between) return physicalGapRegions(corridor.between[0], corridor.between[1], regions);
  if (corridor.container && corridor.side) {
    const region = paddingRegion(corridor.container, corridor.side, regions);
    return region ? [region] : [];
  }
  return [];
}

function nestedExitReservations(endpoint, lca, side, line, regions) {
  for (let current = endpoint.parent; current && current !== lca; current = current.parent) {
    if (!current.visible) continue;
    const region = paddingRegion(current, side, regions);
    // Hierarchy crossings need an ordered pin, not a parallel lane. Counting
    // them as tracks inflated container padding and pulled routes away from
    // their authored higher-level corridor.
    if (region) addUniqueLine(region, line, null, "crossing");
  }
}

function hasAncestorOrSelf(object, ancestor) {
  for (let current = object; current; current = current.parent) if (current === ancestor) return true;
  return false;
}

function explicitPaddingSide(line, endpoint) {
  const segments = endpoint === line.from ? line.segments : [...line.segments].reverse();
  for (const segment of segments) {
    const container = segment.region?.kind === "padding" ? segment.region.container : segment.corridor?.container;
    const side = segment.region?.kind === "padding" ? segment.region.side : segment.corridor?.side;
    if (container && side && hasAncestorOrSelf(endpoint.object, container)) return side;
  }
  return null;
}

function explicitRegionConnectsBranches(line, lca, first, second) {
  return line.segments.some((segment) => {
    const between = segment.region?.kind === "gap" ? segment.region.between : segment.corridor?.between;
    if (!between) return false;
    const left = branchBelow(lca, between[0]);
    const right = branchBelow(lca, between[1]);
    return (left === first && right === second) || (left === second && right === first);
  });
}

export function reserveRoutingSpace(scene) {
  const regions = new Map();
  // corridors start at bare track width; labels only widen a corridor after
  // a solve proved they find no free spot (escalated by the pipeline)
  const reservations = scene.labelReservations ?? new Map();
  for (const object of scene.objects) {
    object.reserved = {
      gaps: [],
      gridColumnGaps: [],
      gridRowGaps: [],
      padding: { top: 0, right: 0, bottom: 0, left: 0 },
    };
  }

  for (const [rank, corridor] of scene.corridors.entries()) {
    corridor.rank = rank;
    for (const region of regionsForCorridor(corridor, regions)) region.corridors.push(corridor);
  }

  for (const line of scene.lines) {
    if (!line.from || !line.to || line.space === "overlay") continue;
    line.regionTracks = new Map();
    const lca = leastCommonAncestor(line.from.object, line.to.object);
    const fromBranch = branchBelow(lca, line.from.object);
    const toBranch = branchBelow(lca, line.to.object);
    const hasExplicitRegion = line.segments.some((segment) => segment.corridor || segment.region);

    if (lca && fromBranch && toBranch && fromBranch !== toBranch) {
      if (effectiveLayout(lca) === "grid" && !hasExplicitRegion) {
        const members = lca.children.filter((child) => !child.anchor && !child.frame);
        const columns = Math.max(1, Math.min(lca.columns ?? 1, members.length));
        const fromIndex = members.indexOf(fromBranch);
        const toIndex = members.indexOf(toBranch);
        const fromColumn = fromIndex % columns;
        const toColumn = toIndex % columns;
        const fromRow = Math.floor(fromIndex / columns);
        const toRow = Math.floor(toIndex / columns);
        if (fromRow === toRow && fromColumn !== toColumn) {
          const gapIndex = Math.floor((fromColumn + toColumn - 1) / 2);
          const key = `gridcol:${lca.path}:${gapIndex}`;
          line.labelReservation = { key, axis: "horizontal" };
          lca.reserved.gridColumnGaps[gapIndex] = Math.max(lca.reserved.gridColumnGaps[gapIndex] ?? 0, reservations.get(key) ?? 0);
        } else if (fromColumn === toColumn && fromRow !== toRow) {
          const gapIndex = Math.floor((fromRow + toRow - 1) / 2);
          const key = `gridrow:${lca.path}:${gapIndex}`;
          line.labelReservation = { key, axis: "vertical" };
          lca.reserved.gridRowGaps[gapIndex] = Math.max(lca.reserved.gridRowGaps[gapIndex] ?? 0, reservations.get(key) ?? 0);
        }
      }
      const implicitRegions = physicalGapRegions(fromBranch, toBranch, regions, { implicit: true });
      for (const region of implicitRegions) addUniqueLine(region, line);
      if (implicitRegions.length) line.labelRegionKey = implicitRegions[Math.floor(implicitRegions.length / 2)].key;
      // A port side fixes departure from the leaf object. An explicit gap at
      // this hierarchy level fixes the ancestor traversal instead; carrying
      // the leaf side through every ancestor would route around that gap.
      const explicitBranchTraversal = explicitRegionConnectsBranches(line, lca, fromBranch, toBranch);
      const exitSide = (endpoint, fallback) => explicitPaddingSide(line, endpoint)
        ?? (explicitBranchTraversal ? fallback : SIDES.includes(endpoint.port?.side) ? endpoint.port.side : fallback);
      const fromSide = exitSide(line.from, directionToward(lca, fromBranch, toBranch));
      const toSide = exitSide(line.to, directionToward(lca, toBranch, fromBranch));
      nestedExitReservations(line.from.object, lca, fromSide, line, regions);
      nestedExitReservations(line.to.object, lca, toSide, line, regions);
    }

    for (const segment of line.segments) {
      let segmentRegions = [];
      if (segment.corridor) {
        segmentRegions = regionsForCorridor(segment.corridor, regions);
        for (const region of segmentRegions) addUniqueLine(region, line, segment.corridor);
      } else if (segment.region?.kind === "gap") {
        segmentRegions = physicalGapRegions(segment.region.between[0], segment.region.between[1], regions);
        for (const region of segmentRegions) addUniqueLine(region, line);
      } else if (segment.region?.kind === "padding") {
        const region = paddingRegion(segment.region.container, segment.region.side, regions);
        if (region) {
          segmentRegions = [region];
          addUniqueLine(region, line);
        }
      }
      if (segmentRegions.length && (segment.label != null || line.label != null || line.labels.length)) {
        const key = segmentRegions[Math.floor(segmentRegions.length / 2)].key;
        if (segment.label != null) segment.labelRegionKey = key;
        else line.labelRegionKey = key;
      }
    }
  }

  for (const region of regions.values()) {
    region.entries.sort((first, second) => {
      const firstRank = first.corridor?.rank ?? Number.MAX_SAFE_INTEGER;
      const secondRank = second.corridor?.rank ?? Number.MAX_SAFE_INTEGER;
      return firstRank - secondRank || first.line.id.localeCompare(second.line.id);
    });
    const pressures = region.corridors.map((corridor) => corridor.pressure ?? 0);
    const pressure = Math.max(0, Math.min(1, pressures.length ? Math.max(...pressures) : 0));
    const minSpacing = 6;
    const preferredSpacing = 12;
    region.spacing = minSpacing + (1 - pressure) * (preferredSpacing - minSpacing);
    const labelAxis = region.kind === "padding"
      ? region.side === "left" || region.side === "right" ? "horizontal" : "vertical"
      : gapRunsVertically(region) ? "horizontal" : "vertical";
    for (const entry of region.entries) {
      if (entry.line.labelRegionKey === region.key) entry.line.labelReservation = { key: region.key, axis: labelAxis };
      for (const segment of entry.line.segments) {
        if (segment.labelRegionKey === region.key) segment.labelReservation = { key: region.key, axis: labelAxis };
      }
    }
    const labelDemand = reservations.get(region.key) ?? 0;
    // Share-eligible authored lines occupy one track. Implicit hierarchy
    // crossings pass through the band and therefore consume no parallel lane.
    const trackIndexByKey = new Map();
    const trackEntries = region.entries.filter((entry) => entry.usage !== "crossing");
    for (const entry of trackEntries) {
      const key = lineShareKey(entry.line) ?? `line:${entry.line.id}`;
      if (!trackIndexByKey.has(key)) trackIndexByKey.set(key, trackIndexByKey.size);
      entry.trackKey = key;
    }
    const trackCount = trackIndexByKey.size;
    const trackThickness = trackCount ? 12 + trackCount * region.spacing : 0;
    const crossingThickness = region.kind === "padding" && region.entries.some((entry) => entry.usage === "crossing")
      ? BOUNDARY_CROSSING_BAND
      : 0;
    region.thickness = Math.max(trackThickness, crossingThickness, labelDemand);
    region.clearance = region.kind === "padding" && trackThickness > 0 ? ROUTE_CLEARANCE : 0;
    region.entries.forEach((entry) => {
      const crossing = entry.usage === "crossing";
      entry.line.regionTracks.set(region.key, {
        region,
        index: crossing ? 0 : trackIndexByKey.get(entry.trackKey),
        total: crossing ? 1 : trackCount,
        crossing,
      });
    });

    for (const corridor of region.corridors) {
      const count = trackEntries.filter((entry) => entry.corridor === corridor).length;
      if (corridor.capacity != null && count > corridor.capacity) {
        scene.diagnostics.push({
          severity: "error",
          code: "corridor-capacity",
          message: `corridor '${corridor.id}' needs ${count} tracks but has capacity ${corridor.capacity}`,
        });
      }
    }

    if (region.kind === "gap") {
      if (effectiveLayout(region.owner) === "grid") {
        const members = region.owner.children.filter((child) => !child.anchor && !child.frame);
        const columns = Math.max(1, Math.min(region.owner.columns ?? 1, members.length));
        const firstRow = Math.floor(region.index / columns);
        const secondRow = Math.floor((region.index + 1) / columns);
        if (firstRow === secondRow) {
          const gapIndex = region.index % columns;
          region.owner.reserved.gridColumnGaps[gapIndex] = Math.max(
            region.owner.reserved.gridColumnGaps[gapIndex] ?? 0,
            region.thickness,
          );
        } else {
          region.owner.reserved.gridRowGaps[firstRow] = Math.max(
            region.owner.reserved.gridRowGaps[firstRow] ?? 0,
            region.thickness,
          );
        }
      } else {
        region.owner.reserved.gaps[region.index] = Math.max(region.owner.reserved.gaps[region.index] ?? 0, region.thickness);
      }
    } else {
      region.owner.reserved.padding[region.side] = Math.max(
        region.owner.reserved.padding[region.side],
        region.thickness + region.clearance,
      );
    }
  }
  // escalated reservations may target pockets no line registered in (a label
  // squeezed between two siblings it does not connect) — apply them directly
  for (const [key, value] of reservations) {
    if (regions.has(key)) continue;
    const parts = key.split(":");
    if (parts[0] !== "gap") continue;
    const owner = scene.objectByPath.get(parts.slice(1, -1).join(":"));
    const index = Number(parts.at(-1));
    if (owner && Number.isInteger(index)) owner.reserved.gaps[index] = Math.max(owner.reserved.gaps[index] ?? 0, value);
  }

  scene.regions = regions;
  return regions;
}

function contentLines(object) {
  const result = [];
  if (object.label) result.push({ text: object.label, role: "label" });
  for (const entry of object.content) {
    if (entry.group) {
      if (result.length) result.push({ divider: true });
      for (const item of entry.items) result.push({ text: item, role: entry.role });
    } else {
      result.push(entry);
    }
  }
  return result;
}

function wrapText(text, limit) {
  const explicit = String(text).split("\n");
  const result = [];
  for (const line of explicit) {
    if (line.length <= limit) {
      result.push(line);
      continue;
    }
    let current = "";
    for (const word of line.split(/\s+/)) {
      if (current && `${current} ${word}`.length > limit) {
        result.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) result.push(current);
  }
  return result;
}

function measureContent(object, childMax = 0) {
  const fontSize = object.kind === "title" ? 32 : object.kind === "subtitle" ? 18 : object.style.fontSize ?? 15;
  const charWidth = fontSize * 0.55;
  // An infinite canvas gives document headings their intrinsic width. Only an
  // authored newline splits them; a future finite allocation may reflow them
  // against that concrete width in a separate bounded pass.
  const wrap = object.kind === "title" || object.kind === "subtitle" ? Number.POSITIVE_INFINITY
    : object.roles.includes("implementation-status") ? 120
    : object.kind === "note" || object.kind === "legend-item" ? 44
    : 72;
  // a container title wraps toward its children's width — the box must not
  // grow wide only to keep its title on one line
  const labelWrap = object.children.length ? Math.max(24, Math.floor(childMax / charWidth)) : wrap;
  const expanded = [];
  for (const line of contentLines(object)) {
    if (line.divider) expanded.push(line);
    else for (const text of wrapText(line.text, line.role === "label" ? labelWrap : wrap)) expanded.push({ ...line, text });
  }
  const width = Math.max(0, ...expanded.filter((line) => !line.divider).map((line) => line.text.length * charWidth));
  const height = expanded.reduce((sum, line) => sum + (line.divider ? 8 : fontSize * 1.35), 0);
  object.renderLines = expanded;
  object.fontSize = fontSize;
  return { width, height };
}

function defaultPadding(object, tokens) {
  if (object.kind === "diagram") return boxLengths(object.style.padding, 28, tokens);
  if (["row", "column", "grid"].includes(object.kind)) return boxLengths(object.style.padding, 0, tokens);
  if (object.kind === "title" || object.kind === "subtitle") return boxLengths(object.style.padding, 2, tokens);
  if (object.kind === "legend-item") return boxLengths(object.style.padding, 3, tokens);
  if (object.kind === "image") return boxLengths(object.style.padding, 0, tokens);
  if (object.kind === "note" && object.style.stroke === "transparent") return boxLengths(object.style.padding, 4, tokens);
  return boxLengths(object.style.padding, object.kind === "scope" ? 22 : 14, tokens);
}

function flowChildren(object) {
  return object.children.filter((child) => !child.anchor && !child.frame);
}

function themeMinimum(object) {
  if (object.theme !== "excalidraw-handdrawn" || object.kind !== "node" || fixedShape(object) || object.id.startsWith("$text-")) {
    return { width: 0, height: 0 };
  }
  return {
    width: object.style.minWidth == null ? 220 : 0,
    height: object.style.minHeight == null ? 60 : 0,
  };
}

function measureObject(object, scene) {
  for (const child of object.children) measureObject(child, scene);
  const tokens = scene.tokens;
  const content = measureContent(object, Math.max(0, ...flowChildren(object).map((child) => child.measured.width)));
  const padding = defaultPadding(object, tokens);
  for (const side of SIDES) padding[side] += object.reserved.padding[side] ?? 0;
  for (const child of object.children) {
    if (child.kind !== "note" || child.anchor !== object || child.placement?.area !== "inside") continue;
    const side = child.placement.side === "auto" ? "bottom" : child.placement.side;
    const extent = side === "top" || side === "bottom" ? child.measured.height : child.measured.width;
    padding[side] = Math.max(padding[side], extent + 24);
  }
  object.paddingBox = padding;
  const header = object.label && object.children.length ? 8 : 0;
  object.contentHeight = content.height + header;
  const members = flowChildren(object);
  const layout = effectiveLayout(object);
  const baseGap = length(object.style.gap ?? object.layout?.gap, layout ? (object.kind === "legend" ? 8 : 22) : 0, tokens);
  const gaps = Array.from({ length: Math.max(0, members.length - 1) }, (_, index) =>
    baseGap + (object.reserved.gaps[index] ?? 0));
  object.gapSizes = gaps;

  let bodyWidth = 0;
  let bodyHeight = 0;
  object.layoutData = null;
  if (members.length && layout === "row") {
    bodyWidth = members.reduce((sum, child) => sum + child.measured.width, 0) + gaps.reduce((sum, gap) => sum + gap, 0);
    bodyHeight = Math.max(...members.map((child) => child.measured.height));
  } else if (members.length && layout === "grid") {
    const columns = Math.max(1, Math.min(object.columns ?? 1, members.length));
    const rows = Math.ceil(members.length / columns);
    const columnWidths = Array(columns).fill(0);
    const rowHeights = Array(rows).fill(0);
    members.forEach((child, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      columnWidths[column] = Math.max(columnWidths[column], child.measured.width);
      rowHeights[row] = Math.max(rowHeights[row], child.measured.height);
    });
    const columnGaps = Array.from({ length: Math.max(0, columns - 1) }, (_, index) =>
      Math.max(baseGap, object.reserved.gridColumnGaps[index] ?? 0));
    const rowGaps = Array.from({ length: Math.max(0, rows - 1) }, (_, index) =>
      Math.max(baseGap, object.reserved.gridRowGaps[index] ?? 0));
    bodyWidth = columnWidths.reduce((sum, width) => sum + width, 0) + columnGaps.reduce((sum, gap) => sum + gap, 0);
    bodyHeight = rowHeights.reduce((sum, height) => sum + height, 0) + rowGaps.reduce((sum, gap) => sum + gap, 0);
    object.layoutData = { columns, columnWidths, rowHeights, columnGaps, rowGaps };
  } else if (members.length) {
    bodyWidth = Math.max(...members.map((child) => child.measured.width));
    bodyHeight = members.reduce((sum, child) => sum + child.measured.height, 0) + gaps.reduce((sum, gap) => sum + gap, 0);
  }

  if (object.kind === "image") {
    bodyWidth = 96;
    bodyHeight = 96 / (object.aspectRatio ?? 1);
  }
  if (object.shape?.includes("initial")) {
    bodyWidth = 24;
    bodyHeight = 24;
  }
  if (object.shape?.includes("final")) {
    bodyWidth = 28;
    bodyHeight = 28;
  }
  if (object.shape?.includes("occurrence")) {
    bodyWidth = 8;
    bodyHeight = 20;
  }
  if (object.shape?.includes("fork") || object.shape?.includes("join")) {
    bodyWidth = 90;
    bodyHeight = 12;
  }

  const textual = ["title", "subtitle", "legend-item", "diagram"].includes(object.kind);
  const minimumWidth = textual ? 0 : object.visible ? 72 : 0;
  const minimumHeight = textual ? 0 : object.visible ? 38 : 0;
  const themedMinimum = themeMinimum(object);
  const contentBesideChildren = members.length === 0;
  const innerWidth = Math.max(bodyWidth, content.width);
  const innerHeight = bodyHeight + (contentBesideChildren ? content.height : object.contentHeight);
  object.frameWidth = Math.max(
    minimumWidth,
    themedMinimum.width,
    innerWidth + padding.left + padding.right,
    length(object.style.minWidth, 0, tokens),
  );
  object.frameHeight = Math.max(
    minimumHeight,
    themedMinimum.height,
    innerHeight + padding.top + padding.bottom,
    length(object.style.minHeight, 0, tokens),
  );
  const quarterTurn = object.orientation === 90 || object.orientation === 270;
  // floors from stretch, quantization, and same-size act on the physical box
  const floor = object.sizeFloor ?? { width: 0, height: 0 };
  object.frameWidth = Math.max(object.frameWidth, quarterTurn ? floor.height : floor.width);
  object.frameHeight = Math.max(object.frameHeight, quarterTurn ? floor.width : floor.height);
  object.measured = {
    width: quarterTurn ? object.frameHeight : object.frameWidth,
    height: quarterTurn ? object.frameWidth : object.frameHeight,
  };

  let cursor = 0;
  if (layout === "row") {
    const extra = Math.max(0, object.frameWidth - padding.left - padding.right - bodyWidth);
    members.forEach((child, index) => {
      child.localX = padding.left + distributeOffset(object.distribute, extra, index, members.length) + cursor;
      child.localY = padding.top + object.contentHeight + alignOffset(object.align, bodyHeight, child.measured.height);
      cursor += child.measured.width + (gaps[index] ?? 0);
    });
  } else if (layout === "grid" && object.layoutData) {
    const { columns, columnWidths, rowHeights, columnGaps, rowGaps } = object.layoutData;
    const columnX = [];
    let columnCursor = padding.left;
    for (let index = 0; index < columnWidths.length; index += 1) {
      columnX.push(columnCursor);
      columnCursor += columnWidths[index] + (columnGaps[index] ?? 0);
    }
    const rowY = [];
    let rowCursor = padding.top + object.contentHeight;
    for (let index = 0; index < rowHeights.length; index += 1) {
      rowY.push(rowCursor);
      rowCursor += rowHeights[index] + (rowGaps[index] ?? 0);
    }
    members.forEach((child, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      child.localX = columnX[column] + alignOffset(object.align, columnWidths[column], child.measured.width);
      child.localY = rowY[row];
    });
  } else {
    const extra = layout === "column" ? Math.max(0, object.frameHeight - padding.top - padding.bottom - object.contentHeight - bodyHeight) : 0;
    members.forEach((child, index) => {
      child.localX = padding.left + alignOffset(object.align, bodyWidth, child.measured.width);
      child.localY = padding.top + object.contentHeight + distributeOffset(object.distribute, extra, index, members.length) + cursor;
      cursor += child.measured.height + (gaps[index] ?? 0);
    });
  }
}

function alignOffset(align, available, size) {
  if (align === "end") return available - size;
  if (align === "center") return (available - size) / 2;
  return 0;
}

function distributeOffset(distribute, extra, index, count) {
  if (extra <= 0 || !count) return 0;
  if (distribute === "space-between") return count > 1 ? index * extra / (count - 1) : extra / 2;
  if (distribute === "space-around") return (index + 0.5) * extra / count;
  if (distribute === "center") return extra / 2;
  if (distribute === "end") return extra;
  return 0;
}

const STRETCH_EXCLUDED_KINDS = new Set(["title", "subtitle", "note", "legend", "legend-item", "image"]);
const FIXED_SHAPE_HINTS = ["initial", "final", "occurrence", "fork", "join", "actor", "choice", "diamond", "history"];

function fixedShape(object) {
  return object.shape != null && FIXED_SHAPE_HINTS.some((hint) => object.shape.includes(hint));
}

function harmonizable(object) {
  return object.visible
    && !STRETCH_EXCLUDED_KINDS.has(object.kind)
    && !fixedShape(object)
    && !object.id.startsWith("$text-")
    && object.style.minWidth == null
    && object.style.minHeight == null;
}

function raiseFloor(object, dimension, value) {
  if (value > object.sizeFloor[dimension] + 0.5) {
    object.sizeFloor[dimension] = value;
    return true;
  }
  return false;
}

// Group values whose spread stays inside the tolerance and lift every group
// member to the group maximum. Sizes may only grow, so the pass is monotone.
function quantize(entries, dimension) {
  const sorted = [...entries].sort((first, second) => first.measured[dimension] - second.measured[dimension]);
  let raised = false;
  let group = [];
  const flush = () => {
    if (group.length > 1) {
      const target = Math.max(...group.map((object) => object.measured[dimension]));
      for (const object of group) raised = raiseFloor(object, dimension, target) || raised;
    }
    group = [];
  };
  for (const object of sorted) {
    const value = object.measured[dimension];
    const anchor = group[0]?.measured[dimension];
    if (group.length && value - anchor > Math.max(28, anchor * 0.28)) flush();
    group.push(object);
  }
  flush();
  return raised;
}

function peerSignature(object) {
  return [object.kind, object.shape ?? "", [...object.roles].sort().join(","), [...object.classes].sort().join(",")].join("|");
}

// Stretch (the align-items: stretch analog), peer size quantization, and
// explicit same-size constraints all become monotone size floors that the
// next measurement pass applies.
function computeSizeFloors(scene) {
  let raised = false;
  // an extent constraint dictates the item's geometry; harmonizing it would
  // fight the constraint (a stretched activation bar spans its whole column)
  const constraintSized = new Set(scene.constraints
    .filter((constraint) => constraint.kind === "extent" && constraint.itemObject)
    .map((constraint) => constraint.itemObject));
  const eligible = (object) => harmonizable(object) && !constraintSized.has(object);
  // an invisible layout container is pure coordinate space: stretching it
  // costs no visible emptiness and gives distribute and neighbor alignment
  // their room to work
  const structural = (object) => !object.visible
    && ["row", "column", "grid"].includes(object.kind)
    && !constraintSized.has(object);
  // visible members equalize only near misses: stretching a short member to
  // several times its size fills the drawing with emptiness
  const stretchTo = (child, dimension, target) => {
    if (!eligible(child)) return false;
    if (target > child.measured[dimension] * 1.5 + 40) return false;
    return raiseFloor(child, dimension, target);
  };

  for (const container of scene.objects) {
    const members = flowChildren(container);
    if (!members.length) continue;
    const layout = effectiveLayout(container);
    if (!layout) continue;
    // a visible member equalizes only with lookalike siblings (same peer
    // signature) — equal size among equals, content-minimal otherwise; a
    // structurally different neighbor never inflates a box
    const groups = new Map();
    for (const child of members) {
      if (structural(child)) continue;
      const signature = peerSignature(child);
      if (!groups.has(signature)) groups.set(signature, []);
      groups.get(signature).push(child);
    }
    if (layout === "row" || layout === "column") {
      const dimension = layout === "row" ? "height" : "width";
      const overall = Math.max(...members.map((child) => child.measured[dimension]));
      for (const child of members) {
        if (structural(child)) raised = raiseFloor(child, dimension, overall) || raised;
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        const target = Math.max(...group.map((child) => child.measured[dimension]));
        for (const child of group) raised = stretchTo(child, dimension, target) || raised;
      }
    } else if (layout === "grid" && container.layoutData) {
      const { columns, columnWidths, rowHeights } = container.layoutData;
      members.forEach((child, index) => {
        if (!structural(child) && (groups.get(peerSignature(child))?.length ?? 0) < 2) return;
        const lift = structural(child) ? raiseFloor : stretchTo;
        raised = lift(child, "width", columnWidths[index % columns] ?? 0) || raised;
        raised = lift(child, "height", rowHeights[Math.floor(index / columns)] ?? 0) || raised;
      });
    }
  }

  const peers = new Map();
  for (const object of scene.objects) {
    if (!eligible(object) || object.children.length) continue;
    const signature = peerSignature(object);
    if (!peers.has(signature)) peers.set(signature, []);
    peers.get(signature).push(object);
  }
  for (const group of peers.values()) {
    if (group.length < 2) continue;
    raised = quantize(group, "width") || raised;
    raised = quantize(group, "height") || raised;
  }

  for (const constraint of scene.constraints) {
    if (constraint.kind !== "same-size" || constraint.memberObjects.length < 2) continue;
    const dimension = constraint.dimension ?? "both";
    if (dimension !== "height") {
      const target = Math.max(...constraint.memberObjects.map((object) => object.measured.width));
      for (const object of constraint.memberObjects) raised = raiseFloor(object, "width", target) || raised;
    }
    if (dimension !== "width") {
      const target = Math.max(...constraint.memberObjects.map((object) => object.measured.height));
      for (const object of constraint.memberObjects) raised = raiseFloor(object, "height", target) || raised;
    }
  }

  return raised;
}

function multiply(first, second) {
  return {
    a: first.a * second.a + first.c * second.b,
    b: first.b * second.a + first.d * second.b,
    c: first.a * second.c + first.c * second.d,
    d: first.b * second.c + first.d * second.d,
    e: first.a * second.e + first.c * second.f + first.e,
    f: first.b * second.e + first.d * second.f + first.f,
  };
}

function localTransform(object, x, y) {
  switch (object.orientation) {
    case 90: return { a: 0, b: 1, c: -1, d: 0, e: x + object.frameHeight, f: y };
    case 180: return { a: -1, b: 0, c: 0, d: -1, e: x + object.frameWidth, f: y + object.frameHeight };
    case 270: return { a: 0, b: -1, c: 1, d: 0, e: x, f: y + object.frameWidth };
    default: return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
  }
}

function point(matrix, x, y) {
  return { x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f };
}

function transformedBox(matrix, width, height) {
  const points = [point(matrix, 0, 0), point(matrix, width, 0), point(matrix, width, height), point(matrix, 0, height)];
  const xs = points.map((item) => item.x);
  const ys = points.map((item) => item.y);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
}

function assignGlobal(object, parentMatrix, parentOrientation = 0) {
  const matrix = multiply(parentMatrix, localTransform(object, object.localX ?? 0, object.localY ?? 0));
  object.matrix = matrix;
  object.physicalOrientation = (parentOrientation + object.orientation) % 360;
  object.box = transformedBox(matrix, object.frameWidth, object.frameHeight);
  for (const child of flowChildren(object)) assignGlobal(child, matrix, object.physicalOrientation);
}

function anchoredPosition(object, variant = {}) {
  const anchor = object.anchor?.box;
  if (!anchor) return { x: object.parent?.box.x ?? 0, y: object.parent?.box.y ?? 0 };
  const placement = object.placement ?? { area: "outside", side: "bottom", align: "center" };
  const side = placement.side === "auto" ? "bottom" : placement.side;
  const inside = placement.area === "inside";
  const alongX = side === "top" || side === "bottom";
  const align = variant.align ?? placement.align ?? "center";
  const distance = variant.distance ?? 12;
  const aligned = (start, extent, size) => align === "start" ? start + 12 : align === "end" ? start + extent - size - 12 : start + (extent - size) / 2;
  if (alongX) {
    return {
      x: aligned(anchor.x, anchor.width, object.measured.width),
      y: side === "top"
        ? inside ? anchor.y + distance : anchor.y - object.measured.height - distance
        : inside ? anchor.y + anchor.height - object.measured.height - distance : anchor.y + anchor.height + distance,
    };
  }
  return {
    x: side === "left"
      ? inside ? anchor.x + distance : anchor.x - object.measured.width - distance
      : inside ? anchor.x + anchor.width - object.measured.width - distance : anchor.x + anchor.width + distance,
    y: aligned(anchor.y, anchor.height, object.measured.height),
  };
}

function boxesIntersect(first, second, padding = 0) {
  return first.x < second.x + second.width + padding
    && first.x + first.width + padding > second.x
    && first.y < second.y + second.height + padding
    && first.y + first.height + padding > second.y;
}

// Anchored objects try their declared spot first and fall back through a
// bounded set of align/distance variants instead of accepting an overlap.
function assignAnchored(scene) {
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const obstacles = scene.objects.filter((object) => object.visible
    && !object.anchor
    && object.children.length === 0
    && !object.frame
    && !["title", "subtitle", "legend-item"].includes(object.kind));
  const placed = [];
  for (const object of scene.objects.filter((item) => item.anchor)) {
    // keep the declared alignment through growing distances before trying
    // the other alignments — falling back sideways is the bigger change
    const declaredAlign = object.placement?.align ?? "center";
    const variants = [{}];
    for (const align of [declaredAlign, ...["center", "start", "end"].filter((item) => item !== declaredAlign)]) {
      for (const distance of [12, 28, 48, 72]) variants.push({ distance, align });
    }
    let position = null;
    for (const variant of variants) {
      const candidate = anchoredPosition(object, variant);
      const box = { x: candidate.x, y: candidate.y, width: object.measured.width, height: object.measured.height };
      const hit = [...obstacles, ...placed].some((other) => other !== object && boxesIntersect(box, other.box, 4));
      if (!hit) {
        position = candidate;
        break;
      }
    }
    position ??= anchoredPosition(object);
    object.localX = position.x;
    object.localY = position.y;
    assignGlobal(object, identity);
    placed.push(object);
  }
}

function shiftObject(object, dx, dy) {
  object.box.x += dx;
  object.box.y += dy;
  if (object.matrix) {
    object.matrix.e += dx;
    object.matrix.f += dy;
  }
  for (const child of object.children) shiftObject(child, dx, dy);
}

function applyConstraints(scene) {
  for (let pass = 0; pass < 2; pass += 1) {
    for (const constraint of scene.constraints) {
      if (constraint.kind === "align" && constraint.edge === "center-vertical" && constraint.memberObjects.length > 1) {
        const center = Math.max(...constraint.memberObjects.map((object) => object.box.y + object.box.height / 2));
        for (const object of constraint.memberObjects) shiftObject(object, 0, center - (object.box.y + object.box.height / 2));
      } else if (constraint.kind === "below" && constraint.itemObject && constraint.referenceObject) {
        const minimum = constraint.referenceObject.box.y + constraint.referenceObject.box.height + 20;
        if (constraint.itemObject.box.y < minimum || constraint.itemObject.box.y > minimum + 60) {
          shiftObject(constraint.itemObject, 0, minimum - constraint.itemObject.box.y);
        }
      }
    }
  }

  for (const constraint of scene.constraints) {
    if (constraint.kind === "extent" && constraint.itemObject && constraint.fromObject && constraint.toObject) {
      const top = Math.min(constraint.fromObject.box.y, constraint.toObject.box.y);
      const bottom = Math.max(constraint.fromObject.box.y + constraint.fromObject.box.height, constraint.toObject.box.y + constraint.toObject.box.height);
      constraint.itemObject.box.y = top;
      constraint.itemObject.box.height = Math.max(12, bottom - top);
    } else if (constraint.kind === "inside" && constraint.containerObject && constraint.memberObjects.length) {
      const left = Math.min(...constraint.memberObjects.map((object) => object.box.x));
      const top = Math.min(...constraint.memberObjects.map((object) => object.box.y));
      const right = Math.max(...constraint.memberObjects.map((object) => object.box.x + object.box.width));
      const bottom = Math.max(...constraint.memberObjects.map((object) => object.box.y + object.box.height));
      constraint.containerObject.box = { x: left - 14, y: top - 28, width: right - left + 28, height: bottom - top + 42 };
    }
  }

  for (const lifeline of scene.objects.filter((object) => object.roles.includes("uml-lifeline"))) {
    const end = lifeline.children.find((child) => child.roles.includes("uml-lifeline-end"));
    const occurrences = lifeline.children.filter((child) => child.roles.includes("uml-occurrence"));
    if (!end || !occurrences.length) continue;
    const minimum = Math.max(...occurrences.map((occurrence) => occurrence.box.y + occurrence.box.height)) + 20;
    if (end.box.y < minimum) shiftObject(end, 0, minimum - end.box.y);
  }
}

// Slide row/column members with slack over their connected counterparts in
// other containers — an actor lands above the box it feeds. Order and the
// measured minimum gaps stay intact, so tightly packed containers never move.
function alignConnectedNeighbors(scene) {
  for (const container of scene.objects) {
    const layout = effectiveLayout(container);
    if (layout !== "row" && layout !== "column") continue;
    // A declared distribution owns the available main-axis slack. Route-aware
    // alignment may consume slack only from the default/start arrangement;
    // otherwise it would silently invalidate space-between/around/center/end.
    if (container.distribute !== "start") continue;
    if ((container.physicalOrientation ?? 0) % 360 !== 0) continue;
    const members = flowChildren(container);
    if (members.length < 2) continue;
    const horizontal = layout === "row";
    const axis = horizontal ? "x" : "y";
    const extent = horizontal ? "width" : "height";

    const inSubtree = (object, member) => object === member || isDescendantOf(object, member);
    const desired = members.map((member) => {
      const centers = [];
      for (const line of scene.lines) {
        if (!line.from?.object || !line.to?.object) continue;
        const fromIn = inSubtree(line.from.object, member);
        const toIn = inSubtree(line.to.object, member);
        if (fromIn === toIn) continue;
        const remote = fromIn ? line.to.object : line.from.object;
        if (remote === container || isDescendantOf(remote, container)) continue;
        centers.push(remote.box[axis] + remote.box[extent] / 2);
      }
      if (!centers.length) return null;
      return centers.reduce((sum, value) => sum + value, 0) / centers.length;
    });

    const minGaps = container.gapSizes ?? [];
    // the full padded interior is available, not just the current member span
    const padding = container.paddingBox ?? { top: 0, right: 0, bottom: 0, left: 0 };
    const lower = Math.min(
      members[0].box[axis],
      container.box[axis] + (horizontal ? padding.left : padding.top + (container.contentHeight ?? 0)),
    );
    const upper = Math.max(
      members.at(-1).box[axis] + members.at(-1).box[extent],
      container.box[axis] + container.box[extent] - (horizontal ? padding.right : padding.bottom),
    );
    // Prefix and suffix demand bound each connected member's feasible range.
    // Moving an anchor then propagates only as far as required, which lets
    // otherwise free siblings surrender distributive slack on either side.
    const prefixDemand = Array(members.length).fill(0);
    const suffixDemand = Array(members.length).fill(0);
    for (let index = 1; index < members.length; index += 1) {
      prefixDemand[index] = prefixDemand[index - 1] + members[index - 1].box[extent] + (minGaps[index - 1] ?? 0);
    }
    for (let index = members.length - 2; index >= 0; index -= 1) {
      suffixDemand[index] = suffixDemand[index + 1] + members[index + 1].box[extent] + (minGaps[index] ?? 0);
    }

    const positions = members.map((member) => member.box[axis]);
    for (const index of members.keys()) {
      if (desired[index] == null) continue;
      const minimum = lower + prefixDemand[index];
      const maximum = upper - suffixDemand[index] - members[index].box[extent];
      positions[index] = Math.max(minimum, Math.min(maximum, desired[index] - members[index].box[extent] / 2));

      for (let previous = index - 1; previous >= 0; previous -= 1) {
        const maximumPrevious = positions[previous + 1] - (minGaps[previous] ?? 0) - members[previous].box[extent];
        positions[previous] = Math.min(positions[previous], maximumPrevious);
      }
      for (let next = index + 1; next < members.length; next += 1) {
        const minimumNext = positions[next - 1] + members[next - 1].box[extent] + (minGaps[next - 1] ?? 0);
        positions[next] = Math.max(positions[next], minimumNext);
      }
    }

    members.forEach((member, index) => {
      const delta = positions[index] - member.box[axis];
      if (Math.abs(delta) > 0.5) shiftObject(member, horizontal ? delta : 0, horizontal ? 0 : delta);
    });
  }
}

function normalizeCanvas(scene) {
  const painted = scene.objects.filter((object) => object !== scene.root);
  const minX = Math.min(0, ...painted.map((object) => object.box.x));
  const minY = Math.min(0, ...painted.map((object) => object.box.y));
  if (minX < 12 || minY < 12) {
    const dx = 24 - minX;
    const dy = 24 - minY;
    shiftObject(scene.root, dx, dy);
    for (const object of painted.filter((item) => item.anchor && !isDescendantOf(item, scene.root))) shiftObject(object, dx, dy);
  }
  scene.width = Math.ceil(Math.max(scene.root.box.x + scene.root.box.width, ...painted.map((object) => object.box.x + object.box.width)) + 24);
  scene.height = Math.ceil(Math.max(scene.root.box.y + scene.root.box.height, ...painted.map((object) => object.box.y + object.box.height)) + 24);
}

function isDescendantOf(object, ancestor) {
  for (let current = object.parent; current; current = current.parent) if (current === ancestor) return true;
  return false;
}

export function layout(scene) {
  reserveRoutingSpace(scene);
  for (const object of scene.objects) object.sizeFloor = { width: 0, height: 0 };
  measureObject(scene.root, scene);
  for (let pass = 0; pass < 2 && computeSizeFloors(scene); pass += 1) {
    measureObject(scene.root, scene);
  }
  scene.root.localX = 0;
  scene.root.localY = 0;
  assignGlobal(scene.root, { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  for (let pass = 0; pass < 2; pass += 1) alignConnectedNeighbors(scene);
  assignAnchored(scene);
  applyConstraints(scene);
  normalizeCanvas(scene);
  return scene;
}
