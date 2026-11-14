// A test while it runs: a dial that pulses while the call is in flight and a live elapsed clock, beside how long
// it may take. The result replaces it (ui/test-result.tsx). Used on the Providers cards, the Add provider test step
// and each step in the model editor.

import { useEffect, useRef } from "react";
import { formatMs } from "../domain/format";
import { runClock } from "../motion/motion";

export function TestRunning({
  subject,
  timeoutMs,
}: {
  /** What is being called, for the label: "OpenAI". */
  subject: string;
  timeoutMs: number;
}) {
  const clockRef = useRef<HTMLSpanElement>(null);

  useEffect(() => runClock(clockRef.current, (ms) => `${(ms / 1000).toFixed(2)} s`), []);

  return (
    <div className="readout readout--running" role="status" aria-live="polite">
      <span className="readout-dial" aria-hidden="true">
        <span className="readout-pulse" />
      </span>
      <div className="readout-main">
        <p className="readout-label">
          Calling {subject}. This can take up to {formatMs(timeoutMs)}.
        </p>
        <p className="readout-value">
          <span ref={clockRef} className="mono" />
        </p>
      </div>
    </div>
  );
}
