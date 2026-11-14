import { test, expect } from "bun:test";
import { presetById } from "../../../src/modules/gateway/apps/console-web/src/domain/provider-presets";
import { chatPath, defaultDisableReasoning, moveSyntheticMethod, presetDraft, reasoningNote, validateConnection, connectionDraft, withKind } from "../../../src/modules/gateway/apps/console-web/src/domain/connection-form";
import { methodLabel } from "../../../src/modules/gateway/apps/console-web/src/domain/answers";
import { createMockApi } from "../../../src/modules/gateway/apps/console-web/src/api/mock/mock-api";
import { mockSyntheticAnswer } from "../../../src/modules/gateway/apps/console-web/src/domain/synthetic";
import type { DecisionRequest } from "../../../src/modules/gateway/apps/console-web/src/api/types";

test("synthetic preset saves ordered methods, low limits, sampling count and JSON transport", () => {
  const preset = presetById("synthetic-chat")!;
  const draft = { ...presetDraft(preset, []), baseUrl: "http://localhost:8000" };
  expect(draft.wire).toBe("chat");
  expect(draft.maxQuestions).toBe("16");
  expect(draft.maxChoices).toBe("64");
  expect(validateConnection(draft, null).write).toMatchObject({ wire: "chat", synthetic_methods: ["logprobs", "sampling", "json"], sampling_n: 8, json_transport: "auto" });
  expect(moveSyntheticMethod(draft.syntheticMethods, 2, -1)).toEqual(["logprobs", "json", "sampling"]);
  expect(validateConnection({ ...draft, syntheticMethods: [] }, null).write).toBeNull();
  expect(validateConnection({ ...draft, syntheticMethods: ["logprobs"] }, null).errors.maxChoices).toBeDefined();
  expect(validateConnection({ ...draft, samplingN: "33" }, null).errors.samplingN).toBeDefined();
  expect(chatPath("openai", "https://example.test/v1")).toBe("/chat/completions");
  expect(chatPath("openrouter", "https://example.test")).toBe("/api/v1/chat/completions");
  expect(methodLabel("logprobs")).toContain("best");
  expect(methodLabel("sampling")).toContain("coarse");
  expect(methodLabel("json")).toContain("weakest");
});

test("mock mode stores synthetic settings, labels each method and supports fresh TypeSafe seed", async () => {
  const api = createMockApi({ delay: async () => {}, scenario: "fresh" });
  const fresh = await api.listProviders();
  expect(fresh.find((p) => p.name === "typesafe")).toMatchObject({ enabled: false, key: { source: "env", env_var: "TYPESAFE_API_KEY" } });
  const draft = { ...presetDraft(presetById("synthetic-chat")!, []), baseUrl: "http://localhost:8000", syntheticMethods: ["json" as const], jsonTransport: "prompt" as const };
  const write = validateConnection(draft, null).write!;
  const provider = await api.createProvider(write);
  expect(connectionDraft(provider).syntheticMethods).toEqual(["json"]);
  expect(provider.json_transport).toBe("prompt");
  const request: DecisionRequest = { model: `${provider.name}::test`, input: "hello", questions: [{ name: "p", type: "predicate", instructions: "true?" }] };
  const result = await api.runPlayground(request);
  expect(result.response?.gateway).toMatchObject({ synthetic: true, confidence_method: "json" });
  expect(result.response?.answers[0]).toMatchObject({ confidence_method: "json" });
  for (const method of ["logprobs", "sampling"] as const) {
    await api.updateProvider(provider.id, { synthetic_methods: [method], limits: { max_questions: 16, max_choices: 20 }, sampling_n: 8 });
    expect((await api.runPlayground(request)).response?.gateway.confidence_method).toBe(method);
  }
  expect(mockSyntheticAnswer({ type: "predicate", name: "p", probability: 0.7 }, "sampling", 8)).toMatchObject({ probability: 0.75, confidence_method: "sampling" });
});



test("the reasoning switch defaults per kind, follows a saved value and reaches the chat body", async () => {
  const preset = presetById("synthetic-chat")!;
  const draft = { ...presetDraft(preset, []), baseUrl: "http://localhost:8000" };
  expect(defaultDisableReasoning("openrouter")).toBe(true);
  expect(defaultDisableReasoning("openai")).toBe(false);
  expect(defaultDisableReasoning("openai-compatible")).toBe(false);
  expect(connectionDraft(null, "openrouter").disableReasoning).toBe(true);
  expect(connectionDraft(null, "openai").disableReasoning).toBe(false);
  expect(withKind(connectionDraft(null, "openai"), "openrouter").disableReasoning).toBe(true);
  expect(validateConnection(draft, null).write).toMatchObject({ disable_reasoning: draft.disableReasoning });
  expect(validateConnection({ ...draft, disableReasoning: true }, null).write?.disable_reasoning).toBe(true);
  expect(validateConnection({ ...draft, wire: "openai" }, null).write?.disable_reasoning).toBeUndefined();
  expect(reasoningNote("openrouter")).toContain("enabled: false");
  expect(reasoningNote("openai")).toContain("reasoning_effort");
  expect(reasoningNote("systemone")).toContain("nothing is sent");

  const api = createMockApi({ delay: async () => {}, scenario: "fresh" });
  const provider = await api.createProvider(validateConnection({ ...draft, disableReasoning: true }, null).write!);
  expect(provider.disable_reasoning).toBe(true);
  expect(connectionDraft(provider).disableReasoning).toBe(true);
  // A provider saved without the field reads as its kind's default.
  const unset = { ...provider, disable_reasoning: undefined };
  expect(connectionDraft({ ...unset, kind: "openrouter" }).disableReasoning).toBe(true);
  expect(connectionDraft({ ...unset, kind: "openai-compatible" }).disableReasoning).toBe(false);
  let refused = false;
  await api.updateProvider(provider.id, { disable_reasoning: "yes" as unknown as boolean }).catch(() => { refused = true; });
  expect(refused).toBe(true);
});
