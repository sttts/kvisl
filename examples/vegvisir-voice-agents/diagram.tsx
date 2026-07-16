// Pre-implementation grammar fixture. This file specifies the intended
// authoring model and is not expected to compile until the core API exists.
// Presentation lives in document-layer rules; structure carries only roles
// and classes.

import {
  Column,
  Diagram,
  Image,
  Line,
  Node,
  Port,
  PortGroup,
  Row,
  Scope,
  Segment,
  Subtitle,
  Text,
  Title,
  cls,
  gap,
  padding,
  role,
  rule,
  self,
} from "@excalmermaid/core";

const styles = [
  rule(role("device"), { fill: "near-white", stroke: "muted-gray" }),
  rule(role("actor"), { fill: "pale-yellow", stroke: "decision-orange" }),
  rule(role("realtime-agent"), { fill: "pale-blue", stroke: "voice-blue" }),
  rule(role("decision"), { fill: "pale-yellow", stroke: "decision-orange" }),
  rule(role("agent-harness"), { fill: "pale-green", stroke: "road-green" }),
  rule(role("knowledge-source"), { fill: "near-white", stroke: "muted-gray" }),
  rule(role("remote-agents"), { fill: "pale-purple", stroke: "agent-purple" }),
  rule(role("named-agent"), { fill: "light-purple", stroke: "agent-purple" }),
  rule(role("agent-tool"), { stroke: "agent-purple" }),
  rule(cls("voice"), { stroke: "voice-blue" }),
  rule(cls("decision-flow"), { stroke: "decision-orange" }),
  rule(cls("progress"), { stroke: "road-green" }),
  rule(cls("knowledge"), { stroke: "muted-gray" }),
  rule(cls("delegation"), { stroke: "agent-purple" }),
];

function Driver() {
  return (
    <Column id="driver-column" align="center" gap="large">
      <Node id="driver" shape="ellipse" label="Driver" role="actor">
        <Port id="voice" side="right" />
      </Node>
      <Text role="caption">speaks · listens</Text>
      <Image
        id="app-icon"
        source="asset://vegvisir-app-icon"
        alt="Vegvísir app icon"
        aspectRatio={1}
      />
      <Text role="app-name">Vegvísir</Text>
    </Column>
  );
}

function Phone() {
  return (
    <Scope
      id="phone"
      label="Vegvísir on iPhone"
      role="device"
      layout={{ kind: "column", gap: "large" }}
    >
      <Node id="voice-agent" role="realtime-agent">
        <Text role="heading">Realtime Voice Agent</Text>
        <Text role="heading">GPT-Realtime-2 → GPT-Live</Text>
        <Text role="heading">listens · speaks · delegates</Text>
        <Text role="caption">
          Fast conversational loop — never blocked by long-running work
        </Text>
        <Port id="driver" side="left" />
        {/* fixed order keeps the three corridor tracks side by side */}
        <PortGroup id="loop" order="fixed">
          <Port id="tasks" side="bottom" />
          <Port id="speech" side="bottom" />
          <Port id="progress" side="bottom" />
        </PortGroup>
      </Node>

      <Node id="speak-now" shape="diamond" label={"Speak\nnow?"} role="decision" />

      <Node id="road-agent" role="agent-harness">
        <Text role="heading">Road Agent Harness</Text>
        <Text role="heading">
          Drive context · async Road Tasks · ranking
        </Text>
        <Text role="heading">
          POI search · map state · navigation handoff
        </Text>
        <PortGroup id="loop" order="fixed">
          <Port id="tasks" side="top" />
          <Port id="speech" side="top" />
          <Port id="progress" side="top" />
        </PortGroup>
        <Port id="remote" side="right" />
        <Port id="local-context" side="bottom" />
        <Port id="road-knowledge" side="bottom" />
      </Node>

      <Row id="knowledge" gap="large" align="stretch">
        <Node id="local-context" role="knowledge-source">
          <Text>Local Markdown context</Text>
          <Text>Soul · Preferences · Today</Text>
          <Text>· Memory</Text>
          <Port id="harness" side="top" />
        </Node>
        <Node id="road-knowledge" role="knowledge-source">
          <Text>Live road knowledge</Text>
          <Text>MapKit · Overpass ·</Text>
          <Text>Wikipedia</Text>
          <Port id="harness" side="top" />
        </Node>
      </Row>

      {/* the conversational loop runs in the implicit corridor around the
          decision diamond; no channel declarations needed */}
      <Line
        id="accept-road-task"
        className="voice"
        from="voice-agent.tasks"
        to="road-agent.tasks"
        label={"accept + refine\nRoad Task"}
      />
      <Line
        id="speak"
        className="decision-flow"
        from="road-agent.speech"
        to="voice-agent.speech"
      >
        <Segment via="speak-now" />
      </Line>
      <Line
        id="progress"
        className="progress"
        from="road-agent.progress"
        to="voice-agent.progress"
        label={"progress +\nstructured result"}
      />
      <Line
        id="local-memory"
        className="knowledge"
        from="road-agent.local-context"
        to="knowledge/local-context.harness"
        heads="both"
      />
      <Line
        id="live-knowledge"
        className="knowledge"
        from="road-agent.road-knowledge"
        to="knowledge/road-knowledge.harness"
        heads="both"
      />
    </Scope>
  );
}

function UserOwnedAgents() {
  return (
    <Scope
      id="user-owned"
      label="User-owned agents"
      role="remote-agents"
      layout={{ kind: "column", gap: "large" }}
    >
      <Text role="caption">private travel memory,</Text>
      <Text role="caption">wiki, bookings &amp; research</Text>

      <Node id="travel-agent" role="named-agent">
        <Text role="heading">Named travel agent</Text>
        <Text role="heading">situated delegation</Text>
        <Port id="request" side="left" />
        <Port
          id="tools"
          side="bottom"
          cardinality="many"
          sharing={{ mode: "merge", branch: { preference: "late" } }}
        />
      </Node>

      <Node id="openclaw" role="agent-tool">
        <Text>OpenClaw</Text>
        <Text>Gateway</Text>
        <Text>/v1/responses</Text>
        <Port id="request" side="left" />
      </Node>
      <Node id="hermes-webui" role="agent-tool">
        <Text>Hermes WebUI</Text>
        <Text>background task API</Text>
        <Port id="request" side="left" />
      </Node>
      <Node id="hermes-api" role="agent-tool">
        <Text>Hermes Agent API</Text>
        <Text>stateful runs /</Text>
        <Text>responses</Text>
        <Port id="request" side="left" />
      </Node>

      {/* the named tools port joins the fan-out into one trunk in this
          component's own left padding band and branches late */}
      {[
        ["openclaw", "openclaw.request"],
        ["hermes-webui", "hermes-webui.request"],
        ["hermes-api", "hermes-api.request"],
      ].map(([id, target]) => (
        <Line
          key={id}
          id={`to-${id}`}
          className="delegation"
          from="travel-agent.tools"
          to={target}
        >
          <Segment through={padding(self, "left")} />
        </Line>
      ))}
    </Scope>
  );
}

export default (
  <Diagram id="vegvisir-voice-agents" theme="excalidraw-handdrawn" styles={styles}>
    <Title>Vegvísir — one voice, multiple agents</Title>
    <Subtitle>
      A voice-first road companion that stays responsive while deeper work happens in the background
    </Subtitle>

    <Row id="system" align="center" gap="xlarge">
      <Driver />
      <Phone />
      <UserOwnedAgents />
    </Row>

    <Line
      id="driver-conversation"
      className="voice"
      from="system/driver-column/driver.voice"
      to="system/phone/voice-agent.driver"
      heads="both"
    />

    {/* climbs out of the phone, runs through the whitespace between the
        containers, and carries its label along that run */}
    <Line
      id="remote-delegation"
      className="delegation"
      from="system/phone/road-agent.remote"
      to="system/user-owned/travel-agent.request"
    >
      <Segment
        through={gap("system/phone", "system/user-owned")}
        label="drive context + exact request"
        labelOrientation="along"
      />
    </Line>
  </Diagram>
);
