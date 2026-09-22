/**
 * The recipe (`.integration/recipe.json`) and its JSON Schema.
 */
import Ajv2020 from "ajv/dist/2020.js";
import schema from "../schema/recipe.schema.json" with { type: "json" };
import { parseDurationSeconds, type Scope } from "./protocol.ts";
import { BOOTSTRAP_TOKEN_TTL_MAX_SECONDS, BOOTSTRAP_TOKEN_TTL_MIN_SECONDS } from "./bootstrap-token.ts";

export const RECIPE_SCHEMA_VERSION = 1;
export const RECIPE_PATH = ".integration/recipe.json";

export type OutputTarget = "api" | "web" | "ci" | "terraform";

export interface RecipeOutput {
  name: string;
  scope: Scope;
  secret: boolean;
  target: OutputTarget;
  description?: string;
}

export interface Recipe {
  $schema?: string;
  schemaVersion: 1;
  protocolVersion: number;
  id: string;
  name: string;
  requires?: { node?: string; pnpm?: string };
  setupCli: { install?: string; entry: string; timeoutSeconds?: number };
  credential: { kind: "cloudflare-kv"; namespace: string; ttlMax: string };
  outputs: RecipeOutput[];
  overlay: string;
}

/** The recipe JSON Schema (draft 2020-12), also published as `blueprinter-kit/recipe.schema.json`. */
export const recipeSchema: Record<string, unknown> & { $schema: string } = schema;

const ajv = new Ajv2020.default({ allErrors: true, strict: true, allowUnionTypes: true });
const validate = ajv.compile(schema);

export type RecipeValidation = { ok: true; recipe: Recipe } | { ok: false; errors: string[] };

/** Validates a parsed recipe against the schema and the rules a schema cannot express. */
export function validateRecipe(value: unknown): RecipeValidation {
  if (!validate(value)) {
    const errors = (validate.errors ?? []).map((e) => {
      const where = e.instancePath || "(root)";
      const extra = e.keyword === "additionalProperties" ? ` ${JSON.stringify(e.params.additionalProperty)}` : "";
      return `${where} ${e.message ?? "is invalid"}${extra}`;
    });
    return { ok: false, errors };
  }
  const recipe = value as unknown as Recipe;
  const errors: string[] = [];
  const ttl = parseDurationSeconds(recipe.credential.ttlMax);
  if (ttl === undefined || ttl < BOOTSTRAP_TOKEN_TTL_MIN_SECONDS || ttl > BOOTSTRAP_TOKEN_TTL_MAX_SECONDS) {
    errors.push(`/credential/ttlMax must be from PT1M to PT1H, got ${recipe.credential.ttlMax}`);
  }
  const seen = new Set<string>();
  for (const output of recipe.outputs) {
    const key = `${output.scope}:${output.name}`;
    if (seen.has(key)) errors.push(`/outputs duplicate output ${output.name} in scope ${output.scope}`);
    seen.add(key);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, recipe };
}
