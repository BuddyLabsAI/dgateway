import { useEffect, useMemo, useRef, useState } from "react";
import { useApi } from "../app/api-context";
import { hrefFor } from "../app/router";
import { useNow, useResource, useVisibleInterval } from "../app/hooks";
import { FIRST_RUN_DISMISSED, usePreferenceFlag } from "../app/preferences";
import type { Health, PlaygroundRun, Provider, ProviderModel, Route, Stats, StatsWindow } from "../api/types";
import { checklistState, realModels, type ChecklistState, type ChecklistStepId } from "../domain/checklist";
import { CONNECTION_MARK, connectionStatus, connectionTitle, titleLookup, type ConnectionStatus } from "../domain/connections";
import { windowCost } from "../domain/cost";
import { formatCount, formatMs, formatRatio, formatRelative, formatUptime } from "../domain/format";
import {
  ERROR_RATE_LIMITS,
  STATUS_WORD,
  networkLines,
  providerHealth,
  type KeyReadiness,
  type NetworkLine,
  type ProviderHealthRow,
  type StationVerdict,
} from "../domain/health";
import { modelTally } from "../domain/models";
import { sampleDecision } from "../domain/playground";
import { enterOnce } from "../motion/motion";
import { Button, Segmented } from "../ui/controls";
import { CostTotal, GroupCost } from "../ui/cost";
import { connectionPricing, modelPricing, pricingWithTraffic } from "../domain/pricing";
import { loadCatalogs } from "../ui/catalog";
import { cx } from "../ui/cx";
import { DecisionResult } from "../ui/decision-result";
import { EmptyState, ErrorState, LoadingRows, PageHeader, Section, describeError } from "../ui/feedback";
import { Icon } from "../ui/icons";
import { RouteLine } from "../ui/network";
import { StationMark, StatusChip } from "../ui/status";
import { TrafficChart } from "../ui/traffic-chart";

const WINDOW_OPTIONS = [
  { value: "1h" as const, label: "1h" },
  { value: "24h" as const, label: "24h" },
  { value: "7d" as const, label: "7d" },
];

const WINDOW_WORDS: Record<StatsWindow, string> = { "1h": "last hour", "24h": "last 24 h", "7d": "last 7 days" };

const KEY_WORD: Record<KeyReadiness, string> = { ready: "key ready", missing: "needs a key", none: "no key needed", unknown: "key unknown" };

export function OverviewScreen() {
  const api = useApi();
  const [windowChoice, setWindowChoice] = useState<StatsWindow>("24h");
  const stats = useResource(() => api.stats(windowChoice), [windowChoice]);
  const health = useResource(() => api.health(), []);
  const routes = useResource(() => api.listRoutes(), []);
  const providers = useResource(() => api.listProviders(), []);
  // The catalogs of the OpenAI connections: an OpenAI step's default price comes from them. Other kinds need none here.
  const openaiIds = (providers.data ?? []).filter((provider) => provider.kind === "openai").map((provider) => provider.id);
  const catalogs = useResource(() => loadCatalogs(api, openaiIds), [openaiIds.join(",")]);

  const reloadLive = (): void => {
    stats.reload();
    health.reload();
  };

  const reloadAll = (): void => {
    reloadLive();
    routes.reload();
    providers.reload();
  };

  useVisibleInterval(reloadLive, 30_000);
  const now = useNow(15_000);

  return (
    <div className="screen screen--overview">
      <PageHeader
        title="Overview"
        subtitle={<OverviewSubtitle health={health.data} updatedAt={stats.updatedAt} now={now} />}
        actions={
          <>
            <Segmented label="Time window" options={WINDOW_OPTIONS} value={windowChoice} onChange={setWindowChoice} />
            <Button variant="secondary" small onClick={reloadAll} disabled={stats.refreshing} aria-label="Refresh overview">
              <Icon name="refresh" size={14} className={cx(stats.refreshing && "is-spinning")} />
              <span>Refresh</span>
            </Button>
          </>
        }
      />

      {routes.data && providers.data ? (
        <StatusStrip routes={routes.data} providers={providers.data} stats={stats.data} window={windowChoice} />
      ) : null}

      {routes.data && providers.data ? (
        <FirstRun routes={routes.data} providers={providers.data} stats={stats.data} onChanged={reloadAll} />
      ) : null}

      {!stats.data && stats.status === "loading" ? <LoadingRows rows={6} label="Loading the overview" /> : null}
      {!stats.data && stats.status === "error" ? (
        <ErrorState error={stats.error} title="The overview did not load" onRetry={stats.reload} />
      ) : null}

      {stats.data ? (
        <OverviewBody
          stats={stats.data}
          health={health.data}
          routes={routes.data}
          providers={providers.data}
          catalogs={catalogs.data}
        />
      ) : null}
    </div>
  );
}

function OverviewSubtitle({ health, updatedAt, now }: { health: Health | undefined; updatedAt: number | null; now: number }) {
  if (!health) return <>Checking the gateway…</>;
  return (
    <>
      Gateway <span className="mono">{health.version}</span> · up {formatUptime(health.uptime_s)}
      {updatedAt ? ` · updated ${formatRelative(updatedAt, now)}` : ""}
    </>
  );
}

const CONNECTION_ORDER: ConnectionStatus[] = ["connected", "needs-key", "disabled"];

const CONNECTION_TALLY_WORD: Record<ConnectionStatus, [string, string]> = {
  connected: ["connected", "connected"],
  "needs-key": ["needs a key", "need a key"],
  disabled: ["disabled", "disabled"],
};

/** The one-line status at the top: models, connections, and the window's requests, errors and cost. */
function StatusStrip({
  routes,
  providers,
  stats,
  window: windowId,
}: {
  routes: Route[];
  providers: Provider[];
  stats: Stats | undefined;
  window: StatsWindow;
}) {
  const models = modelTally(routes, providers);
  const connections: Record<ConnectionStatus, number> = { connected: 0, "needs-key": 0, disabled: 0 };
  for (const provider of providers) connections[connectionStatus(provider)] += 1;
  const answered = stats ? stats.requests - stats.errors : 0;
  const cost = stats ? windowCost(stats.cost_usd, stats.unpriced, Math.max(0, answered - (stats.unpriced ?? 0))) : null;

  return (
    <section className="strip panel" aria-label="Status">
      <a className="strip-item" href={hrefFor("models")}>
        <span className="strip-label">Models</span>
        <span className="strip-value">
          <span className="strip-part">
            <StationMark status="ok" size={10} />
            <span>
              <span className="mono">{models.ready}</span> ready
            </span>
          </span>
          {models.attention > 0 ? (
            <span className="strip-part strip-part--alert">
              <StationMark status="degraded" size={10} />
              <span>
                <span className="mono">{models.attention}</span> {models.attention === 1 ? "needs" : "need"} attention
              </span>
            </span>
          ) : null}
          {models.off > 0 ? (
            <span className="strip-part strip-part--quiet">
              <StationMark status="disabled" size={10} />
              <span>
                <span className="mono">{models.off}</span> off
              </span>
            </span>
          ) : null}
        </span>
      </a>
      <a className="strip-item" href={hrefFor("providers")}>
        <span className="strip-label">Providers</span>
        <span className="strip-value">
          {CONNECTION_ORDER.filter((status) => connections[status] > 0).map((status) => (
            <span
              key={status}
              className={cx("strip-part", status === "needs-key" && "strip-part--fail", status === "disabled" && "strip-part--quiet")}
            >
              <StationMark status={CONNECTION_MARK[status]} size={10} />
              <span>
                <span className="mono">{connections[status]}</span> {CONNECTION_TALLY_WORD[status][connections[status] === 1 ? 0 : 1]}
              </span>
            </span>
          ))}
        </span>
      </a>
      <a className="strip-item" href={hrefFor("requests")}>
        <span className="strip-label">Requests, {WINDOW_WORDS[windowId]}</span>
        <span className="strip-value">
          {stats ? (
            <>
              <span className="strip-part">
                <span className="mono">{formatCount(stats.requests)}</span>
              </span>
              <span className={cx("strip-part", stats.errors > 0 && "strip-part--fail")}>
                <span>
                  <span className="mono">{formatCount(stats.errors)}</span> {stats.errors === 1 ? "error" : "errors"}
                  {stats.requests > 0 ? <span className="strip-note mono"> {formatRatio(stats.errors / stats.requests)}</span> : null}
                </span>
              </span>
            </>
          ) : (
            <span className="strip-part strip-part--quiet">Loading…</span>
          )}
        </span>
      </a>
      <div className="strip-item strip-item--static">
        <span className="strip-label">Cost, {WINDOW_WORDS[windowId]}</span>
        <span className="strip-value">
          {cost ? (
            <>
              <span className="strip-part">
                <CostTotal value={stats?.cost_usd} />
              </span>
              {cost.unpriced > 0 ? (
                <span className="strip-part strip-part--quiet" title="Answered requests on a model step with no known price">
                  <span>
                    <span className="mono">{formatCount(cost.unpriced)}</span> unpriced
                  </span>
                </span>
              ) : null}
              {(stats?.output_unpriced ?? 0) > 0 ? (
                <span className="strip-part strip-part--quiet" title="Answered requests whose cost covers input only: output tokens had no known price">
                  <span>
                    <span className="mono">{formatCount(stats?.output_unpriced ?? 0)}</span> without output cost
                  </span>
                </span>
              ) : null}
              {cost.perMillion ? <span className="strip-part strip-part--quiet mono">{cost.perMillion}</span> : null}
            </>
          ) : (
            <span className="strip-part strip-part--quiet">{stats ? "Not reported" : "Loading…"}</span>
          )}
        </span>
      </div>
    </section>
  );
}

const STEP_COPY: Record<ChecklistStepId, { title: string; todo: string }> = {
  connect: {
    title: "Connect a provider",
    todo: "Paste an OpenAI or OpenRouter key, or turn on a server you run. The mock does not count: it is for trying things out.",
  },
  model: { title: "Add a model", todo: "Give your apps a model name to send. The model tries that provider first, then a fallback if you add one." },
  test: { title: "Send a test decision", todo: "Send one small decision through that model to see its answer, its latency and its cost." },
};

function FirstRun({
  routes,
  providers,
  stats,
  onChanged,
}: {
  routes: Route[];
  providers: Provider[];
  stats: Stats | undefined;
  onChanged: () => void;
}) {
  const api = useApi();
  const [dismissed, setDismissed] = usePreferenceFlag(FIRST_RUN_DISMISSED);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const candidates = useMemo(() => realModels(routes, providers).map((route) => route.alias), [routes, providers]);
  const fromStats = useMemo(
    () => new Set((stats?.by_route ?? []).filter((row) => row.requests - row.errors > 0).map((row) => row.route)),
    [stats],
  );
  const candidateKey = candidates.join(",");

  useEffect(() => {
    if (dismissed || candidates.length === 0) return;
    let live = true;
    void Promise.all(
      candidates.slice(0, 6).map((alias) =>
        api
          .listLogs({ route: alias, status: "ok", limit: 1 })
          .then((page) => (page.items.length > 0 ? alias : null))
          .catch(() => null),
      ),
    ).then((found) => {
      if (live) setAnswered(new Set(found.filter((alias): alias is string => alias !== null)));
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- candidateKey stands for the candidate list.
  }, [api, candidateKey, dismissed]);

  const state = checklistState({ providers, routes, answeredModels: new Set([...answered, ...fromStats]), dismissed });
  if (!state.visible) return null;
  return <Checklist state={state} providers={providers} onDismiss={() => setDismissed(true)} onChanged={onChanged} />;
}

function stepAction(id: ChecklistStepId, state: ChecklistState, providers: readonly Provider[]): { href: string; label: string } {
  if (id === "connect") {
    const waiting = providers.find((provider) => provider.kind !== "mock" && connectionStatus(provider) === "needs-key");
    return { href: waiting ? hrefFor("providers", waiting.id) : hrefFor("providers"), label: "Connect a provider" };
  }
  if (id === "model") {
    return { href: hrefFor("models", "new", { connection: state.connection?.id }), label: "Add a model" };
  }
  return { href: hrefFor("try", null, { model: state.model?.alias }), label: state.model ? `Try ${state.model.alias}` : "Open Try it" };
}

function doneText(id: ChecklistStepId, state: ChecklistState): string {
  if (id === "connect" && state.connection) return `${connectionTitle(state.connection.name, state.connection.kind)} is connected.`;
  if (id === "model" && state.model) return `${state.model.alias} is ready for your apps.`;
  return "Done.";
}

function Checklist({
  state,
  providers,
  onDismiss,
  onChanged,
}: {
  state: ChecklistState;
  providers: Provider[];
  onDismiss: () => void;
  onChanged: () => void;
}) {
  const api = useApi();
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<PlaygroundRun | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const mock = providers.find((provider) => provider.kind === "mock" && provider.enabled);
  const titleOf = titleLookup(providers);

  const tryMock = async (): Promise<void> => {
    if (!mock) return;
    setRunning(true);
    setRunError(null);
    try {
      setRun(await api.runPlayground(sampleDecision(`${mock.name}::mock-1`)));
      onChanged();
    } catch (caught) {
      setRunError(caught);
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="panel checklist" aria-labelledby="checklist-title">
      <header className="section-head">
        <div className="section-head-text">
          <h2 id="checklist-title">Get your first decision through</h2>
          <p className="section-meta">
            <span className="mono">{state.done}</span> of <span className="mono">{state.steps.length}</span> done. This list goes away when you finish all
            three or dismiss it.
          </p>
        </div>
        <div className="section-actions">
          <Button variant="quiet" small onClick={onDismiss}>
            <Icon name="close" size={14} />
            <span>Dismiss</span>
          </Button>
        </div>
      </header>

      <div className="checklist-body">
        <ol className="checklist-steps">
          {state.steps.map((step, index) => {
            const copy = STEP_COPY[step.id];
            const action = stepAction(step.id, state, providers);
            const current = state.current === step.id;
            return (
              <li key={step.id} className={cx("checklist-step", step.done && "is-done", current && "is-current")}>
                <span className="checklist-rail" aria-hidden="true">
                  <span className="checklist-station">
                    {step.done ? <Icon name="check" size={12} /> : <span className="mono">{index + 1}</span>}
                  </span>
                </span>
                <div className="checklist-text">
                  <p className="checklist-title">
                    {copy.title}
                    <span className="sr-only">{step.done ? " (done)" : " (to do)"}</span>
                  </p>
                  <p className="checklist-detail">{step.done ? doneText(step.id, state) : copy.todo}</p>
                </div>
                {!step.done ? (
                  <a className={cx("btn btn--small", current ? "btn--primary" : "btn--secondary")} href={action.href}>
                    <span>{action.label}</span>
                    <Icon name="arrow-right" size={14} />
                  </a>
                ) : null}
              </li>
            );
          })}
        </ol>

        <div className="checklist-aside">
          <p className="checklist-title">No key yet? Try the mock now</p>
          <p className="checklist-detail">
            One click sends a small decision to the built-in mock, which is free and needs no key, so you can see what a result looks like.
          </p>
          <div className="row-start">
            <Button variant="secondary" onClick={() => void tryMock()} disabled={running || !mock}>
              <Icon name="bolt" size={14} />
              <span>{running ? "Sending…" : run ? "Send another" : "Try the mock now"}</span>
            </Button>
            {run ? (
              <a className="btn btn--quiet btn--small" href={hrefFor("try", null, { model: mock ? `${mock.name}::mock-1` : undefined })}>
                Open in Try it
              </a>
            ) : null}
          </div>
          {!mock ? <p className="field-hint">The mock provider is disabled or missing.</p> : null}
          {runError ? <p className="field-error">{describeError(runError)}</p> : null}
          {run ? <DecisionResult run={run} titleOf={titleOf} /> : null}
        </div>
      </div>
    </section>
  );
}

function OverviewBody({
  stats,
  health,
  routes,
  providers,
  catalogs,
}: {
  stats: Stats;
  health: Health | undefined;
  routes: Route[] | undefined;
  providers: Provider[] | undefined;
  /** Each connection's model catalog, by connection id; undefined until they have loaded. */
  catalogs: ReadonlyMap<string, readonly ProviderModel[]> | undefined;
}) {
  const rows = useMemo(() => providerHealth(health?.providers ?? [], stats.by_provider, providers ?? []), [health, stats, providers]);
  const verdicts = useMemo(
    () => new Map<string, StationVerdict>(rows.map((row) => [row.name, { status: row.status, reason: row.reason }])),
    [rows],
  );
  const lines = useMemo(() => networkLines(routes ?? [], providers ?? [], stats.by_route, verdicts), [routes, providers, stats, verdicts]);
  const direct = stats.by_route.find((row) => row.route === "(direct)");
  const bodyRef = useRef<HTMLDivElement>(null);
  const showCost = stats.cost_usd !== undefined;

  useEffect(() => {
    enterOnce("overview", bodyRef.current?.querySelectorAll("[data-enter]"));
  }, []);

  return (
    <div className="overview" ref={bodyRef}>
      <section className="panel panel--hero" data-enter aria-label="Traffic">
        <TrafficChart
          buckets={stats.timeseries}
          window={stats.window}
          requests={stats.requests}
          errors={stats.errors}
          fallbacks={stats.fallbacks}
          fallbacksAnswered={stats.fallbacks_answered}
          p50={stats.p50_ms}
          p95={stats.p95_ms}
        />
      </section>

      <div className="overview-grid">
        <div data-enter>
          <Section variant="panel" title="Providers" id="connections-health" meta="How each provider did in this window, worst first.">
            {rows.length === 0 ? (
              <EmptyState title="No providers yet">
                <a href={hrefFor("providers", "new")}>Add a provider</a> to start sending decisions.
              </EmptyState>
            ) : (
              <ConnectionHealthTable rows={rows} showCost={showCost} routes={routes ?? []} providers={providers ?? []} catalogs={catalogs} />
            )}
            <p className="panel-foot">
              Failing: it needs a key, or {Math.round(ERROR_RATE_LIMITS.failing * 100)}% or more of its requests failed in this window. Degraded:{" "}
              {Math.round(ERROR_RATE_LIMITS.degraded * 100)}% or more failed.
            </p>
          </Section>
        </div>

        <div data-enter>
          <Section
            variant="panel"
            title="Network"
            id="network"
            meta="Each model is a line, and each station on it is a step. Steps are tried left to right; a dashed track marks a skipped step."
          >
            {!routes ? <LoadingRows rows={3} label="Loading models" /> : null}
            {routes && lines.length === 0 ? (
              <EmptyState title="No models yet">
                <a href={hrefFor("models", "new")}>Add a model</a> so apps have a name to send.
              </EmptyState>
            ) : null}
            {lines.length > 0 ? (
              <ul className="network">
                {lines.map((line) => (
                  <li key={line.id} className={cx("network-line", !line.enabled && "network-line--off")}>
                    <div className="network-head">
                      <a href={hrefFor("models", line.id)} className={`line-badge ink-${line.ink}`}>
                        <span className="line-badge-swatch" aria-hidden="true" />
                        <span className="mono">{line.alias}</span>
                      </a>
                      {!line.enabled ? <StatusChip status="disabled" /> : null}
                      <dl className="network-figures">
                        <div>
                          <dt>Requests</dt>
                          <dd className="mono">{formatCount(line.requests)}</dd>
                        </div>
                        <div className={cx(line.errors > 0 && "is-alert")}>
                          <dt>Errors</dt>
                          <dd className="mono">{formatRatio(line.errorRate)}</dd>
                        </div>
                        <div>
                          <dt>Median</dt>
                          <dd className="mono">{formatMs(line.p50)}</dd>
                        </div>
                        {showCost ? (
                          <div>
                            <dt>Cost</dt>
                            <dd className="mono">
                              <LineCost line={line} routes={routes ?? []} providers={providers ?? []} catalogs={catalogs} />
                            </dd>
                          </div>
                        ) : null}
                      </dl>
                    </div>
                    <RouteLine stops={line.stations} ink={line.ink} label={`Fallback order for ${line.alias}`} muted={!line.enabled} />
                  </li>
                ))}
              </ul>
            ) : null}
            {direct ? (
              <p className="panel-foot">
                <span className="mono">{formatCount(direct.requests)}</span> requests named <span className="mono">provider::model</span>{" "}
                directly and skipped models.
              </p>
            ) : null}
          </Section>
        </div>
      </div>
    </div>
  );
}

function LineCost({
  line,
  routes,
  providers,
  catalogs,
}: {
  line: NetworkLine;
  routes: Route[];
  providers: Provider[];
  catalogs: ReadonlyMap<string, readonly ProviderModel[]> | undefined;
}) {
  const route = routes.find((candidate) => candidate.id === line.id);
  if (!route) return <CostTotal value={line.cost} />;
  const view = modelPricing(route, providers, catalogs);
  return (
    <GroupCost
      value={line.cost}
      pricing={pricingWithTraffic(view.pricing, line)}
      priceHref={hrefFor("models", route.id, { step: view.unpricedStep ? String(view.unpricedStep) : undefined })}
    />
  );
}

function ConnectionHealthTable({
  rows,
  showCost,
  routes,
  providers,
  catalogs,
}: {
  rows: readonly ProviderHealthRow[];
  showCost: boolean;
  routes: Route[];
  providers: readonly Provider[];
  catalogs: ReadonlyMap<string, readonly ProviderModel[]> | undefined;
}) {
  return (
    <div className="table-scroll">
      <table className="sheet sheet--health">
        <caption className="sr-only">Provider health, key readiness, traffic and cost in this window, worst first</caption>
        <thead>
          <tr>
            <th scope="col">Provider</th>
            <th scope="col">Status</th>
            <th scope="col">Requests</th>
            <th scope="col" className="num">
              Errors
            </th>
            <th scope="col" className="num">
              Median
            </th>
            {showCost ? (
              <th scope="col" className="num">
                Cost
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className={cx(row.status === "disabled" && "is-muted")}>
              <th scope="row">
                <a href={row.providerId ? hrefFor("providers", row.providerId) : hrefFor("providers")} className="cell-link">
                  <span className="cell-strong">{row.title}</span>
                  <span className="cell-sub">
                    
                    <span className={cx("key-state", `key-state--${row.key}`)}>
                      {row.key === "missing" ? <StationMark status="failing" size={9} /> : null}
                      {KEY_WORD[row.key]}
                    </span>
                  </span>
                </a>
              </th>
              <td>
                <StatusChip status={row.status}>{row.status === "ok" ? STATUS_WORD.ok : row.reason}</StatusChip>
              </td>
              <td>
                <span className="share">
                  <span className="share-track" aria-hidden="true">
                    <span className="share-fill" style={{ transform: `scaleX(${row.share})` }} />
                  </span>
                  <span className="share-value mono">{formatCount(row.requests)}</span>
                </span>
              </td>
              <td className={cx("num", row.errors > 0 && "num--alert")}>{formatRatio(row.errorRate)}</td>
              <td className="num">{formatMs(row.p50)}</td>
              {showCost ? (
                <td className="num">
                  <GroupCost
                    value={row.cost}
                    pricing={pricingWithTraffic(
                      connectionPricing(
                        providers.find((provider) => provider.id === row.providerId) ?? {
                          id: row.providerId ?? "",
                          kind: row.kind ?? "openai-compatible",
                        },
                        routes,
                        catalogs?.get(row.providerId ?? ""),
                      ),
                      row,
                    )}
                  />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
