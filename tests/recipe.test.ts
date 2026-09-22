import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { recipeSchema, validateRecipe, type Recipe } from "../src/recipe.ts";

const sample: Recipe = JSON.parse(readFileSync(new URL("./fixtures/sample/.integration/recipe.json", import.meta.url), "utf8"));

function variant(mutate: (r: any) => void): unknown {
  const copy = structuredClone(sample) as any;
  mutate(copy);
  return copy;
}

describe("recipe schema", () => {
  it("is a draft 2020-12 JSON Schema shipped with the package", () => {
    assert.equal(recipeSchema.$schema, "https://json-schema.org/draft/2020-12/schema");
    const exported = JSON.parse(readFileSync(new URL("../schema/recipe.schema.json", import.meta.url), "utf8"));
    assert.deepEqual(exported, recipeSchema);
  });

  it("accepts the sample recipe", () => {
    const result = validateRecipe(sample);
    assert.deepEqual(result, { ok: true, recipe: sample });
  });

  it("accepts a minimal recipe", () => {
    const result = validateRecipe(
      variant((r) => {
        delete r.requires;
        delete r.setupCli.install;
        delete r.setupCli.timeoutSeconds;
        r.outputs = [];
      }),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  const invalid: Array<[string, (r: any) => void, RegExp]> = [
    ["a missing id", (r) => delete r.id, /id/],
    ["an unknown property", (r) => (r.endpoint = "x"), /endpoint/],
    ["an uppercase id", (r) => (r.id = "Sample"), /id/],
    ["another schema version", (r) => (r.schemaVersion = 2), /schemaVersion/],
    ["a credential kind other than cloudflare-kv", (r) => (r.credential.kind = "service-bootstrap-token"), /credential/],
    ["the dropped credential.obtain", (r) => (r.credential.obtain = "pnpm ops issue"), /obtain/],
    ["a namespace not named <slug>-operators-<stage>", (r) => (r.credential.namespace = "sample-ops-staging"), /namespace/],
    ["a ttlMax that is not a duration", (r) => (r.credential.ttlMax = "1h"), /ttlMax/],
    ["a ttlMax above one hour", (r) => (r.credential.ttlMax = "PT2H"), /ttlMax/],
    ["a ttlMax below one minute", (r) => (r.credential.ttlMax = "PT30S"), /ttlMax/],
    ["an empty entry", (r) => (r.setupCli.entry = ""), /entry/],
    ["a timeout above ten minutes", (r) => (r.setupCli.timeoutSeconds = 601), /timeoutSeconds/],
    ["a lowercase output name", (r) => (r.outputs[0].name = "secret"), /name/],
    ["a Terraform output in tenant scope", (r) => r.outputs.push({ name: "X", scope: "tenant", secret: false, target: "terraform" }), /outputs/],
    ["a secret Terraform output", (r) => r.outputs.push({ name: "X", scope: "instance", secret: true, target: "terraform" }), /outputs/],
    ["a non-secret CI output", (r) => r.outputs.push({ name: "X", scope: "tenant", secret: false, target: "ci" }), /outputs/],
    ["an unknown target", (r) => r.outputs.push({ name: "X", scope: "tenant", secret: false, target: "kv" }), /target/],
    ["a duplicate output in one scope", (r) => r.outputs.push({ ...r.outputs[0] }), /duplicate output/],
    ["an overlay outside the repository", (r) => (r.overlay = "../elsewhere"), /overlay/],
    ["an absolute overlay path", (r) => (r.overlay = "/etc"), /overlay/],
    ["a protocolVersion of zero", (r) => (r.protocolVersion = 0), /protocolVersion/],
  ];
  for (const [name, mutate, message] of invalid) {
    it(`rejects ${name}`, () => {
      const result = validateRecipe(variant(mutate));
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.errors.join("\n"), message);
    });
  }

  it("rejects what is not an object", () => {
    for (const value of [null, [], "recipe", 1]) assert.equal(validateRecipe(value).ok, false);
  });
});
