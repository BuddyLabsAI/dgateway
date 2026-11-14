import { describe, expect, test } from "bun:test";
import {
  buildDecisionRequest,
  emptyBuilder,
  equivalentCurl,
  makeChoice,
  makeLevel,
  makeQuestion,
  parseChoiceValue,
  presets,
  shellQuote,
  type BuilderState,
} from "../../../src/modules/gateway/apps/console-web/src/domain/playground";

function validState(): BuilderState {
  const department = makeQuestion("choice", "department", "Which team?");
  department.choices = [makeChoice("string", "billing", "Money."), makeChoice("string", "technical", "Bugs.")];
  return { model: " luna ", input: "Charged twice.", questions: [department] };
}

describe("request builder: conversion", () => {
  test("builds a DecisionRequest with trimmed model and input and omits a blank model", () => {
    const result = buildDecisionRequest(validState());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.model).toBe("luna");
    expect(result.request.input).toBe("Charged twice.");
    expect(result.request.questions[0]).toEqual({
      name: "department",
      type: "choice",
      instructions: "Which team?",
      choices: [
        { value: "billing", description: "Money." },
        { value: "technical", description: "Bugs." },
      ],
    });
  });

  test("leaves model out when it is blank, so the default route applies", () => {
    const state = { ...validState(), model: "   " };
    const result = buildDecisionRequest(state);
    expect(result.ok).toBe(true);
    if (result.ok) expect("model" in result.request).toBe(false);
  });

  test("keeps boolean and number choice values typed", () => {
    const paid = makeQuestion("choice", "paid", "Paid?");
    paid.choices = [makeChoice("boolean", "true", "Yes."), makeChoice("boolean", "false", "No.")];
    const tier = makeQuestion("choice", "tier", "Tier?");
    tier.choices = [makeChoice("number", "1", "Urgent."), makeChoice("number", "2.5", "Other.")];
    const result = buildDecisionRequest({ model: "", input: "x", questions: [paid, tier] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.questions[0]?.choices?.map((c) => c.value)).toEqual([true, false]);
    expect(result.request.questions[1]?.choices?.map((c) => c.value)).toEqual([1, 2.5]);
  });

  test("a predicate carries neither choices nor levels", () => {
    const urgent = makeQuestion("predicate", "is_urgent", "Urgent?");
    const result = buildDecisionRequest({ model: "", input: "x", questions: [urgent] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.request.questions[0] ?? {}).sort()).toEqual(["instructions", "name", "type"]);
  });

  test("a score question carries levels, with labels only where they were given", () => {
    const severity = makeQuestion("score", "severity", "How bad?");
    severity.levels = [makeLevel("minor", "Small."), makeLevel("", "Large.")];
    const result = buildDecisionRequest({ model: "", input: "x", questions: [severity] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.questions[0]?.levels).toEqual([{ label: "minor", description: "Small." }, { description: "Large." }]);
  });
});

describe("request builder: validation", () => {
  test("flags a question name used twice, pointing at the later one", () => {
    const a = makeQuestion("predicate", "urgent", "A?");
    const b = makeQuestion("predicate", " urgent ", "B?");
    const result = buildDecisionRequest({ model: "", input: "x", questions: [a, b] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([{ path: "questions.1.name", message: 'The name "urgent" is already used by question 1.' }]);
  });

  test("flags choice values that collide as text, such as string 1 and number 1", () => {
    const tier = makeQuestion("choice", "tier", "Tier?");
    tier.choices = [makeChoice("string", "1", "A."), makeChoice("number", "1", "B.")];
    const result = buildDecisionRequest({ model: "", input: "x", questions: [tier] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.path)).toEqual(["questions.0.choices.1.value"]);
    expect(result.issues[0]?.message).toContain("Values must be unique as text");
  });

  test("flags duplicate score labels before anything is sent", () => {
    const severity = makeQuestion("score", "severity", "How bad?");
    severity.levels = [makeLevel("high", "A."), makeLevel("high", "B.")];
    const result = buildDecisionRequest({ model: "", input: "x", questions: [severity] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      { path: "questions.0.levels.1.label", message: 'The label "high" is already used by level 1. Labels must be unique.' },
    ]);
  });

  test("flags an empty input, an empty question list and too few choices", () => {
    const choice = makeQuestion("choice", "q", "Q?");
    choice.choices = [makeChoice("string", "only", "One.")];
    const result = buildDecisionRequest({ model: "", input: "   ", questions: [choice] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((i) => i.path);
    expect(paths).toContain("input");
    expect(paths).toContain("questions.0.choices");
    const none = buildDecisionRequest({ model: "", input: "x", questions: [] });
    expect(none.ok).toBe(false);
  });

  test("rejects a number that does not parse, and an empty boolean", () => {
    expect(parseChoiceValue(makeChoice("number", "abc"))).toEqual({ ok: false, message: "Enter a finite number." });
    expect(parseChoiceValue(makeChoice("number", ""))).toEqual({ ok: false, message: "Enter a number." });
    expect(parseChoiceValue(makeChoice("boolean", ""))).toEqual({ ok: false, message: "Choose true or false." });
    expect(parseChoiceValue(makeChoice("boolean", "false"))).toEqual({ ok: true, value: false });
  });

  test("the empty starter builder asks for input and an instruction, not for a blank request", () => {
    const result = buildDecisionRequest(emptyBuilder());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const paths = result.issues.map((i) => i.path);
    for (const path of ["input", "questions.0.name", "questions.0.instructions"]) expect(paths).toContain(path);
  });
});

describe("request builder: presets and curl", () => {
  test("every example preset builds into a valid request", () => {
    for (const preset of presets()) {
      const result = buildDecisionRequest(preset.build());
      expect(result.ok, preset.id).toBe(true);
    }
    expect(presets()).toHaveLength(3);
  });

  test("shellQuote escapes single quotes so pasted commands stay intact", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  test("the equivalent curl adds the client key header only when client keys are required", () => {
    const result = buildDecisionRequest(validState());
    if (!result.ok) throw new Error("fixture should be valid");
    const open = equivalentCurl(result.request, "http://127.0.0.1:8790", false);
    const keyed = equivalentCurl(result.request, "http://127.0.0.1:8790", true);
    expect(open.startsWith("curl http://127.0.0.1:8790/v1/decisions")).toBe(true);
    expect(open).not.toContain("Authorization");
    expect(keyed).toContain('-H "Authorization: Bearer $DG_CLIENT_KEY"');
    expect(keyed).toContain('"model": "luna"');
  });
});
