import assert from "node:assert/strict";
import test from "node:test";
import { Camera } from "../camera.js";

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
}

test("fit centers complete bounds with padding, including very large graphs and tiny viewports", () => {
  for (const [width, height, bounds] of [
    [800, 600, { minX: -100, minY: 20, maxX: 200, maxY: 120 }],
    [800, 600, { minX: -1e8, minY: -1e8, maxX: 1e8, maxY: 1e8 }],
    [1, 1, { minX: -100, minY: -200, maxX: 100, maxY: 200 }],
    [800, 600, { minX: 20, minY: 30, maxX: 20, maxY: 30 }],
  ]) {
    const camera = new Camera(width, height);
    camera.fit(bounds);
    near(camera.worldToScreen(camera.centerX, camera.centerY).x, width / 2);
    near(camera.worldToScreen(camera.centerX, camera.centerY).y, height / 2);
    for (const [x, y] of [[bounds.minX, bounds.minY], [bounds.maxX, bounds.maxY]]) {
      const screen = camera.worldToScreen(x, y);
      assert.ok(screen.x >= 0 && screen.x <= width);
      assert.ok(screen.y >= 0 && screen.y <= height);
    }
  }
});

test("drag moves graph by CSS pixels and resize preserves camera position and zoom", () => {
  const camera = new Camera(800, 600);
  camera.zoom(2);
  const before = camera.worldToScreen(10, 15);
  camera.pan(30, -20);
  assert.deepEqual(camera.worldToScreen(10, 15), { x: before.x + 30, y: before.y - 20 });
  const { centerX, centerY, scale } = camera;
  camera.resize(1200, 900);
  assert.deepEqual([camera.centerX, camera.centerY, camera.scale], [centerX, centerY, scale]);
  assert.deepEqual(camera.worldToScreen(centerX, centerY), { x: 600, y: 450 });
});

test("zoom fixes the world position under the pointer and reverses without drift", () => {
  const camera = new Camera(800, 600);
  camera.pan(100, -30);
  const x = (173 - camera.width / 2) / camera.scale + camera.centerX;
  const y = (391 - camera.height / 2) / camera.scale + camera.centerY;
  const before = { ...camera };
  camera.zoom(3.5, 173, 391);
  near(camera.worldToScreen(x, y).x, 173);
  near(camera.worldToScreen(x, y).y, 391);
  camera.zoom(1 / 3.5, 173, 391);
  near(camera.centerX, before.centerX);
  near(camera.centerY, before.centerY);
  near(camera.scale, before.scale);
  camera.zoom(1e10);
  assert.equal(camera.scale, 100);
  camera.zoom(1e-10);
  assert.equal(camera.scale, 0.02);
});

test("invalid dimensions, bounds and navigation cannot poison camera state", () => {
  const camera = new Camera(NaN, -1);
  assert.deepEqual([camera.width, camera.height], [1, 1]);
  camera.resize(Number.MIN_VALUE, Infinity);
  assert.deepEqual([camera.width, camera.height], [1, 1]);
  for (const bounds of [null, {}, { minX: 10, minY: 0, maxX: -10, maxY: Infinity }]) {
    camera.fit(bounds);
    assert.deepEqual([camera.centerX, camera.centerY, camera.scale], [0, 0, 1]);
  }
  const before = { ...camera };
  for (const factor of [NaN, Infinity, -1, 0]) camera.zoom(factor);
  camera.zoom(2, NaN, 0);
  camera.pan(Infinity, 0);
  assert.deepEqual({ ...camera }, before);
  camera.fit({ minX: -Number.MAX_VALUE, minY: 0, maxX: Number.MAX_VALUE, maxY: 1 });
  camera.pan(Number.MAX_VALUE, Number.MAX_VALUE);
  camera.zoom(2, Number.MAX_VALUE, Number.MAX_VALUE);
  assert.ok(Object.values(camera).every(Number.isFinite));
  assert.ok(camera.scale > 0);
});
