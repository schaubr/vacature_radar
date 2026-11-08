import type { Bucket, Profile, ScoreResult, Settings, VacancyFields } from "../../shared/types";
import type { LlmClient, LlmUsage } from "./client";
import { buildScoringSystem, buildScoringUser, type FeedbackHint, type ScoringVacancyInput } from "./prompts";
import { ScoreSchema, type ScoreOutput } from "./schemas";

export type { FeedbackHint, ScoringVacancyInput };

function clampInt(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function bucketFor(score: number): Bucket {
  if (score >= 70) return "strong";
  if (score >= 50) return "possible";
  return "weak";
}

function cleanList(xs: string[]): string[] {
  return xs
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);
}

/** Pure post-processing of the model output (exported for tests). */
export function postProcessScore(o: ScoreOutput): { fields: VacancyFields; score: ScoreResult } {
  const knockoutReason = o.knockout_reason.trim();
  let score = clampInt(o.score);
  let bucket: Bucket;
  if (knockoutReason) {
    bucket = "knockout";
    score = Math.min(score, 30);
  } else if (o.bucket === "knockout") {
    // The model said knockout without a reason: trust the numeric score.
    bucket = bucketFor(score);
  } else {
    bucket = bucketFor(score);
  }
  const fields: VacancyFields = {
    summary: o.summary.trim(),
    sector: o.sector.trim(),
    isSocialSector: o.is_social_sector,
    hours: o.hours.trim(),
    contract: o.contract.trim(),
    diplomaRequired: o.diploma_required.trim(),
    experienceRequired: o.experience_required.trim(),
    payScale: o.pay_scale.trim(),
    deadline: o.deadline.trim(),
  };
  return {
    fields,
    score: {
      score,
      bucket,
      subscores: {
        diploma: clampInt(o.subscores.diploma),
        experience: clampInt(o.subscores.experience),
        skills: clampInt(o.subscores.skills),
        preferences: clampInt(o.subscores.preferences),
      },
      reasons: cleanList(o.reasons),
      gaps: cleanList(o.gaps),
      knockoutReason,
      confidence: o.confidence,
    },
  };
}

export async function scoreVacancy(
  llm: LlmClient,
  settings: Settings,
  profile: Profile,
  vacancy: ScoringVacancyInput,
  feedback: FeedbackHint[],
): Promise<{ fields: VacancyFields; score: ScoreResult; organization: string; location: string; usage: LlmUsage }> {
  const { data, usage } = await llm.structured({
    purpose: "score",
    model: settings.scoringModel,
    effort: settings.effort,
    maxTokens: 6000,
    system: buildScoringSystem(profile, settings.outputLanguage),
    user: buildScoringUser(vacancy, feedback),
    schema: ScoreSchema,
  });
  return { ...postProcessScore(data), organization: data.organization.trim(), location: data.location.trim(), usage };
}
