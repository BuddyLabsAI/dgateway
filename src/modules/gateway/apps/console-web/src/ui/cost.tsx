// Cost on screen. Every amount says what it is: billed by the provider, a priced figure, an
// estimate, or unpriced with a way to set a price. The words come from domain/cost.ts.

import { describeCost, formatUsd, type CostFields } from "../domain/cost";
import type { GroupPricing } from "../domain/pricing";
import { cx } from "./cx";

/** One request's cost for a table cell. Unpriced links to the model step where a price is set. */
export function CostCell({ fields, failed = false, priceHref }: { fields: CostFields; failed?: boolean; priceHref?: string | null }) {
  const view = describeCost(fields, failed);
  if (view.kind === "unpriced" && priceHref) {
    return (
      <a className="cost cost--unpriced" href={priceHref} title={view.detail}>
        Unpriced
      </a>
    );
  }
  return (
    <span className={cx("cost", `cost--${view.kind}`)} title={view.detail}>
      {view.text}
      {view.kind === "estimated" ? <span className="cost-est"> est.</span> : null}
      {view.kind === "billed" ? <span className="cost-est"> billed</span> : null}
    </span>
  );
}

/**
 * A window or group total: the amount, plus how many answered requests went unpriced. Null means
 * the gateway did not report cost at all, which is not the same as zero.
 */
export function CostTotal({ value, unpriced = 0 }: { value: number | null | undefined; unpriced?: number }) {
  if (value === null || value === undefined)
    return (
      <span className="cost cost--none" title="The gateway did not report cost.">
        —
      </span>
    );
  return (
    <span className="cost">
      {formatUsd(value)}
      {unpriced > 0 ? <span className="cost-est"> + {unpriced.toLocaleString("en-US")} unpriced</span> : null}
    </span>
  );
}

/**
 * A model's or a connection's cost in a window, told apart from free and unpriced: "Free" when
 * nothing it uses costs anything, "Unpriced" (a link to the step to price) when nothing could be
 * priced, and the amount with "+ unpriced" when only some of it could.
 */
export function GroupCost({ value, pricing, priceHref }: { value: number | null | undefined; pricing: GroupPricing; priceHref?: string | null }) {
  if (value === null || value === undefined) return <CostTotal value={value} />;
  if (pricing === "free" && value === 0) {
    return (
      <span className="cost cost--free" title="Every step has a zero input price.">
        Free
      </span>
    );
  }
  if (pricing === "unpriced" && value === 0) {
    const title = "No step has a known price, so these requests are not counted. Set a price on the step.";
    return priceHref ? (
      <a className="cost cost--unpriced" href={priceHref} title={title}>
        Unpriced
      </a>
    ) : (
      <span className="cost cost--unpriced" title={title}>
        Unpriced
      </span>
    );
  }
  if (pricing === "unpriced" || pricing === "partly-unpriced") {
    return (
      <span className="cost" title="Some requests went to a step with no known price and are not counted.">
        {formatUsd(value)}
        <span className="cost-est"> + unpriced</span>
      </span>
    );
  }
  return <CostTotal value={value} />;
}
