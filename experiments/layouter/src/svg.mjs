import { headGeometry, normalizedHeads } from "./heads.mjs";
import { regionGeometry } from "./mesh.mjs";

const SIDE_VECTOR = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

function escape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function color(value, scene, fallback) {
  if (value == null) return fallback;
  return scene.tokens[value] ?? value;
}

function canvasColor(scene, fallback = "#ffffff") {
  return color(scene.root?.style?.fill, scene, fallback);
}

function fontFamily(style, fallback = "ui-rounded, 'Comic Sans MS', sans-serif") {
  return style?.fontFamily ?? fallback;
}

function dash(style) {
  if (Array.isArray(style.dash)) return ` stroke-dasharray="${style.dash.join(" ")}"`;
  if (style.dash === "dashed") return ' stroke-dasharray="10 7"';
  if (style.dash === "dotted") return ' stroke-dasharray="2 6" stroke-linecap="round"';
  return "";
}

function depth(object) {
  let result = 0;
  for (let current = object.parent; current; current = current.parent) result += 1;
  return result;
}

function objectPaint(object, scene) {
  const stroke = color(object.style.stroke, scene, object.kind === "scope" ? "#7b8794" : "#26364a");
  const fill = color(object.style.fill, scene, object.kind === "scope" ? "#f8fafc" : "#ffffff");
  const width = object.style.strokeWidth ?? 2;
  return `fill="${escape(fill)}" stroke="${escape(stroke)}" stroke-width="${width}"${dash(object.style)}`;
}

function shouldDrawBoundary(object) {
  if (["diagram", "row", "column", "grid", "title", "subtitle", "legend", "legend-item"].includes(object.kind)) return false;
  if (object.kind === "note") return object.style.stroke != null || object.roles.includes("stub") || object.roles.includes("implementation-status");
  if (object.roles.includes("uml-lifeline") || object.roles.includes("uml-interaction")) return false;
  return object.style.stroke !== "transparent";
}

function roundedRect(object, scene, radius = 14) {
  const box = object.box;
  return `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="${radius}" ${objectPaint(object, scene)}/>`;
}

function drawActor(object, scene) {
  const box = object.box;
  const stroke = color(object.style.stroke, scene, "#26364a");
  const cx = box.x + box.width / 2;
  const top = box.y + 8;
  return `<g fill="none" stroke="${escape(stroke)}" stroke-width="2"><circle cx="${cx}" cy="${top + 9}" r="8"/><path d="M ${cx} ${top + 17} V ${top + 43} M ${cx - 17} ${top + 27} H ${cx + 17} M ${cx} ${top + 43} L ${cx - 15} ${top + 61} M ${cx} ${top + 43} L ${cx + 15} ${top + 61}"/></g>`;
}

function drawShape(object, scene) {
  if (object.roles.includes("uml-occurrence") || object.roles.includes("uml-lifeline-end")) return "";
  if (!shouldDrawBoundary(object) && object.kind !== "image") return "";
  const box = object.box;
  const shape = object.shape ?? "rounded-rectangle";
  if (object.kind === "image") {
    return `<g><rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="20" fill="#0ea5e9"/><path d="M ${box.x + 12} ${box.y + box.height - 24} Q ${box.x + box.width / 2} ${box.y + 30} ${box.x + box.width - 12} ${box.y + box.height - 24}" fill="none" stroke="#fff" stroke-width="8"/><circle cx="${box.x + box.width * .65}" cy="${box.y + box.height * .28}" r="8" fill="#fde047"/></g>`;
  }
  if (shape === "ellipse") return `<ellipse cx="${box.x + box.width / 2}" cy="${box.y + box.height / 2}" rx="${box.width / 2}" ry="${box.height / 2}" ${objectPaint(object, scene)}/>`;
  if (shape === "diamond" || shape.includes("choice")) {
    return `<polygon points="${box.x + box.width / 2},${box.y} ${box.x + box.width},${box.y + box.height / 2} ${box.x + box.width / 2},${box.y + box.height} ${box.x},${box.y + box.height / 2}" ${objectPaint(object, scene)}/>`;
  }
  if (shape.includes("actor")) return drawActor(object, scene);
  if (shape.includes("initial")) return `<circle cx="${box.x + box.width / 2}" cy="${box.y + box.height / 2}" r="${Math.min(box.width, box.height) / 2}" fill="#172033"/>`;
  if (shape.includes("final")) return `<g><circle cx="${box.x + box.width / 2}" cy="${box.y + box.height / 2}" r="${Math.min(box.width, box.height) / 2 - 1}" fill="white" stroke="#172033" stroke-width="2"/><circle cx="${box.x + box.width / 2}" cy="${box.y + box.height / 2}" r="${Math.min(box.width, box.height) / 2 - 6}" fill="#172033"/></g>`;
  if (shape.includes("fork") || shape.includes("join")) return `<rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" rx="3" fill="#172033"/>`;
  if (shape.includes("occurrence")) return `<circle cx="${box.x + box.width / 2}" cy="${box.y + box.height / 2}" r="3" fill="#172033"/>`;
  if (shape.includes("history")) return `<g>${roundedRect(object, scene, box.width / 2)}<text x="${box.x + box.width / 2}" y="${box.y + box.height / 2 + 5}" text-anchor="middle" font-size="14">H</text></g>`;
  if (shape.includes("package")) {
    // the tab grows with the package name so the label lives inside it
    const label = String(object.label ?? "");
    const tab = Math.min(box.width * 0.7, Math.max(64, label.length * (object.fontSize ?? 15) * 0.62 + 30));
    const tabHeight = 24;
    return `<path d="M ${box.x} ${box.y + tabHeight} V ${box.y + box.height} H ${box.x + box.width} V ${box.y + tabHeight} H ${box.x + tab} L ${box.x + tab - 10} ${box.y} H ${box.x} Z" ${objectPaint(object, scene)}/>`;
  }
  if (shape.includes("node-3d")) {
    return `<g>${roundedRect(object, scene, 6)}<path d="M ${box.x + 8} ${box.y + 8} L ${box.x + 18} ${box.y - 2} H ${box.x + box.width + 8} V ${box.y + box.height - 10} L ${box.x + box.width} ${box.y + box.height}" fill="none" stroke="${escape(color(object.style.stroke, scene, "#26364a"))}" stroke-width="2"/></g>`;
  }
  if (shape.includes("component")) {
    return `<g>${roundedRect(object, scene, 7)}<rect x="${box.x - 5}" y="${box.y + 14}" width="18" height="10" fill="white" stroke="#26364a"/><rect x="${box.x - 5}" y="${box.y + 31}" width="18" height="10" fill="white" stroke="#26364a"/></g>`;
  }
  if (shape.includes("artifact")) {
    return `<g>${roundedRect(object, scene, 5)}<path d="M ${box.x + box.width - 20} ${box.y} V ${box.y + 20} H ${box.x + box.width}" fill="none" stroke="#26364a" stroke-width="2"/></g>`;
  }
  return roundedRect(object, scene, shape === "rectangle" ? 2 : 14);
}

function drawObjectText(object, scene) {
  if (object.kind === "image" || !object.renderLines?.length) return "";
  const box = object.box;
  const fontSize = object.fontSize ?? 15;
  const colorValue = color(object.style.color ?? object.style.stroke, scene, "#172033");
  const isTitle = object.kind === "title";
  const isSubtitle = object.kind === "subtitle";
  const isBoundaryLabel = object.label && (object.children.length > 0 || object.frame);
  const leftAligned = isTitle || isSubtitle || isBoundaryLabel || object.roles.some((role) => role.startsWith("uml-") && ["uml-class", "uml-object", "uml-state"].includes(role));
  const x = leftAligned ? box.x + (isTitle || isSubtitle ? 0 : 13) : box.x + box.width / 2;
  const anchor = leftAligned ? "start" : "middle";
  const visibleLines = object.renderLines.filter((line) => !line.divider);
  const totalHeight = visibleLines.length * fontSize * 1.35;
  const inPackageTab = isBoundaryLabel && object.shape?.includes("package");
  const actorText = object.shape?.includes("actor");
  const combinedFragment = object.roles.includes("uml-combined-fragment");
  let y = inPackageTab ? box.y + fontSize + 2
    : isBoundaryLabel ? box.y + fontSize + 7
    : isTitle || isSubtitle ? box.y + fontSize
    : actorText ? box.y + box.height - totalHeight + fontSize - 4
    : box.y + (box.height - totalHeight) / 2 + fontSize;
  const result = [];
  if (combinedFragment) {
    const labelWidth = Math.max(0, ...visibleLines.map((line) => line.measuredWidth ?? 0));
    const tabWidth = Math.min(box.width - 12, Math.max(96, labelWidth + 26));
    const tabHeight = fontSize * 1.8 + 4;
    const notch = 10;
    const stroke = color(object.style.stroke, scene, "#26364a");
    result.push(`<path data-uml-combined-fragment-tab="${escape(object.path)}" d="M ${box.x} ${box.y} H ${box.x + tabWidth} V ${box.y + tabHeight - notch} L ${box.x + tabWidth - notch} ${box.y + tabHeight} H ${box.x} Z" fill="${escape(canvasColor(scene))}" stroke="${escape(stroke)}" stroke-width="${object.style.strokeWidth ?? 2}"/>`);
  }
  let previousWasDivider = false;
  for (const line of object.renderLines) {
    if (line.divider) {
      const dividerY = y - fontSize * 0.8;
      result.push(`<path d="M ${box.x + 1} ${dividerY} H ${box.x + box.width - 1}" stroke="${escape(color(object.style.stroke, scene, "#26364a"))}" stroke-width="1"/>`);
      previousWasDivider = true;
      continue;
    }
    if (previousWasDivider) y += 4;
    const weight = ["heading", "uml-class-name", "label"].includes(line.role) || isTitle ? 700 : 450;
    const decoration = line.role === "uml-instance-name" ? ' text-decoration="underline"' : "";
    const italic = object.classes.includes("abstract") && line.role === "uml-class-name" ? ' font-style="italic"' : "";
    const text = line.role === "uml-stereotype" ? `«${line.text}»` : line.text;
    result.push(`<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${escape(colorValue)}" font-family="${escape(fontFamily(object.style))}" font-size="${fontSize}" font-weight="${weight}"${decoration}${italic}>${escape(text)}</text>`);
    y += fontSize * 1.35;
    previousWasDivider = false;
  }
  return result.join("");
}

function arrowGeometry(tip, previous, head, stroke, backdrop) {
  const geometry = headGeometry(head);
  if (!geometry.kind || geometry.kind === "none") return "";
  const dx = tip.x - previous.x;
  const dy = tip.y - previous.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const halfWidth = geometry.width / 2;
  const back = { x: tip.x - ux * geometry.shoulderDepth, y: tip.y - uy * geometry.shoulderDepth };
  if (geometry.kind.includes("diamond")) {
    const far = { x: tip.x - ux * geometry.depth, y: tip.y - uy * geometry.depth };
    const fill = geometry.kind.includes("filled") ? stroke : backdrop;
    return `<polygon points="${tip.x},${tip.y} ${back.x + px * halfWidth},${back.y + py * halfWidth} ${far.x},${far.y} ${back.x - px * halfWidth},${back.y - py * halfWidth}" fill="${escape(fill)}" stroke="${escape(stroke)}" stroke-width="2"/>`;
  }
  if (geometry.kind.includes("triangle")) {
    return `<polygon points="${tip.x},${tip.y} ${back.x + px * halfWidth},${back.y + py * halfWidth} ${back.x - px * halfWidth},${back.y - py * halfWidth}" fill="${escape(backdrop)}" stroke="${escape(stroke)}" stroke-width="2"/>`;
  }
  return `<path d="M ${back.x + px * halfWidth} ${back.y + py * halfWidth} L ${tip.x} ${tip.y} L ${back.x - px * halfWidth} ${back.y - py * halfWidth}" fill="none" stroke="${escape(stroke)}" stroke-width="2" stroke-linejoin="round"/>`;
}

function drawLine(line, scene) {
  if (line.route.length < 2) return "";
  const stroke = color(line.style.stroke, scene, "#334155");
  const width = line.style.strokeWidth ?? 2;
  const points = line.route.map((point) => `${point.x},${point.y}`).join(" ");
  const heads = normalizedHeads(line.heads);
  const backdrop = canvasColor(scene);
  const firstHead = arrowGeometry(line.route[0], line.route[1], heads[0], stroke, backdrop);
  const lastHead = arrowGeometry(line.route.at(-1), line.route.at(-2), heads[1], stroke, backdrop);
  return `<g data-line="${escape(line.id)}"><polyline points="${points}" fill="none" stroke="${escape(stroke)}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"${dash(line.style)}/>${firstHead}${lastHead}</g>`;
}

function drawLineLabels(line, scene) {
  return line.routeLabels.map((label) => {
    const renderedText = label.role === "uml-keyword" ? `«${label.text}»` : label.text;
    const lines = String(renderedText).split("\n");
    const box = label.box;
    const centerX = label.x ?? box.x + box.width / 2;
    const centerY = label.y ?? box.y + box.height / 2;
    const lineHeight = 16;
    const firstBaseline = centerY - lines.length * lineHeight / 2 + 13;
    const stroke = color(line.style.stroke, scene, "#334155");
    const transform = label.angle ? ` transform="rotate(${label.angle} ${centerX} ${centerY})"` : "";
    const textAnchor = label.textAnchor ?? "middle";
    return `<g data-line-label="${escape(line.id)}"${transform}>${lines.map((text, index) => `<text x="${centerX}" y="${firstBaseline + index * lineHeight}" text-anchor="${textAnchor}" font-family="${escape(fontFamily(line.style, "ui-rounded, sans-serif"))}" font-size="13" fill="${escape(stroke)}" stroke="${escape(canvasColor(scene))}" stroke-opacity=".92" stroke-width="3.5" stroke-linejoin="round" paint-order="stroke fill">${escape(text)}</text>`).join("")}</g>`;
  }).join("");
}

function drawPorts(scene) {
  const result = [];
  for (const object of scene.objects) {
    for (const port of object.ports.values()) {
      if (!port.point || port.marker === "none") continue;
      const stroke = color(port.style.stroke ?? object.style.stroke, scene, "#334155");
      const kind = typeof port.marker === "string" ? port.marker : port.marker?.name;
      if (kind?.includes("provided") || kind === "circle") {
        result.push(`<circle data-port-marker="${escape(kind)}" cx="${port.point.x}" cy="${port.point.y}" r="6" fill="${escape(canvasColor(scene))}" stroke="${escape(stroke)}" stroke-width="2"/>`);
      } else if (kind?.includes("required")) {
        const vector = SIDE_VECTOR[port.physicalSide ?? "right"];
        const perpendicular = { x: -vector.y, y: vector.x };
        const first = {
          x: port.point.x + perpendicular.x * 6,
          y: port.point.y + perpendicular.y * 6,
        };
        const second = {
          x: port.point.x - perpendicular.x * 6,
          y: port.point.y - perpendicular.y * 6,
        };
        const control = {
          x: port.point.x - vector.x * 8,
          y: port.point.y - vector.y * 8,
        };
        result.push(`<path data-port-marker="${escape(kind)}" d="M ${first.x} ${first.y} Q ${control.x} ${control.y} ${second.x} ${second.y}" fill="none" stroke="${escape(stroke)}" stroke-width="2"/>`);
      } else {
        result.push(`<rect x="${port.point.x - 5}" y="${port.point.y - 5}" width="10" height="10" fill="${escape(canvasColor(scene))}" stroke="${escape(stroke)}" stroke-width="2"/>`);
      }
    }
  }
  return result.join("");
}

function solvedDividers(scene) {
  const result = [];
  for (const corridor of scene.corridors) {
    if (!corridor.divider) continue;
    const region = [...scene.regions.values()].find((candidate) => candidate.corridors.includes(corridor));
    if (!region?.channelBinding?.trackCell) continue;
    const geometry = regionGeometry(region);
    const horizontal = geometry.axis === "horizontal";
    const first = horizontal
      ? { x: geometry.x, y: geometry.y + geometry.height / 2 }
      : { x: geometry.x + geometry.width / 2, y: geometry.y };
    const second = horizontal
      ? { x: geometry.x + geometry.width, y: first.y }
      : { x: first.x, y: geometry.y + geometry.height };
    result.push({ first, second, horizontal, style: corridor.divider.style ?? {}, label: corridor.divider.label });
  }
  return result;
}

function drawDividers(scene) {
  return (scene.solvedDividers ?? solvedDividers(scene)).map((divider) => {
    const stroke = color(divider.style.stroke, scene, "#64748b");
    const path = `<path d="M ${divider.first.x} ${divider.first.y} L ${divider.second.x} ${divider.second.y}" fill="none" stroke="${escape(stroke)}" stroke-width="2"${dash(divider.style)}/>`;
    if (!divider.label) return path;
    const x = divider.horizontal ? divider.second.x - 8 : divider.first.x + 8;
    const y = divider.horizontal ? divider.second.y - 8 : divider.first.y + 14;
    return `${path}<text x="${x}" y="${y}" text-anchor="end" font-family="ui-rounded, sans-serif" font-size="13" fill="${escape(stroke)}">${escape(divider.label)}</text>`;
  }).join("");
}

function solvedRoutingRegions(scene) {
  return (scene.channelMesh ?? [])
    .filter((cell) => cell.geometry?.width > 2 && cell.geometry?.height > 2)
    .map((cell) => ({
      key: cell.key,
      kind: cell.kind,
      materialized: cell.materialized ?? false,
      authored: Boolean(cell.corridors?.length),
      geometry: cell.geometry,
    }));
}

function drawRoutingRegions(scene) {
  return (scene.solvedRoutingRegions ?? solvedRoutingRegions(scene)).map((cell) => {
    const geometry = cell.geometry;
    return `<rect data-routing-region="${escape(cell.key)}" data-region-kind="${escape(cell.kind)}" data-materialized="${cell.materialized ? "true" : "false"}" data-authored="${cell.authored ? "true" : "false"}" x="${geometry.x + 1}" y="${geometry.y + 1}" width="${geometry.width - 2}" height="${geometry.height - 2}" fill="#ef4444" fill-opacity="0.1"/>`;
  }).join("");
}

function solvedSharingDebug(scene) {
  const result = [];
  for (const group of scene.shareGroups?.values?.() ?? []) {
    const laneCount = group.bundle?.lanes.length ?? (group.mode === "merge" ? 1 : group.members.length);
    const item = { id: group.id, mode: group.mode, laneCount, lanes: [], slots: [], pins: [], runs: [] };
    if (group.mode === "bundle") {
      for (const lane of group.bundle.lanes) {
        for (const member of lane.members) {
          item.lanes.push({ id: lane.id, line: member.line.id, route: member.line.route });
        }
      }
      const slots = group.source.kind === "port" ? group.source.port.terminalSlots ?? [] : [];
      item.slots.push(...slots.map((slot) => ({ lane: slot.lane.id, point: slot.point })));
      const uniquePins = new Map();
      for (const member of group.members) {
        const pin = group.bundle.pinByLine?.get(member.line);
        if (pin) uniquePins.set(`${pin.x},${pin.y}`, pin);
      }
      item.pins.push(...uniquePins.values());
    } else if (group.merge?.pin) {
      item.convergence = group.merge.convergence;
      item.mergePin = group.merge.pin;
    }
    item.runs.push(...(group.allowedSharedRuns ?? []).map((run) => ({ first: run.first, second: run.second })));
    result.push(item);
  }
  return result;
}

function drawSharingDebug(scene) {
  const result = [];
  for (const group of scene.solvedSharingDebug ?? solvedSharingDebug(scene)) {
    const debugColor = group.mode === "merge" ? "#2563eb" : group.mode === "bundle" ? "#7c3aed" : "#64748b";
    result.push(`<g data-share-group="${escape(group.id)}" data-share-mode="${escape(group.mode)}" data-share-lanes="${group.laneCount}">`);
    for (const lane of group.lanes) {
      const points = lane.route.map((point) => `${point.x},${point.y}`).join(" ");
      result.push(`<polyline data-bundle-lane="${escape(lane.id)}" data-bundle-line="${escape(lane.line)}" points="${points}" fill="none" stroke="${debugColor}" stroke-width="8" stroke-opacity="0.12"/>`);
    }
    for (const slot of group.slots) {
      result.push(`<circle data-terminal-slot="${escape(slot.lane)}" cx="${slot.point.x}" cy="${slot.point.y}" r="4" fill="${debugColor}" fill-opacity="0.55"/>`);
    }
    for (const pin of group.pins) {
      result.push(`<rect data-bundle-pin="true" x="${pin.x - 3}" y="${pin.y - 3}" width="6" height="6" fill="${debugColor}" fill-opacity="0.55"/>`);
    }
    if (group.convergence) result.push(`<circle data-merge-convergence="true" cx="${group.convergence.x}" cy="${group.convergence.y}" r="4" fill="${debugColor}" fill-opacity="0.55"/>`);
    if (group.mergePin) result.push(`<circle data-merge-pin="true" cx="${group.mergePin.x}" cy="${group.mergePin.y}" r="4" fill="${debugColor}" fill-opacity="0.55"/>`);
    for (const run of group.runs) {
      result.push(`<line data-authorized-shared-run="true" x1="${run.first.x}" y1="${run.first.y}" x2="${run.second.x}" y2="${run.second.y}" stroke="${debugColor}" stroke-width="10" stroke-opacity="0.16"/>`);
    }
    result.push("</g>");
  }
  return result.join("");
}

export function serializeSvgScene(scene) {
  return {
    schema: "kvisl.solved-svg-scene",
    version: "0.1.0",
    width: scene.width,
    height: scene.height,
    tokens: scene.tokens,
    diagnostics: scene.diagnostics,
    root: scene.root.path,
    objects: scene.objects.map((object) => ({
      id: object.id,
      path: object.path,
      kind: object.kind,
      roles: object.roles,
      classes: object.classes,
      shape: object.shape,
      label: object.label,
      style: object.style,
      box: object.box,
      fontSize: object.fontSize,
      renderLines: object.renderLines,
      frame: object.frame,
      parent: object.parent?.path ?? null,
      children: object.children.map((child) => child.path),
      ports: [...object.ports.entries()].map(([name, port]) => [name, {
        point: port.point,
        marker: port.marker,
        physicalSide: port.physicalSide,
        style: port.style,
      }]),
    })),
    lines: scene.lines.map((line) => ({
      id: line.id,
      route: line.route,
      routeLabels: line.routeLabels,
      style: line.style,
      heads: line.heads,
    })),
    solvedDividers: solvedDividers(scene),
    solvedRoutingRegions: solvedRoutingRegions(scene),
    solvedSharingDebug: solvedSharingDebug(scene),
  };
}

export function renderSvgScene(model, options = {}) {
  if (model.schema !== "kvisl.solved-svg-scene" || model.version !== "0.1.0") {
    throw new Error(`unsupported solved SVG scene ${model.schema ?? "<missing>"}@${model.version ?? "<missing>"}`);
  }
  const objects = model.objects.map((object) => ({ ...object, ports: new Map(object.ports) }));
  const byPath = new Map(objects.map((object) => [object.path, object]));
  for (const object of objects) {
    object.parent = object.parent ? byPath.get(object.parent) : null;
    object.children = object.children.map((child) => byPath.get(child));
  }
  return renderSvg({
    width: model.width,
    height: model.height,
    tokens: model.tokens,
    diagnostics: model.diagnostics,
    root: byPath.get(model.root),
    objects,
    lines: model.lines,
    solvedDividers: model.solvedDividers,
    solvedRoutingRegions: model.solvedRoutingRegions,
    solvedSharingDebug: model.solvedSharingDebug,
  }, options);
}

export function renderSvg(scene, options = {}) {
  const containers = scene.objects.filter((object) => object.children.length || object.frame).sort((a, b) => depth(a) - depth(b));
  const leaves = scene.objects.filter((object) => !object.children.length && !object.frame);
  const diagnostics = scene.diagnostics.map((item) => `${item.severity}:${item.code}:${item.message}`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}" role="img" aria-label="${escape(scene.root.id)}">
  <title>${escape(scene.root.id)}</title>
  <desc>${escape(diagnostics || "Kvísl layouter prototype preview")}</desc>
  ${options.transparent ? "" : `<rect width="100%" height="100%" fill="${escape(options.background ?? canvasColor(scene))}"/>`}
  <g id="boundaries">${containers.map((object) => drawShape(object, scene)).join("")}</g>
${options.debugRouting ? `  <g id="routing-regions">${drawRoutingRegions(scene)}</g>\n  <g id="sharing-debug">${drawSharingDebug(scene)}</g>\n` : ""}  <g id="corridor-dividers">${drawDividers(scene)}</g>
  <g id="lines">${scene.lines.map((line) => drawLine(line, scene)).join("")}</g>
  <g id="objects">${leaves.map((object) => drawShape(object, scene)).join("")}</g>
  <g id="ports">${drawPorts(scene)}</g>
  <g id="text">${scene.objects.map((object) => drawObjectText(object, scene)).join("")}${scene.lines.map((line) => drawLineLabels(line, scene)).join("")}</g>
</svg>`;
}
