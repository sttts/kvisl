// Pre-implementation UML grammar example. Activity partitions are scopes and
// control flows cross them with inferred hierarchy traversal.

import { Constraint, Diagram, Grid, Title } from "@kvisl/core";
import { UmlAction, UmlActivityPartition, UmlPseudostate, UmlRelation, umlStyles } from "./uml";

export default (
  <Diagram id="uml-activity-example" theme="uml" styles={umlStyles}>
    <Title>Fulfil an order — activity diagram</Title>

    <Grid id="partitions" columns={3} gap="large" order="fixed">
      <UmlActivityPartition id="customer" name="Customer">
        <UmlPseudostate id="start" kind="initial" />
        <UmlAction id="submit" name="Submit order" />
        <UmlAction id="correct" name="Correct payment details" />
        <UmlPseudostate id="end" kind="final" />
      </UmlActivityPartition>

      <UmlActivityPartition id="checkout" name="Checkout Service">
        <UmlAction id="validate" name="Validate order" />
        <UmlPseudostate id="valid" kind="choice" />
        <UmlAction id="authorize" name="Authorize payment" />
        <UmlPseudostate id="authorized" kind="choice" />
        <UmlPseudostate id="fork" kind="fork" />
        <UmlPseudostate id="join" kind="join" />
        <UmlAction id="confirm" name="Confirm order" />
      </UmlActivityPartition>

      <UmlActivityPartition id="fulfillment" name="Fulfillment">
        <UmlAction id="reserve" name="Reserve inventory" />
        <UmlAction id="prepare" name="Prepare shipment" />
      </UmlActivityPartition>
    </Grid>

    <Constraint
      id="equal-partition-heights"
      kind="same-size"
      dimension="height"
      members={["partitions/customer", "partitions/checkout", "partitions/fulfillment"]}
    />

    <UmlRelation id="start-submit" kind="transition" from="partitions/customer/start" to="partitions/customer/submit" />
    <UmlRelation id="submit-validate" kind="transition" from="partitions/customer/submit" to="partitions/checkout/validate" />
    <UmlRelation id="validate-choice" kind="transition" from="partitions/checkout/validate" to="partitions/checkout/valid" />
    <UmlRelation id="invalid-end" kind="transition" from="partitions/checkout/valid" to="partitions/customer/end" guard="invalid" />
    <UmlRelation id="valid-authorize" kind="transition" from="partitions/checkout/valid" to="partitions/checkout/authorize" guard="valid" />
    <UmlRelation id="authorize-choice" kind="transition" from="partitions/checkout/authorize" to="partitions/checkout/authorized" />
    <UmlRelation id="payment-retry" kind="transition" from="partitions/checkout/authorized" to="partitions/customer/correct" guard="declined" />
    <UmlRelation id="correct-authorize" kind="transition" from="partitions/customer/correct" to="partitions/checkout/authorize" />
    <UmlRelation id="authorized-fork" kind="transition" from="partitions/checkout/authorized" to="partitions/checkout/fork" guard="approved" />
    <UmlRelation id="fork-reserve" kind="transition" from="partitions/checkout/fork" to="partitions/fulfillment/reserve" />
    <UmlRelation id="fork-prepare" kind="transition" from="partitions/checkout/fork" to="partitions/fulfillment/prepare" />
    <UmlRelation id="reserve-join" kind="transition" from="partitions/fulfillment/reserve" to="partitions/checkout/join" />
    <UmlRelation id="prepare-join" kind="transition" from="partitions/fulfillment/prepare" to="partitions/checkout/join" />
    <UmlRelation id="join-confirm" kind="transition" from="partitions/checkout/join" to="partitions/checkout/confirm" />
    <UmlRelation id="confirm-end" kind="transition" from="partitions/checkout/confirm" to="partitions/customer/end" />
  </Diagram>
);
