# UML grammar examples

This directory contains pre-implementation TSX examples for the principal UML diagram families. They are language-design fixtures: their purpose is to prove that UML notation can be expressed as composable library components over the Excalmermaid core rather than as privileged core diagram types.

Unlike the visual reference fixtures in the parent directory, these examples do not currently have an `original.png` and are not pixel-reproduction targets. Each file is nevertheless intended to be a complete logical model with no absolute coordinates.

The current set covers:

- [class diagrams](class-diagram.tsx);
- [object diagrams](object-diagram.tsx);
- [component diagrams](component-diagram.tsx);
- [deployment diagrams](deployment-diagram.tsx);
- [package diagrams](package-diagram.tsx);
- [use-case diagrams](use-case-diagram.tsx);
- [sequence diagrams](sequence-diagram.tsx);
- [activity diagrams](activity-diagram.tsx);
- [state-machine diagrams](state-machine-diagram.tsx).

[`uml.tsx`](uml.tsx) is an illustrative UML component library implemented with ordinary TSX components and core entities. It ships its notation presentation as a library-layer stylesheet (`umlStyles`), so a theme or document can override any of it without touching the components. It is part of the grammar design, not a runtime implementation.

More specialized UML families — communication, composite-structure, timing, interaction-overview, and profile diagrams — are candidates for a later coverage set. The current set first establishes the structural, behavioral, and interaction mechanisms on which those notations build.

## Design pressure exposed by UML

These examples intentionally exercise requirements that simpler architecture drawings do not:

- class and object compartments as structured content groups;
- stereotypes and keywords as structured values the theme decorates, not «string» text;
- endpoint adornments through structured line ends (`UmlEnd` over the core `End` grammar): hollow triangles, filled and hollow diamonds, navigability, roles, and multiplicities;
- generalizations joining at one named port and sharing a triangle trunk;
- nested package, component, execution-environment, and composite-state boundaries;
- interactions where JSX order is the temporal order: `Interaction`/`Lifeline`/`Message`/`Reply`/`Loop` expand into occurrences derived from messages, per-message alignment, activation bars under `extent` constraints, and fragment frames — the core never models time;
- a shared semantic `subject` referenced from a class diagram and a lifeline classifier;
- guards, forks, joins, decisions, and pseudostates.

Where exact convenience syntax is still unsettled, the examples choose one typed, serializable form and the requirements record the remaining grammar decision. The normalized semantics are the important contract.
