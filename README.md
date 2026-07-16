# Excalmermaid

Excalmermaid is a composable modelling language for design diagrams. It aims to scale from a small sketch to an effectively unbounded system canvas while keeping logical structure — not pixel coordinates — as the source of truth.

The long-term target is a model detailed enough to describe an entire Kubernetes landscape or an entire Linux system, from the highest architectural boundaries down to the lowest useful implementation level. A DIN A0 poster is a normal output size, not the limit of the model.

Status: language and data-model design. There is no working compiler, solver, or renderer yet.

## Why

Large technical drawings usually fail in one of two ways: a diagram language supports only a narrow family of charts, or a drawing tool leaves authors maintaining positions and routes manually. Both approaches become fragile as a system grows.

Excalmermaid instead treats a drawing as a composable logical model:

- components expose public ports while retaining optional deep hierarchical addressing;
- every ordinary structural container has a local ID and contributes to its containment path;
- scopes provide containment, local identity, and local orientation;
- layouts express relationships rather than coordinates;
- lines cross arbitrary hierarchy boundaries;
- most route segments are inferred;
- explicit segments pin only the semantically important parts of a route;
- whitespace created by layout is also the routing plane;
- presentation comes from typed rules in a layered cascade — renderer, theme, library, document, inline — keyed by roles and classes;
- components can provide several context- and detail-sensitive views, selected media-query-style;
- one model can support overview, detailed, poster, tiled, and infinite-canvas rendering.

## Core principles

### Composition first

Components are ordinary TypeScript functions. Callers normally attach lines through opaque port handles and do not depend on component-internal IDs. When intentional deep access is useful, every named container remains reachable through a relative hierarchical path. Components can be nested, repeated, moved, and expanded or collapsed without rewriting their internal connections.

### One model across all scales

High-level architecture and low-level implementation detail coexist in the same logical graph. A component may provide named meta views for a symbol, summary, specialized projection, or detailed internals. Unselected view templates are invisible to normal paths and do not create active objects or a second component identity.

A renderer creates context for each component instance, including target medium, page or viewport, available space, purpose, state, and capabilities. View selection works like media and container queries: declaration order is preference order, and the first view whose condition holds and whose footprint fits wins. In `maximum-that-fits` mode the renderer works outside-in, instantiates that branch, and conditionally adapts it before layout and routing.

### No coordinate authoring

Authors describe containment, layout, ports, lines, constraints, and routing regions. Layout and routing cooperate to reserve space. Absolute positions are not part of the normal authoring model.

### Whitespace is routable structure

Margins, padding bands, and gaps between layout siblings form implicit routing regions. Named corridors refine those regions with spacing, pressure, ordering, or a visible divider.

### Renderer-neutral pipeline

TSX is evaluated once and normalized into a versioned, language-neutral Logical IR. Independent TypeScript, Go, and Rust solvers or renderers can consume that IR.

```text
diagram.tsx
    -> TSX evaluation and component expansion
    -> Logical IR
    -> renderer context, first-fit view selection, and meta-branch materialization
    -> Projection IR
    -> layout and routing
    -> Solved IR
    -> Excalidraw, SVG, Canvas, or another painter
```

## Authoring direction

The exact API is still a draft, but the intended composition looks like this:

```tsx
type ServiceProps = {
  id: string;
  request: PortHandle<Request>;
};

function Service({ id, request }: ServiceProps) {
  return (
    <Scope id={id}>
      <Port id="request" side="left" bind={request} />

      {/* declaration order is preference order: first viable view wins */}
      <View
        id="internals"
        detail={2}
        requires={gte(context("allocation.inlineSize"), 70)}
        footprint={{ minWidth: 90, minHeight: 60 }}
      >
        <Column id="internal-layout">
          <Node id="api">API</Node>
          <Scope id="workers">{/* detailed render branch */}</Scope>
        </Column>
        <PortPlacement port="request" on="internal-layout/api" side="left" />
      </View>

      <View id="summary" detail={0} footprint={{ minWidth: 30, minHeight: 15 }}>
        <Node id="card">Service</Node>
        <PortPlacement port="request" on="card" side="left" />
      </View>
    </Scope>
  );
}

const clientRequest = port<Request>();
const serviceRequest = port<Request>();

export default (
  <Diagram id="service-system">
    <Row id="services">
      <Scope id="client">
        <Node id="ui">
          <Port id="request" side="right" bind={clientRequest} />
        </Node>
      </Scope>

      <Service id="service" request={serviceRequest} />
    </Row>

    <Line from={clientRequest} to={serviceRequest}>
      <Segment
        through={gap("services/client", "services/service")}
        label="request"
      />
    </Line>
  </Diagram>
);
```

The component caller knows only the public port handle. The normalizer resolves both handles to stable ports and infers hierarchy traversal. `services/service/internals` and `services/service/workers` do not enter the hidden view templates. Renderer materialization creates the selected branch in Projection IR.

A named endpoint such as `services/client/ui.health` implicitly defines `health` on the ordinary `ui` object if necessary. A nested `<Port id="health">` or later `<Port ref="services/client/ui.health" marker="circle">` configures that same canonical port rather than creating another one. Lines attached to the same named port form one join and follow the sharing policy declared there.

An endpoint that names only an object, such as `services/client/ui`, creates a distinct dock owned by that line end. It does not create a port or join with another object-only endpoint. Dock and line styles both contribute to the rendered attachment: non-conflicting properties compose, while the line style overrides any property also supplied by the dock.

A normal deep line target stops at the deepest object instantiated by the selected views. If a line truly needs a different target for one rendered view, endpoint alternatives provide the explicit escape hatch through a typed `alt()` helper: it chooses `abc` when `foo` renders view `view`, otherwise `foo/bar`. A compact string spelling may exist as sugar, but the structured helper is normative, and normal paths never expose the meta tree.

## Documents

- [DESIGN.md](DESIGN.md) describes implementation architecture and plumbing only.
- [REQUIREMENTS.md](REQUIREMENTS.md) states the normative language and system requirements.
- [MODEL.md](MODEL.md) defines the conceptual data model and draft Logical IR.
- [`examples/`](examples/) contains visual reference fixtures and pre-implementation grammar examples.

The documents and fixtures are written before implementation on purpose. A grammar change must update every affected fixture so the language is continuously tested against real design drawings rather than toy flowcharts.

## Reference fixtures

Each fixture contains the original drawing and the TSX model intended to reproduce it:

- [Vegvísir voice agents](examples/vegvisir-voice-agents/diagram.tsx)
- [Modelplane fleet inference](examples/modelplane-fleet-inference/diagram.tsx)
- [Agent Substrate](examples/agent-substrate/diagram.tsx)
- [Machine thought operating system](examples/machine-thought-os/diagram.tsx)

The references exercise nested containment, repeated components, long hierarchy-crossing routes, shared trunks, fan-out and fan-in, routing corridors, annotations, boundaries, and mixed levels of detail.

## UML grammar examples

[`examples/uml/`](examples/uml/) contains complete TSX formulations for class, object, component, deployment, package, use-case, sequence, activity, and state-machine diagrams. These examples have no `original.png`; they test the breadth and composability of the language rather than reproduction of one supplied drawing.

The UML vocabulary is expressed as an ordinary TSX component library over the core model. UML diagram types therefore do not become privileged syntax or renderer-specific IR variants.

## Non-goals

Excalmermaid is not:

- a new general-purpose programming language;
- a fixed collection of diagram types;
- a pixel-coordinate drawing format;
- tied to Excalidraw as its only renderer;
- expected to reconstruct the original TSX source from normalized IR.
