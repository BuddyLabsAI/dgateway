type Point = { x: number; y: number };
type Box = { left: number; top: number; right: number; bottom: number; cx: number; cy: number };
type Axis = 'x' | 'y';

const RADIUS = 14;

function along(point: Point, axis: Axis) {
  return axis === 'x' ? point.x : point.y;
}

function across(point: Point, axis: Axis) {
  return axis === 'x' ? point.y : point.x;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/**
 * An orthogonal wire: from `a` along the main axis to `at`, across to the
 * target's line, then along the main axis to `b`, with rounded corners.
 */
function bend(a: Point, b: Point, axis: Axis, at: number) {
  const pt = (main: number, cross: number) =>
    axis === 'x'
      ? `${main.toFixed(1)} ${cross.toFixed(1)}`
      : `${cross.toFixed(1)} ${main.toFixed(1)}`;
  const start = along(a, axis),
    end = along(b, axis),
    from = across(a, axis),
    to = across(b, axis);
  const shift = to - from;
  if (Math.abs(shift) < 0.5) return `M${pt(start, from)}L${pt(end, from)}`;
  const sign = Math.sign(shift);
  const dirIn = Math.sign(at - start) || 1;
  const dirOut = Math.sign(end - at) || 1;
  const r = Math.min(RADIUS, Math.abs(shift) / 2, Math.abs(at - start), Math.abs(end - at));
  return (
    `M${pt(start, from)}` +
    `L${pt(at - dirIn * r, from)}` +
    `Q${pt(at, from)} ${pt(at, from + sign * r)}` +
    `L${pt(at, to - sign * r)}` +
    `Q${pt(at, to)} ${pt(at + dirOut * r, to)}` +
    `L${pt(end, to)}`
  );
}

/**
 * Reads the card positions once and draws the wires between them. Runs on
 * mount and again after a width change, never per frame.
 */
export function drawHeroWires(stage: HTMLElement) {
  const bounds = stage.getBoundingClientRect();
  const measure = (name: string): Box => {
    const r = stage.querySelector(`[data-hf-box="${name}"]`)!.getBoundingClientRect();
    const left = r.left - bounds.left,
      top = r.top - bounds.top;
    return {
      left,
      top,
      right: left + r.width,
      bottom: top + r.height,
      cx: left + r.width / 2,
      cy: top + r.height / 2,
    };
  };
  const request = measure('request'),
    first = measure('step-1'),
    next = measure('step-2'),
    answer = measure('answer');
  const vertical = answer.top >= request.bottom;
  let out: Point, junction: Point, entry: Point, tag: Point;
  let wires: Record<string, string>;

  if (!vertical) {
    const mid = (first.cy + next.cy) / 2;
    const forkX = request.right + (first.left - request.right) * 0.5;
    const mergeX = Math.max(first.right, next.right);
    const joinX = mergeX + (answer.left - mergeX) * 0.5;
    out = { x: request.right, y: clamp(mid, request.top + 24, request.bottom - 24) };
    junction = { x: forkX - RADIUS, y: mid };
    entry = { x: answer.left, y: clamp(mid, answer.top + 24, answer.bottom - 24) };
    tag = { x: first.left + 16, y: mid };
    const firstIn = { x: first.left, y: first.cy },
      nextIn = { x: next.left, y: next.cy };
    wires = {
      out: bend(out, junction, 'x', (out.x + junction.x) / 2),
      first: bend(junction, firstIn, 'x', forkX),
      next: bend(junction, nextIn, 'x', forkX),
      answer: bend({ x: next.right, y: next.cy }, entry, 'x', joinX),
      spare: bend({ x: first.right, y: first.cy }, entry, 'x', joinX),
    };
  } else {
    const forkY = request.bottom + (Math.min(first.top, next.top) - request.bottom) * 0.5;
    const lowest = Math.max(first.bottom, next.bottom);
    const joinY = lowest + (answer.top - lowest) * 0.5;
    out = { x: request.cx, y: request.bottom };
    junction = { x: request.cx, y: forkY - RADIUS };
    entry = { x: answer.cx, y: answer.top };
    tag = { x: junction.x + 16, y: forkY - 16 };
    wires = {
      out: bend(out, junction, 'y', (out.y + junction.y) / 2),
      first: bend(junction, { x: first.cx, y: first.top }, 'y', forkY),
      next: bend(junction, { x: next.cx, y: next.top }, 'y', forkY),
      answer: bend({ x: next.cx, y: next.bottom }, entry, 'y', joinY),
      spare: bend({ x: first.cx, y: first.bottom }, entry, 'y', joinY),
    };
  }

  const svg = stage.querySelector<SVGSVGElement>('.hf-wires')!;
  svg.setAttribute('viewBox', `0 0 ${bounds.width.toFixed(1)} ${bounds.height.toFixed(1)}`);
  const firstTrip = wires.out + wires.first.replace(/^M[^L]+/, '');
  const shapes: Record<string, string> = {
    'base-out': wires.out,
    'base-first': wires.first,
    'base-next': wires.next,
    'base-answer': wires.answer,
    'base-spare': wires.spare,
    'lit-trip': firstTrip,
    'lit-out': wires.out,
    'lit-fail': wires.first,
    'lit-next': wires.next,
    'lit-answer': wires.answer,
    'motion-trip': firstTrip,
    'motion-next': wires.next,
    'motion-answer': wires.answer,
  };
  for (const [name, d] of Object.entries(shapes))
    svg.querySelector(`[data-hf="${name}"]`)?.setAttribute('d', d);
  const nodes: Record<string, Point> = { out, junction, entry };
  for (const [name, point] of Object.entries(nodes))
    svg.querySelectorAll(`[data-hf-node="${name}"]`).forEach((node) => {
      node.setAttribute('cx', point.x.toFixed(1));
      node.setAttribute('cy', point.y.toFixed(1));
    });
  const label = stage.querySelector<HTMLElement>('[data-hf="tag"]');
  if (label) {
    label.style.left = `${tag.x.toFixed(1)}px`;
    label.style.top = `${(tag.y - label.offsetHeight / 2).toFixed(1)}px`;
  }
  stage.dataset.layout = vertical ? 'vertical' : 'horizontal';
  stage.setAttribute('data-wires-ready', '');
  return { width: bounds.width, start: out, retry: junction };
}
