// Pre-implementation UML grammar example. Entity-only relationship ends
// deliberately exercise distinct line-owned docks.

import { Diagram, Row, Title } from "@kvisl/core";
import { UmlAssociation, UmlEnd, UmlObject, UmlRelation, umlStyles } from "./uml";

export default (
  <Diagram id="uml-object-example" theme="uml" styles={umlStyles}>
    <Title>One placed order — object diagram</Title>

    <Row id="instances" gap={96} order="prefer-source">
      <UmlObject
        id="alice"
        name="alice"
        classifier="Customer"
        slots={[
          { name: "id", value: "C-1042" },
          { name: "email", value: "alice@example.test" },
        ]}
      />
      <UmlObject
        id="order-4711"
        name="order4711"
        classifier="Order"
        slots={[
          { name: "number", value: "4711" },
          { name: "status", value: "paid" },
        ]}
      />
      <UmlObject
        id="line-1"
        name="line1"
        classifier="LineItem"
        slots={[
          { name: "quantity", value: "2" },
          { name: "unitPrice", value: "19.90 EUR" },
        ]}
      />
      <UmlObject
        id="payment-1"
        name="payment1"
        classifier="CreditCardPayment"
        slots={[{ name: "authorized", value: "true" }]}
      />
    </Row>

    <UmlRelation id="alice-order" kind="association" from="instances/alice" to="instances/order-4711" name="orders" />
    <UmlAssociation id="order-line" name="items">
      <UmlEnd ref="instances/order-4711" aggregation="composite" />
      <UmlEnd ref="instances/line-1" />
    </UmlAssociation>
    <UmlRelation id="order-payment" kind="association" from="instances/order-4711" to="instances/payment-1" name="payment" />
  </Diagram>
);
