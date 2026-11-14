// A provider's Test, wherever one starts: on each Providers card, on the Add provider test step and for a step in the
// model editor. The owner picks the model first (ui/test-model-picker.tsx: the provider's models, opened on the
// model the test would use, with why), then Run the test sends the known-answer check and the result reads in plain
// words. Nothing runs before Run the test. It renders no form of its own, because a step's test sits inside the
// model editor's form.

import { useState, type ReactNode } from "react";
import { useApi } from "../app/api-context";
import type { Provider, ProviderTestResult } from "../api/types";
import { connectionTitle, titleLookup } from "../domain/connections";
import { KNOWN_ANSWER, quoted } from "../domain/known-answer";
import {
  pickedModel,
  pickerSort,
  pickReason,
  requestedModel,
  testedReason,
  testPreset,
  type TestEntry,
  type TestPreset,
} from "../domain/test-picker";
import { providerTestOutcome } from "../domain/test-result";
import { useCatalog } from "./catalog";
import { Button } from "./controls";
import { ErrorState } from "./feedback";
import { Icon } from "./icons";
import { TestModelPicker } from "./test-model-picker";
import { TestRunning } from "./test-readout";
import { TestResult } from "./test-result";

export function ProviderTestPanel({
  provider,
  entry,
  providers,
  lede,
  onTested,
  onResult,
}: {
  provider: Provider;
  /** Where the test starts, which sets the model the picker opens on. */
  entry: TestEntry;
  /** Every provider, so attempts read with their titles. */
  providers?: readonly Provider[];
  /** What the test does, in a sentence; the default suits a provider. */
  lede?: ReactNode;
  /** After a test ran, pass or fail: the gateway has recorded it as last_test. */
  onTested?: () => void;
  onResult?: (result: ProviderTestResult) => void;
}) {
  const api = useApi();
  const catalog = useCatalog(provider.id);
  const title = connectionTitle(provider.name, provider.kind);
  const titleOf = titleLookup(providers ?? [provider]);
  const status = catalog.loading ? "loading" : catalog.error ? "failed" : "ready";
  const preset = testPreset(entry, provider, catalog.models, status);
  // What the owner chose in the picker; null follows the preset.
  const [picked, setPicked] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  // The last result, with what was sent and the preset at the time, so its reason does not follow later edits.
  const [tested, setTested] = useState<{ result: ProviderTestResult; sent: string | undefined; preset: TestPreset | null } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const model = pickedModel(picked, preset);
  const why = pickReason(model, preset, title);

  const run = async (): Promise<void> => {
    const sent = requestedModel(model, preset);
    setRunning(true);
    setTested(null);
    setError(null);
    try {
      // Without a model sent the gateway chooses, and says why.
      const result = await api.testProvider(provider.id, sent);
      setTested({ result, sent, preset });
      onResult?.(result);
      onTested?.();
    } catch (caught) {
      setError(caught);
    } finally {
      setRunning(false);
    }
  };

  const result = tested?.result ?? null;
  const reason = tested ? testedReason(tested.result, tested.sent, tested.preset, title) : null;

  return (
    <div className="provider-test">
      <p className="provider-test-lede">
        {lede ?? (
          <>
            Test asks one question with a known answer ({quoted(KNOWN_ANSWER.expected)}), so you see that {title} answers and that its answer
            makes sense.
          </>
        )}
      </p>
      <TestModelPicker
        catalog={catalog}
        title={title}
        preset={preset}
        picked={picked}
        sort={pickerSort(provider)}
        onPick={setPicked}
      />
      <div className="test-run">
        <Button variant={result ? "secondary" : "primary"} onClick={() => void run()} disabled={running}>
          <Icon name="bolt" size={14} />
          <span>{running ? "Testing…" : result ? "Test again" : "Run the test"}</span>
        </Button>
        <p className="test-run-model">
          {model ? (
            <>
              Tests <span className="mono test-run-id">{model}</span>, {why}.
            </>
          ) : catalog.loading ? (
            <>Reading {title}&apos;s models to choose one…</>
          ) : (
            <>The gateway chooses the model when the test runs.</>
          )}
        </p>
      </div>
      {running ? <TestRunning subject={title} timeoutMs={provider.timeout_ms} /> : null}
      {error ? <ErrorState error={error} title="The test did not run" /> : null}
      {result && !running ? <TestResult outcome={providerTestOutcome(result, titleOf)} reason={reason} /> : null}
    </div>
  );
}
