// Pre-implementation UML grammar example. Nested scopes express deployment
// containment independently of communication paths.

import { Diagram, Port, Row, Title } from "@kvisl/core";
import { UmlArtifact, UmlComponent, UmlDeploymentNode, UmlRelation, umlStyles } from "./uml";

export default (
  <Diagram id="uml-deployment-example" theme="uml" styles={umlStyles}>
    <Title>Production checkout — deployment diagram</Title>

    <Row id="topology" gap="large" order="prefer-source">
      <UmlDeploymentNode id="browser" name="Customer Browser" stereotype="device">
        <UmlArtifact id="web-app" name="checkout.js" />
      </UmlDeploymentNode>

      <UmlDeploymentNode id="cloud" name="Production Cluster" stereotype="node">
        <UmlDeploymentNode id="checkout-pod" name="checkout-7f9d" stereotype="executionEnvironment">
          <UmlComponent id="checkout" name="Checkout Service" ports={[{ id: "https", side: "left" }]} />
          <UmlArtifact id="checkout-image" name="checkout:v42" />
        </UmlDeploymentNode>
        <UmlDeploymentNode id="inventory-pod" name="inventory-55c8" stereotype="executionEnvironment">
          <UmlComponent id="inventory" name="Inventory Service" ports={[{ id: "grpc", side: "left" }]} />
        </UmlDeploymentNode>
      </UmlDeploymentNode>

      <UmlDeploymentNode id="database" name="PostgreSQL" stereotype="device">
        <UmlArtifact id="orders-schema" name="orders schema" />
      </UmlDeploymentNode>
    </Row>

    <Port ref="topology/browser.https" side="right" />
    <Port ref="topology/cloud/checkout-pod/checkout.db" side="right" />
    <Port ref="topology/database.sql" side="left" />

    <UmlRelation
      id="browser-checkout"
      kind="association"
      from="topology/browser.https"
      to="topology/cloud/checkout-pod/checkout.https"
      name="HTTPS"
    />
    <UmlRelation
      id="checkout-inventory"
      kind="association"
      from="topology/cloud/checkout-pod/checkout"
      to="topology/cloud/inventory-pod/inventory.grpc"
      name="gRPC"
    />
    <UmlRelation
      id="checkout-database"
      kind="association"
      from="topology/cloud/checkout-pod/checkout.db"
      to="topology/database.sql"
      name="TCP / SQL"
    />
    <UmlRelation
      id="image-deploys-checkout"
      kind="dependency"
      from="topology/cloud/checkout-pod/checkout-image"
      to="topology/cloud/checkout-pod/checkout"
      keyword="deploy"
    />
  </Diagram>
);
