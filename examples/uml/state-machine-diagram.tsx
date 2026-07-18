// Pre-implementation UML grammar example. A composite state owns its nested
// state machine while transitions may cross that boundary.

import { Column, Diagram, Row, Title } from "@kvisl/core";
import { UmlPseudostate, UmlRelation, UmlState, umlStyles } from "./uml";

export default (
  <Diagram id="uml-state-machine-example" theme="uml" styles={umlStyles} gap={80}>
    <Title>Order lifecycle — state-machine diagram</Title>

    <Column id="states" gap="large">
      <Row id="top" gap="large" align="start">
        <UmlPseudostate id="initial" kind="initial" />
        <UmlState id="draft" name="Draft" entry="create basket" />
        <UmlState id="submitted" name="Submitted" entry="freeze prices" />
      </Row>

      <Row id="outcomes" gap="large" align="start">
        <UmlState id="processing" name="Processing" doActivity="coordinate payment and inventory">
          <UmlPseudostate id="history" kind="history" />
          <UmlState id="authorizing" name="Authorizing payment" />
          <UmlState id="reserving" name="Reserving inventory" />
          <UmlPseudostate id="complete" kind="final" />

          <UmlRelation id="history-authorizing" kind="transition" from="history" to="authorizing" />
          <UmlRelation id="authorizing-reserving" kind="transition" from="authorizing" to="reserving" name="authorized" />
          <UmlRelation id="reserving-complete" kind="transition" from="reserving" to="complete" name="reserved" />
        </UmlState>

        <UmlState id="fulfilled" name="Fulfilled" entry="emit OrderFulfilled" />
        <UmlState id="cancelled" name="Cancelled" entry="release reservations" />
      </Row>

      <Row id="end" distribute="center">
        <UmlPseudostate id="final" kind="final" />
      </Row>
    </Column>

    <UmlRelation id="begin" kind="transition" from="states/top/initial" to="states/top/draft" />
    <UmlRelation id="submit" kind="transition" from="states/top/draft" to="states/top/submitted" name="submit" guard="basket not empty" />
    <UmlRelation id="process" kind="transition" from="states/top/submitted" to="states/outcomes/processing/history" name="paymentRequested" />
    <UmlRelation id="fulfil" kind="transition" from="states/outcomes/processing/complete" to="states/outcomes/fulfilled" name="processingComplete" />
    <UmlRelation id="cancel-submitted" kind="transition" from="states/top/submitted" to="states/outcomes/cancelled" name="cancel" />
    <UmlRelation id="cancel-processing" kind="transition" from="states/outcomes/processing" to="states/outcomes/cancelled" name="cancel" />
    <UmlRelation id="finish-fulfilled" kind="transition" from="states/outcomes/fulfilled" to="states/end/final" />
    <UmlRelation id="finish-cancelled" kind="transition" from="states/outcomes/cancelled" to="states/end/final" />
  </Diagram>
);
