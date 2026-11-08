import type { Settings } from "../../shared/types";
import type { LlmClient } from "../llm/client";
import { buildProfilePdfPrompt, buildProfilePdfSystem } from "../llm/prompts";

export async function linkedinPdfToMarkdown(llm: LlmClient, settings: Settings, buf: Uint8Array): Promise<string> {
  const data = Buffer.from(buf).toString("base64");
  const { text } = await llm.text({
    purpose: "profile_import",
    model: settings.utilityModel,
    effort: settings.effort,
    maxTokens: 8000,
    system: buildProfilePdfSystem(),
    user: [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
      { type: "text", text: buildProfilePdfPrompt() },
    ],
  });
  return text.trim();
}
