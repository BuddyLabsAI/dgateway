import { describe, expect, test } from "bun:test";
import { PRESETS, presetById, presetForProvider } from "../../../src/modules/gateway/apps/console-web/src/domain/provider-presets";
import { presetDraft } from "../../../src/modules/gateway/apps/console-web/src/domain/connection-form";
import { providerWrite } from "../../../src/modules/gateway/apps/console-web/src/domain/add-provider";
import { wireTag } from "../../../src/modules/gateway/apps/console-web/src/domain/connections";
import { createMockApi } from "../../../src/modules/gateway/apps/console-web/src/api/mock/mock-api";

const preset = (id: string) => {
  const found = presetById(id);
  if (!found) throw new Error(`no preset ${id}`);
  return found;
};

const noWait = async (): Promise<void> => {};

describe("the explicit chat presets", () => {
  test("OpenAI (chat-endpoint) and OpenRouter (chat-endpoint) sit right after their native presets; the generic chat preset stays", () => {
    const ids = PRESETS.map((p) => p.id);
    expect(ids.indexOf("openai-chat")).toBe(ids.indexOf("openai") + 1);
    expect(ids.indexOf("openrouter-chat")).toBe(ids.indexOf("openrouter") + 1);
    expect(preset("synthetic-chat").title).toBe("Any OpenAI-compatible chat model (synthetic)");
  });

  test("each uses the chat wire, its chat path and the native preset's key variable", () => {
    const row = (id: string) => {
      const p = preset(id);
      return [p.title, p.kind, p.wire, p.baseUrl, p.path, p.key, p.envVar, p.limits];
    };

    const limits = { max_questions: 16, max_choices: 64 };
    expect(row("openai-chat")).toEqual(["OpenAI (chat-endpoint)", "openai", "chat", "https://api.openai.com/v1", "/chat/completions", "required", "OPENAI_API_KEY", limits]);
    expect(row("openrouter-chat")).toEqual([
      "OpenRouter (chat-endpoint)",
      "openrouter",
      "chat",
      "https://openrouter.ai",
      "/api/v1/chat/completions",
      "required",
      "OPENROUTER_API_KEY",
      limits,
    ]);
    for (const id of ["openai-chat", "openrouter-chat"]) expect(preset(id).pick).toContain("chat models as synthetic decisions");
  });

  test("the native presets keep their decision APIs", () => {
    expect([preset("openai").wire, preset("openai").path]).toEqual([undefined, "/decisions"]);
    expect([preset("openrouter").wire, preset("openrouter").path]).toEqual([undefined, "/api/alpha/decisions"]);
  });

  test("a provider made from each is a chat-wire provider named after the preset, with an env key", () => {
    for (const [id, envVar] of [["openai-chat", "OPENAI_API_KEY"], ["openrouter-chat", "OPENROUTER_API_KEY"]] as const) {
      const draft = { ...presetDraft(preset(id), ["openai", "openrouter"]), keyMode: "env" as const, envVar };
      expect(draft.name).toBe(id);
      const write = providerWrite(draft);
      expect(write).toMatchObject({ name: id, wire: "chat", path: preset(id).path, key: { source: "env", env_var: envVar } });
    }
    expect(presetDraft(preset("openai-chat"), ["openai-chat"]).name).toBe("openai-chat-2");
  });

  test("the seeded chat providers match their presets, and the native ones match theirs", () => {
    const base = { base_url: "https://api.openai.com/v1" };
    expect(presetForProvider({ ...base, kind: "openai", path: "/chat/completions" })?.id).toBe("openai-chat");
    expect(presetForProvider({ ...base, kind: "openai", path: "/decisions" })?.id).toBe("openai");
    expect(presetForProvider({ kind: "openrouter", base_url: "https://openrouter.ai", path: "/api/v1/chat/completions" })?.id).toBe("openrouter-chat");
  });
});

describe("the wire tag on a provider card", () => {
  test("chat reads Synthetic, a decision API reads Native, the mock has none", () => {
    expect(wireTag({ kind: "openrouter", wire: "chat" })?.text).toBe("Synthetic");
    expect(wireTag({ kind: "openai-compatible", wire: "chat" })?.text).toBe("Synthetic");
    expect(wireTag({ kind: "openrouter", wire: "map" })?.text).toBe("Native");
    expect(wireTag({ kind: "openai", wire: "openai" })?.text).toBe("Native");
    expect(wireTag({ kind: "mock", wire: "openai" })).toBeNull();
  });
});

describe("mock mode", () => {
  test("a fresh first run lists openai-chat and openrouter-chat disabled, with no model using them", async () => {
    const api = createMockApi({ delay: noWait, scenario: "fresh" });
    const providers = await api.listProviders();
    const chat = providers.filter((p) => p.name.endsWith("-chat"));
    expect(chat.map((p) => [p.name, p.kind, p.wire, p.enabled, p.key])).toEqual([
      ["openai-chat", "openai", "chat", false, { source: "env", env_var: "OPENAI_API_KEY", present: false }],
      ["openrouter-chat", "openrouter", "chat", false, { source: "env", env_var: "OPENROUTER_API_KEY", present: false }],
    ]);
    expect(providers.find((p) => p.name === "openrouter")).toMatchObject({ wire: "map", path: "/api/alpha/decisions" });
    const routes = await api.listRoutes();
    const ids = new Set(chat.map((p) => p.id));
    expect(routes.some((r) => r.targets.some((t) => ids.has(t.provider_id)))).toBe(false);
  });
});
