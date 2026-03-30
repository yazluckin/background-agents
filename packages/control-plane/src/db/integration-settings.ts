import {
  isValidModel,
  isValidReasoningEffort,
  INTEGRATION_DEFINITIONS,
  type IntegrationId,
  type IntegrationSettingsMap,
  type GitHubBotSettings,
  type LinearBotSettings,
  type LinearGlobalConfig,
  type CodeServerSettings,
} from "@open-inspect/shared";

export class IntegrationSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationSettingsValidationError";
  }
}

const VALID_INTEGRATION_IDS = new Set<string>(INTEGRATION_DEFINITIONS.map((d) => d.id));

export function isValidIntegrationId(id: string): id is IntegrationId {
  return VALID_INTEGRATION_IDS.has(id);
}

export class IntegrationSettingsStore {
  constructor(private readonly db: D1Database) {}

  async getGlobal<K extends IntegrationId>(
    integrationId: K
  ): Promise<IntegrationSettingsMap[K]["global"] | null> {
    const row = await this.db
      .prepare("SELECT settings FROM integration_settings WHERE integration_id = ?")
      .bind(integrationId)
      .first<{ settings: string }>();

    if (!row) return null;
    return JSON.parse(row.settings) as IntegrationSettingsMap[K]["global"];
  }

  async setGlobal<K extends IntegrationId>(
    integrationId: K,
    settings: IntegrationSettingsMap[K]["global"]
  ): Promise<void> {
    if (settings.enabledRepos !== undefined) {
      if (
        !Array.isArray(settings.enabledRepos) ||
        !settings.enabledRepos.every((r) => typeof r === "string")
      ) {
        throw new IntegrationSettingsValidationError("enabledRepos must be an array of strings");
      }
      settings = {
        ...settings,
        enabledRepos: settings.enabledRepos.map((r) => r.toLowerCase()),
      };
    }

    if (settings.defaults) {
      settings = {
        ...settings,
        defaults: this.validateAndNormalizeSettings(integrationId, settings.defaults),
      };
    }

    if (integrationId === "linear") {
      const linearGlobal = settings as LinearGlobalConfig;
      if (linearGlobal.teamRepos !== undefined) {
        this.validateTeamRepoMapping(linearGlobal.teamRepos);
      }
      if (linearGlobal.projectRepos !== undefined) {
        this.validateProjectRepoMapping(linearGlobal.projectRepos);
      }
    }

    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO integration_settings (integration_id, settings, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(integration_id) DO UPDATE SET
           settings = excluded.settings,
           updated_at = excluded.updated_at`
      )
      .bind(integrationId, JSON.stringify(settings), now, now)
      .run();
  }

  async deleteGlobal<K extends IntegrationId>(integrationId: K): Promise<void> {
    await this.db
      .prepare("DELETE FROM integration_settings WHERE integration_id = ?")
      .bind(integrationId)
      .run();
  }

  async getRepoSettings<K extends IntegrationId>(
    integrationId: K,
    repo: string
  ): Promise<IntegrationSettingsMap[K]["repo"] | null> {
    const row = await this.db
      .prepare(
        "SELECT settings FROM integration_repo_settings WHERE integration_id = ? AND repo = ?"
      )
      .bind(integrationId, repo.toLowerCase())
      .first<{ settings: string }>();

    if (!row) return null;
    return JSON.parse(row.settings) as IntegrationSettingsMap[K]["repo"];
  }

  async setRepoSettings<K extends IntegrationId>(
    integrationId: K,
    repo: string,
    settings: IntegrationSettingsMap[K]["repo"]
  ): Promise<void> {
    const normalized = this.validateAndNormalizeSettings(integrationId, settings);

    const now = Date.now();
    await this.db
      .prepare(
        `INSERT INTO integration_repo_settings (integration_id, repo, settings, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(integration_id, repo) DO UPDATE SET
           settings = excluded.settings,
           updated_at = excluded.updated_at`
      )
      .bind(integrationId, repo.toLowerCase(), JSON.stringify(normalized), now, now)
      .run();
  }

  async deleteRepoSettings<K extends IntegrationId>(integrationId: K, repo: string): Promise<void> {
    await this.db
      .prepare("DELETE FROM integration_repo_settings WHERE integration_id = ? AND repo = ?")
      .bind(integrationId, repo.toLowerCase())
      .run();
  }

  async listRepoSettings<K extends IntegrationId>(
    integrationId: K
  ): Promise<Array<{ repo: string; settings: IntegrationSettingsMap[K]["repo"] }>> {
    const { results } = await this.db
      .prepare("SELECT repo, settings FROM integration_repo_settings WHERE integration_id = ?")
      .bind(integrationId)
      .all<{ repo: string; settings: string }>();

    return results.map((row) => ({
      repo: row.repo,
      settings: JSON.parse(row.settings) as IntegrationSettingsMap[K]["repo"],
    }));
  }

  async getResolvedConfig<K extends IntegrationId>(
    integrationId: K,
    repo: string
  ): Promise<ResolvedIntegrationConfig<IntegrationSettingsMap[K]["repo"]>> {
    const [globalSettings, repoSettings] = await Promise.all([
      this.getGlobal(integrationId),
      this.getRepoSettings(integrationId, repo),
    ]);

    // undefined → null (all repos), [] → [] (disabled), [...] → [...] (allowlist)
    const enabledRepos =
      globalSettings?.enabledRepos !== undefined ? globalSettings.enabledRepos : null;

    const defaults = globalSettings?.defaults ?? {};
    const overrides = repoSettings ?? {};

    // Generic merge: repo overrides win, undefined keys don't clobber defaults
    const settings: Record<string, unknown> = { ...defaults };
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) {
        settings[key] = value;
      }
    }

    return { enabledRepos, settings } as ResolvedIntegrationConfig<
      IntegrationSettingsMap[K]["repo"]
    >;
  }

  private validateAndNormalizeSettings<K extends IntegrationId>(
    integrationId: K,
    settings: IntegrationSettingsMap[K]["repo"]
  ): IntegrationSettingsMap[K]["repo"] {
    if (integrationId === "github") {
      return this.validateAndNormalizeGitHubSettings(
        settings as GitHubBotSettings
      ) as IntegrationSettingsMap[K]["repo"];
    }

    if (integrationId === "linear") {
      this.validateLinearSettings(settings as LinearBotSettings);
    }

    if (integrationId === "code-server") {
      this.validateCodeServerSettings(settings as CodeServerSettings);
    }

    return settings;
  }

  private validateModelAndEffort(settings: { model?: string; reasoningEffort?: string }): void {
    if (settings.model !== undefined && !isValidModel(settings.model)) {
      throw new IntegrationSettingsValidationError(`Invalid model ID: ${settings.model}`);
    }

    if (
      settings.model !== undefined &&
      settings.reasoningEffort !== undefined &&
      !isValidReasoningEffort(settings.model, settings.reasoningEffort)
    ) {
      throw new IntegrationSettingsValidationError(
        `Invalid reasoning effort "${settings.reasoningEffort}" for model "${settings.model}"`
      );
    }
  }

  private validateAndNormalizeGitHubSettings(settings: GitHubBotSettings): GitHubBotSettings {
    this.validateModelAndEffort(settings);

    if (
      settings.codeReviewInstructions !== undefined &&
      typeof settings.codeReviewInstructions !== "string"
    ) {
      throw new IntegrationSettingsValidationError("codeReviewInstructions must be a string");
    }

    if (
      settings.commentActionInstructions !== undefined &&
      typeof settings.commentActionInstructions !== "string"
    ) {
      throw new IntegrationSettingsValidationError("commentActionInstructions must be a string");
    }

    if (settings.allowedTriggerUsers !== undefined) {
      if (
        !Array.isArray(settings.allowedTriggerUsers) ||
        !settings.allowedTriggerUsers.every((u) => typeof u === "string")
      ) {
        throw new IntegrationSettingsValidationError(
          "allowedTriggerUsers must be an array of strings"
        );
      }
      return {
        ...settings,
        allowedTriggerUsers: settings.allowedTriggerUsers.map((u) => u.trim().toLowerCase()),
      };
    }

    return settings;
  }

  private validateLinearSettings(settings: LinearBotSettings): void {
    this.validateModelAndEffort(settings);

    if (
      settings.allowUserPreferenceOverride !== undefined &&
      typeof settings.allowUserPreferenceOverride !== "boolean"
    ) {
      throw new IntegrationSettingsValidationError("allowUserPreferenceOverride must be a boolean");
    }

    if (
      settings.allowLabelModelOverride !== undefined &&
      typeof settings.allowLabelModelOverride !== "boolean"
    ) {
      throw new IntegrationSettingsValidationError("allowLabelModelOverride must be a boolean");
    }

    if (
      settings.emitToolProgressActivities !== undefined &&
      typeof settings.emitToolProgressActivities !== "boolean"
    ) {
      throw new IntegrationSettingsValidationError("emitToolProgressActivities must be a boolean");
    }

    if (
      settings.issueSessionInstructions !== undefined &&
      typeof settings.issueSessionInstructions !== "string"
    ) {
      throw new IntegrationSettingsValidationError("issueSessionInstructions must be a string");
    }

    if (
      typeof settings.issueSessionInstructions === "string" &&
      settings.issueSessionInstructions.length > 10000
    ) {
      throw new IntegrationSettingsValidationError(
        "issueSessionInstructions must be 10000 characters or fewer"
      );
    }
  }

  private validateCodeServerSettings(settings: CodeServerSettings): void {
    if (settings.enabled !== undefined && typeof settings.enabled !== "boolean") {
      throw new IntegrationSettingsValidationError("enabled must be a boolean");
    }
  }

  private validateTeamRepoMapping(mapping: unknown): void {
    if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
      throw new IntegrationSettingsValidationError("teamRepos must be an object");
    }
    for (const [teamId, repos] of Object.entries(mapping)) {
      if (!Array.isArray(repos)) {
        throw new IntegrationSettingsValidationError(
          `teamRepos["${teamId}"] must be an array of repo configs`
        );
      }
      for (const repo of repos) {
        if (typeof repo !== "object" || repo === null) {
          throw new IntegrationSettingsValidationError(
            `teamRepos["${teamId}"] entries must be objects with owner and name`
          );
        }
        const r = repo as Record<string, unknown>;
        if (typeof r.owner !== "string" || typeof r.name !== "string") {
          throw new IntegrationSettingsValidationError(
            `teamRepos["${teamId}"] entries must have string owner and name`
          );
        }
        if (r.label !== undefined && typeof r.label !== "string") {
          throw new IntegrationSettingsValidationError(
            `teamRepos["${teamId}"] label must be a string`
          );
        }
      }
    }
  }

  private validateProjectRepoMapping(mapping: unknown): void {
    if (typeof mapping !== "object" || mapping === null || Array.isArray(mapping)) {
      throw new IntegrationSettingsValidationError("projectRepos must be an object");
    }
    for (const [projectId, repo] of Object.entries(mapping)) {
      if (typeof repo !== "object" || repo === null) {
        throw new IntegrationSettingsValidationError(
          `projectRepos["${projectId}"] must be an object with owner and name`
        );
      }
      const r = repo as Record<string, unknown>;
      if (typeof r.owner !== "string" || typeof r.name !== "string") {
        throw new IntegrationSettingsValidationError(
          `projectRepos["${projectId}"] must have string owner and name`
        );
      }
    }
  }
}

export interface ResolvedIntegrationConfig<TRepo extends object = Record<string, unknown>> {
  enabledRepos: string[] | null;
  settings: TRepo;
}
