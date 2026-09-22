/**
 * Which files an integration overlay may add (ADR-0012 applied to integrations).
 * The overlay engine adds these as whole files; everything else a project
 * needs (Worker secrets, vars, CI secrets) is delivered by the blueprinter.
 */

export interface OverlayPathRule {
  /** A path relative to the overlay root; a trailing `/` allows everything below it. */
  path: string;
  required: boolean;
  description: string;
}

export function overlayPathRules(id: string): OverlayPathRule[] {
  return [
    { path: `docs/integrations/${id}.md`, required: true, description: "what the integration adds and how to remove it" },
    { path: `infra/terraform/integration-${id}.tf`, required: false, description: "the tenant's Terraform slice" },
    { path: `app/api/src/integrations/${id}/`, required: false, description: "API Worker code" },
    { path: `app/web/layers/integration-${id}/`, required: false, description: "a Nuxt layer for the web Worker" },
    { path: "app/api/.dev.vars.example", required: false, description: "a fragment appended to the API's example vars" },
    { path: "app/web/.dev.vars.example", required: false, description: "a fragment appended to the web Worker's example vars" },
  ];
}

export interface OverlayPathProblem {
  path: string;
  problem: string;
}

/** Returns every file outside the allowed set and every required file that is missing. */
export function checkOverlayPaths(id: string, files: string[]): OverlayPathProblem[] {
  const rules = overlayPathRules(id);
  const allowed = (file: string) =>
    rules.some((rule) => (rule.path.endsWith("/") ? file.startsWith(rule.path) && file.length > rule.path.length : file === rule.path));
  const problems: OverlayPathProblem[] = files
    .filter((file) => !allowed(file))
    .map((path) => ({ path, problem: "is outside the paths an integration overlay may add" }));
  for (const rule of rules) {
    if (rule.required && !files.includes(rule.path)) problems.push({ path: rule.path, problem: `is missing (${rule.description})` });
  }
  return problems;
}
