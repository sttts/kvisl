// Pre-implementation UML component library. It demonstrates how UML notation
// composes from the Kvísl core; it is not a runtime implementation.

import {
  Compartment,
  Constraint,
  End,
  Line,
  Node,
  Port,
  Row,
  Scope,
  Text,
  role,
  rule,
} from "@kvisl/core";

type Child = unknown;
type Endpoint = string;
type Visibility = "+" | "-" | "#" | "~";
type Marker =
  | "none"
  | "circle"
  | "square"
  | "diamond"
  | { kind: "extension"; namespace: string; name: string };

function asArray<T>(value: T | readonly T[] | null | undefined): readonly T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value as T];
}

export type UmlFeature = {
  visibility?: Visibility;
  text: string;
};

export type UmlSlot = {
  name: string;
  value: string;
};

type RelationKind =
  | "association"
  | "directed-association"
  | "generalization"
  | "realization"
  | "dependency"
  | "include"
  | "extend"
  | "transition";

const hollowTriangle = { kind: "extension", namespace: "uml", name: "hollow-triangle" } as const;
const hollowDiamond = { kind: "extension", namespace: "uml", name: "hollow-diamond" } as const;
const filledDiamond = { kind: "extension", namespace: "uml", name: "filled-diamond" } as const;

// Library-layer stylesheet: UML notation presentation keyed by roles. A theme
// or document layer can override any of it without touching the components.
export const umlStyles = [
  rule(role("uml-dependency"), { dash: "dashed" }),
  rule(role("uml-realization"), { dash: "dashed" }),
  rule(role("uml-include"), { dash: "dashed" }),
  rule(role("uml-extend"), { dash: "dashed" }),
  rule(role("uml-reply"), { dash: "dashed" }),
  rule(role("uml-lifeline-spine"), { dash: "dashed" }),
  rule(role("uml-activation"), { fill: "near-white" }),
  rule(role("uml-combined-fragment"), { fill: "transparent", stroke: "ink", strokeWidth: 2 }),
];

function featureText(feature: UmlFeature) {
  return `${feature.visibility ?? ""}${feature.visibility ? " " : ""}${feature.text}`;
}

// Stereotype names are structured values; the theme renders the guillemets.
function Stereotype({ name }: { name: string }) {
  return <Text role="uml-stereotype">{name}</Text>;
}

export function UmlClass({
  id,
  name,
  subject,
  stereotype,
  attributes = [],
  operations = [],
  abstract = false,
  ports = [],
}: {
  id: string;
  name: string;
  subject?: { namespace: string; id: string };
  stereotype?: string;
  attributes?: readonly UmlFeature[];
  operations?: readonly UmlFeature[];
  abstract?: boolean;
  ports?: readonly { id: string; side?: "top" | "right" | "bottom" | "left" }[];
}) {
  return (
    <Node
      id={id}
      role="uml-class"
      shape="rectangle"
      subject={subject}
      className={abstract ? "abstract" : undefined}
    >
      {stereotype ? <Stereotype name={stereotype} /> : null}
      <Text role="uml-class-name">{name}</Text>
      <Compartment role="attributes">
        {attributes.map((attribute) => (
          <Text key={attribute.text} role="uml-attribute">{featureText(attribute)}</Text>
        ))}
      </Compartment>
      <Compartment role="operations">
        {operations.map((operation) => (
          <Text key={operation.text} role="uml-operation">{featureText(operation)}</Text>
        ))}
      </Compartment>
      {ports.map((port) => <Port key={port.id} id={port.id} side={port.side ?? "right"} />)}
    </Node>
  );
}

export function UmlObject({
  id,
  name,
  classifier,
  subject,
  slots = [],
}: {
  id: string;
  name: string;
  classifier: string;
  subject?: { namespace: string; id: string };
  slots?: readonly UmlSlot[];
}) {
  return (
    <Node id={id} role="uml-object" shape="rectangle" subject={subject}>
      <Text role="uml-instance-name">{`${name}: ${classifier}`}</Text>
      <Compartment role="slots">
        {slots.map((slot) => (
          <Text key={slot.name} role="uml-slot">{`${slot.name} = ${slot.value}`}</Text>
        ))}
      </Compartment>
    </Node>
  );
}

export function UmlComponent({
  id,
  name,
  stereotype,
  subject,
  ports = [],
}: {
  id: string;
  name: string;
  stereotype?: string;
  subject?: { namespace: string; id: string };
  ports?: readonly {
    id: string;
    side: "top" | "right" | "bottom" | "left";
    marker?: Marker;
  }[];
}) {
  return (
    <Node id={id} role="uml-component" shape="uml:component" subject={subject}>
      {stereotype ? <Stereotype name={stereotype} /> : null}
      <Text>{name}</Text>
      {ports.map((port) => <Port key={port.id} id={port.id} side={port.side} marker={port.marker ?? "square"} />)}
    </Node>
  );
}

export function UmlArtifact({ id, name, subject }: { id: string; name: string; subject?: { namespace: string; id: string } }) {
  return (
    <Node id={id} role="uml-artifact" shape="uml:artifact" subject={subject}>
      <Stereotype name="artifact" />
      <Text>{name}</Text>
    </Node>
  );
}

export function UmlPackage({
  id,
  name,
  children,
}: {
  id: string;
  name: string;
  children?: Child;
}) {
  return (
    <Scope id={id} role="uml-package" label={name} shape="uml:package">
      {children}
    </Scope>
  );
}

export function UmlDeploymentNode({
  id,
  name,
  stereotype = "node",
  children,
}: {
  id: string;
  name: string;
  stereotype?: "device" | "executionEnvironment" | "node";
  children?: Child;
}) {
  // the theme derives the «stereotype» prefix of the boundary label from the class
  return (
    <Scope id={id} role="uml-deployment-node" className={stereotype} label={name} shape="uml:node-3d">
      {children}
    </Scope>
  );
}

export function UmlActor({ id, name }: { id: string; name: string }) {
  return (
    <Node id={id} role="uml-actor" shape="uml:actor">
      <Text>{name}</Text>
    </Node>
  );
}

export function UmlUseCase({ id, name }: { id: string; name: string }) {
  return (
    <Node id={id} role="uml-use-case" shape="ellipse">
      <Text>{name}</Text>
    </Node>
  );
}

export function UmlState({
  id,
  name,
  entry,
  doActivity,
  exit,
  children,
}: {
  id: string;
  name: string;
  entry?: string;
  doActivity?: string;
  exit?: string;
  children?: Child;
}) {
  return (
    <Scope id={id} role="uml-state" label={name} shape="rounded-rectangle">
      {entry ? <Text role="uml-state-behavior">{`entry / ${entry}`}</Text> : null}
      {doActivity ? <Text role="uml-state-behavior">{`do / ${doActivity}`}</Text> : null}
      {exit ? <Text role="uml-state-behavior">{`exit / ${exit}`}</Text> : null}
      {children}
    </Scope>
  );
}

export function UmlPseudostate({
  id,
  kind,
}: {
  id: string;
  kind: "initial" | "final" | "choice" | "junction" | "history" | "deep-history" | "fork" | "join";
}) {
  return <Node id={id} role={`uml-${kind}`} shape={`uml:${kind}`} />;
}

export function UmlAction({ id, name }: { id: string; name: string }) {
  return (
    <Node id={id} role="uml-action" shape="rounded-rectangle">
      <Text>{name}</Text>
    </Node>
  );
}

export function UmlActivityPartition({
  id,
  name,
  children,
}: {
  id: string;
  name: string;
  children?: Child;
}) {
  return (
    <Scope id={id} role="uml-activity-partition" label={name} layout={{ kind: "column" }}>
      {children}
    </Scope>
  );
}

// ---------------------------------------------------------------------------
// Relationships
// ---------------------------------------------------------------------------

// One adorned association end, built on the core structured-End grammar.
export function UmlEnd({
  ref,
  role,
  multiplicity,
  aggregation,
  navigable,
}: {
  ref: Endpoint;
  role?: string;
  multiplicity?: string;
  aggregation?: "shared" | "composite";
  navigable?: boolean;
}) {
  const head =
    aggregation === "shared" ? hollowDiamond
    : aggregation === "composite" ? filledDiamond
    : navigable ? "open-arrow"
    : "none";
  const labels = [
    ...(role ? [{ text: role, role: "role" }] : []),
    ...(multiplicity ? [{ text: multiplicity, role: "multiplicity" }] : []),
  ];
  return <End ref={ref} head={head} labels={labels} />;
}

// An association with adorned ends: exactly two UmlEnd children, optionally
// with pinned segments between them.
export function UmlAssociation({
  id,
  name,
  children,
}: {
  id: string;
  name?: string;
  children?: Child;
}) {
  return (
    <Line
      id={id}
      role="uml-association"
      labels={name ? [{ text: name, placement: "center", role: "name" }] : []}
    >
      {children}
    </Line>
  );
}

// Unadorned relationships: kind selects heads, dash, and the derived keyword.
export function UmlRelation({
  id,
  kind,
  from,
  to,
  name,
  keyword,
  guard,
}: {
  id: string;
  kind: RelationKind;
  from: Endpoint;
  to: Endpoint;
  name?: string;
  keyword?: string; // «keyword» rendered by the theme, e.g. import, access, merge, deploy
  guard?: string;
}) {
  const heads = (() => {
    switch (kind) {
      case "generalization":
      case "realization": return ["none", hollowTriangle] as const;
      case "dependency":
      case "include":
      case "extend":
      case "transition":
      case "directed-association": return ["none", "open-arrow"] as const;
      default: return ["none", "none"] as const;
    }
  })();

  const derivedKeyword =
    keyword ?? (kind === "include" ? "include" : kind === "extend" ? "extend" : undefined);
  const labels = [
    ...(derivedKeyword ? [{ text: derivedKeyword, placement: "center", role: "uml-keyword" }] : []),
    ...(name ? [{ text: name, placement: "center", role: "name" }] : []),
    ...(guard ? [{ text: `[${guard}]`, placement: "center", role: "guard" }] : []),
  ];

  // dash styling comes from umlStyles rules keyed by the role
  return (
    <Line
      id={id}
      role={`uml-${kind}`}
      from={from}
      to={to}
      heads={heads}
      labels={labels}
    />
  );
}

// ---------------------------------------------------------------------------
// Interactions (sequence diagrams)
//
// Lifeline, Message, Reply, and Fragment components evaluate to typed step
// declarations rather than diagram entities. Interaction consumes its children
// as data (the children-as-data protocol under grammar design) and expands
// them into occurrences, message lines, activations, and constraints. JSX
// source order inside Interaction is a hard temporal order. Time is a library
// concept; the core sees only elements, lines, and constraints.
// ---------------------------------------------------------------------------

export type LifelineDecl = {
  step: "lifeline";
  id: string;
  name: string;
  classifier?: string;
  subject?: { namespace: string; id: string };
  // activation bars: from the occurrence of one message to another
  activations?: readonly { id: string; from: string; to: string }[];
};

export type MessageDecl = {
  step: "message" | "reply";
  id: string;
  from: string; // lifeline id
  to: string;   // lifeline id
  text: string;
};

export type FragmentDecl = {
  step: "fragment";
  id: string;
  operator: "loop" | "opt" | "alt" | "par";
  guard?: string;
  steps: readonly InteractionStep[];
};

export type InteractionStep = MessageDecl | FragmentDecl;
type InteractionChild = LifelineDecl | InteractionStep;

export function Lifeline(props: Omit<LifelineDecl, "step">): LifelineDecl {
  return { step: "lifeline", ...props };
}

export function Message(props: { id: string; from: string; to: string; call: string }): MessageDecl {
  return { step: "message", id: props.id, from: props.from, to: props.to, text: props.call };
}

export function Reply(props: { id: string; from: string; to: string; value: string }): MessageDecl {
  return { step: "reply", id: props.id, from: props.from, to: props.to, text: props.value };
}

export function Loop(props: { id: string; guard?: string; children?: InteractionStep | readonly InteractionStep[] }): FragmentDecl {
  return {
    step: "fragment",
    id: props.id,
    operator: "loop",
    guard: props.guard,
    steps: asArray(props.children),
  };
}

// depth-first message order = temporal order
function linearize(steps: readonly InteractionStep[]): readonly MessageDecl[] {
  return steps.flatMap((s) => (s.step === "fragment" ? linearize(s.steps) : [s]));
}

export function Interaction({
  id,
  children,
}: {
  id: string;
  children?: InteractionChild | readonly InteractionChild[];
}) {
  const decls = asArray(children);
  const lifelines = decls.filter((d): d is LifelineDecl => d.step === "lifeline");
  const steps = decls.filter((d): d is InteractionStep => d.step !== "lifeline");
  const messages = linearize(steps);
  const fragments = steps.filter((s): s is FragmentDecl => s.step === "fragment");

  // each lifeline gets only the occurrences of the messages it participates in
  const occurrences = (l: LifelineDecl) =>
    messages.filter((m) => m.from === l.id || m.to === l.id);
  const occ = (lifeline: string, message: string) => `lifelines/${lifeline}/${message}`;

  return (
    <Scope id={id} role="uml-interaction">
      <Row id="lifelines" gap="large" order="fixed" align="start">
        {lifelines.map((l) => (
          <Scope
            key={l.id}
            id={l.id}
            role="uml-lifeline"
            subject={l.subject}
            layout={{ kind: "column", order: "fixed" }}
          >
            <Node id="head" role="uml-lifeline-head" shape="rectangle">
              <Text role="uml-instance-name">
                {l.classifier ? `${l.name}: ${l.classifier}` : l.name}
              </Text>
            </Node>
            {occurrences(l).map((m) => (
              <Node key={m.id} id={m.id} role="uml-occurrence" shape="uml:occurrence" />
            ))}
            <Node id="end" role="uml-lifeline-end" shape="uml:occurrence" />
            <Line
              id="spine"
              role="uml-lifeline-spine"
              from="head"
              to="end"
              heads="none"
              space="overlay"
            />
            {(l.activations ?? []).flatMap((a) => [
              <Node key={a.id} id={a.id} role="uml-activation" shape="rectangle" />,
              <Constraint
                key={`${a.id}-extent`}
                id={`${a.id}-extent`}
                kind="extent"
                item={a.id}
                axis="vertical"
                from={a.from}
                to={a.to}
                strength="required"
              />,
            ])}
          </Scope>
        ))}
      </Row>

      {/* one message line plus one row alignment per message */}
      {messages.flatMap((m, i) => [
        <Line
          key={m.id}
          id={m.id}
          role={m.step === "reply" ? "uml-reply" : "uml-message"}
          from={occ(m.from, m.id)}
          to={occ(m.to, m.id)}
          labels={[
            { text: `${i + 1}`, placement: "start", role: "sequence" },
            { text: m.text, placement: "center", role: "name" },
          ]}
        />,
        <Constraint
          key={`${m.id}-row`}
          id={`${m.id}-row`}
          kind="align"
          edge="center-vertical"
          members={[occ(m.from, m.id), occ(m.to, m.id)]}
          strength="required"
        />,
      ])}

      {/* JSX order is the temporal order: chain consecutive messages */}
      {messages.slice(1).map((m, i) => (
        <Constraint
          key={`${m.id}-after`}
          id={`${m.id}-after`}
          kind="below"
          item={occ(m.from, m.id)}
          reference={occ(messages[i].from, messages[i].id)}
          strength="required"
        />
      ))}

      {/* combined fragments frame the occurrences of their nested messages */}
      {fragments.flatMap((f) => [
        <Scope
          key={f.id}
          id={f.id}
          role="uml-combined-fragment"
          label={f.guard ? `${f.operator} [${f.guard}]` : f.operator}
          shape="rectangle"
        />,
        <Constraint
          key={`${f.id}-frame`}
          id={`${f.id}-frame`}
          kind="inside"
          container={f.id}
          members={linearize(f.steps).flatMap((m) => [occ(m.from, m.id), occ(m.to, m.id)])}
          strength="required"
        />,
      ])}
    </Scope>
  );
}
