# Examples

The examples are complete Kvísl Script models covering architecture drawings, UML, and focused language features.

## Visual reference fixtures

These directories pair a reference drawing with its TSX model:

- [`vegvisir-voice-agents/`](vegvisir-voice-agents/)
- [`modelplane-fleet-inference/`](modelplane-fleet-inference/)
- [`agent-substrate/`](agent-substrate/)
- [`machine-thought-os/`](machine-thought-os/)

Each visual fixture contains `original.png` and `diagram.tsx`.

## Grammar-coverage examples

[`uml/`](uml/) contains examples for the principal UML diagram families. They demonstrate how the core model hosts a broad notation as a composable library.

[`coverage/`](coverage/) exercises core features the visual fixtures do not reach: one component with its layout orientation cascaded through two frame levels while child geometry stays upright, `strictPorts`, `separate` port-group anti-affinity, `avoid` regions, an explicit share group without a common named port, and theme tokens. The modelplane fixture additionally carries a conditional rule (the media-query analog).
