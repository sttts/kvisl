# Layouter Prototype Decisions

Status: Accepted for the experiment

These decisions make the first layout experiment concrete. They do not amend the Kvísl language model. Where the experiment exposes a model ambiguity, the result belongs in a later explicit update to [`MODEL.md`](../../MODEL.md).

## D1. Port sides are an ordered set

A port side is represented internally as an ordered, non-empty set of allowed sides.

- One side means required.
- Several sides mean allowed in preference order.
- All four sides mean automatic placement.

The current `side: Side | "auto"` model maps directly to a singleton or all four sides. The prototype does not add authoring syntax for a preference list.

Rationale: this keeps hard feasibility distinct from preference without introducing opaque numeric weights.

## D2. Corridor capacity counts simultaneous visible tracks

Capacity is the number of simultaneous visible track slots at one cross-section of a corridor.

- A merged trunk consumes one slot.
- Five separately visible bundled lines consume five slots.
- A divider or corridor-resident object consumes physical width but not a track slot.

Rationale: capacity then has a geometric meaning the solver can validate before coordinates are assigned.

## D3. Pressure is normalized

Pressure is in the closed interval `0..1`.

- `0` uses preferred track spacing.
- `1` uses minimum track spacing.
- Intermediate values interpolate linearly: `min + (1 - pressure) * (preferred - min)`.

Pressure may bias an automatic sharing choice toward a bundle or merge. It never violates minimum spacing, capacity, or an explicit sharing prohibition.

## D4. The reference route geometry is orthogonal

The prototype emits orthogonal polylines. Painter profiles may round corners, perturb strokes, or produce a hand-drawn appearance without changing solved topology.

The first language version does not need a per-line route-geometry grammar. A future alternative solver may advertise non-orthogonal routing as a renderer capability.

Rationale: orthogonal geometry makes corridors, tracks, portals, docking sides, labels, and reserved space measurable with one coherent model.

## D5. Corridor residents remain ordinary objects

An object residing in a corridor remains an `ObjectIR`. It is anchored to a `RegionRef` with `placement.area: "inside"`. Track-order constraints can place tracks before or after that object.

The experiment must use this representation when corridor-resident fixtures are added; it must not introduce a corridor-resident entity kind.

## D6. Hard size conflicts cause deterministic fallback or failure

When required routing space conflicts with a hard maximum size, the solver proceeds in this order:

1. try its bounded alternative route topologies;
2. if the view was selected automatically, reject it and try the next view;
3. if the view was forced or no viable view remains, emit a hard diagnostic.

The solver must not silently route outside a semantic boundary or overlap an object to satisfy the size.

## D7. Pure hierarchy traversals stay compressed

The solver materializes a boundary portal only where geometry, orientation, a visible boundary, or painter binding changes. Pure hierarchy traversal remains compact provenance.

Rationale: eagerly emitting one portal for every crossed ancestor can make a sparse, deeply nested input produce quadratic output.

## D8. Crossing geometry is output-sensitive and optional

The reference solver may count crossings in aggregate while choosing routes. It enumerates individual crossings only when the painter requests bridge or gap adornments.

The resulting `X` term is part of output size. Crossing enumeration is off by default in this experiment.

## D9. Prototype completeness is explicit

The experiment has two result classes:

- **solved**: all required endpoints, regions, capacities, and hard constraints were honored;
- **preview**: an SVG was emitted, but one or more unsupported or relaxed features produced diagnostics.

Preview output is valuable for visual comparison, but it is never evidence that the complete language feature is implemented.

## D10. The experiment is deterministic and bounded

The prototype uses a fixed candidate set for routes, stable ordering by canonical path, and a fixed number of refinement passes. It contains no permutation search, backtracking over global route combinations, SAT/ILP invocation, or convergence loop.

The implementation target is near-linear in projected input plus emitted geometry. Spatial queries use a sparse cell index instead of testing every route segment against every object.

## D11. Label demand is reserved in one physical region

A line label contributes space to one selected gap or explicitly named padding/corridor region, not to every hierarchy band crossed by the line. Grid column and row gutters are sized independently.

Rationale: charging the full label width to every traversed band compounds through nesting and makes otherwise compact diagrams arbitrarily wide. A label is painted once and therefore reserves one local interval.

## D12. Named merge and bundle ports have different geometry

Lines at a `merge` port share one positive-length dock trunk before branching. Lines at a `bundle` port share only the canonical dock point, fan into adjacent lanes immediately, and remain separate strokes. Line-level bundles occupying one explicit gap receive adjacent tracks there.

Rationale: coincident polylines are not a visual implementation of a bundle. The distinction must remain visible even in the minimal SVG painter.

## D13. Previously routed lines are sparse routing obstacles

The router indexes emitted segments as it proceeds. A new candidate receives a strong penalty for an unrelated collinear run and a smaller penalty for a crossing. A declared merge is exempt from the collinear penalty.

Rationale: object avoidance alone can produce visually ambiguous coincident paths. The same cell index keeps this check local and output-sensitive.

## D14. The gallery reports structural conflicts

Every preview is checked for unrelated object overlaps, route/object intersections, line-label/object overlaps, line-label/line-label overlaps, and unrelated shared runs. UML occurrences inside activation bars are an explicit object-overlap exception. Crossings are counted but are not a hard failure because some legal drawings require them.

The repository examples are a regression gate: every example must render, remain orthogonal, and report zero structural conflicts in those five categories.

## D15. Size harmonization is renderer policy with a near-miss cap

Row and column members, and grid cells, equalize their cross-axis sizes by default — the `align-items: stretch` analog — and peers with the same kind/shape/role signature quantize onto shared widths and heights. Both apply only within a near-miss tolerance (stretch: 1.5× + 40 units; quantization: 28 units or 28 % group spread) so a small member is never inflated to several times its size. An explicit `same-size` constraint equalizes without a cap. Objects sized by an `extent` constraint are exempt.

Rationale: hand-drawn references equalize sibling boxes pervasively, and requiring an annotation for every equality would contradict the implicit-first model. Harmonization is expressed as monotone size floors, so it can only widen reservations, never shrink them.

## D16. Boundary labels are local channel residents

A container title contributes to the container's intrinsic content size, but it does not translate the complete top-channel mesh. The mesh subtracts the measured title rectangle from the one top-padding region and connects the remaining parts only across positive-length shared edges.

Derived gap track cells similarly use only the facing overlap of adjacent siblings. Their approach wings are separate canonical access cells. The router retains no larger approach rectangle.

Rationale: a left-aligned title blocks routing locally. Treating its height as a global channel offset wastes the full width, while painting a bounding-union gap incorrectly marks space behind an uneven sibling as routeable.

## D17. Each side has one padding region

Every container padding mesh has exactly one boundary-reaching logical region per side. Track allocation, free capacity, clearance, and transitions are properties of that region; they are not additional parallel regions. Resident subtraction may split the region into canonical cells without inventing a second region. Each corner uses the full width and height of its two neighboring side bands.

Rationale: painting base padding and a reserved track as two cells invents a second padding corridor. A single region preserves the logical topology; its track is a scalar allocation inside cited canonical cells, not a narrower hidden rectangle.

## D18. The channel mesh is the only routing geometry

The prototype builds the channel mesh before routing and binds every active logical region to canonical cell identities. A cell has one rectangle. Adjacency records the positive-length shared boundary as a portal interval. Track allocations cite cell identities, one cross-axis coordinate, and axial spans.

`region.geometry` and per-cell `routingGeometry` shadow rectangles are forbidden. Longitudinal tracks use facing core cells; perpendicular crossings may use connected access cells. Compatible collinear allocations of one line share a coordinate from the intersection of their legal intervals. Only an empty intersection creates an intentional transition.

Direct parent/child cells connect only at real shared boundaries. Padding cells leave through their own side, and corner junctions leave only through their declared outward sides.

Rationale: a debug mesh reconstructed independently from routing can look correct while the line follows different coordinates. One topology makes centering, transitions, debug output, and performance assertions inspectable against the same data.
