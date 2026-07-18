import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSvg } from "../src/svg.mjs";

function sceneWithLabel(label) {
  return {
    width: 320,
    height: 180,
    root: { id: "label-painter" },
    diagnostics: [],
    tokens: {},
    objects: [],
    corridors: [],
    lines: [{
      id: "request",
      style: { stroke: "#2563eb" },
      heads: "none",
      route: [{ x: 20, y: 90 }, { x: 300, y: 90 }],
      routeLabels: [label],
    }],
  };
}

test("line labels paint at their solved center without an opaque background rectangle", () => {
  const svg = renderSvg(sceneWithLabel({
    text: "a deliberately long label",
    box: { x: 80, y: 62, width: 42, height: 22 },
    angle: 0,
  }), { transparent: true });

  assert.doesNotMatch(svg, /<rect/);
  assert.match(svg, /<g data-line-label="request">/);
  assert.match(svg, /<text x="101" y="78"/);
  assert.match(svg, /paint-order="stroke fill"/);
});

test("rotated multiline labels keep the solved center as their painter origin", () => {
  const svg = renderSvg(sceneWithLabel({
    text: "first\nsecond",
    x: 137,
    y: 91,
    box: { x: 118, y: 46, width: 38, height: 90 },
    angle: 90,
  }), { transparent: true });

  assert.match(svg, /transform="rotate\(90 137 91\)"/);
  assert.match(svg, /<text x="137" y="88"/);
  assert.match(svg, /<text x="137" y="104"/);
  assert.equal((svg.match(/stroke="#ffffff"/g) ?? []).length, 2);
});

test("routing debug paints channel-mesh cells as inset ten-percent red rectangles", () => {
  const scene = sceneWithLabel({
    text: "debug",
    box: { x: 80, y: 62, width: 42, height: 22 },
    angle: 0,
  });
  scene.channelMesh = [
    {
      key: "mesh:padding:system:left",
      kind: "padding",
      materialized: false,
      corridors: [],
      geometry: { x: 24, y: 32, width: 16, height: 112, axis: "vertical" },
    },
    {
      key: "mesh:gap:system:0",
      kind: "gap",
      materialized: true,
      corridors: [{ id: "bus" }],
      geometry: { x: 140, y: 32, width: 24, height: 112, axis: "vertical" },
    },
  ];

  const regular = renderSvg(scene, { transparent: true });
  const debug = renderSvg(scene, { transparent: true, debugRouting: true });
  assert.doesNotMatch(regular, /id="routing-regions"/);
  assert.match(debug, /id="routing-regions"/);
  assert.equal((debug.match(/fill="#ef4444" fill-opacity="0\.1"/g) ?? []).length, 2);
  assert.match(debug, /data-routing-region="mesh:gap:system:0" data-region-kind="gap" data-materialized="true" data-authored="true" x="141" y="33" width="22" height="110"/);
});
