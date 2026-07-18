// Pre-implementation grammar fixture. This file specifies the intended
// authoring model and is not expected to compile until the core API exists.
// Views are ordered first-fit alternatives; presentation lives in
// document-layer rules keyed by roles and classes.

import {
  Column,
  Corridor,
  Diagram,
  Grid,
  Legend,
  LegendItem,
  Line,
  Node,
  Note,
  Port,
  PortPlacement,
  Row,
  Scope,
  Segment,
  Subtitle,
  Text,
  Title,
  View,
  When,
  cls,
  context,
  eq,
  gap,
  gte,
  role,
  rule,
} from "@kvisl/core";

const baseStyles = [
  rule(role("serving-cluster"), { fill: "near-white", stroke: "structural-gray" }),
  rule(role("control-plane"), { fill: "near-white", stroke: "structural-gray" }),
  rule(role("inference-fleet"), { fill: "near-white", stroke: "structural-gray" }),
  rule(role("external-actor"), { stroke: "structural-gray" }),
  rule(role("ml-api"), { stroke: "ml-green" }),
  rule(role("platform-api"), { stroke: "platform-blue" }),
  rule(role("composition"), { stroke: "composition-yellow" }),
  rule(role("reconcile-output"), { stroke: "composition-yellow" }),
  rule(role("fleet-scheduler"), { stroke: "reconcile-orange" }),
  rule(role("inference-gateway"), { stroke: "request-purple" }),
  rule(role("serving-stack"), { stroke: "platform-blue" }),
  rule(role("model-replica"), { stroke: "reconcile-orange" }),
  rule(role("model-cache"), { stroke: "ml-green" }),
  rule(role("cluster-edge"), { stroke: "request-purple" }),
  rule(role("serving-cluster-summary"), { stroke: "request-purple" }),
  rule(role("status"), { stroke: "structural-gray" }),
  rule(role("external-endpoint"), { stroke: "external-pink" }),
  rule(role("locality"), { stroke: "locality-cyan" }),
  rule(role("stub"), { stroke: "reconcile-orange", dash: "dashed" }),
  rule(role("client"), { stroke: "request-purple" }),
  rule(role("implementation-status"), { stroke: "structural-gray" }),
  rule(cls("ml-intent"), { stroke: "ml-green" }),
  rule(cls("platform-intent"), { stroke: "platform-blue" }),
  rule(cls("reconcile"), { stroke: "reconcile-orange" }),
  rule(cls("request"), { stroke: "request-purple" }),
  rule(cls("cache"), { stroke: "ml-green" }),
  rule(cls("locality"), { stroke: "locality-cyan" }),
  // media-query analog: print targets get heavier boundaries
  rule(role("serving-cluster"), { strokeWidth: 2 }, eq(context("medium"), "print")),
];

type ClusterProps = {
  id: string;
  label: string;
  serving: readonly string[];
  replica: readonly string[];
  edge: readonly string[];
  withCache?: boolean;
  withObservedStatus?: boolean;
  withLocalityNote?: boolean;
};

function TextLines({ values }: { values: readonly string[] }) {
  return <>{values.map((value) => <Text key={value}>{value}</Text>)}</>;
}

function Cluster({
  id,
  label,
  serving,
  replica,
  edge,
  withCache,
  withObservedStatus,
  withLocalityNote,
}: ClusterProps) {
  return (
    <Scope
      id={id}
      label={label}
      role="serving-cluster"
      layout={{ kind: "column", gap: "medium" }}
    >
      <Port id="placement" side="top" />
      <Port id="request" side="right" />

      {/* declaration order is preference order: first viable view wins */}
      <View
        id="internals"
        detail={2}
        requires={gte(context("allocation.inlineSize"), 70)}
        footprint={{ minWidth: 100, minHeight: 70 }}
      >
        <Grid id="serving-grid" columns={2} gap="medium">
          <Node id="serving-stack" role="serving-stack">
            <TextLines values={serving} />
            <Port id="replica" side="right" />
          </Node>

          <Node id="model-replica" role="model-replica">
            <TextLines values={replica} />
            <Port id="stack" side="left" />
            <Port id="edge" side="bottom" />
          </Node>

          {withCache ? (
            <Node id="model-cache" role="model-cache">
              <Text>ModelCache</Text>
              <Text>Hugging Face →</Text>
              <Text>RWX PVC</Text>
              <Text>job + claim</Text>
              <Port id="replica" side="right" />
            </Node>
          ) : withObservedStatus ? (
            <Node id="observed-status" role="status">
              <Text>Observed status</Text>
              <Text>gpuPools / labels</Text>
              <Text>coarse capacity</Text>
            </Node>
          ) : null}

          <Node id="cluster-edge" role="cluster-edge">
            <TextLines values={edge} />
            <Port id="replica" side="top" />
          </Node>
        </Grid>

        <PortPlacement port="placement" on="serving-grid/model-replica" side="top" />
        <PortPlacement port="request" on="serving-grid/cluster-edge" side="right" />

        {withLocalityNote ? (
          <When id="locality-detail" test={gte(context("allocation.inlineSize"), 130)}>
            <Note id="locality" role="locality">
              KV locality: keep prefill/decode inside one cluster
            </Note>
            <Line
              id="edge-to-locality"
              className="locality"
              from="serving-grid/cluster-edge"
              to="locality"
            />
          </When>
        ) : null}

        <Line
          id="stack-to-replica"
          className="reconcile"
          from="serving-grid/serving-stack.replica"
          to="serving-grid/model-replica.stack"
        />
        {withCache ? (
          <Line
            id="cache-to-replica"
            className="cache"
            from="serving-grid/model-cache.replica"
            to="serving-grid/model-replica.stack"
          />
        ) : null}
        <Line
          id="replica-to-edge"
          className="request"
          from="serving-grid/model-replica.edge"
          to="serving-grid/cluster-edge.replica"
        />
      </View>

      <View id="overview" detail={0} footprint={{ minWidth: 35, minHeight: 20 }}>
        <Node id="summary" role="serving-cluster-summary">
          <Text>{label}</Text>
          <TextLines values={edge} />
        </Node>
        <PortPlacement port="placement" on="summary" side="top" />
        <PortPlacement port="request" on="summary" side="right" />
      </View>
    </Scope>
  );
}

function ControlPlane() {
  return (
    <Scope
      id="control-plane"
      role="control-plane"
      layout={{ kind: "column", gap: "medium" }}
    >
      <Note
        id="control-plane-label"
        placement={{ area: "inside", side: "top", align: "center" }}
        style={{ fill: "transparent", stroke: "transparent", color: "structural-gray", padding: 0 }}
      >
        Modelplane control plane (Crossplane v2)
      </Note>

      <Row id="control-flow" align="center" gap="large">
        <Node id="ml-apis" role="ml-api">
          <Text>ML APIs</Text>
          <Text>ModelDeployment</Text>
          <Text>ModelService</Text>
          <Port id="intent" side="top" />
          <Port id="platform" side="right" />
        </Node>
        <Node id="platform-apis" role="platform-api">
          <Text>Platform APIs</Text>
          <Text>InferenceGateway</Text>
          <Text>InferenceClass</Text>
          <Text>InferenceCluster</Text>
          <Text>ModelCache</Text>
          <Port id="team" side="top" />
          <Port id="ml" side="left" />
          <Port id="composition" side="right" />
        </Node>
        <Node id="composition" role="composition">
          <Text>Composition functions</Text>
          <Text>expand XRs</Text>
          <Text>render cluster resources</Text>
          <Text>observe remote status</Text>
          <Port id="platform" side="left" />
          <Port id="scheduler" side="right" />
          <Port id="outputs" side="bottom" />
        </Node>
        <Node id="scheduler" role="fleet-scheduler">
          <Text>Fleet scheduler</Text>
          <Text>label selectors</Text>
          <Text>coarse node-capacity gate</Text>
          <Text>spread by replica count</Text>
          <Text>pin ModelReplica</Text>
          <Port id="composition" side="left" />
          <Port id="gateway" side="right" />
          <Port
            id="placement"
            side="bottom"
            cardinality="many"
            sharing={{ mode: "merge", branch: { preference: "late" } }}
          />
        </Node>
        <Node id="gateway" role="inference-gateway">
          <Text>InferenceGateway</Text>
          <Text>Traefik today</Text>
          <Text>ModelService URLs</Text>
          <Text>OpenAI-compatible</Text>
          <Text>edge</Text>
          <Port id="scheduler" side="left" />
          <Port id="client" side="top" />
          <Port
            id="requests"
            side="bottom"
            cardinality="many"
            sharing={{ mode: "merge", branch: { preference: "late" } }}
          />
        </Node>
      </Row>

      <Node id="reconcile-outputs" role="reconcile-output">
        <Text>Reconcile outputs</Text>
        <Text>ModelDeployment → pinned ModelReplica + optional ModelEndpoint</Text>
        <Text>ModelService → equal-weight HTTPRoute fanout</Text>
        <Port id="composition" side="top" />
      </Node>

      <Line className="reconcile" from="control-flow/ml-apis.platform" to="control-flow/platform-apis.ml" />
      <Line className="reconcile" from="control-flow/platform-apis.composition" to="control-flow/composition.platform" />
      <Line className="reconcile" from="control-flow/composition.scheduler" to="control-flow/scheduler.composition" />
      <Line className="reconcile" from="control-flow/scheduler.gateway" to="control-flow/gateway.scheduler" />
      <Line className="reconcile" from="control-flow/composition.outputs" to="reconcile-outputs.composition" />
    </Scope>
  );
}

export function ModelplaneFleetInferenceDiagram({ styles = [] }) {
  return (
  <Diagram
    id="modelplane-fleet-inference"
    theme="excalidraw-handdrawn"
    styles={[...baseStyles, ...styles]}
  >
    <Title>Modelplane fleet inference architecture</Title>
    <Subtitle>
      Orange shows control-plane reconciliation; purple shows runtime inference routing.
    </Subtitle>

    <Legend id="legend" anchor="diagram" placement="inside-top-right" layout="column">
      <LegendItem className="reconcile">orange = reconcile / placement</LegendItem>
      <LegendItem className="request">purple = request path</LegendItem>
      <LegendItem style={{ stroke: "structural-gray", dash: "dashed" }}>
        dashed = design / stub / status
      </LegendItem>
    </Legend>

    <Row id="actors" distribute="space-between" align="end">
      <Row id="teams" gap="large">
        <Node id="ml-team" role="external-actor" className="ml-intent">
          <Text>ML team</Text>
          <Text>model + serving intent</Text>
          <Port id="control" side="bottom" />
        </Node>
        <Node id="platform-team" role="external-actor" className="platform-intent">
          <Text>Platform team</Text>
          <Text>cluster classes, gateways,</Text>
          <Text>cache</Text>
          <Port id="control" side="bottom" />
        </Node>
      </Row>
      <Node id="client" role="client">
        <Text>Client</Text>
        <Text>OpenAI-compatible</Text>
        <Text>API</Text>
        <Port id="request" side="bottom" />
      </Node>
    </Row>

    <ControlPlane />

    <Scope
      id="fleet"
      label="Inference fleet: per-cluster serving stacks and endpoint targets"
      role="inference-fleet"
      layout={{ kind: "row", align: "start", gap: "large" }}
    >
      <Cluster
        id="cluster-a"
        label="Cluster A / region 1"
        serving={["ServingStack", "Envoy/GAIE", "Prometheus, NFD,", "DRA"]}
        replica={["ModelReplica", "Deployment or", "LeaderWorkerSet", "engine container + flags"]}
        edge={["Cluster edge routing", "HTTPRoute → Service", "P/D: InferencePool + EPP"]}
        withCache
        withLocalityNote
      />
      <Cluster
        id="cluster-b"
        label="Cluster B / region 2"
        serving={["ServingStack", "Envoy/GAIE", "DRA + LWS"]}
        replica={["ModelReplica", "placed copy", "GPU claim"]}
        edge={["Cluster edge routing", "Gateway API resources", "service endpoint"]}
        withObservedStatus
      />

      <Column id="external-targets" gap="xlarge">
        <Node id="external-endpoint" role="external-endpoint">
          <Text>External ModelEndpoint</Text>
          <Text>manual endpoint target</Text>
          <Text>still routed via gateway</Text>
        </Node>
        <Note id="stubs" role="stub">
          Stubs exist for Dynamo / Grove / planner / router / workers; they may replace or encapsulate ServingStack + edge routing.
        </Note>
      </Column>
    </Scope>

    {/* the endpoint reference below creates this named port implicitly;
        this post-hoc declaration configures that same canonical port */}
    <Port
      ref="fleet/external-targets/external-endpoint.request"
      side="top"
    />

    {/* the whitespace between the two bands carries both buses as ordered
        corridors; declaration order stacks placement above request */}
    <Corridor id="placement-bus" in={gap("control-plane", "fleet")} pressure={0.9} />
    <Corridor id="request-bus" in={gap("control-plane", "fleet")} pressure={0.9} />

    {[
      ["cluster-a", "fleet/cluster-a.placement"],
      ["cluster-b", "fleet/cluster-b.placement"],
    ].map(([id, target]) => (
      <Line
        key={id}
        id={`place-${id}`}
        className="reconcile"
        from="control-plane/control-flow/scheduler.placement"
        to={target}
      >
        <Segment
          through="placement-bus"
          label={id === "cluster-a" ? "placement / reconcile" : undefined}
        />
      </Line>
    ))}

    {[
      ["cluster-a", "fleet/cluster-a.request"],
      ["cluster-b", "fleet/cluster-b.request"],
      ["external", "fleet/external-targets/external-endpoint.request"],
    ].map(([id, target]) => (
      <Line
        key={id}
        id={`request-${id}`}
        className="request"
        from="control-plane/control-flow/gateway.requests"
        to={target}
      >
        <Segment
          through="request-bus"
          label={id === "cluster-b" ? "request routing" : undefined}
        />
      </Line>
    ))}

    <Line className="reconcile" from="actors/teams/ml-team.control" to="control-plane/control-flow/ml-apis.intent" />
    <Line className="reconcile" from="actors/teams/platform-team.control" to="control-plane/control-flow/platform-apis.team" />
    <Line className="request" from="actors/client.request" to="control-plane/control-flow/gateway.client" />

    <Note id="footer" role="implementation-status">
      v0.1 implemented: GKE/EKS/BYO; Traefik control gateway; Envoy/GAIE workload gateways; Deployment/LWS; DRA; HF → RWX ModelCache. Early limits: equal-weight routing; no capacity scoring, anti-affinity policy, or transient failover. Design/stub: DynamoBackend, Grove / ModelExpress / DGD; one Modelplane API, no user-facing orchestrator switch.
    </Note>
  </Diagram>
  );
}

export default <ModelplaneFleetInferenceDiagram />;
