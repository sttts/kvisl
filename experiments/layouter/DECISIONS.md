# Layouter Prototype Decisions

Status: Accepted for the experiment

These decisions make the first layout experiment concrete. They do not amend the Kvísl language model. Where the experiment exposes a model ambiguity, the result belongs in a later explicit update to [`MODEL.md`](../../MODEL.md).

“Accepted” means the experiment has chosen the behavior; it is not an implementation-completeness marker. The current prototype still emits a fused preview scene rather than versioned Projection and Solved IR, so D7 and D9 cannot yet be represented as their final contracts. D12 has a canonical post-cascade `ShareGroup` representation with regression coverage for style cohorts, required-merge diagnostics, requested bundles, monotone lanes, terminal slots, and its debug overlay. D16 and D17 have direct mesh regression coverage. D18 has canonical cells, region bindings, portal intervals, shared debug geometry, and direct coarse traversal of cell identities and portals. Complete itinerary-adjacent `TrackRun` allocation remains partial: compatible regional allocations currently share interval intersections without yet deriving every maximal run from consecutive portal-connected cell incidences. The reference complexity target is likewise unproven until the performance counters and generated fixtures in `ALGORITHM.md` section 23 exist.

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

Pressure compacts the spacing of an already selected bundle toward its minimum. It never fuses requested bundle lanes, crosses style-cohort boundaries, or violates minimum spacing, capacity, or an explicit sharing prohibition. Automatic compatible members may merge only through the canonical share-group decision of D12, not as a later pressure shortcut.

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

## D7a. Semantic container interiors are not transit space

A visible semantic container blocks every line whose endpoints both lie outside its containment subtree. Containers on an endpoint's ancestry permit only the hierarchy entry or exit required by that endpoint: source-chain occupancy is one contiguous prefix and target-chain occupancy one contiguous suffix. Leaving and re-entering either chain is invalid. Layout-only rows, columns, and grids have no painted semantic boundary, while visual frames do not own their enclosed objects; neither creates this transit barrier.

The router, bounded refinements, and quality analyzer use the same container classification and open-rectangle collision rule. Authored pins cannot override it.

Rationale: treating a container border as decoration lets a Manhattan shortcut enter and leave an unrelated subsystem, contradicting both the hierarchy and the whitespace routing model.

## D8. Crossing geometry is output-sensitive and optional

The reference solver may count crossings in aggregate while choosing routes. It enumerates individual crossings only when the painter requests bridge or gap adornments.

The resulting `X` term is part of output size. Crossing enumeration is off by default in this experiment.

## D9. Prototype completeness is explicit

The experiment has two result classes:

- **solved**: all required endpoints, regions, capacities, and hard constraints were honored;
- **preview**: an SVG was emitted, but one or more unsupported or relaxed features produced diagnostics.

Preview output is valuable for visual comparison, but it is never evidence that the complete language feature is implemented.

## D10. The experiment is deterministic and bounded

The prototype uses a fixed candidate family for provisional routes, stable ordering by canonical path, a coordinate-bounded shortest-path search over each eligible route's relevant whitespace subgraph, and a fixed number of refinement passes. It contains no pixel search, permutation search, backtracking over global route combinations, SAT/ILP invocation, document-wide shortest-path pass per line, or convergence loop.

The implementation target is near-linear in projected input plus emitted geometry. Spatial queries use a sparse cell index instead of testing every route segment against every object.

## D11. Label demand is reserved in one physical region

A line label contributes space to one selected gap or explicitly named padding/corridor region, not to every hierarchy band crossed by the line. Grid column and row gutters are sized independently.

Rationale: charging the full label width to every traversed band compounds through nesting and makes otherwise compact diagrams arbitrarily wide. A label is painted once and therefore reserves one local interval.

The label and its owning run remain in the same semantic container space. A label bound to a region must fit inside that region's cross-section; if it does not, that one reservation grows. Border avoidance never clears a label into an adjacent container. Automatic orientation prefers upright text above and then below a horizontal run, then rotated text along a vertical run, and finally upright text beside a vertical run.

## D12. One canonical ShareGroup owns effective sharing geometry

After the cascade has resolved line paint, the prototype builds one canonical `ShareGroup` for every active named-port join, non-free `PortGroup`, and explicit line share group. Each member receives a normalized shared-piece stroke signature; at a canonical named-port end, the terminal head kind also participates because incompatible heads need distinct physical slots. The group's requested mode and these signatures determine one effective representation that every later reservation, routing, quality, and debug phase consumes:

- an explicitly requested `bundle` has exactly one lane per semantic line, even when several lines have identical styles;
- an automatic group with one style cohort merges to one lane and one positive-length trunk;
- an automatic group with several style cohorts becomes a bundle with one lane per cohort; compatible members in one cohort may merge within that lane, while different cohort lanes remain visibly distinct;
- an incompatible required `merge` emits a diagnostic and retains the separate cohort lanes in preview geometry rather than painting incompatible coincident strokes;
- `separate` and `free` produce no shared positive-length geometry.

Every bundle is monotone toward its common end: once a member enters its lane it does not leave and re-enter, and the contiguous lane-block order does not swap along the run. A canonical named port remains one semantic dock block but receives a compact physical terminal-slot block with one slot per effective lane. A requested bundle therefore receives one slot per line; an automatic cohort lane receives one slot shared by its compatible members. A named-port `separate` group receives more widely spaced physical approach slots, one per line, but no permission to share a positive-length run. A `PortGroup` instead keeps its independent ordered member-port docks and compresses only the adjacent lane block after departure. It does not synthesize same-port terminal slots.

Every physical terminal lane reserves its own marker and arrowhead extent, and a headed terminal run remains straight for at least twice the rendered head width before its first bend. The routing-debug painter reads the same `ShareGroup`, cohort lanes, terminal slots, and branch pins used by routing; it never infers sharing again from coincident polylines.

Approach alignment is independent of sharing permission. Same-front approaches with disjoint axial occupancy may receive one common bend coordinate even though their allocation identities remain distinct. A merge becomes coincident only at its authorized trunk; bundle lanes remain separate through the terminal. If the intervals overlap or their legal channel-coordinate intersection is empty, the alignment preference does not apply.

Rationale: coincident incompatible strokes are not a merge, a requested bundle is not permission to fuse compatible members, and several physical slots must not multiply canonical port identity. A single normalized state prevents reservation, routing, quality checks, and debug output from disagreeing about which geometry may be shared.

## D13. Previously routed lines are sparse routing obstacles

The router indexes emitted segments as it proceeds. A new candidate receives a strong penalty for an unrelated collinear run and a smaller penalty for a crossing. Only members of the same effective merged group or the same automatic style-cohort lane are exempt from the collinear penalty; distinct requested-bundle and style-cohort lanes remain obstacles to one another.

During this sequential solve, a compatible member may extend an already authorized terminal run only by touching its outer frontier and continuing collinearly away from the common end. This admits a longer maximal prefix without granting pair-wide overlap permission or allowing a split/rejoin.

Rationale: object avoidance alone can produce visually ambiguous coincident paths. The same cell index keeps this check local and output-sensitive.

## D14. The gallery reports structural conflicts

Every preview is checked for unrelated object overlaps, route/object intersections, line-label/object overlaps, line-label/line-label overlaps, and unrelated shared runs. UML occurrences inside activation bars are an explicit object-overlap exception. Crossings are counted but are not a hard failure because some legal drawings require them.

The repository examples are a regression gate: every example must render, remain orthogonal, and report zero structural conflicts in those five categories.

## D15. Size harmonization is renderer policy with a near-miss cap

Row and column members, and grid cells, equalize their cross-axis sizes by default — the `align-items: stretch` analog — and peers with the same kind/shape/role signature quantize onto shared widths and heights. Both apply only within a near-miss tolerance (stretch: 1.5× + 40 units; quantization: 28 units or 28 % group spread) so a small member is never inflated to several times its size. An explicit `same-size` constraint equalizes without a cap. Objects sized by an `extent` constraint are exempt.

Rationale: hand-drawn references equalize sibling boxes pervasively, and requiring an annotation for every equality would contradict the implicit-first model. Harmonization is expressed as monotone size floors, so it can only widen reservations, never shrink them.

## D16. Boundary labels are local channel residents

A container title contributes to the container's intrinsic content size, but it does not translate the complete top-channel mesh. The mesh subtracts the title's measured line rectangle plus explicit local clearance from the one top-padding region and connects the remaining parts only across positive-length shared edges. Layout, painting, and the mesh share that measured width; the mesh does not estimate it again from character count.

Derived gap track cells similarly use only the facing overlap of adjacent siblings. Their approach wings are separate canonical access cells that extend to the parent content boundaries. The router retains no larger approach rectangle.

Rationale: a left-aligned title blocks routing locally. Treating its height as a global channel offset wastes the full width, while painting a bounding-union gap incorrectly marks space behind an uneven sibling as routeable.

## D17. Each side has one padding region

Every container padding mesh has exactly one boundary-reaching logical region per side. Track allocation, free capacity, clearance, and transitions are properties of that region; they are not additional parallel regions. Resident subtraction may split the region into canonical cells without inventing a second region. Each corner uses the full width and height of its two neighboring side bands.

Rationale: painting base padding and a reserved track as two cells invents a second padding corridor. A single region preserves the logical topology; its track is a scalar allocation inside cited canonical cells, not a narrower hidden rectangle.

## D18. The channel mesh is the only routing geometry

The prototype builds the channel mesh before routing and binds every active logical region to canonical cell identities. A cell has one rectangle. Adjacency records the positive-length shared boundary as a portal interval. Track allocations cite cell identities, one cross-axis coordinate, and axial spans.

`region.geometry` and per-cell `routingGeometry` shadow rectangles are forbidden. Longitudinal tracks use facing core cells; perpendicular crossings may use connected access cells. Compatible, itinerary-adjacent collinear allocations of one line or effective share lane use a coordinate from the intersection of their legal intervals. Only an empty intersection at a recorded portal or junction creates an intentional transition; spatially compatible regions that are not consecutive in the itinerary do not form a run.

Direct parent/child cells connect only at real shared boundaries. Padding cells leave through their own side, and corner junctions leave only through their declared outward sides.

The coarse route is selected directly on this sparse cell graph. Search states cite a canonical cell key, the exact portal entry point, and the incoming segment direction. Every transition is charged for the centered in-cell geometry that realization will emit, including its bends; cell-center distances are not routing costs. The search traverses only recorded positive-length portals. The endpoint ancestry supplies the admissible owner set, so a cell belonging to an unrelated semantic container cannot become a shortcut. A bounded coordinate visibility search remains only a fallback when an endpoint or required waypoint has no materialized cell connection.

The debug scene also exposes the canonical D12 state: share-group source and effective mode, ordered cohort or per-line lanes, physical same-port terminal slots, and branch pins. These overlays cite the same objects consumed by allocation and realization.

Rationale: a debug mesh or sharing overlay reconstructed independently from routing can look correct while the line follows different coordinates. One topology and one `ShareGroup` state make centering, transitions, lane continuity, terminal slots, debug output, and performance assertions inspectable against the same data.

## D19. Endpoint access is a track, and dock movement invalidates geometry

A fixed side port exposed on a descendant reserves a longitudinal track in the adjacent row or column sibling gap when that gap is its hierarchy-scale approach. The gap is materialized and contributes thickness before layout; the port's escape stub remains a short terminal run and never substitutes for that track.

If a later bounded routing pass slides a dock along its legal side slot, every route derived from the old coordinate is rebuilt from the same symbolic itinerary and allocations. Old soft pins are discarded rather than protected as bends.

Rationale: extending a terminal stub through an inactive gap draws off-center without reserving space. Mutating a dock after routing while retaining old pins creates an avoidable return jog even though both the new dock and the authored corridor are individually correct.

## D20. Orientation remaps layout axes to an explicit frame depth

Orientation is a directional mapping, not a geometric transform of rendered children. `90` and `270` exchange the declaring container's row and column axes; all quarter turns remap local sides, ports, corridor directions, and routes. Child boxes keep their intrinsic width and height, and their contents stay upright.

The numeric form has depth one. It changes the declaring layout and the directional attachment semantics of its direct children, but it stops before the next nested layout is solved. A finite structured depth crosses that many normalized layout/frame boundaries, and `"all"` reaches the complete projected subtree. Depth counts projected structural frames, not JSX wrappers or component-function calls. Nested mappings compose modulo 360 degrees.

Rationale: rotating painted geometry turns wide boxes into tall boxes and makes reusable components depend on presentation transforms. Bounded directional propagation lets an author reflow exactly the intended amount of a component while preserving every object's measured geometry.
