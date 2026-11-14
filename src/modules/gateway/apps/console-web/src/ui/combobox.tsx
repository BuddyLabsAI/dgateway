// A text field with a list of suggestions (the ARIA 1.2 combobox pattern). Typing filters the
// list and free text is always allowed; the arrow keys move through the list, Enter picks, and
// Escape closes it. Used for upstream models (with price and context) and for picking a model.

import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cx } from "./cx";
import { Icon } from "./icons";

export interface ComboOption {
  value: string;
  /** Shown in the data face: an id or a model name. */
  label: string;
  /** A second line in words, such as a description or a chain sentence. */
  detail?: string;
  /** Right-aligned figures, such as a price and a context size. */
  meta?: ReactNode;
}

export interface ComboboxProps {
  label: string;
  value: string;
  onChange: (text: string) => void;
  onPick: (option: ComboOption) => void;
  options: readonly ComboOption[];
  /** Filters the options for what has been typed since the list opened. */
  filter?: (options: readonly ComboOption[], query: string) => ComboOption[];
  hint?: ReactNode;
  error?: string | null;
  placeholder?: string;
  mono?: boolean;
  /** Shown in the list when nothing matches. */
  emptyText?: string;
  loading?: boolean;
  id?: string;
  onFocus?: () => void;
}

function defaultFilter(options: readonly ComboOption[], query: string): ComboOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  return options.filter((option) => option.label.toLowerCase().includes(needle) || (option.detail ?? "").toLowerCase().includes(needle));
}

export function Combobox({
  label,
  value,
  onChange,
  onPick,
  options,
  filter = defaultFilter,
  hint,
  error,
  placeholder,
  mono = false,
  emptyText = "Nothing matches. Keep typing to use the text as it is.",
  loading = false,
  id,
  onFocus,
}: ComboboxProps) {
  const generated = useId();
  const base = id ?? `combo-${generated.replace(/[^\w-]/g, "")}`;
  const listId = `${base}-list`;
  const hintId = `${base}-hint`;
  const errorId = `${base}-error`;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);

  const shown = useMemo(() => filter(options, query).slice(0, 80), [filter, options, query]);
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;

  const openList = (): void => {
    setQuery("");
    setActive(-1);
    setOpen(true);
  };

  const pick = (option: ComboOption): void => {
    onPick(option);
    setOpen(false);
    setActive(-1);
  };

  const move = (delta: number): void => {
    if (!open) {
      openList();
      return;
    }
    if (shown.length === 0) return;
    const next = (active + delta + shown.length) % shown.length;
    setActive(next);
    listRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter" && open && active >= 0) {
      const option = shown[active];
      if (option) {
        event.preventDefault();
        pick(option);
      }
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className={cx("field", "combo", error && "field--invalid")}>
      <div className="field-label">
        <label htmlFor={base}>{label}</label>
      </div>
      <div className="combo-box">
        <input
          id={base}
          className={cx("input", "combo-input", mono && "input--mono")}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && active >= 0 ? `${base}-opt-${active}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          value={value}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            onChange(event.target.value);
            setQuery(event.target.value);
            setActive(-1);
            setOpen(true);
          }}
          onFocus={() => {
            onFocus?.();
            openList();
          }}
          onClick={() => {
            if (!open) openList();
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        <Icon name="chevron" size={14} className={cx("combo-caret", open && "combo-caret--open")} />
        {open ? (
          <ul id={listId} ref={listRef} className="combo-list" role="listbox" aria-label={label}>
            {loading ? <li className="combo-empty">Loading the list…</li> : null}
            {!loading && shown.length === 0 ? <li className="combo-empty">{emptyText}</li> : null}
            {shown.map((option, index) => (
              <li
                key={option.value}
                id={`${base}-opt-${index}`}
                data-index={index}
                role="option"
                aria-selected={index === active}
                className={cx("combo-option", index === active && "is-active", option.value === value && "is-current")}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(option);
                }}
                onMouseEnter={() => setActive(index)}
              >
                <span className="combo-option-main">
                  <span className="combo-option-label mono">{option.label}</span>
                  {option.detail ? <span className="combo-option-detail">{option.detail}</span> : null}
                </span>
                {option.meta ? <span className="combo-option-meta">{option.meta}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {hint ? (
        <p id={hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="field-error" role="alert">
          <Icon name="warning" size={14} />
          <span>{error}</span>
        </p>
      ) : null}
    </div>
  );
}
