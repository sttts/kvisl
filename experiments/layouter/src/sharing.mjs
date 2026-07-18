import { headKind, normalizedHeads } from "./heads.mjs";

const STROKE_STYLE_KEYS = ["stroke", "strokeWidth", "dash", "opacity", "roughness"];

function resolveToken(scene, value) {
  if (typeof value !== "string") return value;
  return scene.tokens?.[value] ?? value;
}

function normalizedDash(value) {
  if (value == null || value === "none" || value === "solid") return null;
  return Array.isArray(value) ? [...value] : value;
}

function normalizedStrokeStyle(scene, line) {
  const defaults = {
    stroke: "#334155",
    strokeWidth: 2,
    dash: null,
    opacity: 1,
    roughness: null,
  };
  const style = {};
  for (const key of STROKE_STYLE_KEYS) {
    const resolved = resolveToken(scene, line.style?.[key] ?? defaults[key]);
    const value = key === "dash" ? normalizedDash(resolved) : resolved;
    style[key] = value;
  }
  return style;
}

function styleSignature(scene, line) {
  return JSON.stringify(normalizedStrokeStyle(scene, line));
}

function terminalHeadSignature(group, member) {
  if (group.source.kind !== "port" || !member.endpoint) return null;
  const endIndex = member.endpoint === member.line.from ? 0 : 1;
  return headKind(normalizedHeads(member.line.heads)[endIndex]);
}

function laneCompatibilitySignature(scene, group, member) {
  return JSON.stringify({ stroke: styleSignature(scene, member.line), terminalHead: terminalHeadSignature(group, member) });
}

function groupMode(requestedMode, compatible) {
  if (requestedMode === "separate" || requestedMode === "free") return "separate";
  if (requestedMode === "bundle") return "bundle";
  if (compatible) return "merge";
  return "bundle";
}

function addMembership(group, member) {
  const membership = {
    group,
    line: member.line,
    endpoint: member.endpoint,
    end: member.endpoint?.end ?? null,
    laneIndex: member.laneIndex,
    laneCount: group.bundle?.lanes.length ?? 1,
    lane: member.bundleLane ?? null,
  };
  member.line.shareMemberships.push(membership);
  if (member.endpoint) member.endpoint.shareMemberships.push(membership);
  member.membership = membership;
}

function diagnoseIncompatibleRequiredMerge(scene, group) {
  if (group.requestedMode !== "merge" || group.compatible) return;
  scene.diagnostics.push({
    severity: "error",
    code: "incompatible-merge-style",
    message: `required merge '${group.id}' has incompatible shared-piece stroke styles or terminal head geometry; distinct bundle lanes were retained`,
  });
}

function attachmentsByPort(scene) {
  const attached = new Map();
  for (const line of scene.lines) {
    for (const endpoint of [line.from, line.to]) {
      if (!endpoint?.port) continue;
      const members = attached.get(endpoint.port) ?? [];
      members.push({ line, endpoint });
      attached.set(endpoint.port, members);
    }
  }
  return attached;
}

function portGroups(attached) {
  return [...attached].filter(([, members]) => members.length > 1).map(([port, members]) => ({
    id: `port:${(port.anchor ?? port.owner)?.path ?? ""}:${port.id}`,
    source: { kind: "port", port },
    requestedMode: port.sharing?.mode ?? "auto",
    branch: port.sharing?.branch ?? null,
    members,
  }));
}

function explicitGroups(scene) {
  const groups = new Map();
  for (const line of scene.lines) {
    if (line.share?.group == null) continue;
    const id = String(line.share.group);
    const key = `${line.scope?.path ?? ""}\u0000${id}`;
    const candidate = groups.get(key) ?? {
      id: `explicit:${line.scope?.path ?? ""}:${id}`,
      source: { kind: "explicit", id, parent: line.scope },
      requestedMode: line.share.mode ?? "auto",
      branch: line.share.branch ?? null,
      members: [],
    };
    candidate.members.push({ line, endpoint: null });
    if (line.share.mode === "merge") candidate.requestedMode = "merge";
    else if (candidate.requestedMode === "auto" && line.share.mode === "bundle") candidate.requestedMode = "bundle";
    groups.set(key, candidate);
  }
  return [...groups.values()].filter((group) => group.members.length > 1);
}

function portAffinityGroups(scene, attached) {
  const groups = [];
  for (const owner of scene.objects) {
    for (const portGroup of owner.portGroups ?? []) {
      if (portGroup.affinity === "free") continue;
      const members = [];
      for (const [portOrder, port] of portGroup.members.entries()) {
        for (const attachedMember of attached.get(port) ?? []) {
          members.push({ ...attachedMember, portOrder });
        }
      }
      if (members.length < 2) continue;
      members.sort((first, second) => first.portOrder - second.portOrder || first.line.order - second.line.order);
      groups.push({
        id: `port-group:${owner.path}:${portGroup.id}`,
        source: { kind: "port-group", group: portGroup },
        requestedMode: portGroup.affinity,
        branch: portGroup.branch ?? null,
        members,
      });
    }
  }
  return groups;
}

// Sharing policy is normalized once, after the cascade has resolved line
// paint and before routing space is allocated. Every later phase consumes the
// effective mode instead of independently reinterpreting raw port policy.
export function buildShareGroups(scene) {
  if (scene.shareGroups) return scene.shareGroups;
  scene.diagnostics ??= [];
  for (const line of scene.lines) line.shareMemberships = [];
  for (const line of scene.lines) {
    for (const endpoint of [line.from, line.to]) if (endpoint) endpoint.shareMemberships = [];
  }

  const attached = attachmentsByPort(scene);
  const groups = [...portGroups(attached), ...portAffinityGroups(scene, attached), ...explicitGroups(scene)];
  for (const group of groups) {
    for (const member of group.members) member.styleSignature = laneCompatibilitySignature(scene, group, member);
    const signatures = new Set(group.members.map((member) => member.styleSignature));
    group.compatible = signatures.size === 1;
    group.mode = groupMode(group.requestedMode, group.compatible);
    group.strokeStyles = group.members.map((member) => normalizedStrokeStyle(scene, member.line));
    group.members.sort((first, second) => (first.portOrder ?? Number.POSITIVE_INFINITY) - (second.portOrder ?? Number.POSITIVE_INFINITY)
      || (first.line.order ?? 0) - (second.line.order ?? 0)
      || first.line.id.localeCompare(second.line.id));
    group.bundle = null;
    if (group.mode === "bundle") {
      const laneMembers = [];
      if (group.requestedMode === "bundle") {
        for (const member of group.members) laneMembers.push([member]);
      } else {
        const byStyle = new Map();
        for (const member of group.members) {
          const members = byStyle.get(member.styleSignature) ?? [];
          members.push(member);
          byStyle.set(member.styleSignature, members);
        }
        laneMembers.push(...byStyle.values());
      }
      const lanes = laneMembers.map((members, laneIndex) => ({
        id: `${group.id}:lane:${laneIndex}`,
        laneIndex,
        styleSignature: members[0].styleSignature,
        members,
      }));
      for (const lane of lanes) {
        for (const member of lane.members) {
          member.bundleLane = lane;
          member.laneIndex = lane.laneIndex;
        }
      }
      group.bundle = {
        monotoneTowardCommonEnd: true,
        lanes,
        laneOrder: lanes.flatMap((lane) => lane.members.map((member) => member.line.id)),
      };
    } else {
      group.members.forEach((member) => { member.laneIndex = 0; });
    }
    for (const member of group.members) addMembership(group, member);
    diagnoseIncompatibleRequiredMerge(scene, group);
  }
  scene.shareGroups = new Map(groups.map((group) => [group.id, group]));
  scene.shareGroupByPort = new Map(groups
    .filter((group) => group.source.kind === "port")
    .map((group) => [group.source.port, group]));
  return scene.shareGroups;
}

export function endpointShareMembership(line, endpoint) {
  const memberships = endpoint?.shareMemberships?.filter((membership) => membership.line === line) ?? [];
  return memberships.find((membership) => membership.group.mode === "bundle")
    ?? memberships.find((membership) => membership.group.mode === "merge")
    ?? memberships[0]
    ?? null;
}

export function effectiveEndpointSharing(line, endpoint) {
  return endpointShareMembership(line, endpoint)?.group.mode ?? "separate";
}

export function linesMayShareGeometry(first, second) {
  const secondMemberships = second.shareMemberships ?? [];
  return (first.shareMemberships ?? []).some((firstMembership) => secondMemberships.some((secondMembership) =>
    firstMembership.group === secondMembership.group
    && (firstMembership.group.mode === "merge"
      || (firstMembership.group.mode === "bundle" && firstMembership.lane === secondMembership.lane))));
}

function overlapSegment(first, second) {
  const firstHorizontal = first.first.y === first.second.y;
  const secondHorizontal = second.first.y === second.second.y;
  if (firstHorizontal !== secondHorizontal) return null;
  const axis = firstHorizontal ? "x" : "y";
  const fixed = firstHorizontal ? "y" : "x";
  if (Math.abs(first.first[fixed] - second.first[fixed]) > 0.001) return null;
  const start = Math.max(Math.min(first.first[axis], first.second[axis]), Math.min(second.first[axis], second.second[axis]));
  const end = Math.min(Math.max(first.first[axis], first.second[axis]), Math.max(second.first[axis], second.second[axis]));
  if (end - start <= 0.001) return null;
  return firstHorizontal
    ? { first: { x: start, y: first.first.y }, second: { x: end, y: first.first.y } }
    : { first: { x: first.first.x, y: start }, second: { x: first.first.x, y: end } };
}

function runContains(run, segment) {
  const runHorizontal = run.first.y === run.second.y;
  const segmentHorizontal = segment.first.y === segment.second.y;
  if (runHorizontal !== segmentHorizontal) return false;
  const axis = runHorizontal ? "x" : "y";
  const fixed = runHorizontal ? "y" : "x";
  if (Math.abs(run.first[fixed] - segment.first[fixed]) > 0.001) return false;
  const runStart = Math.min(run.first[axis], run.second[axis]) - 0.001;
  const runEnd = Math.max(run.first[axis], run.second[axis]) + 0.001;
  const segmentStart = Math.min(segment.first[axis], segment.second[axis]);
  const segmentEnd = Math.max(segment.first[axis], segment.second[axis]);
  return segmentStart >= runStart && segmentEnd <= runEnd;
}

function runsCoverSegment(runs, segment) {
  if (!runs.length) return false;
  const horizontal = segment.first.y === segment.second.y;
  const axis = horizontal ? "x" : "y";
  const fixed = horizontal ? "y" : "x";
  const start = Math.min(segment.first[axis], segment.second[axis]);
  const end = Math.max(segment.first[axis], segment.second[axis]);
  const intervals = runs
    .filter((run) => (run.first.y === run.second.y) === horizontal
      && Math.abs(run.first[fixed] - segment.first[fixed]) <= 0.001)
    .map((run) => [Math.min(run.first[axis], run.second[axis]), Math.max(run.first[axis], run.second[axis])])
    .sort((first, second) => first[0] - second[0] || first[1] - second[1]);
  let covered = start;
  for (const interval of intervals) {
    if (interval[1] < covered - 0.001) continue;
    if (interval[0] > covered + 0.001) return false;
    covered = Math.max(covered, interval[1]);
    if (covered >= end - 0.001) return true;
  }
  return false;
}

function samePoint(first, second) {
  return Math.abs(first.x - second.x) <= 0.001 && Math.abs(first.y - second.y) <= 0.001;
}

function turnsFromTerminalRun(run, segment) {
  const runHorizontal = run.first.y === run.second.y;
  const segmentHorizontal = segment.first.y === segment.second.y;
  if (runHorizontal === segmentHorizontal) return false;
  return samePoint(run.second, segment.first) || samePoint(run.second, segment.second);
}

function sharedMembershipPairs(firstLine, secondLine) {
  const pairs = [];
  for (const firstMembership of firstLine.shareMemberships ?? []) {
    const secondMembership = (secondLine.shareMemberships ?? [])
      .find((membership) => membership.group === firstMembership.group);
    if (!secondMembership) continue;
    const group = firstMembership.group;
    const sameLane = group.mode === "merge"
      || (group.mode === "bundle" && firstMembership.lane === secondMembership.lane);
    if (sameLane) pairs.push({ group, firstMembership, secondMembership });
  }
  return pairs;
}

function memberLinesForLane(group, membership) {
  return group.mode === "merge"
    ? group.members.map((member) => member.line)
    : membership.lane?.members.map((member) => member.line) ?? [];
}

function runsForPair(group, firstLine, secondLine) {
  return (group.allowedSharedRuns ?? []).filter((run) => {
    const members = run.members ?? group.members.map((member) => member.line);
    return members.includes(firstLine) && members.includes(secondLine);
  });
}

// While routes are solved sequentially, a later member may extend the
// already-authorized terminal prefix of its lane. This is not a rejoin: the
// overlap touches the prefix's outer end and grows it monotonically away from
// the common port. The final topology pass replaces this provisional
// permission with the actual maximal common terminal runs.
function extendsTerminalRun(run, segment) {
  const runHorizontal = run.first.y === run.second.y;
  const segmentHorizontal = segment.first.y === segment.second.y;
  if (runHorizontal !== segmentHorizontal) return false;
  const axis = runHorizontal ? "x" : "y";
  const fixed = runHorizontal ? "y" : "x";
  if (Math.abs(run.first[fixed] - segment.first[fixed]) > 0.001) return false;
  const direction = Math.sign(run.second[axis] - run.first[axis]);
  if (!direction) return false;
  const terminal = run.first[axis];
  const frontier = run.second[axis];
  const start = Math.min(segment.first[axis], segment.second[axis]);
  const end = Math.max(segment.first[axis], segment.second[axis]);
  if (direction > 0) {
    return start >= terminal - 0.001 && start <= frontier + 0.001 && end > frontier + 0.001;
  }
  return end <= terminal + 0.001 && end >= frontier - 0.001 && start < frontier - 0.001;
}

// Sharing permission is local solved topology, not a line-pair exemption.
// Once two routes leave their authorized common run, later coincidence is an
// ordinary forbidden overlap and therefore cannot become a hidden rejoin.
export function segmentsMayShareGeometry(firstLine, secondLine, firstSegment, secondSegment) {
  const overlap = overlapSegment(firstSegment, secondSegment);
  if (!overlap) return false;
  for (const { group } of sharedMembershipPairs(firstLine, secondLine)) {
    const allowedRuns = runsForPair(group, firstLine, secondLine);
    if (allowedRuns.some((run) => runContains(run, overlap)) || runsCoverSegment(allowedRuns, overlap)) return true;
    if (group.source.kind === "port" && allowedRuns.some((run) => extendsTerminalRun(run, overlap))) return true;
    if (group.source.kind === "port" && allowedRuns.some((run) => turnsFromTerminalRun(run, overlap))) return true;
  }
  return false;
}

// Routing is solved one waypoint at a time. Once an accepted piece extends a
// shared terminal prefix, advance the authorization frontier immediately so
// the following piece sees one continuous trunk instead of an unrelated
// overlap. Only overlap with an already-routed compatible member can advance
// the frontier, so a split can never authorize a later rejoin.
export function authorizeSharedGeometry(firstLine, secondLine, firstSegment, secondSegment) {
  const overlap = overlapSegment(firstSegment, secondSegment);
  if (!overlap) return false;
  let changed = false;
  for (const { group, firstMembership } of sharedMembershipPairs(firstLine, secondLine)) {
    if (group.source.kind !== "port") continue;
    const allowedRuns = runsForPair(group, firstLine, secondLine);
    if (allowedRuns.some((run) => runContains(run, overlap)) || runsCoverSegment(allowedRuns, overlap)) continue;
    const extension = allowedRuns.find((run) => extendsTerminalRun(run, overlap));
    if (extension) {
      const horizontal = extension.first.y === extension.second.y;
      const axis = horizontal ? "x" : "y";
      const direction = Math.sign(extension.second[axis] - extension.first[axis]);
      const candidate = [overlap.first, overlap.second]
        .sort((first, second) => direction * (second[axis] - first[axis]))[0];
      if (direction * (candidate[axis] - extension.second[axis]) > 0.001) {
        extension.second = { ...candidate };
        changed = true;
      }
      continue;
    }
    const turn = allowedRuns.find((run) => turnsFromTerminalRun(run, overlap));
    if (!turn) continue;
    const second = samePoint(turn.second, overlap.first) ? overlap.second : overlap.first;
    group.allowedSharedRuns.push({
      first: { ...turn.second },
      second: { ...second },
      members: memberLinesForLane(group, firstMembership),
    });
    changed = true;
  }
  return changed;
}
