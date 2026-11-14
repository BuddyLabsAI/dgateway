// Form controls. Every control has a visible label, optional hint, and an error line
// tied to the control with aria-describedby. Keyboard and focus styles live in CSS.

import {
  useId,
  useRef,
  type Ref,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { cx } from "./cx";
import { Icon } from "./icons";

type ButtonVariant = "primary" | "secondary" | "quiet" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  small?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({ variant = "secondary", small = false, className, type = "button", ...rest }: ButtonProps) {
  return <button type={type} className={cx("btn", `btn--${variant}`, small && "btn--small", className)} {...rest} />;
}

interface FieldFrame {
  id: string;
  hintId: string;
  errorId: string;
  describedBy: string | undefined;
}

function useFieldFrame(id: string | undefined, hint: ReactNode | undefined, error: string | null | undefined): FieldFrame {
  const generated = useId();
  const base = id ?? `field-${generated}`;
  const hintId = `${base}-hint`;
  const errorId = `${base}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return { id: base, hintId, errorId, describedBy };
}

function FieldMessages({ frame, hint, error }: { frame: FieldFrame; hint?: ReactNode; error?: string | null }) {
  return (
    <>
      {hint ? (
        <p id={frame.hintId} className="field-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={frame.errorId} className="field-error" role="alert">
          <Icon name="warning" size={14} />
          <span>{error}</span>
        </p>
      ) : null}
    </>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  accessory?: ReactNode;
  mono?: boolean;
  labelHidden?: boolean;
}

export function TextField({ label, hint, error, accessory, mono = false, labelHidden = false, id, className, ...input }: TextFieldProps) {
  const frame = useFieldFrame(id, hint, error);
  return (
    <div className={cx("field", error && "field--invalid", className)}>
      {labelHidden ? (
        <label htmlFor={frame.id} className="sr-only">
          {label}
        </label>
      ) : (
        <div className="field-label">
          <label htmlFor={frame.id}>{label}</label>
          {accessory}
        </div>
      )}
      <input
        id={frame.id}
        className={cx("input", mono && "input--mono")}
        aria-invalid={error ? true : undefined}
        aria-describedby={frame.describedBy}
        {...input}
      />
      <FieldMessages frame={frame} hint={hint} error={error} />
    </div>
  );
}

export interface TextAreaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  accessory?: ReactNode;
  mono?: boolean;
}

export function TextAreaField({ label, hint, error, accessory, mono = false, id, className, rows = 4, ...area }: TextAreaFieldProps) {
  const frame = useFieldFrame(id, hint, error);
  return (
    <div className={cx("field", error && "field--invalid", className)}>
      <div className="field-label">
        <label htmlFor={frame.id}>{label}</label>
        {accessory}
      </div>
      <textarea
        id={frame.id}
        rows={rows}
        className={cx("input", "input--area", mono && "input--mono")}
        aria-invalid={error ? true : undefined}
        aria-describedby={frame.describedBy}
        {...area}
      />
      <FieldMessages frame={frame} hint={hint} error={error} />
    </div>
  );
}

export interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  labelHidden?: boolean;
}

export function SelectField({ label, hint, error, labelHidden = false, id, className, children, ...select }: SelectFieldProps) {
  const frame = useFieldFrame(id, hint, error);
  return (
    <div className={cx("field", error && "field--invalid", className)}>
      {labelHidden ? (
        <label htmlFor={frame.id} className="sr-only">
          {label}
        </label>
      ) : (
        <div className="field-label">
          <label htmlFor={frame.id}>{label}</label>
        </div>
      )}
      <select
        id={frame.id}
        className="input input--select"
        aria-invalid={error ? true : undefined}
        aria-describedby={frame.describedBy}
        {...select}
      >
        {children}
      </select>
      <FieldMessages frame={frame} hint={hint} error={error} />
    </div>
  );
}

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
}

export function Switch({ checked, onChange, label, description, disabled = false }: SwitchProps) {
  const generated = useId();
  const labelId = `${generated}-label`;
  const descId = `${generated}-desc`;
  return (
    <div className="switch-row">
      <button
        type="button"
        role="switch"
        className="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-track" aria-hidden="true">
          <span className="switch-knob" />
        </span>
      </button>
      <div className="switch-text">
        <p id={labelId} className="switch-label">
          {label}
        </p>
        {description ? (
          <p id={descId} className="field-hint">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedProps<T extends string> {
  label: string;
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}

/** A radio group drawn as a segmented control, with arrow-key movement. */
export function Segmented<T extends string>({ label, options, value, onChange, disabled = false }: SegmentedProps<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (from: number, delta: number): void => {
    const next = (from + delta + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onChange(option.value);
    buttons.current[next]?.focus();
  };

  return (
    <div role="radiogroup" aria-label={label} className="segmented">
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            className={cx("segment", checked && "segment--on")}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(index, 1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(index, -1);
              }
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
