// Pre-implementation UML grammar example. No absolute coordinates.
// Associations use structured ends; generalizations join at a named port and
// share one hollow-triangle trunk; ref() composition keeps deep paths short.

import { Diagram, Grid, Port, Title, ref } from "@kvisl/core";
import { UmlAssociation, UmlClass, UmlEnd, UmlPackage, UmlRelation, umlStyles } from "./uml";

const customer = ref("model/customer");
const order = ref("model/order");
const lineItem = ref("model/line-item");
const paymentMethod = ref("model/payment-method");

export default (
  <Diagram id="uml-class-example" theme="uml" styles={umlStyles}>
    <Title>Order domain — class diagram</Title>

    <UmlPackage id="sales" name="sales">
      <Grid id="model" columns={3} gap={96} order="prefer-source">
        <UmlClass
          id="customer"
          name="Customer"
          subject={{ namespace: "uml", id: "sales/Customer" }}
          attributes={[
            { visibility: "-", text: "id: CustomerId" },
            { visibility: "-", text: "email: Email" },
          ]}
          operations={[{ visibility: "+", text: "placeOrder(cart: Cart): Order" }]}
          ports={[
            { id: "orders", side: "right" },
            { id: "payments", side: "bottom" },
          ]}
        />

        <UmlClass
          id="order"
          name="Order"
          subject={{ namespace: "uml", id: "sales/Order" }}
          attributes={[
            { visibility: "-", text: "number: OrderNumber" },
            { visibility: "-", text: "status: OrderStatus" },
          ]}
          operations={[
            { visibility: "+", text: "add(item: Product, quantity: int)" },
            { visibility: "+", text: "total(): Money" },
          ]}
          ports={[
            { id: "customer", side: "left" },
            { id: "items", side: "right" },
            { id: "payment", side: "bottom" },
          ]}
        />

        <UmlClass
          id="line-item"
          name="LineItem"
          attributes={[
            { visibility: "-", text: "quantity: int" },
            { visibility: "-", text: "unitPrice: Money" },
          ]}
          ports={[{ id: "order", side: "left" }]}
        />

        <UmlClass id="payment-method" name="PaymentMethod" abstract />
        <UmlClass id="credit-card" name="CreditCardPayment" />
        <UmlClass id="paypal" name="PaypalPayment" />
        <UmlClass id="payment-authorizer" name="PaymentAuthorizer" stereotype="interface" />
        <UmlClass id="stripe-authorizer" name="StripeAuthorizer" />
        <UmlClass id="order-repository" name="OrderRepository" stereotype="interface" />
      </Grid>

      {/* both subclass arrows join at this port and share one triangle trunk */}
      <Port
        ref={paymentMethod.port("generalizations")}
        side="bottom"
        sharing={{ mode: "merge", branch: { preference: "late" } }}
      />

      <UmlAssociation id="customer-orders">
        <UmlEnd ref={customer.port("orders")} role="customer" multiplicity="1" />
        <UmlEnd ref={order.port("customer")} role="orders" multiplicity="0..*" />
      </UmlAssociation>

      <UmlAssociation id="order-items">
        <UmlEnd ref={order.port("items")} aggregation="composite" multiplicity="1" />
        <UmlEnd ref={lineItem.port("order")} multiplicity="1..*" />
      </UmlAssociation>

      <UmlAssociation id="customer-payment-methods">
        <UmlEnd ref={customer.port("payments")} aggregation="shared" multiplicity="1" />
        <UmlEnd ref={paymentMethod} multiplicity="0..*" />
      </UmlAssociation>

      <UmlAssociation id="order-payment" name="pays with">
        <UmlEnd ref={order.port("payment")} />
        <UmlEnd ref={paymentMethod} navigable multiplicity="1" />
      </UmlAssociation>

      <UmlRelation
        id="credit-card-generalization"
        kind="generalization"
        from="model/credit-card"
        to={paymentMethod.port("generalizations")}
      />
      <UmlRelation
        id="paypal-generalization"
        kind="generalization"
        from="model/paypal"
        to={paymentMethod.port("generalizations")}
      />
      <UmlRelation
        id="stripe-realization"
        kind="realization"
        from="model/stripe-authorizer"
        to="model/payment-authorizer"
      />
      <UmlRelation
        id="repository-dependency"
        kind="dependency"
        from="model/order"
        to="model/order-repository"
        name="persists through"
      />
    </UmlPackage>
  </Diagram>
);
