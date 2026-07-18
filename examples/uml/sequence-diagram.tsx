// Pre-implementation UML grammar example. JSX order inside Interaction is the
// temporal order. The library derives occurrences, alignments, activations,
// and fragment frames from the messages; the core never models time.

import { Diagram, Title } from "@kvisl/core";
import { Interaction, Lifeline, Loop, Message, Reply, umlStyles } from "./uml";

export default (
  <Diagram id="uml-sequence-example" theme="uml" styles={umlStyles}>
    <Title>Place an order — sequence diagram</Title>

    <Interaction id="checkout-flow">
      {/* the same subject as the Customer class in the class diagram */}
      <Lifeline
        id="customer"
        name="customer"
        classifier="Customer"
        subject={{ namespace: "uml", id: "sales/Customer" }}
      />
      <Lifeline
        id="checkout"
        name="checkout"
        classifier="CheckoutService"
        activations={[{ id: "handling", from: "submit", to: "confirmation" }]}
      />
      <Lifeline
        id="inventory"
        name="inventory"
        classifier="InventoryService"
        activations={[{ id: "reserving", from: "reserve", to: "reserved" }]}
      />
      <Lifeline
        id="payment"
        name="payment"
        classifier="PaymentProvider"
        activations={[{ id: "authorizing", from: "authorize", to: "authorized" }]}
      />

      <Message id="submit" from="customer" to="checkout" call="submit(order)" />
      <Message id="reserve" from="checkout" to="inventory" call="reserve(items)" />
      <Reply id="reserved" from="inventory" to="checkout" value="reservation" />
      <Message id="authorize" from="checkout" to="payment" call="authorize(total)" />

      <Loop id="payment-retry" guard="pending and attempts < 3">
        <Message id="poll" from="checkout" to="payment" call="status()" />
        <Reply id="pending" from="payment" to="checkout" value="pending" />
      </Loop>

      <Reply id="authorized" from="payment" to="checkout" value="authorized" />
      <Reply id="confirmation" from="checkout" to="customer" value="confirmation" />
    </Interaction>
  </Diagram>
);
