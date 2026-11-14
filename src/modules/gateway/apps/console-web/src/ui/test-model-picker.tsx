// The model picker of every provider test: a search field over the provider's models (id, price per million input
// tokens, context), opened on the model the test would use, with that row tagged ("Gateway's choice", "This step's
// model"). Typing searches and chooses the best match, or the text as typed when nothing matches, so typing an id
// and running the test tests that id; clearing the search without a choice goes back to the model chosen before it.
// A model the provider does not list can be used as typed, also when the list did not load. The search field keeps
// focus while the arrow keys move through the rows and choose (aria-activedescendant); Enter chooses too and never
// runs the test or submits a surrounding form; Escape clears the search. Only the panel's Run the test runs it.

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { CatalogSort } from "../domain/catalog";
import { formatPricePerM } from "../domain/cost";
import { formatContext } from "../domain/format";
import { pickedModel, pickerCount, pickerList, pickerPrice, presetTag, type PickerRow, type TestPreset } from "../domain/test-picker";
import type { CatalogState } from "./catalog";
import { cx } from "./cx";
import { describeError, LoadingRows } from "./feedback";
import { Icon } from "./icons";
import { StationMark } from "./status";

/** A row's identity across renders: the search as typed and a model with that id are different rows. */
function rowKey(row: PickerRow): string {
  return row.typed ? `typed:${row.id}` : row.id;
}

/** Price and context; for a model the provider does not list, say so once the list is known. */
function RowFigures({ row, listKnown }: { row: PickerRow; listKnown: boolean }) {
  if (!row.model) {
    return (
      <span className="test-picker-figures">
        <span className="test-picker-price">{listKnown && !row.typed ? "not in the list" : ""}</span>
        <span className="mono test-picker-context" />
      </span>
    );
  }
  const price = pickerPrice(row.model);
  return (
    <span className="test-picker-figures">
      <span className="mono test-picker-price">{price === null ? "no list price" : formatPricePerM(price)}</span>
      <span className="mono test-picker-context">{row.model.context === undefined ? "" : `${formatContext(row.model.context)} ctx`}</span>
    </span>
  );
}

export function TestModelPicker({
  catalog,
  title,
  preset,
  picked,
  sort,
  onPick,
}: {
  catalog: CatalogState;
  /** The provider as the console names it. */
  title: string;
  /** The model the picker starts on, and why; null while the gateway's choice is not known. */
  preset: TestPreset | null;
  /** The owner's pick; null follows the preset. */
  picked: string | null;
  sort: CatalogSort;
  onPick: (model: string | null) => void;
}) {
  const base = `picker-${useId().replace(/[^\w-]/g, "")}`;
  const inputId = `${base}-search`;
  const listId = `${base}-list`;
  const hintId = `${base}-hint`;
  const [query, setQuery] = useState("");
  const [activeKey, setActiveKey] = useState<string | null>(null);
  // The pick from before the search began, while the search has only chosen tentatively; null otherwise.
  const [before, setBefore] = useState<{ picked: string | null } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = pickedModel(picked, preset);
  // While searching, a tentative pick is not a row of its own: the list shows the pick from before.
  const anchor = before ? before.picked : picked;
  const presetId = preset?.model ?? null;
  const list = useMemo(
    () => pickerList(catalog.models, query, { preset: presetId, picked: anchor, sort }),
    [catalog.models, query, presetId, anchor, sort],
  );
  const { rows } = list;
  const activeIndex = activeKey === null ? -1 : rows.findIndex((row) => rowKey(row) === activeKey);
  const activeRow = activeIndex >= 0 ? rows[activeIndex] : undefined;
  const failed = Boolean(catalog.error) && !catalog.loading;
  const ready = !catalog.loading && !failed;
  const empty = ready && catalog.models.length === 0;
  const noMatch = query.trim().length > 0 && list.matched === 0 && catalog.models.length > 0;
  const count = pickerCount(list, catalog.models.length, query);

  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  /** A choice of the owner's: it stays when the search is cleared. */
  const commit = (row: PickerRow): void => {
    onPick(row.id);
    setBefore(null);
    // Once chosen, text used as typed is a model of its own, keyed by its id.
    setActiveKey(row.id);
  };

  const search = (text: string): void => {
    setQuery(text);
    if (!text.trim()) {
      setActiveKey(null);
      if (before) onPick(before.picked);
      setBefore(null);
      return;
    }
    if (!before) setBefore({ picked });
    const best = pickerList(catalog.models, text, { preset: presetId, picked: anchor, sort }).rows[0];
    setActiveKey(best ? rowKey(best) : null);
    if (best) onPick(best.id);
  };

  const clear = (): void => {
    setQuery("");
    setActiveKey(null);
    if (before) onPick(before.picked);
    setBefore(null);
  };

  const move = (delta: number): void => {
    if (rows.length === 0) return;
    const next = activeIndex < 0 ? (delta > 0 ? 0 : rows.length - 1) : (activeIndex + delta + rows.length) % rows.length;
    const row = rows[next];
    if (row) commit(row);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // Alt with an arrow moves a step in the model editor; leave it to the step.
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter") {
      // Enter chooses; it never submits a surrounding form or runs the test.
      event.preventDefault();
      if (activeRow) commit(activeRow);
    } else if (event.key === "Escape" && query) {
      event.preventDefault();
      clear();
    }
  };

  return (
    <div className="field test-picker">
      <div className="field-label">
        <label htmlFor={inputId}>Model to test</label>
      </div>
      <input
        id={inputId}
        className="input input--mono test-picker-search"
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeRow ? `${base}-opt-${activeIndex}` : undefined}
        aria-describedby={hintId}
        value={query}
        placeholder="Search by id or description, or type any model id"
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => search(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="test-picker-box">
        {failed ? (
          <div className="test-picker-state test-picker-state--error" role="alert">
            <p className="test-picker-state-text">
              <StationMark status="failing" size={12} />
              <span>The model list did not load. You can still type a model id above and test it.</span>
            </p>
            <p className="test-picker-state-detail">{describeError(catalog.error)}</p>
            <button type="button" className="btn btn--secondary btn--small" onClick={catalog.reload}>
              <Icon name="refresh" size={14} />
              <span>Try again</span>
            </button>
          </div>
        ) : null}
        <ul id={listId} ref={listRef} className="test-picker-list" role="listbox" aria-label={`Models to test on ${title}`}>
          {rows.map((row, index) => {
            const chosen = row.id === selected;
            return (
              <li
                key={rowKey(row)}
                id={`${base}-opt-${index}`}
                data-index={index}
                role="option"
                aria-selected={chosen}
                className={cx("test-picker-row", index === activeIndex && "is-active", chosen && "is-chosen", row.typed && "is-typed")}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActiveKey(rowKey(row))}
                onClick={() => commit(row)}
              >
                <span className="test-picker-check" aria-hidden="true">
                  {chosen ? <Icon name="check" size={14} /> : row.typed ? <Icon name="plus" size={14} /> : null}
                </span>
                <span className="test-picker-main">
                  {row.typed ? (
                    <span className="test-picker-id">
                      Use <span className="mono">{row.id}</span> as typed
                    </span>
                  ) : (
                    <span className="mono test-picker-id">{row.id}</span>
                  )}
                  {row.typed ? (
                    <span className="test-picker-desc">The test sends it to {title} exactly as typed.</span>
                  ) : row.model?.description ? (
                    <span className="test-picker-desc">{row.model.description}</span>
                  ) : null}
                </span>
                {row.preset && preset ? <span className="test-picker-tag">{presetTag(preset)}</span> : <span />}
                <RowFigures row={row} listKnown={ready} />
              </li>
            );
          })}
        </ul>
        {catalog.loading ? (
          <div className="test-picker-state">
            <LoadingRows rows={3} label={`Loading ${title}'s models`} />
          </div>
        ) : null}
        {empty ? (
          <p className="test-picker-state test-picker-state-text">{title} lists no models. Type the model id it expects above.</p>
        ) : null}
        {noMatch ? (
          <p className="test-picker-state test-picker-state-text">
            No listed model matches <span className="mono">{query.trim()}</span>.
          </p>
        ) : null}
      </div>
      <p id={hintId} className="field-hint">
        {count ? `${count} ` : ""}Typing chooses the best match, or your text as typed; the up and down arrows move through the list.
      </p>
    </div>
  );
}
