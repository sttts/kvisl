// Pre-implementation UML grammar example. Components are ordinary reusable
// TSX components exposing named ports.

import { Diagram, Row, Scope, Title } from "@kvisl/core";
import { UmlComponent, UmlRelation, umlStyles } from "./uml";

const provided = { kind: "extension", namespace: "uml", name: "provided-interface" } as const;
const required = { kind: "extension", namespace: "uml", name: "required-interface" } as const;

export default (
  <Diagram id="uml-component-example" theme="uml" styles={umlStyles}>
    <Title>Checkout service — component diagram</Title>

    <Scope id="checkout-system" role="uml-component-boundary" label="Checkout System">
      <Row id="components" gap="large" order="prefer-source">
        <UmlComponent id="web" name="Checkout UI" ports={[{ id: "checkout", side: "right", marker: required }]} />
        <UmlComponent
          id="checkout"
          name="Checkout Service"
          ports={[
            { id: "http", side: "left", marker: provided },
            { id: "inventory", side: "right", marker: required },
            { id: "payment", side: "right", marker: required },
          ]}
        />
        <UmlComponent id="inventory" name="Inventory Service" ports={[{ id: "api", side: "left", marker: provided }]} />
        <UmlComponent id="payment" name="Payment Adapter" ports={[{ id: "api", side: "left", marker: provided }]} />
      </Row>

      <UmlRelation id="web-checkout" kind="association" from="components/web.checkout" to="components/checkout.http" />
      <UmlRelation id="checkout-inventory" kind="association" from="components/checkout.inventory" to="components/inventory.api" />
      <UmlRelation id="checkout-payment" kind="association" from="components/checkout.payment" to="components/payment.api" />
      <UmlRelation id="payment-sdk" kind="dependency" from="components/payment" to="stripe-sdk" name="uses" />

      <UmlComponent id="stripe-sdk" name="Stripe SDK" stereotype="library" />
    </Scope>
  </Diagram>
);
