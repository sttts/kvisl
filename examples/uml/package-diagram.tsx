// Pre-implementation UML grammar example. Package dependencies cross nested
// containment without flattening package identity.

import { Diagram, Grid, Title } from "@kvisl/core";
import { UmlClass, UmlPackage, UmlRelation, umlStyles } from "./uml";

export default (
  <Diagram id="uml-package-example" theme="uml" styles={umlStyles}>
    <Title>Commerce modules — package diagram</Title>

    <Grid id="packages" columns={2} gap="large" order="prefer-source">
      <UmlPackage id="checkout" name="checkout">
        <UmlClass id="service" name="CheckoutService" />
        <UmlPackage id="application" name="application">
          <UmlClass id="command" name="PlaceOrder" />
        </UmlPackage>
      </UmlPackage>

      <UmlPackage id="inventory" name="inventory">
        <UmlClass id="api" name="InventoryApi" stereotype="interface" />
      </UmlPackage>

      <UmlPackage id="payments" name="payments">
        <UmlClass id="api" name="PaymentApi" stereotype="interface" />
      </UmlPackage>

      <UmlPackage id="shared-kernel" name="shared-kernel">
        <UmlClass id="money" name="Money" />
      </UmlPackage>
    </Grid>

    {/* keywords are structured; the theme renders the guillemets */}
    <UmlRelation id="checkout-inventory" kind="dependency" from="packages/checkout" to="packages/inventory" keyword="import" />
    <UmlRelation id="checkout-payments" kind="dependency" from="packages/checkout" to="packages/payments" keyword="access" />
    <UmlRelation id="checkout-shared" kind="dependency" from="packages/checkout" to="packages/shared-kernel" keyword="import" />
    <UmlRelation id="payments-shared" kind="dependency" from="packages/payments" to="packages/shared-kernel" keyword="merge" />
  </Diagram>
);
