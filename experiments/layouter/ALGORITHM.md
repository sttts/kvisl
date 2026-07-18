# Kvísl Script Layout and Routing Algorithm

Status: Reference algorithm design draft

This document defines a scalable reference algorithm for turning a materialized Kvísl [Projection IR](../../MODEL.md) into Solved IR. It does not define authoring grammar, model semantics, package boundaries, or implementation language. [MODEL.md](../../MODEL.md) remains the source of truth for the data consumed by the algorithm; [REQUIREMENTS.md](../../REQUIREMENTS.md) remains the source of truth for required behavior; [DESIGN.md](../../DESIGN.md) defines the surrounding plumbing.

The central requirement is joint layout and routing: objects must be placed with enough space for lines, labels, docks, and shared trunks, while port and dock positions must be chosen in concert with the routes that use them. Routing is not a paint pass over immutable object coordinates.

Normative words in this document describe the reference solver contract, not the completeness of the JavaScript experiment. A paragraph explicitly headed or worded as **current prototype** is an implementation snapshot. [`DECISIONS.md`](DECISIONS.md) records accepted choices for the experiment; acceptance fixes intended behavior but does not by itself claim that the behavior is implemented. Tests and emitted diagnostics are the evidence for implementation conformance.

## 1. Short answer on complexity

Yes, a useful Kvísl solver can be sub-quadratic for the large, sparse, hierarchical models the language targets. It cannot honestly promise sub-quadratic time as a function of the number of objects alone for every valid document.

If `n` objects are connected by `Theta(n^2)` authored lines, merely reading the lines is quadratic. A sparse input can also require quadratic output: for example, many lines may cross a hierarchy of linear depth and require a distinct emitted portal at every boundary. No algorithm can run asymptotically faster than the input it must read or the geometry it must emit.

The correct guarantee is therefore:

> The reference solver MUST have no hidden all-pairs object phase, no all-pairs line phase, and no exhaustive search. Its running time MUST be near-linear in the actual input, realized route-incidence, and emitted-geometry sizes, with only a logarithmic indexing factor and a fixed number of heuristic refinement passes.

For the common case in which the numbers of lines, constraints, route incidences, bends, and portals are `O(n log n)`, this gives `O(n log^2 n)` time, which is sub-quadratic. A simpler bounded-depth model is `O(n log n)`.

The reference algorithm never performs exponential search. Exact global optimization is deliberately out of scope: minimum-crossing graph drawing is NP-complete, and even the two-layer crossing subproblem used by layered layout is NP-complete. Kvísl uses deterministic, bounded heuristics for those objectives and reserves exact algorithms for polynomial subproblems.

## 2. Size measures and complexity contract

Complexity is stated against the following quantities after view materialization:

- `N`: projected objects, including structural containers and anchored objects;
- `P`: canonical ports plus line-owned docks;
- `L`: lines;
- `S`: explicit segment pins, endpoint adornments, and labels;
- `C`: constraints and paint relations relevant to solving;
- `R`: implicit gap and padding regions plus named corridor refinements;
- `J`: realized line/share-group incidences in routing regions after compact hierarchy expansion;
- `G`: emitted geometric fragments: bends, portals, dock stubs, trunks, branches, and solved label boxes;
- `X`: crossing adornments, but only if a painter profile explicitly requires one emitted fragment per crossing.

Let `I = N + P + L + S + C + R` and `Q = I + J + G + X`.

The target full-solve bound is:

```text
time:   O(Q log Q)
memory: O(Q)
```

The logarithm covers stable sorting, balanced spatial indexes, priority queues, interval packing, and sparse constraint processing. A phase MAY use a linear-time specialization. It MUST NOT add an unconditional `O(N^2)`, `O(L^2)`, or `O(NL)` term.

This is an output-sensitive contract. When the input or mandatory output is quadratic, the solve may be quadratic because it cannot be otherwise; diagnostics and telemetry MUST attribute that cost to the measured input or output term rather than to an opaque solver phase.

The algorithm also has a **bounded-work rule**:

- every heuristic sweep count is a renderer-versioned constant, not “until no improvement”;
- every view alternative is attempted at most once per projection instance and allocation state;
- every route has a bounded set of canonical topology candidates before an output-sensitive detour is constructed;
- no phase enumerates permutations, port-side combinations, route combinations, or view combinations;
- no default phase invokes SAT, mixed-integer programming, or another solver with exponential worst-case search.

An optional offline quality solver may use a different polynomial algorithm, but conformance cannot depend on it and it must publish its own complexity profile.

## 3. What is optimized, and what is guaranteed

The solver separates hard feasibility from soft drawing quality.

Hard requirements include:

- containment and local orientation;
- explicit object sizes and minimum/maximum bounds;
- required sides, port capacity, minimum dock spacing, and port-group order;
- required ordering, alignment, inside, extent, route, and avoid constraints;
- explicit segment order and required region traversal;
- corridor capacity and minimum spacing;
- `merge`, `bundle`, and `separate` requirements when they are not automatic preferences;
- non-overlap and routing-space reservation for `space: "reserve"` lines.

Soft objectives include, in descending default priority:

1. preserve hard feasibility and semantic attachment;
2. avoid object-line intersections;
3. preserve required order and the existing incremental solution;
4. reduce crossings, using source order only as a stabilizer where order is free;
5. reduce bends and route length;
6. keep bundles and shared trunks coherent;
7. reduce occupied corridor width according to pressure;
8. improve symmetry, alignment, and compactness.

The order is renderer policy, not new authoring semantics. A target may tune weights, but it must not turn a preference into a hidden hard constraint.

The reference solver guarantees a deterministic feasible result for the polynomial constraint profile described here or a structured diagnostic. It does not guarantee a globally minimal number of crossings, bends, total area, or total route length.

When an example has an authored `original.png`, that drawing is the binding visual acceptance reference for the experiment. The solver may generalize the mechanism, but it may not redefine an intentional route, title placement, grouping, or whitespace decision merely because another drawing would also be valid. Automated quality checks enforce structural invariants; comparison with the original decides whether the resulting composition is the intended one.

## 4. Solver invariants

The following invariants hold throughout the pipeline.

### 4.1 Combinatorial topology precedes coordinates

The solver first decides relative order, stable channel-cell identities, region itinerary, sharing topology, track order, and dock order. Concrete rectangles, portal intervals, track centerlines, and route points are assigned only after those decisions have produced space demands. Coordinates never decide semantic identity, region identity, cell identity, or sharing.

### 4.2 Whitespace is the only reserving routing plane

Every reserving route occupies implicit padding bands and gaps, optionally refined by corridors. Objects and corridor residents are obstacles. A visible semantic container interior is not transit whitespace: it is a hard obstacle unless the container lies on an endpoint's containment chain. A line may cross those endpoint-chain boundaries, but it receives a portal into the relevant padding band rather than passing through an unrelated container interior.

The algorithm may use temporary overlay geometry while estimating a route, but only the corresponding whitespace demand becomes part of the size solve.

### 4.3 Hierarchy decomposes work; it does not restrict connectivity

A line may connect arbitrary depths and cross arbitrary containment boundaries. The containment tree is an acceleration and composition structure. Each cross-hierarchy line is projected into local obligations at its least common ancestors and boundary paths; the author does not provide those steps.

### 4.4 Port placement is a routing result

Fixed port sides constrain routing. Automatic port sides and all unspecified perimeter positions are selected from route direction, remote order, group order, labels, marker size, and side capacity. The algorithm never places all ports independently and then asks routing to repair the result.

A side containing one unconstrained dock block places that block at the side midpoint. It may move only when an actual local obstacle, explicit order, group extent, label extent, or route constraint requires displacement. Distant objects on the same ray are not by themselves a reason to move a dock.

### 4.5 Reservations are monotone within one solve attempt

Once a route, dock, label, or resident establishes a minimum region thickness, later phases may retain or increase that minimum but never shrink it during the same feasibility attempt. Soft compaction happens only after feasibility and cannot cross a recorded minimum.

This removes oscillating “layout moves line, line moves layout” fixed points. A topology change starts a new, explicitly bounded attempt.

### 4.6 Determinism is total

Every otherwise equal choice is broken by canonical containment address, line identity, endpoint index, corridor rank, and finally source order. Hash-map iteration, thread scheduling, and pointer identity never decide geometry.

### 4.7 Work is local or output-sensitive

Pairwise geometric relations are discovered by sweep lines, interval trees, spatial indexes, or sparse adjacency. A phase may spend time on every actual overlap, route incidence, bend, or emitted crossing, but not on every possible pair.

## 5. Derived solver structures

These structures are derived from Projection IR and do not change the data model.

### 5.1 Containment index

The projected object containment tree is indexed with:

- depth and parent arrays;
- Euler entry/exit ranges for ancestor tests;
- a lowest-common-ancestor index;
- level-ancestor or binary-lifting support;
- local-to-parent directional mappings with explicit remaining frame depth;
- heavy paths for compressed path updates and queries.

Linear preprocessing with constant-time LCA is possible; an `O(N log N)` binary-lifting implementation is also inside the contract. A line endpoint pair can then be assigned to its least common ancestor without walking the complete ancestor chain.

### 5.2 Local quotient interaction graphs

For every container, the solver builds a sparse graph whose vertices are its immediate placeable children plus its own boundary. A deep line contributes an interaction between the immediate child branches below the relevant least common ancestor. Parallel interactions are aggregated by line class, share group, and required segment itinerary where possible.

This quotient graph is what a container layout sees. It prevents a parent layout from inspecting every descendant pair and gives a reusable component a finite routing envelope.

Each projected line contributes to `O(log N)` compressed containment ranges plus its explicit pins, rather than one eagerly allocated record per crossed ancestor. Records are expanded only where a portal or geometric fragment is actually required.

### 5.3 Routing regions and the sparse channel mesh

Every container produces a local routing mesh from its layout topology:

- four padding bands form a boundary ring;
- row and column layouts contribute the gaps between consecutive members;
- a grid contributes row and column gutters;
- tree and layered layouts contribute inter-layer and inter-sibling gaps;
- a constraint layout contributes separators between spatial neighbors discovered by a sweep-line decomposition;
- named corridors annotate or subdivide those same regions;
- corridor residents split a channel locally but do not create a detached routing plane.

The mesh stores adjacency, local axis, capacity, minimum/preferred spacing, pressure, divider occupancy, residents, and route prohibitions. Before coordinate assignment, a cell has one stable identity and symbolic axial/cross-axis bounds. After coordinate assignment, that same cell has exactly one rectangle. Every solved adjacency retains the positive-length shared boundary as a portal interval; a neighbor identity without that interval is insufficient for geometric routing. The mesh contains only structural neighbors and direct parent/child boundary transitions. It must not contain one visibility edge for every mutually visible object pair.

Container boundary labels are local mesh residents, not a scalar offset applied to an entire padding side. The measured title rectangle plus an explicit local clearance is subtracted from the one top-padding region: cells beside the title remain available at the upper level and cells below it form the local bypass. The resident must use the same measured line widths as layout and painting, not a second character-count estimate. Only positive-length shared edges create cell adjacency; point contacts do not. The same rule applies to other residents introduced later.

The four-sided padding ring has exactly one logical region per side. Resident subtraction may partition that region into several canonical cells, all tied together by one stable slot identity and one region binding. Each region reaches the container boundary and contains its track allocation, free capacity, clearance, and portals as properties rather than additional parallel mesh cells. A corner is exactly the Cartesian product of its two adjacent side bands, so its height equals the neighboring horizontal band and its width equals the neighboring vertical band. Corners are internal junction cells: a corner may leave the container only through its two recorded outward sides.

A derived sibling-gap track cell covers only the facing overlap of the two adjacent members. Its approach wings are separate canonical access cells connected by explicit portals and together cover the complete free cross-section between the parent's content boundaries. No larger shadow rectangle is retained by the router. Longitudinal allocations use the facing track cell; perpendicular crossings may use the connected access cells. This prevents an uneven pair of siblings from producing a channel rectangle that extends behind either object while still preserving all routeable whitespace beside the siblings.

Logical routing regions bind to canonical cell identities before the first route is realized. Symbolic track allocations contain track order, width, and cited cell identities; after coordinate assignment they additionally contain one scalar cross-axis coordinate and axial spans over those same cells. Regions never own a second geometry, and cells never own a hidden routing rectangle. The debug painter and router therefore consume identical solved topology.

Every regional incidence is classified as either a **longitudinal track** or a **perpendicular crossing**. A longitudinal incidence consumes a track slot and contributes track thickness. A perpendicular hierarchy or gap crossing needs an intersection point and a bounded crossing band, but it does not consume a parallel track and must not displace longitudinal traffic from the region center. Several crossing-only incidences through the same padding band share one bounded crossing allowance rather than multiplying container padding by line count.

Grid row and column gutters are first-class logical regions backed by those same canonical mesh cells. Their identity includes both grid axis and gutter index; allocation, routing, quality checks, and debug painting must never reconstruct a second gutter rectangle from child bounds. An irregular grid may have a nominal row or column boundary with no positive physical gutter. Such a speculative region is removed before track allocation rather than bound to zero-area or shadow geometry.

When an automatic named-port bundle branches inside the grid gutter adjacent to its common terminal, that gutter reserves at least twice the longest required terminal-head run. With no explicit branch policy, the bundle front uses the canonical gutter centerline. The terminal half of the gutter then contains the complete arrowhead approach, while any perpendicular member approach also runs on the same visible band center instead of being pushed toward one sibling. An authored branch policy may deliberately choose another legal location.

For unconstrained rectangular siblings, a vertical/horizontal decomposition or nearest-neighbor sweep produces a linear-size mesh in `O(k log k)` time for `k` members. Row, column, grid, tree, and layered layouts produce their mesh directly in linear time.

### 5.4 Routing obligations and compact itineraries

A routing obligation is not yet a polyline. It contains:

- two terminal docks or intermediate explicit pins;
- the least common ancestor in which they must be connected;
- required and forbidden regions;
- the ordered explicit segment sequence;
- sharing and branch policy;
- style-derived stroke, marker, and label clearances;
- whether it reserves space or overlays;
- a compact list of chosen local channel spans.

An itinerary is represented as tokens such as `exit child through right padding`, `cross sibling gap`, `use named corridor`, and `enter child through top padding`. Consecutive hierarchy ranges may remain compressed until geometry is emitted.

A named wrapper port may be placed on a selected descendant while retaining the wrapper as its logical owner. When that fixed side faces an adjacent row or column sibling and the remote endpoint lies outside the wrapper's parent, the itinerary includes the intervening sibling gap as a longitudinal endpoint-access track. That gap is materialized and sized before coordinates are assigned. The short endpoint escape stub remains local to the dock and may never be extended through the hierarchy as a substitute for an unreserved access track. Deriving these obligations walks only the endpoint containment path, or its compressed equivalent, and is therefore `O(H)` per endpoint in the direct prototype and `O(log N + J)` with the containment index.

### 5.5 Routing envelopes

Every solved or provisionally solved container exposes a summary to its parent:

- minimum and preferred box size;
- boundary portal demand by local side;
- ordered port and transit groups visible at the boundary;
- compressed through-traffic classes;
- minimum padding-band thicknesses;
- hard maximum-size conflicts;
- a stable summary hash for incremental invalidation.

The parent never needs the child's internal track coordinates to place siblings. It needs the box, portal intervals, and routing demand. This is the main composition boundary for both scale and incremental solving.

### 5.6 Layout membership and frame depth

Every container derives one ordered list of placeable layout members after anchors, frames, lines, corridors, rules, and constraints have been excluded. This normalized member index is the only sibling index used by layout gaps, mesh regions, route projection, label demand, and quality checks. Raw JSX child positions are provenance only; they MUST NOT create phantom gaps or move a route to a different corridor.

Orientation depth is evaluated over the same normalized layout/frame tree. The declaring container always receives its own mapping. Depth one also maps the physical sides and directional attachments of its direct children, but does not change the layout strategy of a nested child frame. A finite larger depth decrements only when another projected layout/frame boundary is crossed; `"all"` never expires. The accumulated mapping composes modulo 360 degrees and never swaps a child's measured width and height.

## 6. End-to-end pipeline

```text
Projection IR
  -> resolve styles, metrics, text, and active endpoint targets
  -> normalize canonical ShareGroups and post-cascade style cohorts
  -> index containment and constraints
  -> measure intrinsic objects and endpoint adornments
  -> lift lines into local quotient interaction graphs
  -> choose local layout topology and member order
  -> build sparse symbolic whitespace channel meshes
  -> choose line/share-group itineraries and port sides
  -> order docks and tracks with bounded alternating sweeps
  -> allocate track slots and compute routing reservations
  -> solve object and container sizes bottom-up
  -> assign coordinates and transforms top-down
  -> materialize canonical cell rectangles, portal intervals, and track-run coordinates
  -> realize portals, trunks, branches, bends, and labels
  -> linearize paint relations over solved fragments
  -> validate hard constraints and emit Solved IR
```

The phases are detailed below.

## 7. Phase A: resolve target-dependent inputs

The renderer planner has already selected and materialized views. The solver resolves:

- conditional rules against the immutable render context;
- style cascade and metric tokens;
- text and image intrinsic measurements;
- marker, stroke, roughness, and label clearances that consume geometry;
- `PortPlacement` anchors in the selected views;
- endpoint alternatives and truncation points chosen during materialization;
- local orientations composed as bounded directional mappings, while retaining local directional vocabulary and upright child geometry.

Text is measured before routing because an end label may enlarge a dock group and a segment label may enlarge a channel. Painterly jitter does not participate in feasibility; the solver reserves a deterministic conservative clearance derived from the style.

Immediately after the cascade, every active named-port join, non-free `PortGroup`, and explicit line share group is normalized into one canonical `ShareGroup`. Its members carry resolved shared-piece stroke signatures, requested mode, effective mode, common-end provenance, and later lane membership. All subsequent phases consume this state; none re-derives sharing from raw endpoint policy or coincident geometry.

If an asset or font required for measurement is unavailable, solving stops or uses an explicitly permitted fallback. It must not silently measure with a host-dependent font.

## 8. Phase B: intrinsic measurement and equality collapse

Objects are measured bottom-up without routing reservations first. The result is a lower bound, not final geometry.

The solver uses disjoint-set structures to collapse compatible `same-size` and alignment equalities. Required contradictory fixed sizes are diagnosed before routing. Anchored objects are measured here even though they are not layout members.

Content groups and labels contribute their measured boxes. Container lower bounds include child lower bounds, resolved padding, layout gap minima, visible boundary labels, and inside-anchored furniture. Frames that enclose foreign members are recorded as later bounding dependencies rather than being treated as containment.

## 9. Phase C: hierarchy projection of lines

For each line, the solver processes the ordered chain:

```text
end 0 -> implicit traversal -> explicit segment pins -> implicit traversal -> end 1
```

Each adjacent pair of terminals or pins is assigned to its least common ancestor. Heavy-path range updates accumulate boundary demand along the ascent and descent without visiting every ancestor immediately. Explicit `through` regions split the path at the named region; `via` waypoints split it at the waypoint object.

At each relevant container, the line becomes one local quotient interaction between:

- two immediate child branches;
- one child branch and the container boundary;
- two boundary portals for through-traffic;
- or a child/boundary and an explicit local region.

This is how a line can ignore semantic hierarchy while the solver remains hierarchical. A route that exits two levels, crosses a parent gap, and re-enters three levels elsewhere is one semantic line but a small sequence of local obligations joined by stable portal identities.

An explicit gap between the two endpoint branches normally describes one perpendicular crossing. It becomes longitudinal occupancy only when the ordered itinerary requires distinct axial entry and exit positions, or when a bundle/share block requires a common longitudinal track. A leaf port side controls departure from the leaf object; an explicit gap or ancestor padding segment controls traversal at that ancestor level. Propagating a leaf side through every ancestor is forbidden when it contradicts the authored higher-level region.

## 10. Phase D: choose layout topology and member order

Layout topology means member ranks, rows, columns, layers, rings, and adjacency; it does not yet mean final coordinates.

### 10.1 Required and preferred order

Required order constraints form a directed acyclic graph. A cycle is a diagnostic. A stable topological sort chooses among currently available members using source order and canonical identity.

For `prefer-source`, source order is the initial order. For `free`, the initial order derives from the quotient interaction graph. A fixed number of median or barycenter sweeps may improve it. Each sweep sorts by aggregated neighbor ranks and uses canonical identity as the stable tie-breaker.

The solver never tests all permutations and never performs adjacent swaps until convergence. Crossing deltas for one sweep are counted with inversion counters or Fenwick trees rather than by enumerating edge pairs.

### 10.2 Strategy-specific topology

- **Row and column:** preserve or improve the one-dimensional member order; positions later become prefix sums of member sizes, margins, gaps, and channel reservations.
- **Grid:** assign members to a declared or derived number of rows and columns with stable streaming placement; a bounded local pass may swap cells when hard order permits.
- **Tree:** determine parent/child ranks from the relevant structural or quotient relation, order siblings with bounded median sweeps, and use subtree contours for separation.
- **Layered:** orient or break cycles deterministically, assign ranks with a sparse DAG pass, order members per layer with bounded median sweeps, and use a linear or near-linear coordinate assignment. Exact crossing minimization is forbidden.
- **Radial:** assign stable angular order and rings, then derive radial and tangential whitespace bands. Cross-ring lines still use the local routing mesh and boundary padding.
- **Stack and overlay:** preserve the declared stacking relation; reserving lines normally escape through padding because overlapping interiors are not general routing space.
- **Constraint:** solve the typed order, align, near, inside, extent, and size relations. It is not a general nonlinear optimizer. Initial spatial neighbors and separation constraints are produced by sweep lines rather than all-pairs overlap tests.

`avoid-overlap` is implemented by generating separation constraints only for actual spatial neighbors or actual overlaps discovered by an index. A bounded-overlap input can therefore use an `O(k log k)` overlap-removal pass instead of an `O(k^2)` scan.

Row and column containers apply bounded cross-axis near-miss stretching to all eligible visible siblings, not only siblings with identical roles or shapes. This is the structural `align-items: stretch` default described by the renderer policy; the near-miss cap prevents a small leaf from being inflated to the size of a fundamentally different large container. An explicit centered alignment uses the visible container frame as its target and is clamped to the routing-padding minima, so asymmetric route reservations do not create an accidental visual offset.

## 11. Phase E: build the symbolic routing mesh

The chosen topology determines which gaps and padding bands exist and their axial order. At this point every region has symbolic extents such as “between member ranks 3 and 7” even though it does not yet have a physical width.

The mesh provides at least one fallback connection between every member and its container boundary: escape to a legal side, enter the padding ring, traverse clockwise or counter-clockwise, then approach the destination. This fallback may be visually longer, but it guarantees that obstacle avoidance does not depend on a dense visibility graph. A hard `avoid` or capacity constraint may remove the fallback and make the route infeasible.

The per-line obstacle query includes every visible semantic container that contains neither endpoint. Containers on the source or target ancestry remain legal endpoint domains, but their interior-hit pattern is monotone: a source container may occupy only a contiguous route prefix and a target container only a contiguous suffix. The route therefore cannot leave and re-enter either endpoint chain. Unrelated sibling and cousin containers remain hard rectangles. The spatial index supplies only nearby candidates, so this adds `O(log N + K)` work per emitted route segment rather than a scan over all containers. Candidate scoring, bounded improvement, crossing refinement, and final quality analysis consume this same classification. A pin inside a forbidden container makes the itinerary infeasible instead of granting a transit exception.

For common layouts, the solver generates a bounded family of better candidates:

1. a direct route through the separating sibling gap;
2. horizontal-then-vertical and vertical-then-horizontal monotone routes through available gutters;
3. the shorter legal direction around the padding ring;
4. the other padding-ring direction;
5. a route required by explicit segment pins.

A route around a sequence of actual blocking neighbors is constructed output-sensitively with spatial successor queries. Candidate generation may spend `O(log k)` per query and `O(b)` for `b` emitted detours. Every route whose topology is not fixed by authored pins or monotone sharing state then receives a bounded shortest-path search over the relevant sparse channel subgraph. A route is not exempt merely because a longer fallback candidate is collision-free.

The search is over whitespace cells, portal intervals, obstacle-edge coordinates, and allocated tracks, never over pixels. It is bounded to the endpoint least-common-ancestor region and nearby obstacle successors. Repeated Dijkstra/A* over the complete document mesh remains outside the reference complexity profile; a bounded search over each route's relevant sparse subgraph is the required coarse solve.

### 11.1 Example: vertical exit, horizontal parent run, vertical entry

Consider a line that should leave a nested source vertically, travel horizontally in a whitespace band of a common ancestor, enter another nested subtree vertically, and dock on the target's bottom side. The solver represents that intent as this symbolic itinerary:

```text
source dock block
  -> vertical escape track in the source-side padding band
  -> source boundary portal
  -> horizontal track in the selected parent gap/corridor
  -> target boundary portal
  -> vertical entry track in the target-side padding band
  -> target bottom dock block
```

Before coordinates exist, this itinerary already contributes four independent space demands:

- longitudinal room on the source side for its dock and label;
- cross-sectional room for the source exit track and portal;
- one track or share block in the horizontal parent corridor, including its label;
- cross-sectional and longitudinal room for the target entry and bottom dock.

Track allocation determines the required thickness of the parent corridor. Dock packing may enlarge the target width. The bottom-up size pass then moves the surrounding objects far enough apart, and the top-down coordinate pass chooses exact portal and track centers. The line therefore crosses relative layers without naming every ancestor and without being overlaid on geometry that was finalized too early.

## 12. Phase F: choose routes and ports jointly

### 12.1 Work order

Routing obligations are processed in this stable priority:

1. fully pinned routes and required corridor traversals;
2. required merged share groups;
3. required bundles and fixed port groups;
4. lines with fixed endpoint sides;
5. other reserving lines, longest hierarchy span first;
6. overlay lines.

Within one class, canonical line/share-group identity decides. Routing constrained traffic first prevents a flexible line from consuming the only legal channel of an inflexible line.

Overlay lines are absent from the route-occupancy index as well as the space-demand solve. Their intersections cannot make reserving lines detour, and crossing refinement cannot move an overlay to avoid ordinary route geometry. This is essential for semantic overlays such as UML lifeline spines, whose intentional intersections with messages are not routing conflicts.

### 12.2 Candidate scoring

Each bounded candidate is scored from information available without final coordinates:

- hard legality;
- new peak track demand in each region;
- corridor pressure and capacity;
- estimated bends and symbolic span;
- agreement with explicit/preferred endpoint sides;
- preservation of an existing incremental itinerary;
- estimated crossings from track-order inversions;
- opportunities for legal sharing or bundling.

The lowest lexicographic cost wins; stable identity breaks ties. The algorithm does not combine every candidate of every line into a global Cartesian product.

### 12.3 Side selection

An explicitly constrained side is used as declared. An automatic side has at most four candidates. Its score uses the first/last route direction, current side demand, required group adjacency, marker and label extent, and estimated bends.

Automatic sides are selected greedily in routing priority order, followed by a fixed number of alternating port/track-order sweeps. A topology attempt may reconsider an automatic side once when its selected side is provably infeasible. It may not backtrack through arbitrary combinations of previous side choices.

The current Logical IR encodes `side: "auto"` or a concrete side but does not distinguish a preferred concrete side from a required concrete side. Until the model adds that distinction, the reference algorithm must treat a concrete `PortIR.side` as required.

### 12.4 Dock order and perimeter slots

For each object side, the solver forms dock blocks:

- one semantic block for a canonical named port, regardless of attachment count;
- one block for each line-owned dock;
- one contiguous super-block of independent member docks for a port group;
- a compact adjacent terminal-slot block inside a named port when its effective `ShareGroup` is bundled;
- a single trunk slot for a merged join.

Required port-group and explicit order constraints form a partial order. A port group is one contiguous super-block; `fixed` member order is hard, while free or preferred order may be chosen geometrically. Its distinct port points remain the terminal docks: bundling compresses their outgoing lane block but does not replace them with same-port sub-slots. Remaining docks are ordered by the median remote track rank or remote endpoint projection, with source order and canonical identity only as stabilizers. This ordering minimizes endpoint inversions before coordinates are assigned. Later facing-dock alignment and dock sliding must preserve it. End-label, marker, stroke, and arrowhead boxes are part of the block extent.

If a side has exactly one block and no local constraint requires movement, its slot is centered exactly. A canonical named port remains one semantic block regardless of attachment count. An effective named-port bundle allocates one compact physical terminal slot per effective lane around that canonical point: a requested bundle has one slot per semantic line, while an automatic multi-style bundle has one slot per style cohort. A named-port `separate` group allocates one more widely spaced approach slot per line so terminal strokes and heads remain independent. These are solved sub-slots, not new ports or dock identities.

Slots are packed along the side with a one-dimensional sweep and priority queue. If the side is too short, the object receives a larger minimum width or height. A fixed maximum that cannot contain its required docks is a hard conflict or a view rejection, never an overlap accepted by the painter.

Two line-owned docks remain distinct even if packing gives them the same visual coordinate. Coincidence never changes topology.

## 13. Phase G: sharing, trunks, bundles, and branches

Sharing is solved from the canonical post-cascade `ShareGroup` built in Phase A. The group source is one canonical port join, one non-free port group, or one explicit share group. It is not discovered by geometric coincidence, and reservations, routing, quality checks, and debug output must not reinterpret its requested mode independently.

The shared-piece compatibility signature contains the resolved visible-stroke properties that make positive-length coincidence meaningful: stroke, stroke width, dash, opacity, and roughness. At a canonical named-port terminal it also includes terminal head kind, because incompatible heads cannot occupy one physical slot. Members with one signature form a style cohort. Requested and effective sharing are then distinct:

- requested `bundle` always creates one effective lane per semantic line; style equality never fuses those lanes;
- `auto` with one cohort becomes `merge`;
- `auto` with several cohorts becomes `bundle`, with one lane per cohort; members inside a cohort may merge on that lane while different cohort lanes never overlap;
- required `merge` with several cohorts emits `incompatible-merge-style`; preview geometry retains the cohort bundle so every line stays inspectable instead of choosing one style;
- `separate` and `free` retain independent geometry.

The solver orients member itineraries away from the group's common end and inserts their region tokens into a trie:

- `merge` turns the common trie prefix into one positive-length trunk;
- `bundle` retains the effective per-line or per-cohort lanes in one adjacent track block along the common prefix;
- `separate` retains only the zero-length common dock and allocates distinct first tracks;
- requested `auto` never reaches the trie unresolved: its canonical `ShareGroup` has already selected compatible merge or cohort bundle geometry.

The trie is linear in the summed itinerary length; no pairwise longest-common-prefix comparison is needed.

Default late branching keeps the maximal common prefix. `early` shortens it at the earliest legal branch region; `balanced` chooses a stable middle legal token. A `within` policy restricts the candidate branch tokens to the referenced region. If no legal token exists, a required policy is diagnosed and a preference falls back deterministically.

Explicit segments that pin grouped lines to the same region contribute the same trie token and therefore coordinate there according to the group's effective lanes. Style compatibility has already been normalized into cohorts; Phase G does not hash styles again.

The common-prefix structure is monotone toward the common end. Once a semantic line enters an effective lane it remains in that lane through the terminal block, and the contiguous lane order is invariant along the run. A cohort may gain compatible members toward the common end, but no member leaves and later re-enters, and no lane swaps with a neighbor. Reordering requires an explicit branch outside the block.

Routing advances shared terminal authorization after every accepted waypoint piece. A compatible merge or bundle lane can therefore continue through several canonical channel cells without being mistaken for an unrelated overlap at the next cell boundary. Authorization grows only from the current terminal frontier while overlapping an already-routed compatible member; after a split, later coincidence remains forbidden.

An authored sibling gap used by a shared terminal group remains a longitudinal routing lane even when one member happens to be nearly aligned with its target. Branching therefore stays inside the authored corridor instead of moving laterally through a parent padding band.

Track reservation applies the same terminal-prefix rule before coordinates exist. When every member of an effective merge authors the same first region from the common endpoint, that region receives one merge track key rather than one track per semantic line. Coalescence stops there: a later common region may not be grouped merely because every member mentions it, because doing so after a split would manufacture an illegal rejoin.

This trie construction is a deterministic hyperedge heuristic. It does not search for a globally minimal rectilinear Steiner tree.

## 14. Phase H: tracks, corridor demand, and crossings

### 14.1 Channel intervals

Every selected itinerary produces one or more axial occupancy intervals in a routing region. An interval carries its dock/share block, stroke width, minimum separation, preferred separation, label occupancy, and order constraints.

Merged trunks contribute one interval. Bundles contribute one adjacent multi-track block with one interval per effective lane: one per semantic line for requested bundle, one per style cohort for automatic multi-style bundle. Separate lines contribute independent intervals.

### 14.2 Track-slot allocation

Without extra order constraints, channel slot allocation is interval-graph coloring:

1. sort intervals by start, then end, then stable identity;
2. release tracks whose active interval has ended;
3. reuse the lowest legal released track or allocate a new one;
4. keep bundle blocks contiguous and `separate` obligations distinct.

For independent unit-track intervals, the sweep is `O(k log k)` for `k` intervals and uses the minimum number of tracks for the fixed interval set. Bundle blocks, variable widths, and order constraints preserve the complexity bound but may use more tracks than the unconstrained optimum. Track-order constraints are incorporated as an acyclic precedence graph; required cycles are diagnostics. A longest-path rank supplies a legal lower bound, after which the sweep chooses the first legal track.

Several corridor refinements of one region are allocated in rank order. Capacity is checked after sharing has reduced the demand. A capacity overflow cannot be repaired by drawing through an object. This phase fixes slot identity, ordering, and required thickness; it does not yet choose an absolute centerline.

Perpendicular crossings are excluded before interval coloring. The reference prototype may obtain that classification with one provisional route, index its emitted segments against the canonical channel cells once, measure the resulting axial occupancies, and reroute once; it must not rescan every route for every region. Production solvers should derive the classification directly from the compact itinerary where possible. A crossing is never inserted into the ordered longitudinal track list. After ordering, one longitudinal track is placed exactly on the corridor centerline; several tracks form a symmetric block around it. Corridor rank is considered first, then geometric endpoint projection, with identity only as a deterministic final tie-breaker.

Distinct track identity does not require distinct centerline coordinates when the tracks do not coexist at any positive-length axial interval. After the provisional occupancy classification, approaches entering the same effective join or bundle front, plus independent approaches coordinated by one `free` port group, are partitioned into non-overlapping interval cohorts by the same sorted-interval/min-heap pattern, in `O(k log k)` for `k` approaches. Every cohort of at least two approaches receives one common cross-axis coordinate from the intersection of its legal channel intervals; a single-coordinate intersection is valid. Occupancy is read from the accepted route inside the canonical allocation cell even when an earlier sharing decision has already moved the segment off its provisional allocation center. This aligns orthogonal bends while preserving separate allocations and sharing permissions. Overlapping intervals, incompatible channel intervals, or a multi-cell run whose continuity cannot be preserved remain on independent coordinates.

### 14.3 Track runs across cells

One local allocation is not automatically one bend. For every line or share block, the allocator records ordered, portal-adjacent cell incidences and forms maximal collinear track runs. Once Phase I has materialized the cells' rectangles, a run intersects their legal cross-axis intervals. While that intersection remains non-empty, every incidence uses one block-center coordinate inside the common interval; bundle lanes retain their stable offsets around that center. An empty intersection closes the run and records one intentional transition at the intervening portal or junction. The polyline realizer may change the block center only at such a recorded transition and may not change lane order there. Two same-axis regions that are not consecutive in the itinerary must never be joined merely because their intervals overlap.

Bundle lanes remain a contiguous ordered super-block. The block is centered as a whole and lane offsets remain stable across all cells of the run. Cohort members that share one automatic lane use its one offset; requested-bundle members never do. The monotone common-end invariant forbids a lane from disappearing and later returning or swapping order at a portal. Per-cell separation constraints are needed only between adjacent ordered blocks, so allocation remains `O(J log J)` rather than comparing every track pair.

### 14.4 Pressure and required thickness

The required region thickness is the sum of:

- boundary clearances and divider occupancy;
- resident-object cross section;
- track or track-block widths;
- required minimum separations;
- marker, arrowhead, and label protrusions that occupy the region.

Preferred separation is then compacted toward the required minimum according to pressure. The exact pressure scale remains a model decision, but every permitted mapping must be monotone: increasing pressure cannot increase preferred width, and no pressure may reduce a hard minimum.

Content padding, crossing allowance, track thickness, and route-to-object clearance are separate quantities. The prototype uses one bounded crossing band for a crossing-only padding region and reserves an additional inner clearance for an authored longitudinal padding track. A track centerline must therefore remain separated from child content even when ordinary content padding is visually compact. Container title strips are independent reserved decor and may not be used as routing lanes.

### 14.5 Crossing estimates without pair enumeration

At a channel boundary, crossings correspond to inversions between dock order and track order. Fenwick trees count those inversions in `O(k log k)`. A fixed number of alternating median sweeps updates:

- object-side dock order from remote track ranks;
- channel track order from dock ranks at its ends;
- sibling order where the layout policy permits it.

The solver does not enumerate every crossing merely to optimize a score. If the painter requires a bridge or gap fragment at every final crossing, discovering and emitting those fragments is charged to `X`, because the requested output itself may be quadratic.

## 15. Phase I: compute sizes and coordinates

At this point all minimum routing thicknesses are known.

### 15.1 Bottom-up size solve

Containers are processed bottom-up. Their minimum sizes combine:

- intrinsic child and content sizes;
- margins and padding minima;
- member gaps widened by allocated channel demand;
- padding bands widened by boundary and transit demand;
- dock-side minimum lengths;
- layout alignment/distribution requirements;
- inside anchors and boundary labels;
- required frame/inside dependencies that are now geometrically known.

Visible container titles reserve a consistent strip at the start of the local content flow. The reference architecture fixtures place them left-aligned. For content placement this strip contributes an intrinsic lower bound; in the routing mesh it is a local resident that partitions only intersecting cells and does not translate the complete top band. The strip must coexist with children, nested frames, and routing bands; centering a title over otherwise usable routing space is not an automatic improvement.

Row and column sizes are prefix sums. Grid sizes are row/column maxima plus gutter reservations. Tree, layered, and radial strategies use their topology-specific contours or ranks. Sparse difference constraints solve required axis separations. A cycle of positive required separations is unsatisfiable.

No iterative route search is needed when a corridor widens: the itinerary and track assignment stay fixed, so member coordinates simply move apart.

### 15.2 Top-down coordinate assignment

Once the root allocation is known, coordinates are assigned top-down in local frames. Alignment and distribution consume surplus space without violating reserved minima. Orientations become parent transforms; child declarations and local route sides remain unchanged.

Automatic fill sizes and preferred sizes may consume surplus, but routing reservations are never compressed below their minima. If a finite target allocation cannot satisfy the minimum, the solver returns the smallest conflicting envelope to the renderer planner. The planner may reject the tentative view and try the next declared view.

### 15.3 Materialize channel geometry and track runs

The top-down pass replaces every symbolic channel-cell bound with one rectangle and every structural adjacency with its positive-length portal interval. Logical regions retain their earlier bindings to those cell identities. The allocator then performs the interval intersections from section 14.3 and assigns exact centerlines without changing slot count, slot order, required thickness, or object geometry. This is coordinate completion, not a second topology or routing pass.

If a formerly adjacent symbolic pair has no positive-length solved portal, the solve is inconsistent and must fail with provenance; the router may not invent a shadow rectangle to reconnect it. The routing-debug painter consumes these exact rectangles and intervals.

## 16. Phase J: realize line geometry and labels

The symbolic itinerary is lowered into concrete local geometry:

1. choose the exact dock coordinate within its allocated side slot; for a named-port bundle, choose its compact physical slot for the member's effective lane; for named-port `separate`, choose its independently spaced approach slot; a port-group member keeps its independent port dock;
2. create an orthogonal escape stub normal to the side for every physical lane; when the end has a head, the terminal run before the first bend is at least twice the rendered head width (a 2:1 length-to-width reserve);
3. select the allocated track center in each gap or padding band;
4. create stable boundary portals where the itinerary crosses containers;
5. join consecutive local tracks with the minimum legal bends;
6. materialize merged trunks once, effective bundle lanes in stable order, and branches separately;
7. place endpoint labels near their dock blocks;
8. place segment labels in reserved axial intervals, preferring the most prominent run;
9. emit provenance for every fragment;
10. lift logical paint relations to fragments and compute a stable topological order.

Region pins constrain only the dimension the region semantically owns. A longitudinal track fixes its cross-axis coordinate but remains movable along the track; a perpendicular crossing fixes the region intersection while allowing the adjacent branch run to choose the shortest legal axial position. For an explicit bundle traversing a shared gap, the entry into that longitudinal track is soft along the track and the terminal-side exit remains hard. This lets the ordered lane block move around a real obstacle without manufacturing a second axial waypoint and return jog. Authored waypoints and explicit branch points remain fully hard.

Polyline simplification may remove a collinear region vertex from the emitted point list, but the resulting segment must still contain that region pin geometrically. A bounded improvement is rejected if it moves the route off any required pin. Shared branch pins are materialized again as explicit vertices after improvement because they encode topology, not merely geometry. A provisional soft allocation pin that collision routing already relaxed is not resurrected during aesthetics: the pass snapshots only soft pins present on the accepted route, and replacements must continue through those geometrically. This prevents a discarded allocation pin from forcing a return jog.

Dock sliding is a bounded endpoint decision, not a post-processing mutation. Moving a dock invalidates every soft pin and escape point derived from its previous coordinate. The affected route is rebuilt from its unchanged symbolic itinerary and current track allocations before further simplification; stale pin coordinates must not survive as protected bends. Joined ports retain their canonical dock and ordering constraints, so a slide never changes topology or splits a shared port.

Initial interior routing begins between provisional endpoint escape points. They encode a minimum normal run rather than immutable bend vertices, so bounded simplification may replace an escape point with a longer collinear terminal run. Every candidate is normalized with the terminal constraints and rejected when that repair would introduce an immediate collinear reversal. A final invariant check removes any premature motion along the dock boundary and repairs the terminal approach, so a candidate search, dock slide, or later refinement cannot silently replace a normal terminal approach with a tangential one.

For compact bundle lanes, the minimum parallel clearance is their solved lane separation rather than the generic corridor clearance; this keeps the lanes distinct without forcing one member into an unrelated detour.

The terminal head reserve is a hard geometric invariant, not an aesthetic score. Every effective bundle lane retains its physical slot, straight terminal run, and head; simplification may not collapse requested lanes or distinct style cohorts at the dock. Simplification, dock sliding, bundling, and bounded refinement may lengthen that straight terminal run but must never insert a bend inside its 2:1 reserve. Head geometry has one shared source of truth for routing and painting, so a painter-side head-size change updates terminal-slot separation and the required route reserve with it. When that terminal run occupies a sibling gap, measurement reserves the run plus ordinary route-to-object clearance; the router must not manufacture the space by entering a neighboring object.

For each bounded topology candidate, feasibility is evaluated before aesthetics: object collisions, forbidden shared runs, and hard-region violations dominate every soft score. Crossings then receive a fixed local cost together with bends and Manhattan length. Removing one crossing may justify a local detour, but not a canvas-scale excursion that abandons an already valid authored or multi-region itinerary. Equal-length orthogonal candidates prefer a single crossing of an explicit gap and preserve the endpoint's normal departure before entering that gap. After realization, a fixed number of local windows may replace a polyline stretch only when no hard pin is removed and the complete candidate score strictly improves. No pass runs until convergence.

Sequential routing MAY extend an authorized terminal trunk or cohort lane only at its current outer frontier, collinearly and away from the common end. This provisional permission is monotone: it cannot create a disconnected rejoin. After all members are solved, the provisional frontier is replaced by their actual maximal common terminal prefix.

Label placement uses another interval sweep along each track. A label first tries its requested or automatic position, then the nearest free position on the same run. Automatic orientation prefers upright text above and then below a horizontal run, rotated text along a vertical run, and finally upright text beside a vertical run. The route-facing text edge of that final upright form is aligned rather than centered. If its already-reserved box cannot fit, the associated gap or band cross-section increases and the affected prefix coordinates are recomputed. The route topology and track order do not change.

Candidate generation is local and bounded. Besides fixed offsets, the solver may query a bounded spatial neighborhood and derive exact perpendicular clearances and along-run positions from nearby obstacle and container-border edges. This avoids missing a narrow legal slot without searching the canvas or changing dock order. Candidates are rejected when they overlap object geometry, unrelated routes, labels, title strips, or container border decor. The candidate center and its route anchor must occupy the same semantic container space. A label authored on a gap, padding band, or corridor must also fit completely within that region's cross-section. If no candidate satisfies these invariants, the owning whitespace reservation grows; clearing across a border into a sibling or nested container is forbidden.

A container title strip remains forbidden as a longitudinal route. A short perpendicular crossing of an endpoint-chain boundary is legal and receives a small local penalty rather than forcing a canvas-scale detour; the route must still retain the authored padding or corridor track on either side. An unrelated semantic container uses its complete open rectangle as a hard obstacle, not merely its border stroke. Ordinary object and forbidden-container interiors are tested against their exact open rectangle: even a shallow positive intrusion is invalid, while touching the boundary is not.

Overlay lines use the existing mesh and spatial index but contribute no earlier width reservation. They may accept ordinary object and route overlap penalties that reserving lines may not, but the semantic-container transit invariant remains hard.

A routing-debug render paints the complete channel mesh as a translucent overlay beneath lines and objects: one padding band per side, the four derived corner junctions of every non-empty container padding ring, every row/column sibling gap, and every grid gutter. Local residents such as boundary titles are subtracted from intersecting cells, and the remaining parts retain positive-length edge adjacency. A sibling gap is partitioned into its facing track core and separate access cells instead of being painted as one bounding rectangle. Debug rectangles are inset by one pixel on every edge so adjacent cell boundaries remain visible. The painter iterates the same canonical cell objects and portal intervals used by allocation and route realization; it never reconstructs channel geometry. The sharing layer follows the same rule: it paints the canonical `ShareGroup` effective mode, ordered per-line or cohort lanes, same-port terminal slots, and branch pins rather than inferring them from emitted polylines. This is an inspection of solved routing topology, not a new authoring construct: named and unnamed regions have identical geometric semantics, while provenance distinguishes actively materialized regions and regions explicitly refined by a `Corridor` declaration. Corner junctions are internal mesh cells and never become author-addressable `RegionRef` values. Their only hierarchy portals are the two outward-facing container sides recorded by the mesh; they cannot form a side-to-side shortcut around the container interior.

Crossing bridges, gaps, and line jumps are painter adornments, not default route topology. They are enumerated only when explicitly enabled by the painter profile and are off by default. The solver must not introduce a jump merely because two legal lines cross.

Required paint-order cycles are diagnostics. Soft relations are removed in stable lowest-weight order until the graph is acyclic; canonical identity chooses among otherwise equal fragments. This phase is sparse in the number of fragments and authored paint relations and does not compare every fragment pair.

## 17. Bounded refinement and termination

The feasibility solve has no open-ended convergence loop. The reference schedule is:

1. one topology and itinerary selection pass;
2. a fixed small number of alternating member/dock/track ordering sweeps;
3. one track-allocation and reservation pass;
4. one bottom-up size pass and one top-down coordinate pass;
5. at most one automatic-side correction for a locally infeasible endpoint;
6. optional compaction that preserves all minima and topology.

The current prototype realizes the crossing/track distinction with one provisional routing pass, one deterministic classification pass, and at most one reroute. It then performs two bounded route-improvement sweeps, a route-aware dock slide that preserves dock order, and two fixed shortest-path refinement sweeps of two passes each. Every eligible route is considered, including a collision-free fallback whose geometry is longer than necessary. The primary coarse search is A* over the route's relevant canonical channel cells and their positive-length portal intervals, using Manhattan distance as an admissible heuristic. Each state records the cell identity, exact portal entry point, and incoming segment direction. Every transition is charged using the same centered in-cell polyline that realization emits, including bends; cell-center distances are not routing costs. Endpoint ancestry filters the graph before search, excluding unrelated semantic-container cells. A local visibility grid of at most 64 by 64 derived coordinates remains a bounded fallback only when the canonical mesh cannot connect an endpoint or required waypoint, or when the realized graph candidate violates hard geometry. Object intrusion, non-monotone container transit, immediate collinear reversal, and unauthorized positive-length overlap are hard invalidity conditions. The remaining score trades crossings against bends and length with one fixed crossing cost. Structured multi-region itineraries with multiple hard pins and monotone merge or bundle topology are not ripped up merely to shorten geometry.

An explicit bundle is initially refined against geometry already committed in routing order, before its own lane enters the spatial index. Once its preliminary approaches exist, their planar order is copied to the shared corridor allocations and to any common entity-only target docks. Subsequent routing processes those members in lane order. This keeps the order invariant across a 90-degree turn instead of letting independently assigned source, corridor, and terminal orders braid. Bundle refinement may move a complete lane around an obstacle, but it must retain its lane index, minimum parallel clearance, required terminal geometry, and every hard corridor exit.

These are versioned constants, not convergence conditions. Each local replacement examines a fixed candidate family and a bounded route window. This fixture-scale schedule is not evidence of the `O(Q log Q)` contract: itinerary-adjacent `TrackRun` allocation and performance counters must replace or bound any repeated region-by-line, line-by-cell, or expanded-gap scan before the prototype can claim that complexity profile.

A side correction invalidates only the endpoint's local route suffix, its side packing, and affected channel intervals. It does not restart unrelated containers.

View fallback is also monotone. The renderer planner advances from one declared view to the next and never returns to a rejected view for the same allocation state. Nested failures propagate through routing envelopes: a child first falls back locally; if the parent envelope still cannot fit, the parent view is rejected. Memoized `(instance, view, allocation-class, context-hash)` attempts prevent repeated work. The total work is proportional to the actually attempted projection branches, not to their Cartesian product.

If a heuristic topology cannot satisfy a hard constraint but infeasibility is not proven, the solver reports **incomplete for this solver profile**, not **unsatisfiable**. Only contradictions such as hard cycles, impossible fixed bounds, exhausted required capacity, or incompatible required sharing may be called unsatisfiable.

## 18. Incremental and viewport solving

The same decomposition supports large and infinite canvases.

### 18.1 Cache units

Cache at least:

- intrinsic object measurements;
- containment/LCA indexes per projection generation;
- local quotient interaction graphs;
- container topology and routing mesh;
- chosen compact itineraries;
- share tries and track allocations;
- routing envelopes;
- solved local geometry and stable output identities.

Every cache key includes the relevant projection identities, styles and metrics, solver version, target policy, and inherited allocation/context class.

### 18.2 Invalidation

A local object edit invalidates its measurement, its container topology, and ancestors until a routing envelope hash is unchanged. A line edit invalidates the compressed containment paths between its terminals and explicit pins, not every object in the document. A style change invalidates only entities matched by the rule plus ancestors whose metrics change.

Spatial indexes identify local overlap and route changes. Stable canonical tie-breakers and preservation costs keep unaffected member, port, and track order unchanged.

### 18.3 Focused projections

A viewport or subtree solve materializes and solves visible containers plus a halo containing:

- boundary portals of lines that continue outside;
- routing regions needed to reach those portals;
- constraints whose other member can affect the visible envelope;
- enough ancestor envelopes to place the focused region.

The hidden continuation is represented by an external portal, not silently deleted. Full and incremental solves must converge on canonical-equivalent local geometry when no changed external constraint or congestion affects the region.

## 19. Diagnostics required from the algorithm

Diagnostics should name the smallest responsible objects, ports, lines, regions, or views and include provenance. At minimum:

- hard order or track-order cycle;
- fixed/min/max size contradiction;
- required docks do not fit an object side;
- port or corridor capacity exceeded;
- no legal route remains after required `avoid` and `through` constraints;
- required corridor missing from the projected view;
- incompatible styles on a required merged trunk;
- branch policy has no legal branch region;
- corridor resident and required track order conflict;
- frame/inside dependency cycle;
- view rejected because its minimum routing envelope exceeds allocation;
- solver-profile incompleteness distinct from proven unsatisfiability;
- operational budget exceeded, including the measured `I`, `J`, `G`, and `X` terms.

A diagnostic must not be “layout failed” when the solver can identify the saturated side, cyclic constraints, or missing route region.

## 20. Complexity by phase

| Phase | Target bound | Reason |
| --- | ---: | --- |
| Style, measurement, normalization checks | `O(I log I)` | indexed rule matching and stable maps; often linear |
| Containment and LCA indexes | `O(N log N)` or `O(N)` | binary lifting or linear LCA preprocessing |
| Line hierarchy projection | `O((L + S) log N)` before expansion | LCA plus heavy-path range representation |
| Local quotient graphs | `O(I log I)` | aggregate sparse interactions by stable keys |
| Layout topology | `O((N + E_q) log N)` | fixed number of stable median/order sweeps |
| Routing mesh construction | `O((N + R) log N)` | structural generation and neighbor sweeps |
| Candidate itinerary selection | `O((L + S) log Q + J)` | bounded candidates plus output-sensitive detours |
| Share tries | `O(J)` | trie insertion over compact itineraries |
| Dock and track ordering | `O((P + J) log Q)` | bounded median and inversion sweeps |
| Track and label interval packing | `O((J + S) log Q)` | interval sweeps and priority queues |
| Size and coordinate solve | `O((N + C + R) log Q)` | sparse constraints, prefix sums, spatial indexes |
| Geometry and paint realization | `O((G + X + C) log Q)` | emitted fragments plus sparse paint-order sorting |

`E_q` is the total number of aggregated edges in local quotient interaction graphs and is bounded by the relevant line/segment incidences. Summed over phases, the target remains `O(Q log Q)` time and `O(Q)` memory.

This table is a conformance target for a reference implementation. The current experiment has not established these bounds until the performance fixtures in section 23 report the stated size terms and demonstrate that no hidden scan grows as `N×L`, `L×R`, or `J²`.

## 21. Forbidden algorithmic patterns

The reference solver MUST NOT use:

- an all-pairs object repulsion or overlap pass;
- an all-pairs line crossing table;
- a dense visibility graph with every visible object pair;
- a full-document shortest-path search separately for every line;
- exact crossing minimization;
- exhaustive member ordering or adjacent swaps until convergence;
- exhaustive automatic-port-side combinations;
- exhaustive share/branch-point combinations;
- global backtracking across component views;
- an unbounded layout-routing fixed-point loop;
- SAT, ILP, SMT, or mixed-integer solving in the mandatory path;
- silent relaxation of a hard constraint to make the drawing finish.

Force-directed layout is not the reference default. A Barnes-Hut or multilevel force phase can be sub-quadratic, but by itself it does not allocate corridor tracks, respect deep containment, or jointly place ports. A renderer may use one as a bounded initializer for `constraint` layout, after which the same whitespace reservation pipeline still applies.

## 22. Experiment decisions and upstream model gaps

The algorithm exposes questions without inventing grammar for them. [`DECISIONS.md`](DECISIONS.md) fixes the experiment's answer. The table distinguishes a genuine upstream model gap from a renderer or solver policy that does not belong in authoring grammar.

| Topic | Experiment decision | Upstream status |
| --- | --- | --- |
| Required versus preferred port side | D1: one allowed side is required; several sides are an internal ordered preference set | `PortIR` still has no authored preferred-side list; add one only if the language needs it |
| Corridor capacity unit | D2: simultaneous visible track slots | exact unit remains unspecified in MODEL.md and REQUIREMENTS.md |
| Pressure scale | D3: normalized `0..1`, linear spacing interpolation | monotonic behavior is normative; numeric range remains unspecified upstream |
| Route geometry | D4: orthogonal reference solver | renderer capability policy; no per-line grammar is required for the first version |
| Corridor residents | D5: ordinary `ObjectIR` anchored to a `RegionRef` | already represented by `ObjectIR.anchor`; no model gap remains |
| Hard size conflict | D6: bounded reroute, automatic view fallback, then hard diagnostic | view fallback is already normative; the attempt order is solver policy |
| Hierarchy portal emission | D7: unchanged traversal stays compressed | Solved IR schema still needs a compact provenance representation |
| Crossing adornments | D8: enumerate only when a painter requests them | target capability and output policy, not authoring semantics |

Only the capacity unit, pressure scale, optional preferred-side authoring, and compact Solved-IR portal representation still require an upstream decision. None requires absolute coordinates in the authoring language.

## 23. Validation and performance fixtures

Before implementation, the algorithm should be tested on generated families in addition to the visual fixtures:

- a wide row with adjacent, skip, and long-span lines;
- a deep containment chain with lines crossing many boundary levels;
- a balanced hierarchy with cross-subtree lines;
- one high-cardinality named port under each sharing policy;
- large port groups with fixed, preferred, and free order;
- one gap subdivided into many ranked corridors under different pressure;
- many corridor intervals with bounded and adversarial overlap;
- constraint layouts with sparse actual overlaps but many objects;
- a deliberately dense `Theta(N^2)` line input to verify that cost follows input size rather than an extra pairwise factor;
- incremental edits whose affected envelope stops after a few ancestors;
- view fallback chains and nested view rejection without combinatorial retries.

Performance tests should record `I`, `J`, `G`, `X`, peak active intervals, dirty containers, and attempted views. Wall time without these counters cannot reveal an accidental quadratic phase.

The four main visual fixtures and their `original.png` files remain binding quality gates. In particular, the solver must reproduce their hierarchy-crossing lines, deep ports, shared fan-out/fan-in, padding-band routes, corridor ordering, labels, left-aligned container titles, and reserved whitespace without fixture-specific algorithms. A generated drawing is not accepted merely because it has zero collisions: unexpected dock displacement, inflated padding, off-center corridor use, endpoint inversions, or an avoidable return jog are regressions against the original composition.

Focused regression metrics should include:

- exact midpoint placement for unconstrained single docks;
- zero endpoint-order inversions for free same-side dock sets, while preserving fixed port-group order;
- independent measurements for content padding, route clearance, and track centerline distance;
- symmetric corridor track coordinates after excluding perpendicular crossings;
- Manhattan route length and backtrack distance for routes with no obstacle-forced detour;
- zero overlap of labels with objects, unrelated routes, other labels, title strips, and container decor;
- deterministic equality of repeated solved output.

## 24. Research basis

The reference design adapts established graph-drawing techniques but combines them around Kvísl's containment and whitespace model:

- Sugiyama, Tagawa, and Toda separate hierarchical drawing into ordering and coordinate phases and use heuristics for scale: [Methods for Visual Understanding of Hierarchical System Structures](https://doi.org/10.1109/TSMC.1981.4308636).
- Eades and Wormald show that the two-layer crossing problem is NP-complete and analyze median/barycenter heuristics: [Edge Crossings in Drawings of Bipartite Graphs](https://doi.org/10.1007/BF01187020).
- Garey and Johnson establish the broader crossing-number limit: [Crossing Number Is NP-Complete](https://doi.org/10.1137/0604033).
- Brandes and Köpf provide a fast coordinate-assignment phase for layered drawings: [Fast and Simple Horizontal Coordinate Assignment](https://doi.org/10.1007/3-540-45848-4_3).
- Dwyer, Marriott, and Stuckey show how sparse separation constraints support `O(n log n)` overlap removal under bounded overlap: [Fast Node Overlap Removal](https://doi.org/10.1007/11618058_15).
- Wybrow, Marriott, and Stuckey give efficient object-avoiding orthogonal connector routing for fixed obstacles: [Orthogonal Connector Routing](https://doi.org/10.1007/978-3-642-11805-0_22).
- Their hyperedge work motivates solving shared joins as trees rather than as coincident independent lines: [Orthogonal Hyperedge Routing](https://doi.org/10.1007/978-3-642-31223-6_10).
- Pupyrev, Nachmanson, Bereg, and Holroyd motivate ordered bundles with explicit width and channel-pressure costs: [Edge Routing with Ordered Bundles](https://doi.org/10.1016/j.comgeo.2015.10.005).
- Kiel's layered-port work demonstrates that port constraints must participate in crossing reduction and routing rather than be attached afterward: [Drawing Layered Graphs with Port Constraints](https://doi.org/10.1016/j.jvlc.2013.11.005).
- Bender and Farach-Colton provide simple optimal preprocessing for repeated least-common-ancestor queries: [The LCA Problem Revisited](https://doi.org/10.1007/10719839_9).

These papers do not supply one complete Kvísl solver. The distinctive step here is to use the containment tree and its implicit gaps/padding as the sparse routing substrate, then let track and dock demand determine layout spacing before coordinates are finalized.
