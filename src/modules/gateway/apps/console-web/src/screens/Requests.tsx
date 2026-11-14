import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../app/api-context";
import { hrefFor } from "../app/router";
import { useResource } from "../app/hooks";
import type { LogEntry, Provider, Route } from "../api/types";
import { connectionTitle, titleLookup } from "../domain/connections";
import { describeCost } from "../domain/cost";
import { latencyFraction, latencyScaleMax, logQuery, summariseLoaded, type FallbackFilter } from "../domain/logs";
import { formatMs, formatStamp, formatTokens } from "../domain/format";
import { answeredByLine, outcomeSentence } from "../domain/outcome";
import { CostCell } from "../ui/cost";
import { fadeIn, reveal } from "../motion/motion";
import { Button, Segmented, SelectField } from "../ui/controls";
import { AttemptsTimeline } from "../ui/attempts";
import { cx } from "../ui/cx";
import { JsonBlock } from "../ui/disclosure";
import { EmptyState, ErrorState, Flag, LoadingRows, Notice, PageHeader, describeError } from "../ui/feedback";
import { Icon } from "../ui/icons";
import { useNotify } from "../ui/toaster";

const PAGE_SIZE = 50;

const RESULT_OPTIONS = [
  { value: "all" as const, label: "All" },
  { value: "ok" as const, label: "Answered" },
  { value: "error" as const, label: "Failed" },
];

const FALLBACK_OPTIONS: { value: FallbackFilter; label: string }[] = [
  { value: "any", label: "Any" },
  { value: "used", label: "Used fallback" },
  { value: "none", label: "No fallback" },
];

interface Filters {
  route: string;
  provider: string;
  result: "all" | "ok" | "error";
  fallback: FallbackFilter;
}

const NO_FILTERS: Filters = { route: "", provider: "", result: "all", fallback: "any" };

/** Where an unpriced request's price is set: the model step that answered it. */
function priceHrefFor(item: LogEntry, routes: readonly Route[], providers: readonly Provider[]): string | null {
  const route = routes.find((candidate) => candidate.alias === item.route);
  if (!route) return null;
  const index = route.targets.findIndex(
    (target) => providers.find((provider) => provider.id === target.provider_id)?.name === item.provider && target.model === item.upstream_model,
  );
  return hrefFor("models", route.id, { step: index >= 0 ? String(index + 1) : undefined });
}

export function RequestsScreen({ initialModel, initialConnection }: { initialModel: string; initialConnection: string }) {
  const api = useApi();
  const notify = useNotify();
  const routes = useResource(() => api.listRoutes(), []);
  const providers = useResource(() => api.listProviders(), []);
  const [filters, setFilters] = useState<Filters>(() => ({ ...NO_FILTERS, route: initialModel, provider: initialConnection }));
  const titleOf = useMemo(() => titleLookup(providers.data ?? []), [providers.data]);

  const providerId = (name: string): string | undefined => providers.data?.find((provider) => provider.name === name)?.id;

  const [reloadToken, setReloadToken] = useState(0);
  const [items, setItems] = useState<LogEntry[]>([]);
  const [nextBefore, setNextBefore] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<unknown>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const requestId = useRef(0);
  const tableRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = ++requestId.current;
    setStatus("loading");
    setError(null);
    setExpanded(null);
    api
      .listLogs({ limit: PAGE_SIZE, ...logQuery(filters) })
      .then((page) => {
        if (id !== requestId.current) return;
        setItems(page.items);
        setNextBefore(page.next_before);
        setStatus("ready");
      })
      .catch((caught: unknown) => {
        if (id !== requestId.current) return;
        setError(caught);
        setStatus("error");
      });
  }, [api, filters, reloadToken]);

  useEffect(() => {
    if (status === "ready") fadeIn(tableRef.current);
  }, [status, filters]);

  const filtersActive = filters.route !== "" || filters.provider !== "" || filters.result !== "all" || filters.fallback !== "any";

  const loadOlder = async (): Promise<void> => {
    if (!nextBefore) return;
    const id = requestId.current;
    setLoadingOlder(true);
    try {
      const page = await api.listLogs({ limit: PAGE_SIZE, before: nextBefore, ...logQuery(filters) });
      if (id !== requestId.current) return;
      setItems((current) => [...current, ...page.items]);
      setNextBefore(page.next_before);
    } catch (caught) {
      notify(describeError(caught), "error");
    } finally {
      setLoadingOlder(false);
    }
  };

  const toggle = (id: string): void => setExpanded((current) => (current === id ? null : id));

  const scaleMax = latencyScaleMax(items);

  return (
    <div className="screen">
      <PageHeader
        title="Requests"
        subtitle="Every decision the gateway handled, newest first, with what happened in one sentence. Open a row for its attempts, cost and any captured payloads."
        actions={
          <Button variant="secondary" small onClick={() => setReloadToken((token) => token + 1)} disabled={status === "loading"}>
            <Icon name="refresh" size={14} className={cx(status === "loading" && "is-spinning")} />
            <span>Refresh</span>
          </Button>
        }
      />

      <div className="filters" role="group" aria-label="Filter requests">
        <span className="filters-label">
          <span>Filter</span>
          {filtersActive ? (
            <button type="button" className="filters-clear" onClick={() => setFilters(NO_FILTERS)}>
              Clear
            </button>
          ) : null}
        </span>
        <SelectField
          label="Model"
          value={filters.route}
          onChange={(event) => setFilters((current) => ({ ...current, route: event.target.value }))}
        >
          <option value="">All models</option>
          {filters.route && !(routes.data ?? []).some((route) => route.alias === filters.route) ? (
            <option value={filters.route}>{filters.route}</option>
          ) : null}
          {(routes.data ?? []).map((route) => (
            <option key={route.id} value={route.alias}>
              {route.alias}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Provider"
          value={filters.provider}
          onChange={(event) => setFilters((current) => ({ ...current, provider: event.target.value }))}
        >
          <option value="">All providers</option>
          {(providers.data ?? []).map((provider) => (
            <option key={provider.id} value={provider.name}>
              {connectionTitle(provider.name, provider.kind)}
            </option>
          ))}
        </SelectField>
        <div className="field">
          <div className="field-label">
            <span>Status</span>
          </div>
          <Segmented
            label="Status"
            options={RESULT_OPTIONS}
            value={filters.result}
            onChange={(result) => setFilters((current) => ({ ...current, result }))}
          />
        </div>
        <div className="field">
          <div className="field-label">
            <span>Fallback</span>
          </div>
          <Segmented
            label="Fallback"
            options={FALLBACK_OPTIONS}
            value={filters.fallback}
            onChange={(fallback) => setFilters((current) => ({ ...current, fallback }))}
          />
        </div>
      </div>

      {status === "error" && items.length === 0 ? (
        <ErrorState error={error} title="The log did not load" onRetry={() => setReloadToken((token) => token + 1)} />
      ) : null}

      {status === "loading" && items.length === 0 ? <LoadingRows rows={6} label="Loading requests" /> : null}

      {items.length > 0 ? (
        <p className="log-summary" aria-live="polite">
          {summariseLoaded(items)}
          <span className="muted"> · filters are applied by the gateway across the whole log</span>
        </p>
      ) : null}

      {status !== "loading" && items.length === 0 && status !== "error" ? (
        <EmptyState
          title={filtersActive ? "No requests match these filters" : "No requests yet"}
          action={
            filtersActive ? (
              <Button variant="secondary" small onClick={() => setFilters(NO_FILTERS)}>
                Clear filters
              </Button>
            ) : undefined
          }
        >
          {filtersActive
            ? "Try a wider filter, or clear them to see the newest requests."
            : "Requests appear here once an app calls the gateway, or once you run a decision in Try it."}
        </EmptyState>
      ) : null}

      {items.length > 0 ? (
        <div className="log-table panel" ref={tableRef}>
          <table className="sheet sheet--logs">
            <caption className="sr-only">Requests, newest first</caption>
            <thead>
              <tr>
                <th scope="col">Time</th>
                <th scope="col">Outcome</th>
                <th scope="col">Model</th>
                <th scope="col">Provider</th>
                <th scope="col" className="num col-latency">
                  Latency
                </th>
                <th scope="col" className="num">
                  Cost
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const open = expanded === item.id;
                return (
                  <Fragment key={item.id}>
                    <tr className={cx(item.status === "error" && "is-failed", open && "is-open")}>
                      <th scope="row" className="log-time">
                        <button
                          type="button"
                          className="row-toggle"
                          aria-expanded={open}
                          aria-controls={open ? `log-detail-${item.id}` : undefined}
                          onClick={() => toggle(item.id)}
                        >
                          <Icon name="chevron" size={14} className={cx("row-chevron", open && "row-chevron--open")} />
                          <span className="mono">{formatStamp(Date.parse(item.ts))}</span>
                        </button>
                      </th>
                      <td>
                        <span className="log-outcome">
                          <Flag tone={item.status === "error" ? "error" : item.fallback_used ? "warn" : "ok"}>{item.http_status}</Flag>
                          <span className={cx("outcome-sentence", item.status === "error" && "outcome-sentence--failed")}>
                            {outcomeSentence(item, titleOf)}
                          </span>
                        </span>
                      </td>
                      <td>
                        {item.route ? (
                          <a className="mono cell-ref" href={hrefFor("models", item.route)}>
                            {item.route}
                          </a>
                        ) : (
                          <span className="muted">direct</span>
                        )}
                      </td>
                      <td>
                        {providerId(item.provider) ? (
                          <a className="cell-ref" href={hrefFor("providers", providerId(item.provider))}>
                            {titleOf(item.provider)}
                          </a>
                        ) : (
                          <span>{titleOf(item.provider)}</span>
                        )}
                        <span className="mono model-cell" title={item.upstream_model}>
                          {item.upstream_model}
                        </span>
                      </td>
                      <td className="num">
                        <span className="latency">
                          <span className="latency-track" aria-hidden="true">
                            <span
                              className={cx("latency-fill", item.status === "error" && "latency-fill--fail")}
                              style={{ transform: `scaleX(${latencyFraction(item.latency_ms, scaleMax)})` }}
                            />
                          </span>
                          <span className="latency-value">{formatMs(item.latency_ms)}</span>
                        </span>
                      </td>
                      <td className="num">
                        <CostCell
                          fields={item}
                          failed={item.status === "error"}
                          priceHref={priceHrefFor(item, routes.data ?? [], providers.data ?? [])}
                        />
                      </td>
                    </tr>
                    {open ? (
                      <tr className="log-detail" id={`log-detail-${item.id}`}>
                        <td colSpan={6}>
                          <LogDetail item={item} titleOf={titleOf} />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {nextBefore ? (
        <div className="row-start log-more">
          <Button variant="secondary" onClick={() => void loadOlder()} disabled={loadingOlder}>
            {loadingOlder ? "Loading older requests…" : "Load older requests"}
          </Button>
        </div>
      ) : null}
      {!nextBefore && items.length > 0 ? <p className="field-hint log-more">That is the oldest request in the log.</p> : null}
    </div>
  );
}

function LogDetail({ item, titleOf }: { item: LogEntry; titleOf: (name: string) => string }) {
  const ref = useRef<HTMLDivElement>(null);
  const captured = item.request !== undefined || item.response !== undefined;
  const cost = describeCost(item, item.status === "error");

  useEffect(() => {
    reveal(ref.current);
  }, []);

  return (
    <div className="log-detail-body" ref={ref}>
      <dl className="facts facts--grid">
        <div>
          <dt>Request id</dt>
          <dd className="mono">{item.id}</dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd className="mono">{new Date(item.ts).toLocaleString()}</dd>
        </div>
        <div>
          <dt>HTTP status</dt>
          <dd className="mono">{item.http_status}</dd>
        </div>
        <div>
          <dt>Questions</dt>
          <dd className="mono">{item.questions}</dd>
        </div>
        {item.status === "ok" ? (
          <div>
            <dt>Answered by</dt>
            <dd className="mono">{answeredByLine(item, titleOf)}</dd>
          </div>
        ) : null}
        <div>
          <dt>Input tokens</dt>
          <dd className="mono">{formatTokens(item.prompt_tokens)}</dd>
        </div>
        <div>
          <dt>Cost</dt>
          <dd>
            <span className="mono">{cost.text}</span> <span className="muted">{cost.detail}</span>
          </dd>
        </div>
      </dl>
      {item.error ? (
        <Notice tone="error" title="Error">
          {item.error}
        </Notice>
      ) : null}
      <div className="log-detail-block">
        <h3 className="result-subhead">Attempts</h3>
        <AttemptsTimeline attempts={item.attempts} />
      </div>
      {captured ? (
        <div className="trace-blocks">
          <JsonBlock label="Request" value={item.request} empty="Not captured." />
          <JsonBlock label="Response" value={item.response} empty="No response was returned." />
        </div>
      ) : (
        <Notice tone="info" title="Payloads were not captured">
          Capture was off when this request ran. Turn on capture in <a href={hrefFor("settings")}>Settings</a> to store request and response
          bodies from now on.
        </Notice>
      )}
    </div>
  );
}
