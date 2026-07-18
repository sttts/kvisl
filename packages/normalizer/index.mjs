// Kvísl normalizer — Core-profile slice.
//
// Covers: component expansion, the object primitive with Node/Scope/layout
// sugar, Text/label content normalization, ports (explicit, grouped, and
// endpoint-implicit) with canonical (owner, id) identity, strictPorts,
// lines with path endpoints, line-owned docks, explicit through/via
// segments, implicit LCA traversal weaving, gap()/padding() regions,
// rules and tokens, deterministic keys, and structural diagnostics.
//
// Not covered (Adaptive profile and later Core work): views, conditions on
// templates, port handles, corridors beyond pass-through, solving.

import { CORE } from "../core/index.mjs";

const SCHEMA = "kvisl.logical";
const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// phase 1: expansion — call components, flatten fragments/arrays/null/false
// ---------------------------------------------------------------------------

function expand(expr, diagnostics) {
  if (expr == null || expr === false || expr === true) return [];
  if (Array.isArray(expr)) return expr.flatMap((e) => expand(e, diagnostics));
  if (typeof expr === "string" || typeof expr === "number") {
    return [{ core: "text-run", value: String(expr) }];
  }
  if (expr.$$jsx) {
    const { type, props } = expr;
    if (typeof type === "function") {
      return expand(type(props), diagnostics);
    }
    if (typeof type === "symbol") {
      return expand(props.children, diagnostics);
    }
    if (type != null && type[CORE]) {
      const children = expand(props.children, diagnostics);
      return [{ core: type[CORE], props, children }];
    }
    diagnostics.push(error("unknown-element", `unknown JSX element type`));
    return [];
  }
  diagnostics.push(error("invalid-expression", `unsupported expression value`));
  return [];
}

function error(code, message) {
  return { severity: "error", code, message };
}

// ---------------------------------------------------------------------------
// phase 2: record tree — build containment records from core nodes
// ---------------------------------------------------------------------------

const OBJECT_KINDS = new Set(["diagram", "scope", "node", "row", "column", "grid", "note"]);
const DEFAULT_LAYOUT = { diagram: "column", row: "row", column: "column", grid: "grid" };

function asList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

// one record per object; ports/groups/lines/rules attach to their container
function buildObject(node, parent, diagnostics) {
  const p = node.props;
  const orientation = typeof p.orientation === "object"
    ? p.orientation
    : { degrees: p.orientation ?? 0, depth: 1 };
  const rec = {
    kind: "object",
    id: p.id ?? null,
    parent,
    node,
    roles: asList(p.role),
    classes: asList(p.className),
    orientation: orientation.degrees ?? 0,
    orientationDepth: orientation.depth ?? 1,
    strictPorts: p.strictPorts === true,
    label: p.label,
    shape: p.shape,
    content: [],
    children: [],
    ports: [],
    portGroups: [],
    lines: [],
    constraints: [],
    layout: null,
    style: p.style,
  };

  // layout facet: component kind default, or an explicit layout prop
  const strategy = p.layout?.kind ?? DEFAULT_LAYOUT[node.core];
  if (strategy) {
    rec.layout = {
      strategy,
      order: p.order ?? p.layout?.order ?? "prefer-source",
      align: p.align ?? p.layout?.align,
      distribute: p.distribute ?? p.layout?.distribute,
      columns: p.columns ?? p.layout?.columns,
    };
  }

  // metric props are sugar for inline-layer style declarations
  const gapValue = p.gap ?? p.layout?.gap;
  const metrics = {
    ...(gapValue != null ? { gap: gapValue } : {}),
    ...(p.padding != null ? { padding: p.padding } : {}),
    ...(p.margin != null ? { margin: p.margin } : {}),
  };
  if (Object.keys(metrics).length) rec.style = { ...rec.style, ...metrics };

  if (rec.id == null && node.core !== "text")
    diagnostics.push(error("missing-id", `structural container of kind ${node.core} has no id`));

  for (const child of node.children) buildChild(child, rec, diagnostics);

  // a label prop is a content entry with role "label"
  if (rec.label != null)
    rec.content.push({ kind: "text", value: rec.label, role: "label" });

  return rec;
}

function buildChild(child, rec, diagnostics) {
  switch (child.core) {
    case "text": {
      // Text inside an object is content; the value is its text-run children
      const value = child.children.map((c) => c.value ?? "").join("");
      rec.content.push({
        kind: "text",
        value,
        ...(child.props.role ? { role: child.props.role } : {}),
      });
      return;
    }
    case "compartment": {
      const items = [];
      for (const item of child.children) {
        if (item.core === "text")
          items.push({
            kind: "text",
            value: item.children.map((c) => c.value ?? "").join(""),
            ...(item.props.role ? { role: item.props.role } : {}),
          });
      }
      rec.content.push({ kind: "group", role: child.props.role, items });
      return;
    }
    case "text-run":
      rec.content.push({ kind: "text", value: child.value });
      return;
    case "port":
      rec.ports.push(makePort(child.props, "explicit"));
      return;
    case "port-group": {
      const members = [];
      for (const inner of child.children)
        if (inner.core === "port") {
          const port = makePort(inner.props, "explicit");
          rec.ports.push(port);
          members.push(port);
        }
      rec.portGroups.push({
        id: child.props.id ?? null,
        affinity: child.props.affinity ?? "free",
        order: child.props.order ?? "prefer-source",
        members,
      });
      return;
    }
    case "line":
      rec.lines.push({ props: child.props, segments: child.children.filter((c) => c.core === "segment") });
      return;
    case "constraint":
      rec.constraints.push(child.props);
      return;
    default: {
      if (OBJECT_KINDS.has(child.core)) {
        rec.children.push(buildObject(child, rec, diagnostics));
        return;
      }
      diagnostics.push(error("unsupported-kind", `kind ${child.core} is outside the normalizer slice`));
    }
  }
}

// bare names select core primitives; "namespace:name" selects an extension
function parseShape(shape) {
  const colon = shape.indexOf(":");
  if (colon < 0) return { kind: shape };
  return { kind: "extension", namespace: shape.slice(0, colon), name: shape.slice(colon + 1), data: {} };
}

function makePort(props, origin) {
  return {
    id: props.id,
    origin,
    side: props.side ?? "auto",
    cardinality: props.cardinality ?? "many",
    sharing: props.sharing ?? { mode: "auto" },
  };
}

// ---------------------------------------------------------------------------
// phase 3: addresses, keys, references
// ---------------------------------------------------------------------------

function childById(rec, id) {
  return rec.children.find((c) => c.id === id);
}

// resolve "a/b/c.port" or "../x" relative to the container declaring the ref
function resolvePath(fromRec, path, diagnostics) {
  let portName;
  const parts = path.split("/");
  const last = parts[parts.length - 1];
  const dot = last.indexOf(".");
  if (dot >= 0) {
    portName = last.slice(dot + 1);
    parts[parts.length - 1] = last.slice(0, dot);
  }
  let current = fromRec;
  for (const part of parts) {
    if (part === "..") {
      current = current.parent;
    } else {
      current = current ? childById(current, part) : undefined;
    }
    if (!current) {
      diagnostics.push(error("unresolved-reference", `cannot resolve '${path}'`));
      return null;
    }
  }
  return { rec: current, portName };
}

function ancestors(rec) {
  const chain = [];
  for (let r = rec; r; r = r.parent) chain.push(r);
  return chain;
}

function leastCommonAncestor(a, b) {
  const chain = new Set(ancestors(a));
  for (let r = b; r; r = r.parent) if (chain.has(r)) return r;
  return null;
}

// nearest strictPorts container that governs implicit port creation
function strictPortsContext(rec) {
  for (let r = rec; r; r = r.parent) if (r.strictPorts) return r;
  return null;
}

// ---------------------------------------------------------------------------
// phase 4: emit Logical IR
// ---------------------------------------------------------------------------

export function normalize(rootExpr) {
  const diagnostics = [];
  const roots = expand(rootExpr, diagnostics);
  const diagrams = roots.filter((n) => n.core === "diagram");
  if (diagrams.length !== 1) {
    diagnostics.push(error("root", `expected exactly one Diagram root, found ${diagrams.length}`));
    return { ir: null, diagnostics };
  }
  const root = buildObject(diagrams[0], null, diagnostics);

  // duplicate sibling ids
  (function checkIds(rec) {
    const seen = new Set();
    for (const c of rec.children) {
      if (c.id != null && seen.has(c.id))
        diagnostics.push(error("duplicate-id", `duplicate id '${c.id}' under '${rec.id}'`));
      seen.add(c.id);
      checkIds(c);
    }
  })(root);

  const entities = [];
  let nextKey = 1;
  const keyOf = new Map();

  function assign(entity) {
    entity.key = nextKey++;
    entities.push(entity);
    return entity.key;
  }

  // deterministic DFS: objects, their layouts, ports, and groups first
  (function walk(rec) {
    const entity = {
      key: 0,
      kind: "object",
      id: rec.id,
      domain: "ordinary",
      parent: rec.parent ? keyOf.get(rec.parent) : null,
      roles: rec.roles,
      classes: rec.classes,
      orientation: rec.orientation,
      ...(rec.orientationDepth !== 1 ? { orientationDepth: rec.orientationDepth } : {}),
      ...(rec.shape ? { primitive: parseShape(rec.shape) } : {}),
      content: rec.content,
      children: [],
      ports: [],
      ...(rec.layout
        ? {
            layout: {
              strategy: { kind: rec.layout.strategy, ...(rec.layout.columns ? { columns: rec.layout.columns } : {}) },
              order: { kind: rec.layout.order },
              ...(rec.layout.align ? { align: rec.layout.align } : {}),
              ...(rec.layout.distribute ? { distribute: rec.layout.distribute } : {}),
            },
          }
        : {}),
      ...(rec.strictPorts ? { strictPorts: true } : {}),
      ...(rec.style ? { style: rec.style } : {}),
    };
    keyOf.set(rec, assign(entity));
    rec.entity = entity;

    for (const port of rec.ports) {
      port.key = assign({
        key: 0,
        kind: "port",
        id: port.id,
        domain: "ordinary",
        parent: entity.key,
        roles: [],
        classes: [],
        owner: entity.key,
        origin: port.origin,
        side: port.side,
        cardinality: port.cardinality,
        sharing: port.sharing,
      });
      entity.ports.push(port.key);
    }
    for (const group of rec.portGroups) {
      assign({
        key: 0,
        kind: "port-group",
        id: group.id,
        domain: "ordinary",
        parent: entity.key,
        roles: [],
        classes: [],
        owner: entity.key,
        members: group.members.map((m) => m.key),
        order: group.order,
        affinity: group.affinity,
      });
    }
    for (const child of rec.children) {
      entity.children.push(walk(child));
    }
    return entity.key;
  })(root);

  // an endpoint names a port (implicit creation honors strictPorts) or the
  // object itself (a line-owned dock)
  function resolveEndpoint(lineRec, declaredIn, ref, end) {
    const resolved = resolvePath(declaredIn, ref, diagnostics);
    if (!resolved) return null;
    const { rec, portName } = resolved;
    const path = [];
    for (const a of ancestors(rec).reverse()) if (a.parent) path.push(keyOf.get(a));
    if (portName != null) {
      let port = rec.ports.find((p) => p.id === portName);
      if (!port) {
        const strict = strictPortsContext(rec);
        if (strict) {
          diagnostics.push(
            error("strict-ports", `endpoint '${ref}' names undeclared port '${portName}' inside strictPorts container '${strict.id}'`),
          );
          return null;
        }
        port = makePort({ id: portName }, "implicit");
        rec.ports.push(port);
        port.key = assign({
          key: 0,
          kind: "port",
          id: portName,
          domain: "ordinary",
          parent: keyOf.get(rec),
          roles: [],
          classes: [],
          owner: keyOf.get(rec),
          origin: "implicit",
          side: "auto",
          cardinality: "many",
          sharing: { mode: "auto" },
        });
        rec.entity.ports.push(port.key);
      }
      return { target: { kind: "path", path, onUnmaterialized: "truncate" }, dock: { kind: "port", port: port.key }, labels: [], rec };
    }
    return {
      target: { kind: "path", path, onUnmaterialized: "truncate" },
      dock: { kind: "line-owned", line: 0, end },
      labels: [],
      rec,
    };
  }

  function resolveRegion(declaredIn, region) {
    if (region?.$$region === "gap") {
      const a = resolvePath(declaredIn, region.between[0], diagnostics);
      const b = resolvePath(declaredIn, region.between[1], diagnostics);
      if (!a || !b) return null;
      if (a.rec.parent !== b.rec.parent)
        diagnostics.push(error("gap-siblings", `gap() references are not layout siblings`));
      return { kind: "gap", between: [keyOf.get(a.rec), keyOf.get(b.rec)] };
    }
    if (region?.$$region === "padding") {
      const container = region.container?.$$self
        ? declaredIn
        : resolvePath(declaredIn, region.container, diagnostics)?.rec;
      if (!container) return null;
      return { kind: "padding", container: keyOf.get(container), side: region.side };
    }
    return null;
  }

  // lines: resolve ends, then weave implicit traversal around explicit pins
  (function emitLines(rec) {
    for (const line of rec.lines) {
      const p = line.props;
      const from = resolveEndpoint(line, rec, p.from, 0);
      const to = resolveEndpoint(line, rec, p.to, 1);
      if (!from || !to) continue;
      const heads = p.heads === "both" ? ["arrow", "arrow"] : p.heads === "none" ? ["none", "none"] : ["none", "arrow"];
      const entity = {
        key: 0,
        kind: "line",
        id: p.id ?? null,
        domain: "ordinary",
        parent: keyOf.get(rec),
        roles: asList(p.role),
        classes: asList(p.className),
        ends: [from, to].map(({ rec: _drop, ...end }) => end),
        heads,
        segments: [],
        space: p.space ?? "reserve",
        avoid: asList(p.avoid).map((r) => resolveRegion(rec, r)).filter(Boolean),
        ...(p.share ? { share: { source: { kind: "explicit", id: p.share.group, parent: keyOf.get(rec) }, mode: p.share.mode ?? "auto", ...(p.share.branch ? { branch: p.share.branch } : {}) } } : {}),
        ...(p.style ? { style: p.style } : {}),
      };
      const lineKey = assign(entity);
      for (const end of entity.ends) if (end.dock.kind === "line-owned") end.dock.line = lineKey;

      const lca = leastCommonAncestor(from.rec, to.rec);
      const segment = (form, origin, labels = []) =>
        assign({ key: 0, kind: "segment", id: null, domain: "ordinary", parent: lineKey, roles: [], classes: [], line: lineKey, origin, form, labels });

      // exits from the source up to (excluding) the LCA
      for (let r = from.rec; r && r !== lca; r = r.parent)
        if (r !== from.rec || r.children.length)
          entity.segments.push(segment({ kind: "traversal", container: keyOf.get(r), role: "exit" }, "implicit"));
      // explicit pins in authored order
      for (const seg of line.segments) {
        const sp = seg.props;
        const labels = [];
        if (sp.label != null)
          labels.push({ text: sp.label, placement: "auto", orientation: sp.labelOrientation ?? "auto" });
        if (sp.through != null) {
          const region = typeof sp.through === "string" ? { kind: "corridor", corridor: sp.through } : resolveRegion(rec, sp.through);
          if (region) entity.segments.push(segment({ kind: "through", region }, "explicit", labels));
        } else if (sp.via != null) {
          const via = resolvePath(rec, sp.via, diagnostics);
          if (via) entity.segments.push(segment({ kind: "via", waypoint: keyOf.get(via.rec) }, "explicit", labels));
        }
      }
      // a line-level label lands on the line's most prominent run
      if (p.label != null && !line.segments.some((s) => s.props.label != null)) {
        const target = entity.segments.length
          ? entities.find((e) => e.key === entity.segments[entity.segments.length - 1])
          : null;
        const label = { text: p.label, placement: "auto", orientation: "upright" };
        if (target) target.labels.push(label);
        else entity.labels = [label];
      }
      // entries from below the LCA down to the target
      const entries = [];
      for (let r = to.rec; r && r !== lca; r = r.parent)
        if (r !== to.rec || r.children.length) entries.push(r);
      for (const r of entries.reverse())
        entity.segments.push(segment({ kind: "traversal", container: keyOf.get(r), role: "enter" }, "implicit"));
    }
    for (const child of rec.children) emitLines(child);
  })(root);

  // constraints: resolve entity references and lower spatial sugar to order
  (function emitConstraints(rec) {
    const resolve = (ref) => {
      if (ref == null) return null;
      const resolved = resolvePath(rec, ref, diagnostics);
      return resolved ? keyOf.get(resolved.rec) : null;
    };
    for (const p of rec.constraints) {
      const base = {
        key: 0,
        kind: "constraint",
        id: p.id ?? null,
        domain: "ordinary",
        parent: keyOf.get(rec),
        roles: [],
        classes: [],
        strength: p.strength ?? { kind: "required" },
      };
      const members = asList(p.members).map(resolve).filter((key) => key != null);
      switch (p.kind) {
        case "same-size":
          assign({ ...base, type: "same-size", members, dimension: p.dimension ?? "both" });
          break;
        case "align":
          assign({ ...base, type: "align", members, edge: p.edge ?? "center-vertical" });
          break;
        case "adjacent":
          assign({ ...base, type: "adjacent", members, ...(p.within != null ? { within: resolve(p.within) } : {}) });
          break;
        case "order":
          assign({ ...base, type: "order", before: resolve(p.before), after: resolve(p.after), basis: p.basis ?? { kind: "layout" } });
          break;
        case "below":
          assign({ ...base, type: "order", before: resolve(p.reference), after: resolve(p.item), basis: { kind: "spatial", axis: "vertical" } });
          break;
        case "above":
          assign({ ...base, type: "order", before: resolve(p.item), after: resolve(p.reference), basis: { kind: "spatial", axis: "vertical" } });
          break;
        case "near":
          assign({ ...base, type: "near", first: resolve(p.first ?? p.item), second: resolve(p.second ?? p.reference) });
          break;
        case "inside":
          assign({ ...base, type: "inside", members, container: resolve(p.container), ...(p.padding != null ? { padding: p.padding } : {}) });
          break;
        case "extent":
          assign({ ...base, type: "extent", item: resolve(p.item), axis: p.axis ?? "vertical", from: resolve(p.from), to: resolve(p.to) });
          break;
        case "avoid-crossing":
          assign({ ...base, type: "avoid-crossing", members });
          break;
        case "avoid-overlap":
          assign({ ...base, type: "avoid-overlap", members });
          break;
        default:
          diagnostics.push(error("constraint-kind", `unknown constraint kind '${p.kind}'`));
      }
    }
    for (const child of rec.children) emitConstraints(child);
  })(root);

  // document-layer rules and tokens from the Diagram styles prop
  for (const entry of asList(diagrams[0].props.styles)) {
    if (entry?.$$tokens) {
      assign({ key: 0, kind: "token-set", id: null, domain: "ordinary", parent: keyOf.get(root), roles: [], classes: [], layer: "document", values: entry.$$tokens });
    } else if (entry?.$$rule) {
      assign({
        key: 0,
        kind: "rule",
        id: null,
        domain: "ordinary",
        parent: keyOf.get(root),
        roles: [],
        classes: [],
        layer: "document",
        selector: { steps: entry.selector.steps, combinators: entry.selector.combinators ?? [] },
        ...(entry.condition ? { condition: entry.condition } : {}),
        declarations: entry.declarations,
      });
    }
  }

  const ir = { schema: SCHEMA, version: VERSION, root: keyOf.get(root), entities, paint: [] };
  return { ir, diagnostics };
}
