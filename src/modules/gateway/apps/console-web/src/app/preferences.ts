// Small choices the owner makes in this browser, such as dismissing the first-run checklist.
// They live in localStorage; when storage is blocked they last until a reload.

import { useCallback, useState } from "react";

const memory = new Map<string, string>();

export function readPreference(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

export function writePreference(key: string, value: string | null): void {
  if (value === null) memory.delete(key);
  else memory.set(key, value);
  try {
    if (value === null) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage can be blocked. The choice then lasts until a reload.
  }
}

/** A remembered yes or no. */
export function usePreferenceFlag(key: string): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(() => readPreference(key) === "1");
  const set = useCallback(
    (next: boolean) => {
      writePreference(key, next ? "1" : null);
      setValue(next);
    },
    [key],
  );
  return [value, set];
}

export const FIRST_RUN_DISMISSED = "dgateway.first-run-dismissed";
