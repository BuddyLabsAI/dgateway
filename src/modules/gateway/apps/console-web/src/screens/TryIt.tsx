import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useApi } from "../app/api-context";
import { hrefFor } from "../app/router";
import { useResource } from "../app/hooks";
import type { DecisionResponse, DecisionType, PlaygroundRun, Provider, Route } from "../api/types";
import { chainSentence, routeChain } from "../domain/chain";
import { titleLookup } from "../domain/connections";
import { answeredByLine, outcomeSentence } from "../domain/outcome";
import {
  buildDecisionRequest,
  emptyBuilder,
  equivalentCurl,
  makeChoice,
  makeLevel,
  makeQuestion,
  presets,
  LIMITS,
  type BuildIssue,
  type BuilderState,
  type ChoiceRow,
  type LevelRow,
  type QuestionDraft,
  type ValueType,
} from "../domain/playground";
import { methodLabel } from "../domain/answers";
import { formatCount, formatMs, formatRelative } from "../domain/format";
import { reveal } from "../motion/motion";
import { AnswerView } from "../ui/answers";
import { Combobox, type ComboOption } from "../ui/combobox";
import { Button, Segmented, SelectField, TextAreaField, TextField } from "../ui/controls";
import { CodeBlock } from "../ui/code";
import { CostLine } from "../ui/decision-result";
import { CopyButton, Disclosure, JsonBlock } from "../ui/disclosure";
import { EmptyState, ErrorState, Flag, LoadingRows, PageHeader, Section } from "../ui/feedback";
import { Icon } from "../ui/icons";
import { AttemptsTimeline } from "../ui/attempts";

const TYPE_OPTIONS: { value: DecisionType; label: string }[] = [
  { value: "choice", label: "Choice" },
  { value: "predicate", label: "Yes or no" },
  { value: "score", label: "Score" },
];

const VALUE_TYPE_OPTIONS: { value: ValueType; label: string }[] = [
  { value: "string", label: "string" },
  { value: "boolean", label: "boolean" },
  { value: "number", label: "number" },
];

function issueAt(issues: readonly BuildIssue[], path: string): string | undefined {
  return issues.find((issue) => issue.path === path)?.message;
}

function modelOptions(routes: readonly Route[], providers: readonly Provider[]): ComboOption[] {
  return routes
    .filter((route) => route.enabled)
    .map((route) => ({ value: route.alias, label: route.alias, detail: chainSentence(routeChain(route.targets, providers)) }));
}

export function TryItScreen({ initialModel }: { initialModel: string }) {
  const api = useApi();
  // The picker lists enabled models from the admin API. GET /v1/models needs a client key when
  // client keys are required, and the console holds only the admin token.
  const routes = useResource(() => api.listRoutes(), []);
  const providers = useResource(() => api.listProviders(), []);
  const settings = useResource(() => api.getSettings(), []);
  const [state, setState] = useState<BuilderState>(() => ({ ...emptyBuilder(), model: initialModel }));
  const [attempted, setAttempted] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<PlaygroundRun | null>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const buildRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialModel) setState((current) => ({ ...current, model: initialModel }));
  }, [initialModel]);

  const built = useMemo(() => buildDecisionRequest(state), [state]);
  const issues = built.ok ? [] : built.issues;
  const origin = typeof window === "undefined" ? "http://127.0.0.1:8790" : window.location.origin;

  const loadPreset = (build: () => BuilderState): void => {
    setState(build());
    setAttempted(false);
    setResult(null);
    setRunError(null);
  };

  const run = async (): Promise<void> => {
    setAttempted(true);
    setRunError(null);
    setResult(null);
    const current = buildDecisionRequest(state);
    if (!current.ok) {
      buildRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      return;
    }
    setRunning(true);
    try {
      setResult(await api.runPlayground(current.request));
    } catch (caught) {
      setRunError(caught);
    } finally {
      setRunning(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void run();
    }
  };

  const defaultRoute = settings.data?.default_route;
  const requireKeys = settings.data?.require_client_keys ?? false;
  const curl = built.ok ? equivalentCurl(built.request, origin, requireKeys) : null;
  const options = useMemo(() => modelOptions(routes.data ?? [], providers.data ?? []), [routes.data, providers.data]);
  const titleOf = useMemo(() => titleLookup(providers.data ?? []), [providers.data]);
  const pickedRoute = (routes.data ?? []).find((route) => route.alias === state.model.trim());

  return (
    <div className="screen">
      <PageHeader
        title="Try it"
        subtitle="Send a decision through the same routing your apps use. The answer shows first. Every upstream call and the exact request are under Details."
        actions={
          <Button variant="primary" onClick={() => void run()} disabled={running}>
            {running ? "Running…" : "Run decision"}
          </Button>
        }
      />

      <div className="playground">
        <div className="playground-build" ref={buildRef}>
          <Section variant="panel" title="Start from an example" id="presets">
            <div className="preset-row">
              {presets().map((preset) => (
                <button key={preset.id} type="button" className="preset" onClick={() => loadPreset(preset.build)}>
                  <span className="preset-title">{preset.title}</span>
                  <span className="preset-summary">{preset.summary}</span>
                </button>
              ))}
            </div>
          </Section>

          <Section variant="panel" title="Request" id="request">
            <Combobox
              label="Model"
              value={state.model}
              options={options}
              mono
              placeholder={defaultRoute ? `${defaultRoute} (the default model)` : "a model name"}
              onChange={(text) => setState((current) => ({ ...current, model: text }))}
              onPick={(option) => setState((current) => ({ ...current, model: option.value }))}
              emptyText="No model by that name. You can still send provider::model to call a provider directly."
              hint={
                <>
                  {pickedRoute ? (
                    <>{chainSentence(routeChain(pickedRoute.targets, providers.data ?? []))}. </>
                  ) : (
                    <>
                      A model name, or <span className="mono">provider::model</span> to call one provider directly.{" "}
                    </>
                  )}
                  {defaultRoute && !state.model.trim() ? (
                    <>
                      Empty uses the default model, <span className="mono">{defaultRoute}</span>.
                    </>
                  ) : null}
                </>
              }
            />
            <TextAreaField
              label="Input"
              value={state.input}
              onChange={(event) => setState((current) => ({ ...current, input: event.target.value }))}
              onKeyDown={onKey}
              error={attempted ? issueAt(issues, "input") : undefined}
              rows={4}
              hint="The text the decision is about. Ctrl+Enter runs the decision."
            />
          </Section>

          <Section
            variant="panel"
            title="Questions"
            id="questions"
            meta={`${state.questions.length} of ${LIMITS.questions.max} allowed. Answers come back in this order.`}
            actions={
              <div className="question-add">
                <Button
                  variant="secondary"
                  small
                  onClick={() => setState((current) => ({ ...current, questions: [...current.questions, makeQuestion("choice")] }))}
                  disabled={state.questions.length >= LIMITS.questions.max}
                >
                  <Icon name="plus" size={14} />
                  <span>Add question</span>
                </Button>
              </div>
            }
          >
            {attempted && issueAt(issues, "questions") ? (
              <p className="field-error" role="alert">
                <Icon name="warning" size={14} />
                <span>{issueAt(issues, "questions")}</span>
              </p>
            ) : null}
            <div className="question-list">
              {state.questions.map((draft, index) => (
                <QuestionEditor
                  key={draft.id}
                  draft={draft}
                  index={index}
                  issues={attempted ? issues : []}
                  canRemove={state.questions.length > 1}
                  onChange={(next) =>
                    setState((current) => ({ ...current, questions: current.questions.map((item) => (item.id === draft.id ? next : item)) }))
                  }
                  onRemove={() => setState((current) => ({ ...current, questions: current.questions.filter((item) => item.id !== draft.id) }))}
                />
              ))}
            </div>
          </Section>

          <div className="savebar savebar--sticky">
            <Button variant="primary" onClick={() => void run()} disabled={running}>
              {running ? "Running…" : "Run decision"}
            </Button>
            {curl ? <CopyButton text={curl} label="Copy curl" variant="secondary" /> : null}
            {attempted && issues.length > 0 ? (
              <Flag tone="error">{issues.length === 1 ? "One field needs attention" : `${issues.length} fields need attention`}</Flag>
            ) : null}
          </div>
        </div>

        <div className="playground-result">
          <Section variant="panel" title="Result" id="result" className="result-panel">
            {running ? <LoadingRows rows={4} label="Waiting for the gateway" /> : null}
            {!running && !result && !runError ? (
              <EmptyState title="No result yet">
                Run the decision to see each answer with its probabilities and confidence, who answered, and what it cost.
              </EmptyState>
            ) : null}
            {!running && runError ? <ErrorState error={runError} title="The decision did not run" /> : null}
            {!running && result && !result.response ? <FailedRun run={result} curl={curl} requireKeys={requireKeys} titleOf={titleOf} /> : null}
            {!running && result && result.response ? (
              <ResultView
                run={result}
                response={result.response}
                curl={curl}
                requireKeys={requireKeys}
                titleOf={titleOf}
                priceHref={pickedRoute ? hrefFor("models", pickedRoute.id) : null}
              />
            ) : null}
          </Section>
        </div>
      </div>
    </div>
  );
}

function QuestionEditor({
  draft,
  index,
  issues,
  canRemove,
  onChange,
  onRemove,
}: {
  draft: QuestionDraft;
  index: number;
  issues: readonly BuildIssue[];
  canRemove: boolean;
  onChange: (next: QuestionDraft) => void;
  onRemove: () => void;
}) {
  const path = `questions.${index}`;

  const set = <K extends keyof QuestionDraft>(key: K, value: QuestionDraft[K]): void => onChange({ ...draft, [key]: value });

  const changeType = (type: DecisionType): void => {
    if (type === draft.type) return;
    const fresh = makeQuestion(type, draft.name, draft.instructions);
    onChange({ ...draft, type, choices: fresh.choices, levels: fresh.levels });
  };

  return (
    <article className="question" aria-label={`Question ${index + 1}${draft.name ? `: ${draft.name}` : ""}`}>
      <header className="question-head">
        <span className="question-count">Question {index + 1}</span>
        <Segmented label={`Type of question ${index + 1}`} options={TYPE_OPTIONS} value={draft.type} onChange={changeType} />
        {canRemove ? (
          <Button variant="quiet" small onClick={onRemove} aria-label={`Remove question ${index + 1}`}>
            <Icon name="trash" size={14} />
            <span>Remove</span>
          </Button>
        ) : null}
      </header>
      <div className="form-grid">
        <TextField
          label="Name"
          value={draft.name}
          onChange={(event) => set("name", event.target.value)}
          error={issueAt(issues, `${path}.name`)}
          mono
          spellCheck={false}
          autoComplete="off"
        />
        <TextAreaField
          label="Instructions"
          value={draft.instructions}
          onChange={(event) => set("instructions", event.target.value)}
          error={issueAt(issues, `${path}.instructions`)}
          rows={2}
        />
      </div>

      {draft.type === "choice" ? <ChoiceRows draft={draft} path={path} issues={issues} onChange={(choices) => set("choices", choices)} /> : null}
      {draft.type === "score" ? <LevelRows draft={draft} path={path} issues={issues} onChange={(levels) => set("levels", levels)} /> : null}
      {draft.type === "predicate" ? (
        <p className="field-hint">A yes or no question. The answer is yes when the model&rsquo;s probability is at least 0.5.</p>
      ) : null}
    </article>
  );
}

function ChoiceRows({
  draft,
  path,
  issues,
  onChange,
}: {
  draft: QuestionDraft;
  path: string;
  issues: readonly BuildIssue[];
  onChange: (choices: ChoiceRow[]) => void;
}) {
  const update = (id: string, patch: Partial<ChoiceRow>): void =>
    onChange(draft.choices.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  const changeValueType = (row: ChoiceRow, valueType: ValueType): void => {
    update(row.id, { valueType, text: valueType === "boolean" ? "true" : "" });
  };

  return (
    <fieldset className="choice-set">
      <legend className="choice-legend">
        Choices{" "}
        <span className="muted">
          ({draft.choices.length} of {LIMITS.choices.max})
        </span>
      </legend>
      <div className="choice-head" aria-hidden="true">
        <span>Type</span>
        <span>Value</span>
        <span>Meaning</span>
        <span />
      </div>
      <ol className="choice-rows">
        {draft.choices.map((row, rowIndex) => {
          const rowPath = `${path}.choices.${rowIndex}`;
          return (
            <li key={row.id} className="choice-row">
              <SelectField
                label={`Value type, choice ${rowIndex + 1}`}
                labelHidden
                value={row.valueType}
                onChange={(event) => changeValueType(row, event.target.value as ValueType)}
              >
                {VALUE_TYPE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </SelectField>
              {row.valueType === "boolean" ? (
                <SelectField
                  label={`Value, choice ${rowIndex + 1}`}
                  labelHidden
                  value={row.text === "false" ? "false" : "true"}
                  error={issueAt(issues, `${rowPath}.value`)}
                  onChange={(event) => update(row.id, { text: event.target.value })}
                >
                  <option value="true">true</option>
                  <option value="false">false</option>
                </SelectField>
              ) : (
                <TextField
                  label={`Value, choice ${rowIndex + 1}`}
                  labelHidden
                  value={row.text}
                  error={issueAt(issues, `${rowPath}.value`)}
                  onChange={(event) => update(row.id, { text: event.target.value })}
                  mono
                  inputMode={row.valueType === "number" ? "decimal" : "text"}
                  spellCheck={false}
                  autoComplete="off"
                />
              )}
              <TextField
                label={`Meaning, choice ${rowIndex + 1}`}
                labelHidden
                value={row.description}
                error={issueAt(issues, `${rowPath}.description`)}
                onChange={(event) => update(row.id, { description: event.target.value })}
                autoComplete="off"
              />
              <Button
                variant="quiet"
                small
                className="choice-remove"
                aria-label={`Remove choice ${rowIndex + 1}`}
                disabled={draft.choices.length <= LIMITS.choices.min}
                onClick={() => onChange(draft.choices.filter((item) => item.id !== row.id))}
              >
                <Icon name="close" size={14} />
              </Button>
            </li>
          );
        })}
      </ol>
      <div className="row-start">
        <Button
          variant="secondary"
          small
          onClick={() => onChange([...draft.choices, makeChoice()])}
          disabled={draft.choices.length >= LIMITS.choices.max}
        >
          <Icon name="plus" size={14} />
          <span>Add choice</span>
        </Button>
      </div>
      {issueAt(issues, `${path}.choices`) ? (
        <p className="field-error" role="alert">
          <Icon name="warning" size={14} />
          <span>{issueAt(issues, `${path}.choices`)}</span>
        </p>
      ) : null}
    </fieldset>
  );
}

function LevelRows({
  draft,
  path,
  issues,
  onChange,
}: {
  draft: QuestionDraft;
  path: string;
  issues: readonly BuildIssue[];
  onChange: (levels: LevelRow[]) => void;
}) {
  const update = (id: string, patch: Partial<LevelRow>): void =>
    onChange(draft.levels.map((row) => (row.id === id ? { ...row, ...patch } : row)));

  return (
    <fieldset className="choice-set">
      <legend className="choice-legend">
        Levels{" "}
        <span className="muted">
          ({draft.levels.length} of {LIMITS.levels.max}, lowest first)
        </span>
      </legend>
      <div className="choice-head choice-head--levels" aria-hidden="true">
        <span>Label</span>
        <span>Meaning</span>
        <span />
      </div>
      <ol className="choice-rows choice-rows--levels">
        {draft.levels.map((row, rowIndex) => {
          const rowPath = `${path}.levels.${rowIndex}`;
          return (
            <li key={row.id} className="level-row">
              <TextField
                label={`Label, level ${rowIndex + 1} (optional)`}
                labelHidden
                value={row.label}
                error={issueAt(issues, `${rowPath}.label`)}
                onChange={(event) => update(row.id, { label: event.target.value })}
                mono
                spellCheck={false}
                autoComplete="off"
              />
              <TextField
                label={`Meaning, level ${rowIndex + 1}`}
                labelHidden
                value={row.description}
                error={issueAt(issues, `${rowPath}.description`)}
                onChange={(event) => update(row.id, { description: event.target.value })}
                autoComplete="off"
              />
              <Button
                variant="quiet"
                small
                className="choice-remove"
                aria-label={`Remove level ${rowIndex + 1}`}
                disabled={draft.levels.length <= LIMITS.levels.min}
                onClick={() => onChange(draft.levels.filter((item) => item.id !== row.id))}
              >
                <Icon name="close" size={14} />
              </Button>
            </li>
          );
        })}
      </ol>
      <div className="row-start">
        <Button
          variant="secondary"
          small
          onClick={() => onChange([...draft.levels, makeLevel()])}
          disabled={draft.levels.length >= LIMITS.levels.max}
        >
          <Icon name="plus" size={14} />
          <span>Add level</span>
        </Button>
      </div>
      <p className="field-hint">Labels are optional, but if you give one it must be unique within the question.</p>
    </fieldset>
  );
}

function CurlBlock({ curl, requireKeys }: { curl: string | null; requireKeys: boolean }) {
  if (!curl) return null;
  return (
    <div className="result-block">
      <h3 className="result-subhead">Equivalent curl</h3>
      <CodeBlock label="Equivalent curl" text={curl} language="curl" actions={<CopyButton text={curl} />} />
      <p className="field-hint">
        {requireKeys ? (
          <>
            Set <span className="mono">DG_CLIENT_KEY</span> to a client key from <a href={hrefFor("keys")}>Keys</a> first.
          </>
        ) : (
          "Apps need no key right now, so no Authorization header is included."
        )}
      </p>
    </div>
  );
}

type TitleOf = (name: string) => string;

function FailedRun({ run, curl, requireKeys, titleOf }: { run: PlaygroundRun; curl: string | null; requireKeys: boolean; titleOf: TitleOf }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    reveal(ref.current);
  }, [run]);
  const sentence = outcomeSentence({ status: "error", attempts: run.trace.attempts, provider: "", error: run.error?.message ?? null }, titleOf);
  return (
    <div className="result result--failed" role="alert" ref={ref}>
      <header className="result-head">
        <Flag tone="error">{run.error?.type ?? "Failed"}</Flag>
      </header>
      {/* The upstream's message is said once here and once in the attempts: the run's error repeats the last attempt's. */}
      <p className="result-lede">{sentence}</p>
      <Disclosure summary="Details: attempts, trace and curl">
        <div className="result-block">
          <h3 className="result-subhead">Attempts</h3>
          <AttemptsTimeline attempts={run.trace.attempts} />
        </div>
        <div className="result-block">
          <h3 className="result-subhead">Upstream trace</h3>
          <JsonBlock label="Upstream request" value={run.trace.upstream_request} empty="No upstream request was sent." />
          <JsonBlock label="Upstream response" value={run.trace.upstream_response} empty="No upstream response." />
        </div>
        <CurlBlock curl={curl} requireKeys={requireKeys} />
      </Disclosure>
    </div>
  );
}

function ResultView({
  run,
  response,
  curl,
  requireKeys,
  titleOf,
  priceHref,
}: {
  run: PlaygroundRun;
  response: DecisionResponse;
  curl: string | null;
  requireKeys: boolean;
  titleOf: TitleOf;
  priceHref: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const now = Date.now();
  useEffect(() => {
    reveal(ref.current);
  }, [response.id]);

  const gateway = response.gateway;
  const mixed = gateway.confidence_method === "mixed";
  const fellBack = gateway.attempts.length > 1;
  const sentence = outcomeSentence(
    {
      status: "ok",
      attempts: gateway.attempts,
      provider: gateway.provider,
      error: null,
      served_by: gateway.served_by,
      upstream_model_resolved: gateway.upstream_model_resolved,
    },
    titleOf,
  );
  return (
    <div className="result" ref={ref}>
      <div className="answers">
        {response.answers.map((answer, index) => (
          <AnswerView key={`${answer.name}-${index}`} answer={answer} />
        ))}
      </div>

      <div className="result-summary">
        <p className="result-who">
          <Flag tone={fellBack ? "warn" : "ok"}>{formatMs(gateway.latency_ms)}</Flag>
          <span>{sentence}</span>
        </p>
        <CostLine gateway={gateway} priceHref={priceHref} />
      </div>

      <Disclosure summary="Details: attempts, trace and curl">
        <dl className="facts facts--grid">
          <div>
            <dt>Model</dt>
            <dd className="mono">{gateway.route ?? "direct (provider::model)"}</dd>
          </div>
          <div>
            <dt>Answered by</dt>
            <dd className="mono">{answeredByLine(gateway, titleOf)}</dd>
          </div>
          {gateway.served_by ? (
            <div>
              <dt>Model sent</dt>
              <dd className="mono">{gateway.upstream_model}</dd>
            </div>
          ) : null}
          <div>
            <dt>Input tokens</dt>
            <dd className="mono">{response.usage ? formatCount(response.usage.input_tokens) : "not reported"}</dd>
          </div>
          <div>
            <dt>Confidence</dt>
            <dd>
              {methodLabel(gateway.confidence_method)}
              {mixed ? <span className="muted"> · answers differ</span> : null}
            </dd>
          </div>
          <div>
            <dt>Decision id</dt>
            <dd className="mono">{response.id}</dd>
          </div>
          <div>
            <dt>Created</dt>
            <dd>{formatRelative(response.created * 1000, now)}</dd>
          </div>
        </dl>
        <div className="result-block">
          <h3 className="result-subhead">Attempts</h3>
          <AttemptsTimeline attempts={gateway.attempts} />
        </div>
        <div className="result-block">
          <h3 className="result-subhead">Trace</h3>
          <p className="field-hint">The upstream request and response for the last attempt. Secrets are redacted.</p>
          <JsonBlock label="Upstream request" value={run.trace.upstream_request} empty="Not captured." />
          <JsonBlock label="Upstream response" value={run.trace.upstream_response} empty="Not captured." />
        </div>
        <CurlBlock curl={curl} requireKeys={requireKeys} />
      </Disclosure>
    </div>
  );
}
