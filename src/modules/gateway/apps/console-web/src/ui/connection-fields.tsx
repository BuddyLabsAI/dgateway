// How a provider is reached, as form fields: address, path, request format, whether the model is named,
// the header that carries the key, the model Test uses, timeout and limits, extra body, and model hints.
// A card's Advanced settings and Add provider's Advanced section both use them.

import type { ReactNode } from "react";
import type { WireShape, SyntheticMethod } from "../api/types";
import type { ConnectionDraft, ConnectionField } from "../domain/connection-form";
import { chatPath, moveSyntheticMethod, reasoningNote } from "../domain/connection-form";
import { REQUEST_FORMAT } from "../domain/connections";
import { kindUsesHints } from "../domain/provider-presets";
import { Button, SelectField, Segmented, Switch, TextAreaField, TextField } from "./controls";

const WIRE_OPTIONS: { value: WireShape; label: string }[] = [
  { value: "openai", label: REQUEST_FORMAT.openai.label },
  { value: "map", label: REQUEST_FORMAT.map.label },
  { value: "chat", label: REQUEST_FORMAT.chat.label },
];

/** The sentence under the Docker-host address: why it is not localhost. */
export const DOCKER_HOST_HINT =
  "When the gateway runs in Docker, localhost means the gateway's own container. host.docker.internal reaches the machine Docker runs on.";

export function ConnectionFields({
  draft,
  errors,
  onChange,
  onBaseUrl,
  onSendModel,
  baseUrlHint,
  showBaseUrl = true,
}: {
  draft: ConnectionDraft;
  errors: Partial<Record<ConnectionField, string>>;
  onChange: <K extends keyof ConnectionDraft>(key: K, value: ConnectionDraft[K]) => void;
  /** A new address. Add provider uses it to let send_model follow the address until the owner sets it. */
  onBaseUrl?: (baseUrl: string) => void;
  /** The owner set send_model themselves. */
  onSendModel?: (sendModel: boolean) => void;
  baseUrlHint?: ReactNode;
  /** False when the address is asked for elsewhere on the page. */
  showBaseUrl?: boolean;
}) {
  const openaiWire = draft.wire === "openai" || draft.wire === "chat";
  return (
    <>
      <div className="form-grid">
        {showBaseUrl ? (
          <TextField
            label="Base URL"
            value={draft.baseUrl}
            onChange={(event) => (onBaseUrl ? onBaseUrl(event.target.value) : onChange("baseUrl", event.target.value))}
            error={errors.baseUrl}
            hint={baseUrlHint}
            mono
            spellCheck={false}
            inputMode="url"
            autoComplete="off"
          />
        ) : null}
        <TextField
          label="Path"
          value={draft.path}
          onChange={(event) => onChange("path", event.target.value)}
          error={errors.path}
          mono
          spellCheck={false}
          autoComplete="off"
        />
      </div>

      <div className="field">
        <div className="field-label">
          <span>Request format</span>
        </div>
        <Segmented label="Request format" options={WIRE_OPTIONS} value={draft.wire} onChange={(value) => { onChange("wire", value); if (value === "chat") onChange("path", chatPath(draft.kind, draft.baseUrl)); }} />
        <p className="field-hint">{REQUEST_FORMAT[draft.wire].sentence}</p>
      </div>

      {draft.wire === "chat" ? (
        <fieldset className="field">
          <legend className="field-label">Synthetic methods, in order</legend>
          <p className="field-hint">Logprobs is best calibrated. Sampling gives coarse frequencies, and JSON gives the weakest estimates, stated by the model itself. If a model does not support a method, the next enabled one is used.</p>
          {draft.syntheticMethods.map((method, index) => (
            <div className="form-grid" key={method}>
              <Switch checked onChange={() => onChange("syntheticMethods", draft.syntheticMethods.filter((m) => m !== method))} label={`${index + 1}. ${method}`} />
              <div>
                <Button small disabled={index === 0} aria-label={`Move ${method} earlier`} onClick={() => onChange("syntheticMethods", moveSyntheticMethod(draft.syntheticMethods, index, -1))}>↑ Earlier</Button>
                <Button small disabled={index === draft.syntheticMethods.length - 1} aria-label={`Move ${method} later`} onClick={() => onChange("syntheticMethods", moveSyntheticMethod(draft.syntheticMethods, index, 1))}>↓ Later</Button>
              </div>
            </div>
          ))}
          {(["logprobs", "sampling", "json"] as SyntheticMethod[]).filter((m) => !draft.syntheticMethods.includes(m)).map((method) => <Switch key={method} checked={false} onChange={() => onChange("syntheticMethods", [...draft.syntheticMethods, method])} label={`Enable ${method}`} />)}
          {errors.syntheticMethods ? <p role="alert" className="field-hint">{errors.syntheticMethods}</p> : null}
          <div className="form-grid">
            <TextField label="Sampling count" value={draft.samplingN} onChange={(event) => onChange("samplingN", event.target.value)} error={errors.samplingN} inputMode="numeric" hint="2–32 samples; default 8. Sampling multiplies output and reasoning-token costs." />
            <SelectField label="JSON transport" value={draft.jsonTransport} onChange={(event) => onChange("jsonTransport", event.target.value as typeof draft.jsonTransport)} hint="Auto tries JSON Schema, then prompt if unsupported.">
              <option value="auto">Auto: JSON Schema → prompt</option><option value="json_schema">JSON Schema only</option><option value="prompt">Prompt only</option>
            </SelectField>
          </div>
          <Switch checked={draft.disableReasoning} onChange={(checked) => onChange("disableReasoning", checked)} label="Turn reasoning off" description={reasoningNote(draft.kind)} />
        </fieldset>
      ) : null}

      <Switch
        checked={openaiWire || draft.sendModel}
        onChange={(checked) => (onSendModel ? onSendModel(checked) : onChange("sendModel", checked))}
        label="Send the model id"
        disabled={openaiWire}
        description={
          openaiWire
            ? "This request format always names the model, so this is always on."
            : "Adds the step's upstream model to each request. Hosted SystemOne vendors need it; a local server that loaded one model does not."
        }
      />

      <TextField
        label="Key header"
        value={draft.authHeader}
        onChange={(event) => onChange("authHeader", event.target.value)}
        error={errors.authHeader}
        hint='authorization sends "Bearer <key>". Any other header, such as x-api-key, carries the key as it is.'
        mono
        spellCheck={false}
        autoComplete="off"
        className="field--narrow"
      />

      <TextField
        label="Test model"
        value={draft.testModel}
        onChange={(event) => onChange("testModel", event.target.value)}
        error={errors.testModel}
        placeholder="none"
        hint="Test uses this model when none of your models uses this provider. Presets fill in a cheap model known to work. Empty uses the first suggested model, or else the cheapest in the catalog."
        mono
        spellCheck={false}
        autoComplete="off"
        className="field--narrow"
      />

      <div className="form-grid form-grid--three">
        <TextField
          label="Timeout (ms)"
          value={draft.timeoutMs}
          onChange={(event) => onChange("timeoutMs", event.target.value)}
          error={errors.timeoutMs}
          inputMode="numeric"
          mono
        />
        <TextField
          label="Max questions"
          value={draft.maxQuestions}
          onChange={(event) => onChange("maxQuestions", event.target.value)}
          error={errors.maxQuestions}
          inputMode="numeric"
          mono
          hint="Requests with more questions skip this provider."
        />
        <TextField
          label="Max choices"
          value={draft.maxChoices}
          onChange={(event) => onChange("maxChoices", event.target.value)}
          error={errors.maxChoices}
          inputMode="numeric"
          mono
        />
      </div>

      <TextAreaField
        label="Extra body (JSON object)"
        value={draft.extraBody}
        onChange={(event) => onChange("extraBody", event.target.value)}
        error={errors.extraBody}
        hint="Merged into every upstream request. For OpenRouter, provider preferences go here."
        mono
        rows={4}
        spellCheck={false}
      />

      {kindUsesHints(draft.kind) ? (
        <TextAreaField
          label="Model hints (JSON list)"
          value={draft.modelHints}
          onChange={(event) => onChange("modelHints", event.target.value)}
          error={errors.modelHints}
          hint="Models to suggest, with list prices in USD per million input tokens. A step with no price of its own is charged its model's hint price."
          mono
          rows={6}
          spellCheck={false}
        />
      ) : null}
    </>
  );
}
