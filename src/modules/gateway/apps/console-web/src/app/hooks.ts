// Data-loading and timing hooks shared by the screens.

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { isAbortError } from "../api/errors";

export type ResourceStatus = "loading" | "ready" | "error";

export interface Resource<T> {
  status: ResourceStatus;
  data: T | undefined;
  error: unknown;
  /** True while a refresh is running and the previous data is still on screen. */
  refreshing: boolean;
  reload: () => void;
  setData: (update: (current: T | undefined) => T | undefined) => void;
  /** When the data last arrived, in epoch milliseconds. */
  updatedAt: number | null;
}

interface ResourceState<T> {
  status: ResourceStatus;
  data: T | undefined;
  error: unknown;
  updatedAt: number | null;
}

/**
 * Runs `load` on mount and whenever `deps` change, or when `reload` is called.
 * Previous data stays visible during a refresh. Stale responses are dropped.
 */
export function useResource<T>(load: (signal: AbortSignal) => Promise<T>, deps: readonly unknown[]): Resource<T> {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading", data: undefined, error: undefined, updatedAt: null });
  const [version, setVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const controller = new AbortController();
    setRefreshing(true);
    setState((previous) => ({ ...previous, status: previous.data === undefined ? "loading" : previous.status }));
    loadRef
      .current(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setState({ status: "ready", data, error: undefined, updatedAt: Date.now() });
        setRefreshing(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || isAbortError(error)) return;
        setState((previous) => ({ ...previous, status: "error", error }));
        setRefreshing(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are supplied by the caller.
  }, [...deps, version]);

  const reload = useCallback(() => setVersion((current) => current + 1), []);
  const setData = useCallback(
    (update: (current: T | undefined) => T | undefined) =>
      setState((previous) => ({ ...previous, data: update(previous.data), status: "ready", updatedAt: Date.now() })),
    [],
  );

  return { ...state, refreshing, reload, setData };
}

/** Calls `callback` every `ms` while the document is visible. */
export function useVisibleInterval(callback: () => void, ms: number): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") ref.current();
    }, ms);
    return () => window.clearInterval(id);
  }, [ms]);
}

/** The current time, refreshed every `ms`. Used for relative labels. */
export function useNow(ms = 10_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** The content width of an element, kept current with a ResizeObserver. Zero until measured. */
export function useElementWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0]?.contentRect.width ?? 0);
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(element);
    setWidth(Math.round(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
