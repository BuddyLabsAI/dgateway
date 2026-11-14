'use client';

import { animate } from 'animejs/animation';
import { createTimeline } from 'animejs/timeline';
import { createMotionPath } from 'animejs/svg';
import { cubicBezier } from 'animejs/easings';

const arrive = cubicBezier(0.23, 1, 0.32, 1);
type Playback = { revert: () => unknown; complete: () => unknown };

export function startLandingMotion(root: HTMLElement) {
  const playbacks: Playback[] = [];
  const observers: IntersectionObserver[] = [];
  const resizes: ResizeObserver[] = [];
  const originalStyles = new Map<Element, string | null>();
  const figures = [...root.querySelectorAll<HTMLElement>('.request-line')];
  let stopped = false;
  const finish = () => {
    if (stopped) return;
    stopped = true;
    observers.forEach((observer) => observer.disconnect());
    resizes.forEach((observer) => observer.disconnect());
    playbacks.forEach((playback) => playback.revert());
    originalStyles.forEach((style, element) => {
      if (style === null) element.removeAttribute('style');
      else element.setAttribute('style', style);
    });
    figures.forEach((figure) => {
      figure.removeAttribute('data-wires-ready');
      figure.setAttribute('data-motion-state', 'static');
    });
  };
  const onceVisible = (element: HTMLElement, play: () => void) => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        try {
          if (!stopped) play();
        } catch {
          finish();
        }
      },
      { threshold: 0.35 },
    );
    observers.push(observer);
    observer.observe(element);
  };

  const prepareJourney = (figure: HTMLElement) => {
    const fallback = figure.dataset.journey === 'fallback';
    const map = figure.querySelector<HTMLElement>('.request-map')!;
    const svg = map.querySelector<SVGSVGElement>('.request-wires')!;
    const paths = [...svg.querySelectorAll<SVGPathElement>('[data-wire]')];
    const dot = svg.querySelector<SVGCircleElement>('.request-dot')!;
    const lights = [...map.querySelectorAll<HTMLElement>('.station-light')];
    const details = map.querySelector<HTMLElement>('.answer-details')!;
    let timeline: ReturnType<typeof createTimeline> | undefined;
    let lastWidth = 0;
    const measure = () => {
      const bounds = map.getBoundingClientRect();
      const point = (name: string) => {
        const rect = map.querySelector(`[data-station="${name}"]`)!.getBoundingClientRect();
        return {
          x: rect.left - bounds.left + rect.width / 2,
          y: rect.top - bounds.top + rect.height / 2,
        };
      };
      const origin = point('origin'),
        route = point('route'),
        answer = point('answer');
      svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
      let routes = [`M${origin.x} ${origin.y}V${route.y}`, `M${route.x} ${route.y}V${answer.y}`];
      if (fallback) {
        const first = point('first'),
          next = point('next');
        const lane = answer.y - 22;
        routes = [
          routes[0],
          `M${route.x} ${route.y}V${first.y - 14}Q${route.x} ${first.y} ${route.x + 14} ${first.y}H${first.x}`,
          `M${first.x} ${first.y}H${next.x}`,
          `M${next.x} ${next.y}H${next.x + 16}Q${next.x + 28} ${next.y} ${next.x + 28} ${next.y + 12}V${lane - 12}Q${next.x + 28} ${lane} ${next.x + 16} ${lane}H${answer.x + 14}Q${answer.x} ${lane} ${answer.x} ${lane + 14}V${answer.y}`,
        ];
      }
      paths.forEach((path, index) => path.setAttribute('d', routes[index]));
      lastWidth = bounds.width;
    };
    onceVisible(figure, () => {
      measure();
      [...lights, details].forEach((element) => {
        originalStyles.set(element, element.getAttribute('style'));
        element.style.opacity = '0';
      });
      timeline = createTimeline({
        autoplay: false,
        defaults: { ease: arrive },
        onComplete: () => figure.setAttribute('data-motion-state', 'complete'),
      });
      playbacks.push(timeline);
      paths.forEach((path, index) => {
        const length = path.getTotalLength();
        path.setAttribute('stroke-dasharray', String(length));
        path.style.strokeDashoffset = String(length);
        timeline!.add(path, { strokeDashoffset: [length, 0], duration: 650 }, index * 85);
      });
      lights.forEach((light, index) =>
        timeline!.add(light, { opacity: [0, 1], scale: [0.9, 1], duration: 260 }, index * 140),
      );
      const arrival = fallback ? 3480 : 2200;
      timeline.add(details, { opacity: [0, 1], translateY: [6, 0], duration: 320 }, arrival);
      timeline.add(dot, { opacity: [0, 1], duration: 120 }, 900);
      const legs = fallback
        ? [
            [0, 400, 900],
            [1, 450, 1300],
            [2, 650, 2200],
            [3, 650, 2850],
          ]
        : [
            [0, 650, 900],
            [1, 650, 1550],
          ];
      legs.forEach(([index, duration, time]) => {
        const motion = createMotionPath(paths[index])!;
        timeline!.add(
          dot,
          {
            translateX: motion.translateX,
            translateY: motion.translateY,
            duration,
            ease: 'linear',
          },
          time,
        );
      });
      if (fallback) {
        const failure = map.querySelector<HTMLElement>('.failure-signal')!;
        timeline.add(failure, { opacity: [0, 1], translateY: [4, 0], duration: 180 }, 1770);
        timeline.add(failure, { opacity: 0, duration: 200 }, 2650);
      }
      timeline.add(dot, { opacity: 0, duration: 180 }, arrival);
      figure.setAttribute('data-wires-ready', '');
      figure.setAttribute('data-motion-state', 'playing');
      timeline.play();
      const resize = new ResizeObserver(() => {
        if (Math.abs(map.getBoundingClientRect().width - lastWidth) < 1) return;
        timeline?.complete();
        measure();
        paths.forEach((path) => {
          path.setAttribute('stroke-dasharray', 'none');
          path.style.strokeDashoffset = '0';
        });
      });
      resizes.push(resize);
      resize.observe(map);
    });
  };

  try {
    const headline = createTimeline({ defaults: { ease: arrive, duration: 600 } });
    playbacks.push(headline);
    root
      .querySelectorAll<HTMLElement>('[data-hero-line]')
      .forEach((line, index) =>
        headline.add(line, { opacity: [0, 1], translateY: [12, 0] }, index * 60),
      );
    root
      .querySelectorAll<HTMLElement>('.explainer-section, .local-section, .explore-section')
      .forEach((section) => {
        onceVisible(section, () =>
          playbacks.push(
            animate(section, { opacity: [0, 1], translateY: [16, 0], duration: 500, ease: arrive }),
          ),
        );
      });
    figures.forEach(prepareJourney);
  } catch {
    finish();
  }
  return finish;
}
