# Layouter experiment

This directory is an executable experiment for the joint layout-and-routing design in [`ALGORITHM.md`](ALGORITHM.md). It evaluates the repository's TSX examples, builds a tolerant prototype projection, reserves layout space for routing demand, routes orthogonal lines, and emits SVG previews.

The experiment is deliberately separate from the normalizer slice in `packages/`. [`MODEL.md`](../../MODEL.md) remains the language truth. A preview diagnostic means that the experiment approximated a feature; it does not redefine that feature.

## Run

```sh
npm run layout:examples
```

Generated SVGs and a GitHub-compatible side-by-side comparison gallery are written to `experiments/layouter/output/`. Open [`output/README.md`](output/README.md) to compare the four visual fixtures with their `original.png` files and to inspect the UML and coverage previews. GitHub renders this gallery automatically when visiting the output directory. Every section reports object/object, route/object, label/object, label/label, unrelated-shared-run, and crossing counts.

Render one file:

```sh
node experiments/layouter/render.mjs examples/agent-substrate/diagram.tsx --output /tmp/agent-substrate.svg
```

Run the experiment tests:

```sh
npm run test:layouter
```

## Intended evaluation

The first success criterion is not pixel similarity. It is whether the same logical TSX produces a recognizably equivalent architecture drawing while preserving:

- containment and nested local layouts;
- enough whitespace for route tracks;
- named-port joins and port-group ordering;
- explicit gap, padding, corridor, and waypoint pins;
- cross-hierarchy connections;
- labels, arrowheads, and meaningful UML shapes;
- deterministic output without exponential search.

The automated gate requires zero unrelated object overlaps, zero route/object intersections, zero line-label collisions, and zero unrelated coincident route runs across all repository examples. Crossings remain a reported quality measure rather than a feasibility failure. The gallery keeps the remaining visual judgment visible instead of hiding it behind a single score.

## Current prototype boundary

This is a layout experiment, not yet the production renderer. It deliberately uses a bounded route candidate set and a tolerant projection for authoring constructs that the normalizer slice does not implement yet. The SVG painter approximates hand-drawn and UML notation.

The prototype currently reserves local routing and label bands before final coordinates, places ports from remote direction and group order, distinguishes merged trunks from bundles, avoids objects and unrelated shared runs through sparse indexes, and places collision-checked line labels.

On top of feasibility it runs bounded aesthetics passes: docks of a line snap onto one shared coordinate when their sides face each other, zig-zag stretches collapse into better bounded candidates while pins and shared branch points survive, targeted repairs route around a specific obstacle or offset an unrelated coincident run, boxes stay content-minimal by default and equalize only among lookalike siblings (same kind/shape/roles/classes signature) — a structurally different neighbor never inflates a box — peers with one signature quantize onto shared sizes, and explicit `same-size` constraints equalize without a cap. Lateral travel happens inside gap corridors — a track pin expands into an entry point at the incoming coordinate and an exit point toward the next target, while implicit exit bands stay pure pass-throughs. Docks follow routing: a dock with a blocked departure or a post-route jog slides along its side, because an off-center dock beats a staircase. Members of a row or column with slack slide over their connected counterparts in other containers — an actor lands above the box it feeds. The gallery reports the perceptual measures these passes optimize — bends per line, detour factor, backtrack ratio, distinct guide coordinates, peer-size and gap variation, and label displacement — next to the hard conflict gate. Guide snapping between *unconnected* subtrees remains future work.

Still outside the experiment boundary are complete hard-constraint infeasibility proofs, full view-fallback propagation, every corridor-resident case, crossing bridges, incremental invalidation, and production Solved IR. Crossing reduction is bounded and heuristic; the reported crossing count is expected to guide further work without introducing an all-pairs or global-search phase.
