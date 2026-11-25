/**
 * Tests of the temperature chart's arithmetic: ordering readings from several
 * sensor logs and mapping them onto a drawing area.
 */

import { describe, expect, it } from "vitest";

import { chartLayout, collectReadings, isWithinRange } from "./temperature.js";

const RANGE = { minTenthsC: 20, maxTenthsC: 80 };
const MARGIN = { left: 40, right: 10, top: 10, bottom: 30 };

describe("collectReadings", () => {
  it("orders logs and readings by time and keeps each log as its own segment", () => {
    const { segments, points } = collectReadings([
      { index: 2, readings: [{ t: 400, tenthsC: 55 }, { t: 300, tenthsC: 54 }] },
      { index: 1, readings: [{ t: 100, tenthsC: 50 }, { t: 200, tenthsC: 52 }] },
    ]);
    expect(segments.map((segment) => segment.index)).toEqual([1, 2]);
    expect(segments[1].points.map((point) => point.t)).toEqual([300, 400]);
    expect(points).toEqual([
      { t: 100, tenthsC: 50, logIndex: 1 },
      { t: 200, tenthsC: 52, logIndex: 1 },
      { t: 300, tenthsC: 54, logIndex: 2 },
      { t: 400, tenthsC: 55, logIndex: 2 },
    ]);
  });

  it("returns nothing for no logs", () => {
    expect(collectReadings([])).toEqual({ segments: [], points: [] });
  });
});

describe("isWithinRange", () => {
  it("treats both bounds as allowed, like the contract", () => {
    expect(isWithinRange(20, RANGE)).toBe(true);
    expect(isWithinRange(80, RANGE)).toBe(true);
    expect(isWithinRange(19, RANGE)).toBe(false);
    expect(isWithinRange(81, RANGE)).toBe(false);
  });
});

describe("chartLayout", () => {
  const points = [
    { t: 1000, tenthsC: 45 },
    { t: 1600, tenthsC: 61 },
    { t: 2200, tenthsC: 52 },
  ];
  const layout = chartLayout({ points, range: RANGE, width: 400, height: 240, margin: MARGIN });

  it("maps the first and last reading to the left and right edge of the plot", () => {
    expect(layout.plot).toEqual({ left: 40, right: 390, top: 10, bottom: 210 });
    expect(layout.x(1000)).toBe(40);
    expect(layout.x(2200)).toBe(390);
    expect(layout.x(1600)).toBe(215);
    expect(layout.xTicks).toEqual([
      { t: 1000, x: 40 },
      { t: 2200, x: 390 },
    ]);
  });

  it("shows the whole allowed range with air around it, even when all readings are well inside", () => {
    // Range 2.0 to 8.0 °C, widened to whole degrees: 1.0 to 9.0 °C.
    expect(layout.y(10)).toBe(210);
    expect(layout.y(90)).toBe(10);
    expect(layout.band).toEqual({ y: layout.y(80), height: layout.y(20) - layout.y(80) });
    expect(layout.band.height).toBeGreaterThan(0);
  });

  it("puts higher temperatures higher on the screen", () => {
    expect(layout.y(61)).toBeLessThan(layout.y(45));
  });

  it("labels the value axis with a few round temperatures", () => {
    // The axis spans 1.0 to 9.0 °C; ticks are multiples of the 2 °C step, which here coincide with the band's edges.
    expect(layout.yTicks.map((tick) => tick.value)).toEqual([20, 40, 60, 80]);
  });

  it("extends the value axis to include an excursion reading outside the range", () => {
    const excursion = { t: 2500, tenthsC: 124 };
    const withExcursion = chartLayout({ points, range: RANGE, excursion, width: 400, height: 240, margin: MARGIN });
    expect(withExcursion.y(excursion.tenthsC)).toBeGreaterThanOrEqual(withExcursion.plot.top);
    expect(withExcursion.x(excursion.t)).toBe(withExcursion.plot.right);
  });

  it("handles sub-zero ranges", () => {
    const frozen = chartLayout({
      points: [{ t: 0, tenthsC: -182 }, { t: 60, tenthsC: -179 }],
      range: { minTenthsC: -250, maxTenthsC: -150 },
      width: 400,
      height: 240,
      margin: MARGIN,
    });
    expect(frozen.y(-250)).toBeGreaterThan(frozen.y(-150));
    expect(frozen.yTicks.every((tick) => tick.y >= frozen.plot.top && tick.y <= frozen.plot.bottom)).toBe(true);
  });

  it("centres a single reading instead of dividing by zero", () => {
    const single = chartLayout({ points: [{ t: 5000, tenthsC: 50 }], range: RANGE, width: 400, height: 240, margin: MARGIN });
    expect(single.x(5000)).toBe(215);
  });

  it("still lays out the band when there are no readings", () => {
    const empty = chartLayout({ points: [], range: RANGE, width: 400, height: 240, margin: MARGIN });
    expect(Number.isFinite(empty.band.y)).toBe(true);
    expect(empty.band.height).toBeGreaterThan(0);
  });
});
