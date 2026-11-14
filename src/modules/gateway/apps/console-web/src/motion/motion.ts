// Motion that explains a change: the console arriving once, a window's bars growing or
// shrinking to their new heights, a headline number counting to its new value, a test or a
// decision arriving. Transform and opacity run through anime.js's WAAPI driver, so they stay
// on the compositor while the page fetches. With prefers-reduced-motion, movement is dropped
// and only a short opacity fade, or nothing, remains.

import { animate, waapi, stagger } from "animejs";

export const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
export const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";

export const DURATION = { fade: 140, enter: 240, reveal: 260, morph: 380, ticker: 520 } as const;

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

type Targets = Element | readonly Element[] | NodeListOf<Element> | null | undefined;

function toArray(targets: Targets): HTMLElement[] {
  if (!targets) return [];
  if (targets instanceof Element) return [targets as HTMLElement];
  return Array.from(targets as ArrayLike<Element>) as HTMLElement[];
}

function fade(elements: HTMLElement[]): void {
  waapi.animate(elements, { opacity: [0, 1], duration: DURATION.fade, ease: "linear" });
}

/** New data in place (a filtered table): a short fade, no movement, in every motion setting. */
export function fadeIn(targets: Targets): void {
  const elements = toArray(targets);
  if (elements.length > 0) fade(elements);
}

/** A screen or panel arriving: a short fade with a 6px rise. */
export function enter(targets: Targets): void {
  const elements = toArray(targets);
  if (elements.length === 0) return;
  if (reducedMotion()) return fade(elements);
  waapi.animate(elements, { opacity: [0, 1], transform: ["translateY(6px)", "translateY(0px)"], duration: DURATION.enter, ease: EASE_OUT });
}

const entered = new Set<string>();

/**
 * The first arrival of a screen in this session: its regions rise in sequence, 45ms apart.
 * Later visits and re-renders only fade, so data refreshes never replay the entrance.
 */
export function enterOnce(key: string, targets: Targets): void {
  const elements = toArray(targets);
  if (elements.length === 0) return;
  if (entered.has(key) || reducedMotion()) {
    entered.add(key);
    return fade(elements);
  }
  entered.add(key);
  waapi.animate(elements, {
    opacity: [0, 1],
    transform: ["translateY(10px)", "translateY(0px)"],
    duration: DURATION.enter + 80,
    delay: stagger(45),
    ease: EASE_OUT,
  });
}

/**
 * Bars moving from their old heights to the new ones after the window changes. Each bar is
 * drawn at its new height and starts from the scale its old height implies, so only a
 * transform animates.
 */
export function morphBars(targets: Targets, fromScales: readonly number[]): void {
  const elements = toArray(targets);
  if (elements.length === 0 || reducedMotion()) return;
  waapi.animate(elements, {
    transform: (_target: unknown, index: number) => [`scaleY(${fromScales[index] ?? 0.001})`, "scaleY(1)"],
    duration: DURATION.morph,
    delay: stagger(8),
    ease: EASE_IN_OUT,
  });
}

/** A line or overlay swapped for new data: a quick crossfade, no movement. */
export function crossfade(targets: Targets): void {
  const elements = toArray(targets);
  if (elements.length === 0) return;
  waapi.animate(elements, {
    opacity: [0, 1],
    duration: reducedMotion() ? DURATION.fade : DURATION.morph,
    ease: reducedMotion() ? "linear" : EASE_OUT,
  });
}

/** Bars filling from the left once an answer or a timeline arrives. */
export function fillBars(targets: Targets): void {
  const elements = toArray(targets);
  if (elements.length === 0 || reducedMotion()) return;
  waapi.animate(elements, {
    transform: ["scaleX(0.001)", "scaleX(1)"],
    duration: DURATION.reveal + 60,
    delay: stagger(40, { start: 80 }),
    ease: EASE_OUT,
  });
}

/** A marker sliding along its scale from the start, used for the score on its rubric. */
export function slideIn(target: Element | null, distancePx: number): void {
  if (!target || reducedMotion()) return;
  waapi.animate(target as HTMLElement, {
    transform: [`translateX(${-distancePx}px)`, "translateX(0px)"],
    opacity: [0, 1],
    duration: DURATION.morph,
    delay: 120,
    ease: EASE_OUT,
  });
}

/** The bracket over an error run is drawn from its first bucket to its last. */
export function drawBracket(target: Element | null): void {
  if (!target) return;
  if (reducedMotion()) return fade([target as HTMLElement]);
  waapi.animate(target as HTMLElement, {
    transform: ["scaleX(0)", "scaleX(1)"],
    opacity: [0, 1],
    duration: DURATION.morph,
    delay: 160,
    ease: EASE_IN_OUT,
  });
}

/** A result block (a test outcome, a decision) arriving after a request. */
export function reveal(targets: Targets): void {
  const elements = toArray(targets);
  if (elements.length === 0) return;
  if (reducedMotion()) return fade(elements);
  waapi.animate(elements, { opacity: [0, 1], transform: ["translateY(4px)", "translateY(0px)"], duration: DURATION.reveal, ease: EASE_OUT });
}

/**
 * Counts a number in `element` from `from` to `to`, writing text directly so React does not
 * re-render per frame. Returns a function that stops it. Reduced motion writes the end value.
 */
export function tickNumber(element: HTMLElement | null, from: number, to: number, format: (value: number) => string): () => void {
  if (!element) return () => undefined;
  if (reducedMotion() || from === to || !Number.isFinite(from) || !Number.isFinite(to)) {
    element.textContent = format(to);
    return () => undefined;
  }
  const state = { value: from };
  const animation = animate(state, {
    value: to,
    duration: DURATION.ticker,
    ease: "outExpo",
    onUpdate: () => {
      element.textContent = format(state.value);
    },
    onComplete: () => {
      element.textContent = format(to);
    },
  });
  return () => {
    animation.pause();
    element.textContent = format(to);
  };
}

/**
 * Counts elapsed time up in `element` while a request is in flight, like an instrument's
 * running readout, ten times a second. Writes text only. Returns the stop function.
 */
export function runClock(element: HTMLElement | null, format: (ms: number) => string): () => void {
  if (!element || typeof window === "undefined") return () => undefined;
  const started = performance.now();

  const write = (): void => {
    element.textContent = format(performance.now() - started);
  };

  write();
  const id = window.setInterval(write, 100);
  return () => window.clearInterval(id);
}
