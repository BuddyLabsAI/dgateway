// A headline number that counts from its previous value to the new one. The text is written
// straight to the element, so counting never re-renders React.

import { useLayoutEffect, useRef } from "react";
import { tickNumber } from "../motion/motion";

const MISSING = "—";

export function Ticker({ value, format, className }: { value: number | null; format: (value: number) => string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef<number | null>(null);
  const formatRef = useRef(format);
  formatRef.current = format;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (value === null) {
      element.textContent = MISSING;
      previous.current = null;
      return;
    }
    const from = previous.current ?? 0;
    previous.current = value;
    return tickNumber(element, from, value, (current) => formatRef.current(current));
  }, [value]);

  return <span ref={ref} className={className} />;
}
