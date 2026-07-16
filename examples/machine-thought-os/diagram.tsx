// Pre-implementation grammar fixture. This file specifies the intended
// authoring model and is not expected to compile until the core API exists.

import {
  Column,
  Constraint,
  Corridor,
  Diagram,
  Grid,
  Line,
  Node,
  Note,
  Port,
  Scope,
  Subtitle,
  Text,
  Title,
  gap,
} from "@excalmermaid/core";

const colors = {
  ink: "ink",
  gray: "kernel-gray",
  blue: "state-blue",
  orange: "scheduler-orange",
  green: "running-green",
  purple: "join-purple",
  yellow: "deferred-yellow",
};

function Child({ id, label }: { id: string; label: string }) {
  return (
    <Node id={id} role="running-child" style={{ fill: "pale-green", stroke: colors.green }}>
      <Text>{label}</Text>
      <Text>running</Text>
      <Port id="schedule" side="left" />
      <Port id="state" side="left" />
      <Port id="join" side="right" />
    </Node>
  );
}

export default (
  <Diagram id="machine-thought-os" theme="excalidraw-handdrawn">
    <Title>An operating system for machine thought</Title>
    <Subtitle>
      The thinking model requests parallelism. The inference engine decides when it runs.
    </Subtitle>

    <Scope
      id="user-mode"
      label="THINKING MODEL · USER MODE"
      role="user-mode"
      layout={{ kind: "row", distribute: "space-between", align: "center" }}
      style={{ fill: "pale-blue", stroke: "light-blue" }}
    >
      <Node id="parent" role="parent-completion" style={{ fill: "light-blue", stroke: colors.blue }}>
        <Text>Parent completion</Text>
        <Text>shared history</Text>
        <Port id="fork" side="right" />
      </Node>
      <Node id="fork" role="system-call" style={{ fill: "pale-yellow", stroke: colors.orange }}>
        <Text>{"<Parallel>"}</Text>
        <Text>system call: fork</Text>
        <Port id="parent" side="left" />
        <Port id="kernel" side="bottom" />
      </Node>
      <Node id="resume" role="parent-resume" style={{ fill: "pale-green", stroke: colors.green }}>
        <Text>Parent resumes</Text>
        <Text>{"<Conclusion>"}</Text>
        <Port id="join" side="bottom" />
      </Node>

      <Line from="parent.fork" to="fork.parent" style={{ stroke: colors.blue }} />
    </Scope>

    {/* the system-call boundary is the decorated gap between the bands,
        not an element of its own */}
    <Corridor
      id="system-call-boundary"
      in={gap("user-mode", "kernel")}
      divider={{
        label: "SYSTEM-CALL BOUNDARY",
        labelPlacement: "end",
        style: { stroke: colors.orange, dash: "dashed" },
      }}
    />

    <Scope
      id="kernel"
      label="SGLANG · INFERENCE ENGINE / KERNEL"
      role="kernel"
      layout={{ kind: "column", gap: "large" }}
      style={{ fill: "near-white", stroke: colors.gray }}
    >
      <Grid id="execution" columns={4} align="center" gap="large">
        <Node id="interpreter" role="interpreter" style={{ fill: "light-blue", stroke: colors.blue }}>
          <Text>Interpreter</Text>
          <Text>creates child</Text>
          <Text>requests</Text>
          <Port id="system-call" side="top" />
          <Port id="scheduler" side="right" />
        </Node>

        <Node id="scheduler" role="scheduler" style={{ fill: "pale-orange", stroke: colors.orange }}>
          <Text>TAPER scheduler</Text>
          <Text>admit per forward</Text>
          <Text>pass</Text>
          <Port id="interpreter" side="left" />
          <Port
            id="children"
            side="right"
            cardinality="many"
            sharing={{ mode: "merge", branch: { preference: "late" } }}
          />
        </Node>

        <Column id="work" gap="medium">
          <Scope
            id="next-pass"
            label="NEXT GPU FORWARD PASS"
            role="gpu-pass"
            layout={{ kind: "column", gap: "medium" }}
            style={{ stroke: colors.green, dash: "dashed" }}
          >
            <Child id="child-a" label="Child A" />
            <Child id="child-b" label="Child B" />
          </Scope>
          <Node
            id="child-c"
            role="deferred-child"
            style={{ fill: "pale-yellow", stroke: colors.orange, dash: "dashed" }}
          >
            <Text>Child C</Text>
            <Text>ready, deferred this</Text>
            <Text>pass</Text>
            <Port id="schedule" side="left" />
            <Port id="state" side="left" />
            <Port id="join" side="right" />
          </Node>
        </Column>

        <Node id="wait" role="join" style={{ fill: "light-purple", stroke: colors.purple }}>
          <Text>wait()</Text>
          <Text>join KV views</Text>
          <Port
            id="children"
            side="left"
            cardinality="many"
            sharing={{ mode: "merge", branch: { preference: "late" } }}
          />
          <Port id="parent" side="top" />
        </Node>

        <Node id="shared-state" role="shared-kv" style={{ fill: "light-blue", stroke: colors.blue }}>
          <Text>Shared prefix KV blocks</Text>
          <Text>+ small branch-local state</Text>
          <Port
            id="children"
            side="right"
            cardinality="many"
            sharing={{ mode: "bundle", branch: { preference: "late" } }}
          />
        </Node>
      </Grid>

      <Note id="batching" role="annotation" anchor="execution/work/next-pass" placement="above">
        continuous batching · radix KV cache
      </Note>

      <Line from="execution/interpreter.scheduler" to="execution/scheduler.interpreter" style={{ stroke: colors.ink }} />

      {/* fan-out merges into one trunk and branches late; the dashed
          branch to the deferred child leaves the solid shared piece */}
      {[
        ["a", "execution/work/next-pass/child-a.schedule", false],
        ["b", "execution/work/next-pass/child-b.schedule", false],
        ["c", "execution/work/child-c.schedule", true],
      ].map(([id, target, dashed]) => (
        <Line
          key={String(id)}
          id={`schedule-child-${id}`}
          from="execution/scheduler.children"
          to={String(target)}
          style={{ stroke: colors.green, dash: dashed ? "dashed" : undefined }}
        />
      ))}

      {[
        ["a", "execution/work/next-pass/child-a.state", colors.blue],
        ["b", "execution/work/next-pass/child-b.state", colors.blue],
        ["c", "execution/work/child-c.state", colors.orange],
      ].map(([id, target, stroke]) => (
        <Line
          key={String(id)}
          id={`state-child-${id}`}
          from="execution/shared-state.children"
          to={String(target)}
          style={{ stroke: String(stroke), dash: "dashed" }}
        />
      ))}

      {[
        ["a", "execution/work/next-pass/child-a.join", false],
        ["b", "execution/work/next-pass/child-b.join", false],
        ["c", "execution/work/child-c.join", true],
      ].map(([id, source, dashed]) => (
        <Line
          key={String(id)}
          id={`join-child-${id}`}
          from={String(source)}
          to="execution/wait.children"
          style={{ stroke: colors.purple, dash: dashed ? "dashed" : undefined }}
        />
      ))}

      <Note id="principle" role="principle" placement="inside-bottom">
        Model chooses the work graph. Engine chooses the schedule.
      </Note>
      <Constraint kind="below" item="execution/shared-state" reference="execution/interpreter" />
      <Constraint
        kind="below"
        item="execution/work/child-c"
        reference="execution/work/next-pass"
        strength="required"
      />
    </Scope>

    {/* both crossings of the system-call boundary route implicitly
        through the decorated gap */}
    <Line
      id="fork-system-call"
      from="user-mode/fork.kernel"
      to="kernel/execution/interpreter.system-call"
      style={{ stroke: colors.orange }}
    />
    <Line
      id="resume-parent"
      from="kernel/execution/wait.parent"
      to="user-mode/resume.join"
      style={{ stroke: colors.purple }}
    />
  </Diagram>
);
