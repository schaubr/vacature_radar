import { z } from "zod";

// No min/max/length constraints: the API ignores them. Clamp in code instead.

export const ScoreSchema = z.object({
  summary: z.string(),
  organization: z.string(),
  location: z.string(),
  sector: z.string(),
  is_social_sector: z.boolean(),
  hours: z.string(),
  contract: z.string(),
  diploma_required: z.string(),
  experience_required: z.string(),
  pay_scale: z.string(),
  deadline: z.string(),
  score: z.number(),
  bucket: z.enum(["strong", "possible", "weak", "knockout"]),
  subscores: z.object({
    diploma: z.number(),
    experience: z.number(),
    skills: z.number(),
    preferences: z.number(),
  }),
  reasons: z.array(z.string()),
  gaps: z.array(z.string()),
  knockout_reason: z.string(),
  confidence: z.enum(["high", "medium", "low"]),
});
export type ScoreOutput = z.infer<typeof ScoreSchema>;

export const RecipeSchema = z.object({
  found: z.boolean(),
  item_selector: z.string(),
  title_selector: z.string(),
  link_selector: z.string(),
  organization_selector: z.string(),
  location_selector: z.string(),
  date_selector: z.string(),
  next_page_selector: z.string(),
  notes: z.string(),
});
export type RecipeOutput = z.infer<typeof RecipeSchema>;

export const ListingExtractSchema = z.object({
  vacancies: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      organization: z.string(),
      location: z.string(),
    }),
  ),
});
export type ListingExtractOutput = z.infer<typeof ListingExtractSchema>;
