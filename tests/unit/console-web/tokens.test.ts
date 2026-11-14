// Every text and meaningful-graphic colour pair the console draws, checked against WCAG AA on
// the surfaces it sits on. The pairs are read from styles/tokens.css, so a token change that
// breaks contrast fails here.

import { describe, expect, test } from "bun:test";
import { colorTokens, contrastRatio, parseHex } from "../../../src/modules/gateway/apps/console-web/src/domain/contrast";

const TOKENS_PATH = new URL("../../../src/modules/gateway/apps/console-web/src/styles/tokens.css", import.meta.url);
const tokens = colorTokens(await Bun.file(TOKENS_PATH).text());

function value(name: string): string {
  const hex = tokens.get(name);
  if (!hex) throw new Error(`--${name} does not resolve to a hex colour`);
  return hex;
}

function ratio(foreground: string, background: string): number {
  return contrastRatio(value(foreground), value(background)) ?? 0;
}

const SURFACES = ["surface-sunk", "surface-0", "surface-1", "surface-2", "surface-3", "field"];

describe("contrast maths", () => {
  test("parses short and long hex and rejects anything else", () => {
    expect(parseHex("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseHex("#0b111d")).toEqual({ r: 11, g: 17, b: 29 });
    expect(parseHex("rgb(0,0,0)")).toBeNull();
  });

  test("matches the WCAG reference values", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
    expect(contrastRatio("#000000", "#000000")).toBe(1);
    expect(contrastRatio("nope", "#000000")).toBeNull();
  });

  test("resolves var() chains in the token sheet", () => {
    const sheet = ":root { --a: #102030; --b: var(--a); --c: var(--b); --d: var(--missing); }";
    const resolved = colorTokens(sheet);
    expect(resolved.get("c")).toBe("#102030");
    expect(resolved.has("d")).toBe(false);
  });
});

describe("text on every surface meets 4.5:1", () => {
  const TEXT = ["text-1", "text-2", "text-3", "accent", "ok", "warn", "fail", "off"];
  for (const foreground of TEXT) {
    for (const background of SURFACES) {
      test(`${foreground} on ${background}`, () => {
        expect(ratio(foreground, background)).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});

describe("status text on its own wash meets 4.5:1", () => {
  const PAIRS: [string, string][] = [
    ["ok", "ok-wash"],
    ["warn", "warn-wash"],
    ["fail", "fail-wash"],
    ["off", "off-wash"],
    ["accent", "accent-wash"],
    ["text-1", "fail-wash"],
    ["text-2", "warn-wash"],
    ["text-2", "fail-wash"],
  ];
  for (const [foreground, background] of PAIRS) {
    test(`${foreground} on ${background}`, () => {
      expect(ratio(foreground, background)).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("filled controls and marks", () => {
  test("button text on its fill", () => {
    expect(ratio("on-accent", "accent-fill")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("on-accent", "accent-fill-hover")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("on-accent", "fail-fill")).toBeGreaterThanOrEqual(4.5);
  });

  test("attempt numbers on their data segments", () => {
    expect(ratio("on-series", "series-ok")).toBeGreaterThanOrEqual(4.5);
    expect(ratio("on-series", "series-error")).toBeGreaterThanOrEqual(4.5);
  });

  test("control borders and the focus ring reach 3:1 where controls sit", () => {
    for (const background of ["surface-0", "surface-1", "field"]) {
      expect(ratio("line-control", background)).toBeGreaterThanOrEqual(3);
      expect(ratio("focus", background)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("data graphics reach 3:1 against the panels and tracks they sit on", () => {
  const GRAPHICS = [
    "series-ok",
    "series-fallback",
    "series-error",
    "series-latency",
    "series-axis",
    "line-ink-0",
    "line-ink-1",
    "line-ink-2",
    "line-ink-3",
    "line-ink-4",
  ];
  for (const graphic of GRAPHICS) {
    for (const background of ["surface-0", "surface-1", "surface-3"]) {
      test(`${graphic} on ${background}`, () => {
        expect(ratio(graphic, background)).toBeGreaterThanOrEqual(3);
      });
    }
  }

  test("unchosen probability bars and meters stand apart from their track", () => {
    expect(ratio("text-3", "surface-3")).toBeGreaterThanOrEqual(3);
    expect(ratio("text-2", "surface-3")).toBeGreaterThanOrEqual(3);
  });
});

describe("code inks on the sunk code ground meet 4.5:1", () => {
  const CODE = [
    "code-key",
    "code-string",
    "code-number",
    "code-literal",
    "code-punct",
    "code-text",
    "code-command",
    "code-flag",
    "code-variable",
  ];
  for (const ink of CODE) {
    test(ink, () => {
      expect(ratio(ink, "surface-sunk")).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("the fallback segment is set off from the answered blue by the panel gap", () => {
  // The chart leaves a 2px gap of the panel surface between the answered segment and a fallback
  // segment, so each side of that boundary must reach 3:1 against the panel.
  test("the answered blue against the gap", () => {
    expect(ratio("series-ok", "surface-1")).toBeGreaterThanOrEqual(3);
  });

  test("the amber fallback stripes against the gap", () => {
    expect(ratio("series-fallback", "surface-1")).toBeGreaterThanOrEqual(3);
  });
});

describe("selected cards and catalog rows keep their text readable on the cobalt wash", () => {
  // The Add model flow's chosen connection card and the chosen catalog row sit on --accent-wash.
  for (const foreground of ["text-1", "text-2", "text-3", "accent"]) {
    test(`${foreground} on accent-wash`, () => {
      expect(ratio(foreground, "accent-wash")).toBeGreaterThanOrEqual(4.5);
    });
  }

  test("the unpriced cost amber on the sunk result well", () => {
    expect(ratio("warn", "surface-sunk")).toBeGreaterThanOrEqual(4.5);
  });

  test("checklist and stepper station rings reach 3:1 where they sit", () => {
    expect(ratio("line-control", "surface-1")).toBeGreaterThanOrEqual(3);
    expect(ratio("line-control", "surface-0")).toBeGreaterThanOrEqual(3);
    expect(ratio("accent", "surface-0")).toBeGreaterThanOrEqual(3);
    expect(ratio("ok", "surface-1")).toBeGreaterThanOrEqual(3);
  });
});
