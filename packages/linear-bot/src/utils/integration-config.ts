import type { LinearGlobalConfig, TeamRepoMapping, ProjectRepoMapping } from "@open-inspect/shared";
import type { Env } from "../types";
import { buildInternalAuthHeaders } from "./internal";

export interface ResolvedLinearConfig {
  model: string | null;
  reasoningEffort: string | null;
  allowUserPreferenceOverride: boolean;
  allowLabelModelOverride: boolean;
  emitToolProgressActivities: boolean;
  issueSessionInstructions: string | null;
  enabledRepos: string[] | null;
  teamRepos: TeamRepoMapping | null;
  projectRepos: ProjectRepoMapping | null;
}

const DEFAULT_CONFIG: ResolvedLinearConfig = {
  model: null,
  reasoningEffort: null,
  allowUserPreferenceOverride: true,
  allowLabelModelOverride: true,
  emitToolProgressActivities: true,
  issueSessionInstructions: null,
  enabledRepos: null,
  teamRepos: null,
  projectRepos: null,
};

export async function getLinearConfig(env: Env, repo: string): Promise<ResolvedLinearConfig> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    return DEFAULT_CONFIG;
  }

  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    return DEFAULT_CONFIG;
  }

  const headers = await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET);

  let response: Response;
  try {
    response = await env.CONTROL_PLANE.fetch(
      `https://internal/integration-settings/linear/resolved/${owner}/${name}`,
      { headers }
    );
  } catch {
    return DEFAULT_CONFIG;
  }

  if (!response.ok) {
    return DEFAULT_CONFIG;
  }

  const data = (await response.json()) as { config: ResolvedLinearConfig | null };
  if (!data.config) {
    return DEFAULT_CONFIG;
  }

  return data.config;
}

/**
 * Fetch global Linear config (for repo mappings needed before repo resolution).
 */
export async function getLinearGlobalConfig(env: Env): Promise<LinearGlobalConfig | null> {
  if (!env.INTERNAL_CALLBACK_SECRET) {
    return null;
  }

  const headers = await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET);

  let response: Response;
  try {
    response = await env.CONTROL_PLANE.fetch("https://internal/integration-settings/linear", {
      headers,
    });
  } catch {
    return null;
  }

  if (!response.ok) {
    return null;
  }

  const data = (await response.json()) as { settings: LinearGlobalConfig | null };
  return data.settings;
}
