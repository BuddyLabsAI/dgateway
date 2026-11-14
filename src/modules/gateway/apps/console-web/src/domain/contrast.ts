// WCAG 2.x contrast between two sRGB colours written as hex. Used by the tests that check
// every text and graphic token pair in styles/tokens.css against AA.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parses "#rgb" or "#rrggbb". Returns null for anything else. */
export function parseHex(hex: string): Rgb | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const digits = match[1] ?? "";
  const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits;
  return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
}

function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance, from 0 (black) to 1 (white). */
export function luminance(color: Rgb): number {
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

/** The contrast ratio of two hex colours, from 1 to 21. Null when either does not parse. */
export function contrastRatio(foreground: string, background: string): number | null {
  const a = parseHex(foreground);
  const b = parseHex(background);
  if (!a || !b) return null;
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/**
 * Reads every `--name: value;` custom property from a stylesheet and resolves `var(--other)`
 * references, keeping the ones that end in a hex colour. Later declarations win.
 */
export function colorTokens(css: string): Map<string, string> {
  const raw = new Map<string, string>();
  for (const match of css.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const [, name, value] = match;
    if (name && value) raw.set(name, value.trim());
  }

  const resolve = (name: string, seen: Set<string>): string | null => {
    const value = raw.get(name);
    if (value === undefined || seen.has(name)) return null;
    const reference = /^var\(--([a-z0-9-]+)\)$/i.exec(value);
    if (reference?.[1]) return resolve(reference[1], new Set([...seen, name]));
    return parseHex(value) ? value.toLowerCase() : null;
  };

  const tokens = new Map<string, string>();
  for (const name of raw.keys()) {
    const value = resolve(name, new Set());
    if (value) tokens.set(name, value);
  }
  return tokens;
}
