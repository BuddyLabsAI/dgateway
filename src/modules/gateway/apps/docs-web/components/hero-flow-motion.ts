'use client';

import { createDrawable, createMotionPath, createTimeline, cubicBezier, stagger } from 'animejs';
import { drawHeroWires } from './hero-flow-geometry';

type Timeline = ReturnType<typeof createTimeline>;

const arrive = cubicBezier(0.23, 1, 0.32, 1);
const travel = cubicBezier(0.77, 0, 0.175, 1);

/** Beats of the 9-second loop, in milliseconds. */
const BEAT = {
  send: 0,
  firstTrip: 200,
  firstTry: 850,
  timeout: 2050,
  retry: 2450,
  nextTrip: 2550,
  nextTry: 3150,
  answered: 3550,
  answerTrip: 3750,
  arrive: 4350,
  assemble: 4400,
  hold: 5600,
  reset: 8400,
  clear: 8750,
  loop: 9000,
};

/**
 * Plays the hero story on a loop: the request leaves your app, the first step
 * times out, dgateway tries the next step, and the answer card assembles.
 * Only transforms, opacity and SVG strokes animate.
 */
export function startHeroFlow(figure: HTMLElement, stage: HTMLElement) {
  const one = <T extends Element = HTMLElement>(name: string) =>
    stage.querySelector<T>(`[data-hf="${name}"]`)!;
  const all = <T extends Element = HTMLElement>(name: string) => [
    ...stage.querySelectorAll<T>(`[data-hf="${name}"]`),
  ];
  const drawn = ['lit-trip', 'lit-next', 'lit-answer', 'timer-1', 'timer-2'].map((name) =>
    one<SVGGeometryElement>(name),
  );
  let timeline: Timeline | undefined;
  let visible = false;
  let width = 0;

  const build = () => {
    width = drawHeroWires(stage).width;
    const [trip, next, answer, timer1, timer2] = createDrawable(drawn);
    const packet = one<SVGGElement>('packet');
    const sparks = all<SVGCircleElement>('spark');
    const values = all('value');
    const fills = all('fill');
    const digits = all('digits');
    const nums = all('num');
    const meta = all('meta');
    const attempts = all('attempt');
    const counters = nums.map(() => ({ value: 0 }));
    const bars = fills.filter((fill) => !fill.classList.contains('hf-marker'));
    const markers = fills.filter((fill) => fill.classList.contains('hf-marker'));
    const tl = createTimeline({ autoplay: false, loop: true, defaults: { ease: arrive } });

    // 0. The opening frame: the route at rest, no results yet.
    tl.set([trip, next, answer, timer1, timer2], { draw: '0 0', opacity: 1 }, 0);
    tl.set(
      [
        packet,
        ...sparks,
        one('lit-out'),
        one('lit-fail'),
        one('glow-request'),
        one('glow-1'),
        one('fail-1'),
        one('glow-2'),
        one('glow-answer'),
        one('timer-end-1'),
        one('timer-end-2'),
        one('wait-1'),
        one('wait-2'),
        one('label-1'),
        one('label-2'),
        one('tag'),
        one('http'),
        ...values,
        ...nums,
        ...meta,
        ...attempts,
      ],
      { opacity: 0 },
      0,
    );
    tl.set([one('icon-1'), one('icon-2')], { opacity: 0, scale: 0.5 }, 0);
    tl.set(bars, { scaleX: 0, opacity: 1 }, 0);
    tl.set(markers, { translateX: '0%', opacity: 0 }, 0);

    const appear = (path: SVGPathElement, at: number) => {
      const start = path.getPointAtLength(0);
      tl.set(packet, { translateX: start.x, translateY: start.y, scale: 0.4 }, at);
      tl.set(sparks, { translateX: start.x, translateY: start.y }, at);
      tl.add(packet, { opacity: [0, 1], scale: [0.4, 1], duration: 220 }, at);
    };
    const go = (path: SVGPathElement, lit: SVGPathElement, at: number, duration: number) => {
      const motion = createMotionPath(path)!;
      tl.add(
        packet,
        { translateX: motion.translateX, translateY: motion.translateY, duration, ease: travel },
        at,
      );
      tl.add(lit, { draw: ['0 0', '0 1'], duration, ease: travel }, at);
      // A short comet tail: three sparks follow the packet a few frames behind.
      sparks.forEach((spark, index) => {
        const lag = at + (index + 1) * 32;
        tl.add(
          spark,
          { translateX: motion.translateX, translateY: motion.translateY, duration, ease: travel },
          lag,
        );
        tl.add(spark, { opacity: [0, 0.55 - index * 0.15], duration: 140 }, lag);
        tl.add(spark, { opacity: 0, duration: 180, ease: 'out(2)' }, lag + duration - 120);
      });
    };
    const absorb = (at: number) =>
      tl.add(packet, { opacity: [1, 0], scale: [1, 0.5], duration: 220 }, at);
    const pulse = (name: string, at: number) =>
      tl.add(one(name), { opacity: [0.85, 0], scale: [1, 3.2], duration: 760 }, at);
    const pop = (target: Element | Element[], at: number) =>
      tl.add(target, { opacity: [0, 1], scale: [0.5, 1], duration: 320 }, at);
    const swap = (from: Element, to: Element, at: number) => {
      tl.add(from, { opacity: [1, 0], translateY: [0, -4], duration: 180 }, at);
      tl.add(to, { opacity: [0, 1], translateY: [4, 0], duration: 260 }, at + 60);
    };

    // 1. Send: your app lights up and a request leaves it.
    tl.add(one('glow-request'), { opacity: [0, 1], duration: 300 }, BEAT.send);
    pulse('pulse-out', BEAT.send + 60);
    appear(one<SVGPathElement>('motion-trip'), BEAT.send + 60);
    go(one<SVGPathElement>('motion-trip'), trip, BEAT.firstTrip, 650);

    // 2. The first step is tried and its timer runs.
    absorb(BEAT.firstTry);
    tl.add(one('glow-request'), { opacity: [1, 0], duration: 500 }, BEAT.firstTry);
    tl.add(one('glow-1'), { opacity: [0, 1], duration: 260 }, BEAT.firstTry);
    tl.add(one('wait-1'), { opacity: [0, 1], translateY: [4, 0], duration: 260 }, BEAT.firstTry);
    tl.add(
      timer1,
      { draw: ['0 0', '0 1'], duration: BEAT.timeout - BEAT.firstTry, ease: 'linear' },
      BEAT.firstTry,
    );

    // 3. Timeout: the step turns red, shakes once, and its wire dims.
    tl.add(one('timer-end-1'), { opacity: [0, 1], duration: 160 }, BEAT.timeout);
    pop(one('icon-1'), BEAT.timeout);
    swap(one('wait-1'), one('label-1'), BEAT.timeout);
    tl.add(one('glow-1'), { opacity: [1, 0], duration: 320 }, BEAT.timeout);
    tl.add(one('fail-1'), { opacity: [0, 1], duration: 220 }, BEAT.timeout);
    tl.add(
      one('step-1'),
      {
        translateX: [
          { to: -5, duration: 70 },
          { to: 5, duration: 70 },
          { to: -3, duration: 70 },
          { to: 2, duration: 70 },
          { to: 0, duration: 90 },
        ],
        ease: 'inOut(2)',
      },
      BEAT.timeout,
    );
    tl.set(one('lit-out'), { opacity: 1 }, BEAT.timeout + 60);
    tl.add(trip, { opacity: [1, 0], duration: 320 }, BEAT.timeout + 60);
    tl.add(one('lit-fail'), { opacity: [0, 0.6], duration: 320 }, BEAT.timeout + 60);

    // 4. Fallback: dgateway tries the next step.
    pulse('pulse-junction', BEAT.retry);
    tl.add(one('tag'), { opacity: [0, 1], scale: [0.92, 1], duration: 320 }, BEAT.retry);
    appear(one<SVGPathElement>('motion-next'), BEAT.retry + 40);
    go(one<SVGPathElement>('motion-next'), next, BEAT.nextTrip, 600);

    // 5. The next step answers quickly.
    absorb(BEAT.nextTry);
    tl.add(one('glow-2'), { opacity: [0, 1], duration: 260 }, BEAT.nextTry);
    tl.add(one('wait-2'), { opacity: [0, 1], translateY: [4, 0], duration: 220 }, BEAT.nextTry);
    tl.add(timer2, { draw: ['0 0', '0 1'], duration: 400, ease: 'out(2)' }, BEAT.nextTry);
    tl.add(one('timer-end-2'), { opacity: [0, 1], duration: 160 }, BEAT.answered);
    pop(one('icon-2'), BEAT.answered);
    swap(one('wait-2'), one('label-2'), BEAT.answered);

    // 6. The answer travels back to the answer card.
    appear(one<SVGPathElement>('motion-answer'), BEAT.answerTrip - 60);
    go(one<SVGPathElement>('motion-answer'), answer, BEAT.answerTrip, 600);
    absorb(BEAT.arrive);
    pulse('pulse-entry', BEAT.arrive);
    tl.add(one('glow-answer'), { opacity: [0, 1], duration: 320 }, BEAT.arrive);
    tl.add(one('http'), { opacity: [0, 1], scale: [0.85, 1], duration: 300 }, BEAT.arrive + 120);

    // 7. The answer card assembles: values, bars, counts, then the gateway facts.
    tl.add(
      values,
      { opacity: [0, 1], translateX: [-6, 0], duration: 420, delay: stagger(110) },
      BEAT.assemble,
    );
    tl.add(nums, { opacity: [0, 1], duration: 300, delay: stagger(110) }, BEAT.assemble);
    fills.forEach((fill, index) => {
      const to = Number(fill.dataset.to);
      const at = BEAT.assemble + 60 + index * 110;
      if (markers.includes(fill))
        tl.add(fill, { translateX: ['0%', `${to * 100}%`], opacity: [0, 1], duration: 780 }, at);
      else tl.add(fill, { scaleX: [0, to], duration: 780 }, at);
      const counter = counters[index];
      const target = Number(nums[index].dataset.to);
      tl.add(
        counter,
        {
          value: [0, target],
          duration: 780,
          onUpdate: () => {
            digits[index].textContent = counter.value.toFixed(2);
          },
        },
        at,
      );
    });
    tl.add(
      meta,
      { opacity: [0, 1], translateY: [6, 0], duration: 380, delay: stagger(90) },
      BEAT.assemble + 600,
    );
    tl.add(
      attempts,
      { opacity: [0, 1], scale: [0.4, 1], duration: 300, delay: stagger(140) },
      BEAT.assemble + 820,
    );

    // 8. Hold, then clear everything back to the opening frame.
    const fading = [
      one('lit-out'),
      one('lit-fail'),
      next,
      answer,
      one('glow-1'),
      one('fail-1'),
      one('glow-2'),
      one('glow-answer'),
      one('timer-end-1'),
      one('timer-end-2'),
      timer1,
      timer2,
      one('icon-1'),
      one('icon-2'),
      one('label-1'),
      one('label-2'),
      one('tag'),
      one('http'),
      ...values,
      ...nums,
      ...fills,
      ...meta,
      ...attempts,
    ];
    tl.add(fading, { opacity: 0, duration: 320, ease: 'out(2)' }, BEAT.reset);
    // Back to the opening frame while nothing is visible, so the loop is seamless.
    tl.set([trip, next, answer, timer1, timer2], { draw: '0 0', opacity: 1 }, BEAT.clear);
    tl.set(bars, { scaleX: 0, opacity: 1 }, BEAT.clear);
    tl.set(markers, { translateX: '0%' }, BEAT.clear);
    tl.add({ duration: 1 }, BEAT.loop - 1);
    return tl;
  };

  const restart = (at: number) => {
    timeline = build();
    timeline.seek(at);
    if (visible) timeline.play();
  };
  const revert = () => {
    timeline?.revert();
    timeline = undefined;
    drawn.forEach((path) => {
      ['pathLength', 'stroke-dasharray', 'stroke-dashoffset', 'draw'].forEach((name) =>
        path.removeAttribute(name),
      );
      path.style.removeProperty('stroke-linecap');
    });
  };

  figure.setAttribute('data-motion', 'playing');
  // Start on the clearing beat: the static end state fades into the opening frame.
  restart(BEAT.reset);

  const sight = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) timeline?.play();
    else timeline?.pause();
  });
  sight.observe(figure);

  const resize = new ResizeObserver(() => {
    if (!timeline || Math.abs(stage.getBoundingClientRect().width - width) < 1) return;
    const at = timeline.iterationCurrentTime;
    revert();
    restart(at);
  });
  resize.observe(stage);

  return () => {
    sight.disconnect();
    resize.disconnect();
    revert();
    figure.removeAttribute('data-motion');
    drawHeroWires(stage);
  };
}
