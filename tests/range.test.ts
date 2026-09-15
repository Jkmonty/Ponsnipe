import { test } from "node:test";
import assert from "node:assert/strict";
import { drawSpeed, assistAngle, DRAW_MIN_SPEED, DRAW_MAX_SPEED } from "../src/app/(site)/range/arrows";

test("a full draw is the fast arrow and the minimum is the slow one", () => {
  assert.equal(drawSpeed(1), DRAW_MAX_SPEED);
  assert.equal(drawSpeed(0), DRAW_MIN_SPEED);
});

test("half a draw is half the difference, not half the speed", () => {
  assert.equal(drawSpeed(0.5), (DRAW_MIN_SPEED + DRAW_MAX_SPEED) / 2);
});

test("a draw outside 0..1 cannot loose a faster or slower arrow than the limits", () => {
  assert.equal(drawSpeed(1.6), DRAW_MAX_SPEED);
  assert.equal(drawSpeed(-0.4), DRAW_MIN_SPEED);
});

test("a thumb gets more help than a mouse, and both are small", () => {
  const mouse = assistAngle(false);
  const touch = assistAngle(true);
  assert.ok(touch > mouse, "touch should be forgiven more");
  assert.equal(touch, mouse * 1.5);
  // Small enough that a bad shot still misses: under three degrees.
  assert.ok(touch < 0.0524, "assist must stay under 3 degrees");
});
