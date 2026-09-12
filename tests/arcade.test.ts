import { test } from "node:test";
import assert from "node:assert/strict";
import { weekOf, weekEnds } from "../src/lib/arcade";

test("a week runs Monday to Monday, in UTC", () => {
  // Every day of one week must resolve to the same Monday, or a leaderboard
  // rolls over underneath whoever is playing at the time.
  const monday = "2026-09-07";
  for (const day of [
    "2026-09-07T00:00:00Z", // Monday, first instant
    "2026-09-07T23:59:59Z",
    "2026-09-10T12:00:00Z", // Thursday
    "2026-09-13T23:59:59Z", // Sunday, last instant
  ]) {
    assert.equal(weekOf(new Date(day)), monday, day);
  }
  // And the next Monday starts a new one.
  assert.equal(weekOf(new Date("2026-09-14T00:00:00Z")), "2026-09-14");
});

test("Sunday belongs to the week that started six days ago", () => {
  // getUTCDay is 0 on Sunday, so the naive arithmetic puts it in the week
  // beginning tomorrow — moving the finish line on the busiest day.
  assert.equal(weekOf(new Date("2026-09-13T18:00:00Z")), "2026-09-07");
});

test("a week ends exactly seven days after it begins", () => {
  const week = weekOf(new Date("2026-09-10T12:00:00Z"));
  assert.equal(weekEnds(week), Date.parse("2026-09-14T00:00:00Z"));
  assert.equal(weekEnds(week) - Date.parse(`${week}T00:00:00Z`), 7 * 86_400_000);
});

test("the week does not shift with the reader's clock", () => {
  // The same instant, expressed in two zones, is one week.
  const utc = weekOf(new Date("2026-09-13T23:30:00Z"));
  const sameMoment = weekOf(new Date("2026-09-14T00:30:00+01:00"));
  assert.equal(utc, sameMoment);
});
