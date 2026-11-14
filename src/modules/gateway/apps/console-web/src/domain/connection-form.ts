// The provider form (a card's Advanced settings, and the details of Add provider): form text in, a provider
// body out, with every issue tied to its field. Validation mirrors the contract. Pure.

import type { KeyWrite, ModelHint, Provider, ProviderKind, ProviderWrite, WireShape, SyntheticMethod, JsonTransport } from "../api/types";
import { defaultSendModel } from "./hosts";
import { parseJsonObject } from "./json";
import { presetModelHints, presetTestModel, suggestProviderName, wireFor, type ProviderPreset } from "./provider-presets";

export type KeyMode = "env" | "stored" | "none";

export interface ConnectionDraft {
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  path: string;
  wire: WireShape;
  syntheticMethods: SyntheticMethod[];
  samplingN: string;
  jsonTransport: JsonTransport;
  /** Chat wire: send the kind's way of turning reasoning off on every call. */
  disableReasoning: boolean;
  enabled: boolean;
  timeoutMs: string;
  maxQuestions: string;
  maxChoices: string;
  extraBody: string;
  keyMode: KeyMode;
  envVar: string;
  secret: string;
  /** Map wire: whether the body names the upstream model. */
  sendModel: boolean;
  /** The header that carries the key: "authorization" for Bearer, or a custom header for the raw key. */
  authHeader: string;
  /** The model hints as a JSON array. */
  modelHints: string;
  /** The model a test uses when no model sends this provider one. Empty for none. */
  testModel: string;
}

export type ConnectionField =
  | "syntheticMethods"
  | "samplingN"
  | "name"
  | "baseUrl"
  | "path"
  | "timeoutMs"
  | "maxQuestions"
  | "maxChoices"
  | "extraBody"
  | "envVar"
  | "secret"
  | "authHeader"
  | "modelHints"
  | "testModel";

export const NAME_PATTERN = /^[a-z0-9-]+$/;
export const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const HEADER_PATTERN = /^[A-Za-z0-9-]+$/;
const RESERVED_HEADERS = ["content-type", "host"];

export const KIND_DEFAULTS: Record<ProviderKind, Pick<ConnectionDraft, "baseUrl" | "path" | "wire" | "envVar" | "keyMode">> = {
  openai: { baseUrl: "https://api.openai.com/v1", path: "/decisions", wire: "openai", envVar: "OPENAI_API_KEY", keyMode: "env" },
  openrouter: { baseUrl: "https://openrouter.ai", path: "/api/alpha/decisions", wire: "map", envVar: "OPENROUTER_API_KEY", keyMode: "env" },
  systemone: { baseUrl: "http://host.docker.internal:8080", path: "/v1/systemone", wire: "map", envVar: "", keyMode: "none" },
  "openai-compatible": { baseUrl: "http://host.docker.internal:8000/v1", path: "/decisions", wire: "openai", envVar: "", keyMode: "none" },
  mock: { baseUrl: "builtin://mock", path: "/decisions", wire: "openai", envVar: "", keyMode: "none" },
};

const hintsText = (hints: readonly ModelHint[] | undefined): string => JSON.stringify(hints ?? [], null, 2);

/** A new connection starts as a custom OpenAI-compatible server; a saved one reads back its values. */
export function connectionDraft(provider: Provider | null, kind: ProviderKind = "openai-compatible"): ConnectionDraft {
  if (!provider) {
    const defaults = KIND_DEFAULTS[kind];
    return {
      name: "",
      kind,
      baseUrl: defaults.baseUrl,
      path: defaults.path,
      wire: defaults.wire,
      syntheticMethods: ["logprobs", "sampling", "json"], samplingN: "8", jsonTransport: "auto",
      disableReasoning: defaultDisableReasoning(kind),
      enabled: true,
      timeoutMs: "20000",
      maxQuestions: "400",
      maxChoices: "64",
      extraBody: "{}",
      keyMode: defaults.keyMode,
      envVar: defaults.envVar,
      secret: "",
      sendModel: defaultSendModel(kind, defaults.baseUrl),
      authHeader: "authorization",
      modelHints: "[]",
      testModel: "",
    };
  }
  return {
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.base_url,
    path: provider.path,
    wire: provider.wire,
    syntheticMethods: provider.synthetic_methods ?? ["logprobs", "sampling", "json"], samplingN: String(provider.sampling_n ?? 8), jsonTransport: provider.json_transport ?? "auto",
    disableReasoning: provider.disable_reasoning ?? defaultDisableReasoning(provider.kind),
    enabled: provider.enabled,
    timeoutMs: String(provider.timeout_ms),
    maxQuestions: String(provider.limits.max_questions),
    maxChoices: String(provider.limits.max_choices),
    extraBody: JSON.stringify(provider.extra_body, null, 2),
    keyMode: provider.key.source,
    envVar: provider.key.source === "env" ? provider.key.env_var : "",
    secret: "",
    sendModel: provider.send_model ?? defaultSendModel(provider.kind, provider.base_url),
    authHeader: provider.auth_header ?? "authorization",
    modelHints: hintsText(provider.model_hints),
    testModel: provider.test_model ?? "",
  };
}

/** A new connection's draft after its kind changes: the kind's address, format and key source. */
export function withKind(draft: ConnectionDraft, kind: ProviderKind): ConnectionDraft {
  const defaults = KIND_DEFAULTS[kind];
  return { ...draft, kind, ...defaults, secret: "", sendModel: defaultSendModel(kind, defaults.baseUrl), disableReasoning: defaultDisableReasoning(kind) };
}

/** The gateway's default for disable_reasoning: on for OpenRouter, whose open models mostly think by default. */
export function defaultDisableReasoning(kind: ProviderKind): boolean {
  return kind === "openrouter";
}

/** The one-line note under the reasoning switch: what the gateway sends for this kind. */
export function reasoningNote(kind: ProviderKind): string {
  if (kind === "openrouter") return "Sends reasoning: { enabled: false } so thinking models answer within small token limits (default on). Hosts that require reasoning are retried once at low effort.";
  if (kind === "openai" || kind === "openai-compatible") return "Sends reasoning_effort: \"none\" (default off). Only newer OpenAI reasoning models accept it; others may refuse the request.";
  return "This kind has no reasoning setting, so nothing is sent.";
}

/**
 * The draft a preset starts Add provider with: its address, format, header, key source, hints and test model, a
 * name not taken yet, and send_model as the preset says ("auto" follows the address, as the gateway does).
 */
export function presetDraft(preset: ProviderPreset, taken: readonly string[]): ConnectionDraft {
  const base = connectionDraft(null, preset.kind);
  return {
    ...base,
    name: suggestProviderName(preset, taken),
    baseUrl: preset.baseUrl,
    path: preset.path,
    wire: preset.wire ?? wireFor(preset.kind),
    maxQuestions: String(preset.limits?.max_questions ?? 400),
    maxChoices: String(preset.limits?.max_choices ?? 64),
    keyMode: preset.key === "required" ? "stored" : "none",
    envVar: preset.envVar,
    sendModel: preset.sendModel === "auto" ? defaultSendModel(preset.kind, preset.baseUrl) : preset.sendModel,
    authHeader: preset.authHeader,
    modelHints: hintsText(presetModelHints(preset)),
    testModel: presetTestModel(preset) ?? "",
  };
}

/** A new base URL for the draft. While the owner has not set send_model themselves, it follows the address. */
export function withBaseUrl(draft: ConnectionDraft, baseUrl: string, sendModelChosen: boolean): ConnectionDraft {
  return { ...draft, baseUrl, sendModel: sendModelChosen ? draft.sendModel : defaultSendModel(draft.kind, baseUrl) };
}

function toInt(text: string, min: number, max: number): number | null {
  const value = Number(text.trim());
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

function validUrl(text: string, kind: ProviderKind): boolean {
  if (kind === "mock") return true;
  try {
    const url = new URL(text.trim());
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Why a header name cannot carry the key, or null when it can. */
export function authHeaderProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!HEADER_PATTERN.test(trimmed)) return "Use letters, digits and hyphens, such as authorization or x-api-key.";
  if (RESERVED_HEADERS.includes(trimmed.toLowerCase())) return "The gateway sets this header itself. Pick another, such as x-api-key.";
  return null;
}

const HINT_FIELDS = ["id", "price_per_m_input", "price_per_m_output", "context", "description"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validHint(value: unknown): value is ModelHint {
  if (!isRecord(value) || Object.keys(value).some((key) => !HINT_FIELDS.includes(key))) return false;
  const price = value.price_per_m_input;
  const context = value.context;
  const output = value.price_per_m_output;
  return (
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    (price === undefined || (typeof price === "number" && Number.isFinite(price) && price >= 0)) &&
    (output === undefined || (typeof output === "number" && Number.isFinite(output) && output >= 0)) &&
    (context === undefined || (typeof context === "number" && Number.isInteger(context) && context > 0)) &&
    (value.description === undefined || typeof value.description === "string")
  );
}

export type HintsParse = { ok: true; value: ModelHint[] } | { ok: false; message: string };

/** The model hints field: a JSON array of { id, price_per_m_input?, price_per_m_output?, context?, description? } with unique ids. */
export function parseModelHints(text: string): HintsParse {
  if (text.trim().length === 0) return { ok: true, value: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    return { ok: false, message: `Not valid JSON: ${cause instanceof Error ? cause.message : "the text is not valid JSON"}.` };
  }
  if (!Array.isArray(parsed) || !parsed.every(validHint)) {
    return {
      ok: false,
      message: 'Use a list of models, such as [{ "id": "jev-1.14", "price_per_m_input": 0.042 }]. price_per_m_input and price_per_m_output are USD per million input and output tokens.',
    };
  }
  const ids = parsed.map((hint) => hint.id);
  if (new Set(ids).size !== ids.length) return { ok: false, message: "Each model id may appear once." };
  return { ok: true, value: parsed };
}

export interface ValidatedConnection {
  errors: Partial<Record<ConnectionField, string>>;
  write: ProviderWrite | null;
}

function keyWrite(draft: ConnectionDraft, existing: Provider | null, errors: Partial<Record<ConnectionField, string>>): KeyWrite | undefined {
  if (draft.keyMode === "env") {
    const envVar = draft.envVar.trim();
    if (ENV_PATTERN.test(envVar)) return { source: "env", env_var: envVar };
    errors.envVar = "Enter an environment variable name, such as OPENAI_API_KEY.";
    return undefined;
  }
  if (draft.keyMode === "none") return { source: "none" };
  if (draft.secret.trim().length > 0) return { source: "stored", value: draft.secret.trim() };
  if (existing?.key.source !== "stored") {
    errors.secret = "Paste the key. It is stored encrypted and shown afterwards only as its last four characters.";
  }
  return undefined;
}

/** Checks the draft. `existing` is the saved connection, so an empty secret can keep its stored key. */
export function validateConnection(draft: ConnectionDraft, existing: Provider | null): ValidatedConnection {
  const errors: Partial<Record<ConnectionField, string>> = {};
  const name = draft.name.trim();
  if (!NAME_PATTERN.test(name)) errors.name = "Use lowercase letters, digits and hyphens, such as local-llm.";
  if (!validUrl(draft.baseUrl, draft.kind)) errors.baseUrl = "Enter a full http or https address, such as http://localhost:8000/v1.";
  if (!draft.path.trim().startsWith("/")) errors.path = "Start the path with a slash, such as /decisions.";
  const timeout = toInt(draft.timeoutMs, 100, 600000);
  if (timeout === null) errors.timeoutMs = "Enter a whole number of milliseconds from 100 to 600000.";
  const maxQuestions = toInt(draft.maxQuestions, 1, 400);
  if (maxQuestions === null) errors.maxQuestions = "Enter a whole number from 1 to 400.";
  const maxChoices = toInt(draft.maxChoices, 2, 64);
  if (maxChoices === null) errors.maxChoices = "Enter a whole number from 2 to 64.";
  const extra = parseJsonObject(draft.extraBody);
  if (!extra.ok) errors.extraBody = extra.message;
  const header = authHeaderProblem(draft.authHeader);
  if (header) errors.authHeader = header;
  const hints = parseModelHints(draft.modelHints);
  if (!hints.ok) errors.modelHints = hints.message;
  const testModel = draft.testModel.trim();
  if (testModel.length > 200) errors.testModel = "Use a model id of at most 200 characters, or leave it empty.";
  const key = keyWrite(draft, existing, errors);
  const samplingN = toInt(draft.samplingN, 2, 32);
  if (draft.wire === "chat") {
    if (!draft.syntheticMethods.length || new Set(draft.syntheticMethods).size !== draft.syntheticMethods.length) errors.syntheticMethods = "Enable at least one method, once each.";
    if (samplingN === null) errors.samplingN = "Enter a whole number from 2 to 32.";
    if (draft.syntheticMethods.length === 1 && draft.syntheticMethods[0] === "logprobs" && (maxChoices ?? 0) > 20) errors.maxChoices = "Logprobs alone supports at most 20 choices.";
  }

  if (Object.keys(errors).length > 0 || timeout === null || maxQuestions === null || maxChoices === null || !extra.ok || !hints.ok) {
    return { errors, write: null };
  }
  return {
    errors,
    write: {
      name,
      kind: draft.kind,
      base_url: draft.baseUrl.trim(),
      path: draft.path.trim(),
      wire: draft.wire,
      ...(draft.wire === "chat" ? { synthetic_methods: draft.syntheticMethods, sampling_n: samplingN ?? 8, json_transport: draft.jsonTransport, disable_reasoning: draft.disableReasoning } : {}),
      enabled: draft.enabled,
      timeout_ms: timeout,
      limits: { max_questions: maxQuestions, max_choices: maxChoices },
      extra_body: extra.value,
      key: key ?? { source: "none" },
      send_model: draft.sendModel,
      auth_header: draft.authHeader.trim().toLowerCase(),
      model_hints: hints.value,
      test_model: testModel || null,
    },
  };
}


export function chatPath(kind: ProviderKind, baseUrl: string): string {
  if (kind === "openrouter") return "/api/v1/chat/completions";
  return baseUrl.replace(/\/$/, "").endsWith("/v1") ? "/chat/completions" : "/v1/chat/completions";
}

export function moveSyntheticMethod(methods: SyntheticMethod[], index: number, direction: -1 | 1): SyntheticMethod[] {
  const result = [...methods];
  const target = index + direction;
  if (target < 0 || target >= result.length) return result;
  [result[index], result[target]] = [result[target]!, result[index]!];
  return result;
}
