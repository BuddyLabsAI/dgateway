// The upstream model catalog of one provider: a searchable list with price and context, in the
// Add model flow and behind "Browse models", and the same entries as combobox suggestions in the
// model editor. Free typing is always allowed, because a catalog can be incomplete.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useApi } from "../app/api-context";
import type { ConsoleApi } from "../api/console-api";
import type { ProviderModel } from "../api/types";
import { searchCatalog, type CatalogSort } from "../domain/catalog";
import { formatPricePerM } from "../domain/cost";
import { formatContext } from "../domain/format";
import type { ComboOption } from "./combobox";
import { Segmented, TextField } from "./controls";
import { cx } from "./cx";
import { ErrorState, LoadingRows } from "./feedback";
import { Icon } from "./icons";

const cache = new Map<string, ProviderModel[]>();

export interface CatalogState {
  models: ProviderModel[];
  loading: boolean;
  error: unknown;
  reload: () => void;
}

/** A connection's catalog, fetched once per session and shared between screens. */
export function useCatalog(providerId: string | null | undefined): CatalogState {
  const api = useApi();
  const [models, setModels] = useState<ProviderModel[]>(() => (providerId ? (cache.get(providerId) ?? []) : []));
  // A catalog not read yet counts as loading from the first render, so nothing reads "lists no models" before the fetch.
  const [loading, setLoading] = useState(() => Boolean(providerId) && !cache.has(providerId ?? ""));
  const [error, setError] = useState<unknown>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!providerId) {
      setModels([]);
      setLoading(false);
      setError(null);
      return;
    }
    const cached = cache.get(providerId);
    if (cached && version === 0) {
      setModels(cached);
      setLoading(false);
      setError(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    api
      .listProviderModels(providerId)
      .then((list) => {
        cache.set(providerId, list);
        if (live) setModels(list);
      })
      .catch((caught: unknown) => {
        if (live) {
          setModels([]);
          setError(caught);
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, providerId, version]);

  return { models, loading, error, reload: () => setVersion((current) => current + 1) };
}

/**
 * The catalogs of several connections, read once per session like useCatalog and shared with it. A
 * connection whose catalog cannot be read is left out, so the prices that depend on it stay unknown.
 */
export async function loadCatalogs(api: ConsoleApi, providerIds: readonly string[]): Promise<Map<string, ProviderModel[]>> {
  const loaded = await Promise.all(
    providerIds.map(async (id) => {
      const cached = cache.get(id);
      if (cached) return [id, cached] as const;
      try {
        const models = await api.listProviderModels(id);
        cache.set(id, models);
        return [id, models] as const;
      } catch {
        return null;
      }
    }),
  );
  return new Map(loaded.filter((entry): entry is readonly [string, ProviderModel[]] => entry !== null));
}

function PriceAndContext({ model }: { model: ProviderModel }) {
  return (
    <>
      <span className="mono catalog-price">
        {model.price_per_m_input === undefined ? "no list price" : formatPricePerM(model.price_per_m_input)}
        {model.price_per_m_output === undefined ? "" : ` · ${formatPricePerM(model.price_per_m_output, "output")}`}
      </span>
      <span className="mono catalog-context">{model.context === undefined ? "" : `${formatContext(model.context)} ctx`}</span>
    </>
  );
}

/** The catalog as combobox suggestions, best matches first. */
export function catalogOptions(models: readonly ProviderModel[]): ComboOption[] {
  return models.map((model) => ({ value: model.id, label: model.id, detail: model.description, meta: <PriceAndContext model={model} /> }));
}

export function catalogFilter(models: readonly ProviderModel[]): (options: readonly ComboOption[], query: string) => ComboOption[] {
  return (options, query) => {
    const order = searchCatalog(models, query).map((model) => model.id);
    const byId = new Map(options.map((option) => [option.value, option]));
    return order.map((id) => byId.get(id)).filter((option): option is ComboOption => option !== undefined);
  };
}

const SUGGESTED_SORT: { value: CatalogSort; label: string } = { value: "listed", label: "Suggested" };

const SORT_OPTIONS: { value: CatalogSort; label: string }[] = [
  { value: "name", label: "Name" },
  { value: "price", label: "Price" },
  { value: "context", label: "Context" },
];

/**
 * The catalog as a list to choose from. `selected` is the current pick; `onPick` receives the id
 * and the catalog entry when there is one (none when the owner uses text as typed).
 */
export function CatalogList({
  catalog,
  selected,
  onPick,
  pickLabel = "Use",
  rowAction,
  emptyHint,
  suggested = false,
}: {
  catalog: CatalogState;
  selected?: string;
  onPick: (id: string, model: ProviderModel | undefined) => void;
  pickLabel?: string;
  /** Replaces the pick button with another action, such as "Add model with this". */
  rowAction?: (model: ProviderModel) => ReactNode;
  emptyHint?: ReactNode;
  /** The provider suggests models (its hints): offer their order, and start with it. */
  suggested?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<CatalogSort>(suggested ? "listed" : "name");
  const sortOptions = suggested ? [SUGGESTED_SORT, ...SORT_OPTIONS] : SORT_OPTIONS;
  const results = useMemo(() => searchCatalog(catalog.models, query, sort), [catalog.models, query, sort]);
  const typed = query.trim();
  const exact = catalog.models.some((model) => model.id === typed);

  return (
    <div className="catalog">
      <div className="catalog-tools">
        <TextField
          label="Search the catalog"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Type a model id or a word from its description"
          autoComplete="off"
          spellCheck={false}
          mono
          hint={catalog.models.length > 0 ? `${results.length} of ${catalog.models.length} shown` : undefined}
        />
        <div className="field">
          <div className="field-label">
            <span>Sort by</span>
          </div>
          <Segmented label="Sort the catalog by" options={sortOptions} value={sort} onChange={setSort} />
        </div>
      </div>

      {catalog.loading ? <LoadingRows rows={4} label="Loading the catalog" /> : null}
      {catalog.error ? <ErrorState error={catalog.error} title="The catalog did not load" onRetry={catalog.reload} /> : null}

      {!catalog.loading && catalog.models.length === 0 && !catalog.error ? (
        <p className="field-hint">{emptyHint ?? "This provider lists no models. Type the model id it expects above."}</p>
      ) : null}

      {results.length > 0 ? (
        <ul className="catalog-list" aria-label="Upstream models">
          {results.map((model) => {
            const current = model.id === selected;
            return (
              <li key={model.id} className={cx("catalog-row", current && "is-current")}>
                <span className="catalog-main">
                  <span className="mono catalog-id">{model.id}</span>
                  {model.description ? <span className="catalog-desc">{model.description}</span> : null}
                </span>
                <PriceAndContext model={model} />
                <span className="catalog-action">
                  {rowAction ? (
                    rowAction(model)
                  ) : (
                    <button
                      type="button"
                      className={cx("btn btn--small", current ? "btn--primary" : "btn--secondary")}
                      aria-pressed={current}
                      aria-label={`${pickLabel} ${model.id}`}
                      onClick={() => onPick(model.id, model)}
                    >
                      {current ? <Icon name="check" size={14} /> : null}
                      <span>{current ? "Chosen" : pickLabel}</span>
                    </button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}

      {typed && !exact && !rowAction ? (
        <div className="catalog-typed">
          <span>
            Not in the list? Use <span className="mono">{typed}</span> exactly as typed.
          </span>
          <button
            type="button"
            className={cx("btn btn--small", selected === typed ? "btn--primary" : "btn--secondary")}
            aria-pressed={selected === typed}
            onClick={() => onPick(typed, undefined)}
          >
            {selected === typed ? "Chosen" : `Use as typed`}
          </button>
        </div>
      ) : null}
    </div>
  );
}
