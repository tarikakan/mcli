import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCliArgs, parseInlineInput } from "../src/cli-args.ts";
import {
  discoverModelsForAgent,
  getModelsForAgent,
  parseCliModelsOutput,
  parseCodexModelsCache,
  parseKimiTomlModels,
  resolveModelAlias,
} from "../src/models.ts";

describe("models & aliases", () => {
  it("resolves short aliases for claude, codex, deepseek, kimi", () => {
    assert.equal(resolveModelAlias("claude", "o"), "opus");
    assert.equal(resolveModelAlias("deepseek", "reasoner"), "deepseek-reasoner");
    assert.equal(resolveModelAlias("deepseek", "r1"), "deepseek-reasoner");
    assert.equal(resolveModelAlias("codex", "5.3"), "gpt-5.3-codex");
    assert.equal(resolveModelAlias("kimi", "thinking"), "kimi-k2-thinking");
    assert.equal(resolveModelAlias("claude", "claude-opus-4-6"), "claude-opus-4-6");
  });

  it("merges configured custom models ahead of presets without duplicates", () => {
    const models = getModelsForAgent("claude", {
      model: "opus",
      models: ["my-enterprise-model", "sonnet"],
    });
    assert.equal(models[0].id, "opus");
    assert.equal(models[1].id, "my-enterprise-model");
    const ids = models.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("parses --agent:model and --models on CLI and inline", () => {
    const cli = parseCliArgs(["--claude:opus", "--deepseek:reasoner", "compare"]);
    assert.deepEqual(cli.agents, ["claude", "deepseek"]);
    assert.deepEqual(cli.agentModels, {
      claude: "opus",
      deepseek: "deepseek-reasoner",
    });
    assert.equal(cli.prompt, "compare");

    const cliModels = parseCliArgs(["--models"]);
    assert.equal(cliModels.listModels, true);
    assert.deepEqual(cliModels.agents, []);

    const inlineModels = parseInlineInput("--models");
    assert.equal(inlineModels.listModels, true);
    assert.equal(inlineModels.switchOnly, false);
    assert.deepEqual(inlineModels.agents, []);

    const inlineFilteredModels = parseInlineInput("--codex --models");
    assert.equal(inlineFilteredModels.listModels, true);
    assert.deepEqual(inlineFilteredModels.agents, ["codex"]);

    const inline = parseInlineInput("--claude:opus --codex:o3 review this");
    assert.deepEqual(inline.agents, ["claude", "codex"]);
    assert.deepEqual(inline.agentModels, { claude: "opus", codex: "o3" });
    assert.equal(inline.prompt, "review this");

    const switchOnly = parseInlineInput("--deepseek:r1");
    assert.equal(switchOnly.switchOnly, true);
    assert.deepEqual(switchOnly.agents, ["deepseek"]);
    assert.deepEqual(switchOnly.agentModels, { deepseek: "deepseek-reasoner" });
  });

  it("parses Codex models_cache.json, Kimi config.toml, and CLI models output", () => {
    const codex = parseCodexModelsCache({
      models: [
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol" },
        { id: "gpt-5.3-codex" },
      ],
    });
    assert.deepEqual(
      codex.map((m) => m.id),
      ["gpt-6.1-sol", "gpt-5.3-codex"],
    );

    const kimi = parseKimiTomlModels(
      `
default_model = "kimi-code/k3"
[models."kimi-code/k3"]
display_name = "K3"
[models."kimi-code/kimi-for-coding"]
model = "kimi-for-coding"
`,
      "~/.kimi/config.toml",
    );
    assert.ok(kimi.some((m) => m.id === "kimi-code/k3"));
    assert.ok(kimi.some((m) => m.id === "kimi-code/kimi-for-coding"));

    const agyOut = parseCliModelsOutput(
      "Available models:\n  * gemini-3-pro   Flagship Gemini\n  - claude-opus-4-6  Opus\n",
      "agy models",
    );
    assert.deepEqual(
      agyOut.map((m) => m.id),
      ["gemini-3-pro", "claude-opus-4-6"],
    );
  });

  it("discovers live DeepSeek models from GET /models", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "deepseek-chat", context_window: 128000 },
            { id: "deepseek-reasoner", context_window: 128000 },
            { id: "deepseek-v4-preview", context_window: 1000000 },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    try {
      const models = await discoverModelsForAgent(
        "deepseek",
        { apiKey: "test-key", baseUrl: "https://api.deepseek.com" },
        true,
      );
      assert.ok(models.some((m) => m.id === "deepseek-v4-preview" && m.source === "discovered"));
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
