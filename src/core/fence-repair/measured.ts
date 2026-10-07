/**
 * What the Tier 3 fence-repair eval measured (#6188 T4,
 * evals/fence-repair-tier3/; verdicts in gbrain-evals). The next eval run
 * updates both constants together.
 *
 * `FENCE_REPAIR_MEASURED_MODELS`: the models that met the preregistered
 * rule (gate-pass at least 80%, false accepts at most 1%), best first. With
 * `models.fence_repair` unset, model repair uses the first one the brain has
 * a provider key for; with none, model repair stays off by default
 * (`no_measured_model`). An explicit `models.fence_repair` always runs.
 *
 * `FENCE_REPAIR_MEASURED`: the sentence the behavior-change notice prints
 * about how often the model's rewrites are accepted.
 */
export const FENCE_REPAIR_MEASURED_MODELS: readonly string[] = ['openai:gpt-6.1-sol', 'anthropic:claude-fable-5-1'];

export const FENCE_REPAIR_MEASURED = 'How often the model\'s rewrites are accepted is not yet measured.';
