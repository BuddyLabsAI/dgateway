import { useMemo, useState } from "react";
import { useApi } from "../app/api-context";
import { hrefFor } from "../app/router";
import { useResource } from "../app/hooks";
import type { PlaygroundRun, Provider, Route } from "../api/types";
import { loadCatalogs } from "../ui/catalog";
import { titleLookup } from "../domain/connections";
import { formatCount, formatMs, formatRatio } from "../domain/format";
import { knownAnswerRequest } from "../domain/known-answer";
import { modelRows, type ModelRow } from "../domain/models";
import { equivalentCurl, sampleDecision } from "../domain/playground";
import { runOutcome } from "../domain/test-result";
import { ChainText } from "../ui/chain";
import { Button } from "../ui/controls";
import { GroupCost } from "../ui/cost";
import { cx } from "../ui/cx";
import { CopyButton } from "../ui/disclosure";
import { EmptyState, ErrorState, LoadingRows, PageHeader, describeError } from "../ui/feedback";
import { Icon } from "../ui/icons";
import { StatusChip } from "../ui/status";
import { TestResult } from "../ui/test-result";

/** The step a decision was answered by, 1-based, for "Set a price" links. */
export function answeringStep(route: Route, providers: readonly Provider[], run: PlaygroundRun): number | null {
  const gateway = run.response?.gateway;
  if (!gateway) return null;
  const index = route.targets.findIndex(
    (target) =>
      providers.find((provider) => provider.id === target.provider_id)?.name === gateway.provider && target.model === gateway.upstream_model,
  );
  return index >= 0 ? index + 1 : null;
}

export function ModelsScreen() {
  const api = useApi();
  const routes = useResource(() => api.listRoutes(), []);
  const providers = useResource(() => api.listProviders(), []);
  const stats = useResource(() => api.stats("24h"), []);
  const settings = useResource(() => api.getSettings(), []);
  // The catalogs of the OpenAI connections: an OpenAI step's default price comes from them. Other kinds need none here.
  const openaiIds = (providers.data ?? []).filter((provider) => provider.kind === "openai").map((provider) => provider.id);
  const catalogs = useResource(() => loadCatalogs(api, openaiIds), [openaiIds.join(",")]);
  const rows = useMemo(
    () => modelRows(routes.data ?? [], providers.data ?? [], stats.data?.by_route ?? [], catalogs.data),
    [routes.data, providers.data, stats.data, catalogs.data],
  );
  const showCost = stats.data ? stats.data.cost_usd !== undefined : true;

  return (
    <div className="screen">
      <PageHeader
        title="Models"
        subtitle={
          <>
            The names your apps send as <span className="mono">model</span>. Each one tries its first step, and falls back to the next only when
            that one fails or times out.
          </>
        }
        actions={
          <a className="btn btn--primary btn--small" href={hrefFor("models", "new")}>
            <Icon name="plus" size={14} />
            <span>Add model</span>
          </a>
        }
      />

      {routes.status === "loading" && !routes.data ? <LoadingRows rows={4} label="Loading models" /> : null}
      {routes.status === "error" && !routes.data ? (
        <ErrorState error={routes.error} title="Models did not load" onRetry={routes.reload} />
      ) : null}

      {routes.data && routes.data.length === 0 ? (
        <EmptyState
          title="No models yet"
          action={
            <a className="btn btn--primary btn--small" href={hrefFor("models", "new")}>
              Add a model
            </a>
          }
        >
          A model is the name your apps send. Pick a provider and an upstream model, and the gateway does the rest.
        </EmptyState>
      ) : null}

      {routes.data && routes.data.length > 0 ? (
        <section className="panel model-list-panel" aria-label="Models">
          <div className="model-list-head" aria-hidden="true">
            <span>Model and its chain</span>
            <span className="model-figures-head">
              <span>Requests, 24 h</span>
              <span>Errors</span>
              <span>p50</span>
              {showCost ? <span>Cost, 24 h</span> : null}
            </span>
          </div>
          <ul className="model-list">
            {rows.map((row) => {
              const route = routes.data?.find((candidate) => candidate.id === row.id);
              return route ? (
                <ModelItem
                  key={row.id}
                  row={row}
                  route={route}
                  providers={providers.data ?? []}
                  showCost={showCost}
                  requireKeys={settings.data?.require_client_keys ?? false}
                />
              ) : null;
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function ModelItem({
  row,
  route,
  providers,
  showCost,
  requireKeys,
}: {
  row: ModelRow;
  route: Route;
  providers: Provider[];
  showCost: boolean;
  requireKeys: boolean;
}) {
  const api = useApi();
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<PlaygroundRun | null>(null);
  const [error, setError] = useState<unknown>(null);
  const origin = typeof window === "undefined" ? "http://127.0.0.1:8790" : window.location.origin;
  const curl = equivalentCurl(sampleDecision(row.name), origin, requireKeys);
  const titleOf = titleLookup(providers);

  const test = async (): Promise<void> => {
    setRunning(true);
    setError(null);
    try {
      setRun(await api.runPlayground(knownAnswerRequest(row.name)));
    } catch (caught) {
      setError(caught);
      setRun(null);
    } finally {
      setRunning(false);
    }
  };

  const step = run ? answeringStep(route, providers, run) : null;

  return (
    <li className={cx("model-row", !row.enabled && "model-row--off")}>
      <div className="model-row-grid">
        <div className="model-row-main">
          <div className="model-row-name">
            <a href={hrefFor("models", row.id)} className={`line-badge ink-${row.ink}`}>
              <span className="line-badge-swatch" aria-hidden="true" />
              <span className="mono">{row.name}</span>
            </a>
            <CopyButton text={row.name} label={`Copy the name ${row.name}`} iconOnly />
            <StatusChip status={row.verdict.status}>{row.verdict.word}</StatusChip>
          </div>
          <p className="model-row-chain">
            <ChainText steps={row.steps} providers={providers} />
          </p>
          {row.verdict.state !== "ready" ? <p className="model-row-reason">{row.verdict.reason}</p> : null}
        </div>
        <dl className="model-figures">
          <div>
            <dt>Requests, 24 h</dt>
            <dd className="mono">{formatCount(row.requests)}</dd>
          </div>
          <div className={cx(row.errors > 0 && "is-alert")}>
            <dt>Errors</dt>
            <dd className="mono">{formatRatio(row.errorRate)}</dd>
          </div>
          <div>
            <dt>p50</dt>
            <dd className="mono">{formatMs(row.p50)}</dd>
          </div>
          {showCost ? (
            <div>
              <dt>Cost, 24 h</dt>
              <dd className="mono">
                <GroupCost
                  value={row.cost}
                  pricing={row.pricing.pricing}
                  priceHref={hrefFor("models", row.id, { step: row.pricing.unpricedStep ? String(row.pricing.unpricedStep) : undefined })}
                />
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
      <div className="model-row-actions">
        <Button variant="secondary" small onClick={() => void test()} disabled={running}>
          <Icon name="bolt" size={14} />
          <span>{running ? "Testing…" : run ? "Test again" : "Test"}</span>
        </Button>
        <CopyButton text={curl} label="Copy curl" />
        <a className="btn btn--quiet btn--small" href={hrefFor("try", null, { model: row.name })}>
          Open in Try it
        </a>
        <a className="btn btn--quiet btn--small model-row-edit" href={hrefFor("models", row.id)}>
          <span>Edit</span>
          <Icon name="arrow-right" size={14} />
        </a>
      </div>
      {error ? <p className="field-error model-row-result">{describeError(error)}</p> : null}
      {run ? (
        <TestResult
          outcome={runOutcome(run, titleOf)}
          className="model-row-result"
          priceHref={hrefFor("models", row.id, { step: step ? String(step) : undefined })}
          actions={
            <Button variant="quiet" small onClick={() => setRun(null)}>
              <Icon name="close" size={14} />
              <span>Close</span>
            </Button>
          }
        />
      ) : null}
    </li>
  );
}
