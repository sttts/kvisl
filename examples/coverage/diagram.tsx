// Grammar-coverage fixture. Like examples/uml/, this file has no
// original.png: it exercises features the visual fixtures do not —
// orientation, strict ports, anti-affinity, avoid regions, an explicit
// share group, an explicit size equality, and theme tokens.

import {
  Constraint,
  Diagram,
  Line,
  Node,
  Port,
  PortGroup,
  Row,
  Scope,
  Segment,
  cls,
  gap,
  role,
  rule,
  tokens,
} from "@kvisl/core";

const palette = tokens({ "flow-blue": "#2563eb", "probe-gray": "#6b7280" });

const styles = [
  rule(role("stage"), { stroke: "ink" }),
  rule(cls("data"), { stroke: "flow-blue" }),
  rule(cls("probe"), { stroke: "probe-gray", dash: "dashed" }),
];

// a pipeline authored entirely in its own left-to-right frame; strictPorts
// makes a typo in a port name an error instead of a silent second port
function Pipeline({ id }: { id: string }) {
  return (
    <Scope id={id} label="Pipeline" role="pipeline" strictPorts layout={{ kind: "row", gap: "medium" }}>
      <Node id="ingest" role="stage" label="Ingest">
        <Port id="in" side="left" />
        <Port id="out" side="right" />
      </Node>
      <Node id="transform" role="stage" label="Transform">
        <Port id="in" side="left" />
        <Port id="out" side="right" />
      </Node>
      <Node id="publish" role="stage" label="Publish">
        <Port id="in" side="left" />
        <Port id="out" side="right" />
      </Node>

      <Line className="data" from="ingest.out" to="transform.in" />
      <Line className="data" from="transform.out" to="publish.in" />
    </Scope>
  );
}

export default (
  <Diagram id="grammar-coverage" theme="excalidraw-handdrawn" styles={[palette, ...styles]}>
    <Row id="system" gap="xlarge" align="center">
      {/* the same component: once horizontal, once with two layout/frame
          levels re-oriented; child boxes and text remain upright */}
      <Pipeline id="upright" />
      <Scope id="rotated" orientation={{ degrees: 90, depth: 2 }} layout={{ kind: "column" }}>
        <Pipeline id="pipeline" />
      </Scope>

      <Node id="monitor" role="stage" label="Monitor">
        {/* anti-affinity: the two probes must stay visibly apart */}
        <PortGroup id="probes" affinity="separate">
          <Port id="upright-probe" side="left" />
          <Port id="rotated-probe" side="left" />
        </PortGroup>
      </Node>
    </Row>

    {/* entity-only endpoints: each probe owns its dock; avoid keeps the
        first probe out of the whitespace between the two pipelines */}
    <Line
      id="probe-upright"
      className="probe"
      from="system/monitor.upright-probe"
      to="system/upright/transform"
      avoid={[gap("system/upright", "system/rotated")]}
    />
    <Line
      id="probe-rotated"
      className="probe"
      from="system/monitor.rotated-probe"
      to="system/rotated/pipeline/transform"
    />

    {/* explicit size equality across kinds: the monitor spans the full
        pipeline height — a gap the near-miss harmonization default never
        bridges on its own */}
    <Constraint kind="same-size" dimension="height" members={["system/upright", "system/monitor"]} />

    {/* explicit share group: no common named port, but both audit lines
        bundle through the same whitespace toward the monitor */}
    <Line
      id="audit-upright"
      className="data"
      from="system/upright/publish.out"
      to="system/monitor"
      share={{ group: "audit", mode: "bundle" }}
    >
      <Segment through={gap("system/rotated", "system/monitor")} />
    </Line>
    <Line
      id="audit-rotated"
      className="data"
      from="system/rotated/pipeline/publish.out"
      to="system/monitor"
      share={{ group: "audit", mode: "bundle" }}
    >
      <Segment through={gap("system/rotated", "system/monitor")} />
    </Line>
  </Diagram>
);
