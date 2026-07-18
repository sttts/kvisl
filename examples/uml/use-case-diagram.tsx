// Pre-implementation UML grammar example. Actors and the system boundary are
// ordinary components; include and extend are styled dependencies.

import { Column, Diagram, Grid, Scope, Title } from "@kvisl/core";
import { UmlActor, UmlRelation, UmlUseCase, umlStyles } from "./uml";

export default (
  <Diagram id="uml-use-case-example" theme="uml" styles={umlStyles}>
    <Title>Online store — use-case diagram</Title>

    <Grid id="scene" columns={3} gap="large" order="fixed">
      <Column id="primary-actors" gap="large">
        <UmlActor id="customer" name="Customer" />
        <UmlActor id="support" name="Support Agent" />
      </Column>

      <Scope id="store" role="uml-system-boundary" label="Online Store">
        <Grid id="cases" columns={2} gap={160}>
          <UmlUseCase id="browse" name="Browse catalog" />
          <UmlUseCase id="authenticate" name="Authenticate customer" />
          <UmlUseCase id="checkout" name="Checkout" />
          <UmlUseCase id="pay" name="Process payment" />
          <UmlUseCase id="refund" name="Refund order" />
          <UmlUseCase id="notify" name="Send notification" />
        </Grid>

        {/* the «include» / «extend» keywords derive from the relation kind */}
        <UmlRelation id="checkout-auth" kind="include" from="cases/checkout" to="cases/authenticate" />
        <UmlRelation id="checkout-pay" kind="include" from="cases/checkout" to="cases/pay" />
        <UmlRelation id="refund-notify" kind="include" from="cases/refund" to="cases/notify" />
        <UmlRelation id="refund-checkout" kind="extend" from="cases/refund" to="cases/checkout" guard="paid" />
      </Scope>

      <Column id="secondary-actors" gap="large">
        <UmlActor id="payment-provider" name="Payment Provider" />
        <UmlActor id="mail-service" name="Mail Service" />
      </Column>
    </Grid>

    <UmlRelation id="customer-browse" kind="association" from="scene/primary-actors/customer" to="scene/store/cases/browse" />
    <UmlRelation id="customer-checkout" kind="association" from="scene/primary-actors/customer" to="scene/store/cases/checkout" />
    <UmlRelation id="support-refund" kind="association" from="scene/primary-actors/support" to="scene/store/cases/refund" />
    <UmlRelation id="provider-pay" kind="association" from="scene/secondary-actors/payment-provider" to="scene/store/cases/pay" />
    <UmlRelation id="mail-notify" kind="association" from="scene/secondary-actors/mail-service" to="scene/store/cases/notify" />
  </Diagram>
);
