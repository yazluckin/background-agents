"use client";

import { useEffect, useState, type ReactNode } from "react";
import useSWR, { mutate } from "swr";
import { toast } from "sonner";
import {
  MODEL_REASONING_CONFIG,
  isValidReasoningEffort,
  type EnrichedRepository,
  type LinearBotSettings,
  type LinearGlobalConfig,
  type TeamRepoMapping,
  type ProjectRepoMapping,
  type StaticRepoConfig,
  type ValidModel,
} from "@open-inspect/shared";
import { useEnabledModels } from "@/hooks/use-enabled-models";
import { IntegrationSettingsSkeleton } from "./integration-settings-skeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { RadioCard } from "@/components/ui/form-controls";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const GLOBAL_SETTINGS_KEY = "/api/integration-settings/linear";
const REPO_SETTINGS_KEY = "/api/integration-settings/linear/repos";

interface GlobalResponse {
  settings: LinearGlobalConfig | null;
}

interface RepoSettingsEntry {
  repo: string;
  settings: LinearBotSettings;
}

interface RepoListResponse {
  repos: RepoSettingsEntry[];
}

interface ReposResponse {
  repos: EnrichedRepository[];
}

export function LinearIntegrationSettings() {
  const { data: globalData, isLoading: globalLoading } =
    useSWR<GlobalResponse>(GLOBAL_SETTINGS_KEY);
  const { data: repoSettingsData, isLoading: repoSettingsLoading } =
    useSWR<RepoListResponse>(REPO_SETTINGS_KEY);
  const { data: reposData } = useSWR<ReposResponse>("/api/repos");
  const { enabledModelOptions } = useEnabledModels();

  if (globalLoading || repoSettingsLoading) {
    return <IntegrationSettingsSkeleton />;
  }

  const settings = globalData?.settings;
  const repoOverrides = repoSettingsData?.repos ?? [];
  const availableRepos = reposData?.repos ?? [];

  return (
    <div>
      <h3 className="text-lg font-semibold text-foreground mb-1">Linear Agent</h3>
      <p className="text-sm text-muted-foreground mb-6">
        Configure model defaults, repository targeting, and runtime behavior for Linear-triggered
        sessions.
      </p>

      <Section title="Connection" description="Linear uses control-plane repository access.">
        {availableRepos.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Repository access is available. You can target all repos or limit the integration to a
            selected allowlist.
          </p>
        ) : (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 px-4 py-3 rounded-sm">
            No repositories are currently accessible from the control plane. Repository filtering is
            unavailable until repository access is configured.
          </p>
        )}
      </Section>

      <GlobalSettingsSection
        settings={settings}
        availableRepos={availableRepos}
        enabledModelOptions={enabledModelOptions}
      />

      <RepositoryMappingsSection settings={settings} availableRepos={availableRepos} />

      <Section
        title="Repository Overrides"
        description="Override model selection and behavior for specific repositories."
      >
        <RepoOverridesSection
          overrides={repoOverrides}
          availableRepos={availableRepos}
          enabledModelOptions={enabledModelOptions}
        />
      </Section>
    </div>
  );
}

function GlobalSettingsSection({
  settings,
  availableRepos,
  enabledModelOptions,
}: {
  settings: LinearGlobalConfig | null | undefined;
  availableRepos: EnrichedRepository[];
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
}) {
  const [model, setModel] = useState(settings?.defaults?.model ?? "");
  const [effort, setEffort] = useState(settings?.defaults?.reasoningEffort ?? "");
  const [enabledRepos, setEnabledRepos] = useState<string[]>(settings?.enabledRepos ?? []);
  const [repoScopeMode, setRepoScopeMode] = useState<"all" | "selected">(
    settings?.enabledRepos == null ? "all" : "selected"
  );
  const [allowUserPreferenceOverride, setAllowUserPreferenceOverride] = useState(
    settings?.defaults?.allowUserPreferenceOverride ?? true
  );
  const [allowLabelModelOverride, setAllowLabelModelOverride] = useState(
    settings?.defaults?.allowLabelModelOverride ?? true
  );
  const [emitToolProgressActivities, setEmitToolProgressActivities] = useState(
    settings?.defaults?.emitToolProgressActivities ?? true
  );
  const [issueSessionInstructions, setIssueSessionInstructions] = useState(
    settings?.defaults?.issueSessionInstructions ?? ""
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [showResetDialog, setShowResetDialog] = useState(false);

  useEffect(() => {
    if (settings !== undefined && !initialized) {
      if (settings) {
        setModel(settings.defaults?.model ?? "");
        setEffort(settings.defaults?.reasoningEffort ?? "");
        setEnabledRepos(settings.enabledRepos ?? []);
        setRepoScopeMode(settings.enabledRepos === undefined ? "all" : "selected");
        setAllowUserPreferenceOverride(settings.defaults?.allowUserPreferenceOverride ?? true);
        setAllowLabelModelOverride(settings.defaults?.allowLabelModelOverride ?? true);
        setEmitToolProgressActivities(settings.defaults?.emitToolProgressActivities ?? true);
        setIssueSessionInstructions(settings.defaults?.issueSessionInstructions ?? "");
      }
      setInitialized(true);
    }
  }, [settings, initialized]);

  const isConfigured = settings !== null && settings !== undefined;
  const reasoningConfig = model ? MODEL_REASONING_CONFIG[model as ValidModel] : undefined;

  const resetNotice =
    "Reset all Linear settings to defaults? This enables both label/user model overrides.";

  const handleReset = () => {
    setShowResetDialog(true);
  };

  const handleConfirmReset = async () => {
    setSaving(true);
    setError("");

    try {
      const res = await fetch(GLOBAL_SETTINGS_KEY, { method: "DELETE" });

      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        setModel("");
        setEffort("");
        setEnabledRepos([]);
        setRepoScopeMode("all");
        setAllowUserPreferenceOverride(true);
        setAllowLabelModelOverride(true);
        setEmitToolProgressActivities(true);
        setIssueSessionInstructions("");
        setDirty(false);
        toast.success("Settings reset to defaults.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to reset settings");
      }
    } catch {
      toast.error("Failed to reset settings");
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError("");

    const defaults: LinearBotSettings = {
      allowUserPreferenceOverride,
      allowLabelModelOverride,
      emitToolProgressActivities,
    };

    if (model) defaults.model = model;
    if (effort) defaults.reasoningEffort = effort;
    if (issueSessionInstructions) defaults.issueSessionInstructions = issueSessionInstructions;

    const body: LinearGlobalConfig = { defaults };
    if (repoScopeMode === "selected") {
      body.enabledRepos = enabledRepos;
    }

    try {
      const res = await fetch(GLOBAL_SETTINGS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: body }),
      });

      if (res.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        toast.success("Settings saved.");
        setDirty(false);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save settings");
      }
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  const toggleRepo = (fullName: string) => {
    const lower = fullName.toLowerCase();
    setEnabledRepos((prev) =>
      prev.includes(lower) ? prev.filter((r) => r !== lower) : [...prev, lower]
    );
    setDirty(true);
    setError("");
  };

  return (
    <Section
      title="Defaults & Scope"
      description="Global model, fallback behavior, and repository targeting."
    >
      {error && <Message tone="error" text={error} />}

      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        <label className="text-sm">
          <span className="block text-foreground font-medium mb-1">Default model</span>
          <Select
            value={model}
            onValueChange={(nextModel) => {
              setModel(nextModel);
              if (effort && nextModel && !isValidReasoningEffort(nextModel, effort)) {
                setEffort("");
              }
              setDirty(true);
              setError("");
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Use system default" />
            </SelectTrigger>
            <SelectContent>
              {enabledModelOptions.map((group) => (
                <SelectGroup key={group.category}>
                  <SelectLabel>{group.category}</SelectLabel>
                  {group.models.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </label>

        <label className="text-sm">
          <span className="block text-foreground font-medium mb-1">Default reasoning effort</span>
          <Select
            value={effort}
            onValueChange={(v) => {
              setEffort(v);
              setDirty(true);
              setError("");
            }}
            disabled={!reasoningConfig}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Use model default" />
            </SelectTrigger>
            <SelectContent>
              {(reasoningConfig?.efforts ?? []).map((value) => (
                <SelectItem key={value} value={value}>
                  {value}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      <div className="grid sm:grid-cols-2 gap-2 mb-4">
        <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
          <span>Allow user model preferences</span>
          <Checkbox
            checked={allowUserPreferenceOverride}
            onCheckedChange={(checked) => {
              setAllowUserPreferenceOverride(!!checked);
              setDirty(true);
              setError("");
            }}
          />
        </label>
        <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
          <span>Allow model labels (model:*)</span>
          <Checkbox
            checked={allowLabelModelOverride}
            onCheckedChange={(checked) => {
              setAllowLabelModelOverride(!!checked);
              setDirty(true);
              setError("");
            }}
          />
        </label>
      </div>

      <div className="mb-4">
        <label className="flex items-center justify-between px-3 py-2 border border-border rounded-sm cursor-pointer hover:bg-muted/50 transition text-sm">
          <span>Emit tool progress activities</span>
          <Checkbox
            checked={emitToolProgressActivities}
            onCheckedChange={(checked) => {
              setEmitToolProgressActivities(!!checked);
              setDirty(true);
              setError("");
            }}
          />
        </label>
      </div>

      <div className="mb-4">
        <label className="block text-sm font-medium text-foreground mb-1">
          Issue Session Instructions
        </label>
        <p className="text-xs text-muted-foreground mb-2">
          Custom instructions appended to agent prompts for all Linear issue sessions. Use this to
          guide how the agent approaches issues (e.g., coding standards, preferred tools, MR
          conventions).
        </p>
        <Textarea
          value={issueSessionInstructions}
          onChange={(e) => {
            setIssueSessionInstructions(e.target.value);
            setDirty(true);
            setError("");
          }}
          rows={3}
          placeholder="e.g., Always run tests before pushing changes. Prefer minimal diffs."
          className="resize-y"
        />
      </div>

      <div className="mb-4">
        <p className="text-sm font-medium text-foreground mb-2">Repository Scope</p>
        <div className="grid sm:grid-cols-2 gap-2 mb-3">
          <RadioCard
            name="linear-repo-scope"
            checked={repoScopeMode === "all"}
            onChange={() => {
              setRepoScopeMode("all");
              setDirty(true);
              setError("");
            }}
            label="All repositories"
            description="Linear events can run against every accessible repository."
          />
          <RadioCard
            name="linear-repo-scope"
            checked={repoScopeMode === "selected"}
            onChange={() => {
              setRepoScopeMode("selected");
              setDirty(true);
              setError("");
            }}
            label="Selected repositories"
            description="Linear events run only for repositories in the allowlist."
          />
        </div>

        {repoScopeMode === "selected" && (
          <>
            {availableRepos.length === 0 ? (
              <p className="text-sm text-muted-foreground px-4 py-3 border border-border rounded-sm">
                Repository filtering is unavailable because no repositories are accessible.
              </p>
            ) : (
              <div className="border border-border max-h-56 overflow-y-auto rounded-sm">
                {availableRepos.map((repo) => {
                  const fullName = repo.fullName.toLowerCase();
                  const isChecked = enabledRepos.includes(fullName);

                  return (
                    <label
                      key={repo.fullName}
                      className="flex items-center gap-2 px-4 py-2 hover:bg-muted/50 transition cursor-pointer text-sm"
                    >
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => toggleRepo(repo.fullName)}
                      />
                      <span className="text-foreground">{repo.fullName}</span>
                    </label>
                  );
                })}
              </div>
            )}

            {enabledRepos.length === 0 && availableRepos.length > 0 && (
              <p className="text-xs text-amber-700 mt-1">
                No repositories selected. The Linear integration will ignore all issues.
              </p>
            )}
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "Saving..." : "Save"}
        </Button>

        {isConfigured && (
          <Button variant="destructive" onClick={handleReset} disabled={saving}>
            Reset to defaults
          </Button>
        )}
      </div>

      <AlertDialog open={showResetDialog} onOpenChange={setShowResetDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset to defaults</AlertDialogTitle>
            <AlertDialogDescription>{resetNotice}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmReset}>Reset</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}

// ─── Repository Mappings Section ─────────────────────────────────────────────

interface TeamMappingEntry {
  teamId: string;
  repos: StaticRepoConfig[];
}

interface ProjectMappingEntry {
  projectId: string;
  owner: string;
  name: string;
}

function toTeamEntries(mapping?: TeamRepoMapping): TeamMappingEntry[] {
  if (!mapping) return [];
  return Object.entries(mapping).map(([teamId, repos]) => ({ teamId, repos: [...repos] }));
}

function toProjectEntries(mapping?: ProjectRepoMapping): ProjectMappingEntry[] {
  if (!mapping) return [];
  return Object.entries(mapping).map(([projectId, repo]) => ({
    projectId,
    owner: repo.owner,
    name: repo.name,
  }));
}

function fromTeamEntries(entries: TeamMappingEntry[]): TeamRepoMapping {
  const mapping: TeamRepoMapping = {};
  for (const e of entries) {
    if (e.teamId) mapping[e.teamId] = e.repos;
  }
  return mapping;
}

function fromProjectEntries(entries: ProjectMappingEntry[]): ProjectRepoMapping {
  const mapping: ProjectRepoMapping = {};
  for (const e of entries) {
    if (e.projectId && e.owner && e.name) mapping[e.projectId] = { owner: e.owner, name: e.name };
  }
  return mapping;
}

function RepositoryMappingsSection({
  settings,
  availableRepos,
}: {
  settings: LinearGlobalConfig | null | undefined;
  availableRepos: EnrichedRepository[];
}) {
  const [teamEntries, setTeamEntries] = useState<TeamMappingEntry[]>(() =>
    toTeamEntries(settings?.teamRepos)
  );
  const [projectEntries, setProjectEntries] = useState<ProjectMappingEntry[]>(() =>
    toProjectEntries(settings?.projectRepos)
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (settings !== undefined && !initialized) {
      setTeamEntries(toTeamEntries(settings?.teamRepos));
      setProjectEntries(toProjectEntries(settings?.projectRepos));
      setInitialized(true);
    }
  }, [settings, initialized]);

  const handleSave = async () => {
    // Check for duplicate team/project IDs
    const teamIds = teamEntries.map((e) => e.teamId).filter(Boolean);
    if (new Set(teamIds).size !== teamIds.length) {
      toast.error("Duplicate team IDs found. Each team can only be mapped once.");
      return;
    }
    const projectIds = projectEntries.map((e) => e.projectId).filter(Boolean);
    if (new Set(projectIds).size !== projectIds.length) {
      toast.error("Duplicate project IDs found. Each project can only be mapped once.");
      return;
    }

    setSaving(true);
    try {
      // Read-modify-write: fetch current settings, merge mappings, save
      const res = await fetch(GLOBAL_SETTINGS_KEY);
      const current = res.ok ? ((await res.json()) as GlobalResponse) : null;
      const merged: LinearGlobalConfig = {
        ...(current?.settings ?? {}),
        teamRepos: fromTeamEntries(teamEntries),
        projectRepos: fromProjectEntries(projectEntries),
      };

      const saveRes = await fetch(GLOBAL_SETTINGS_KEY, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: merged }),
      });

      if (saveRes.ok) {
        mutate(GLOBAL_SETTINGS_KEY);
        setDirty(false);
        toast.success("Repository mappings saved.");
      } else {
        const data = await saveRes.json();
        toast.error(data.error || "Failed to save mappings");
      }
    } catch {
      toast.error("Failed to save mappings");
    } finally {
      setSaving(false);
    }
  };

  const addTeamEntry = () => {
    setTeamEntries((prev) => [...prev, { teamId: "", repos: [] }]);
    setDirty(true);
  };

  const removeTeamEntry = (index: number) => {
    setTeamEntries((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };

  const updateTeamId = (index: number, teamId: string) => {
    setTeamEntries((prev) => prev.map((e, i) => (i === index ? { ...e, teamId } : e)));
    setDirty(true);
  };

  const addTeamRepo = (index: number) => {
    setTeamEntries((prev) =>
      prev.map((e, i) =>
        i === index ? { ...e, repos: [...e.repos, { owner: "", name: "" }] } : e
      )
    );
    setDirty(true);
  };

  const updateTeamRepo = (entryIndex: number, repoIndex: number, repoFullName: string) => {
    const [owner, name] = repoFullName.split("/");
    setTeamEntries((prev) =>
      prev.map((e, i) =>
        i === entryIndex
          ? {
              ...e,
              repos: e.repos.map((r, j) =>
                j === repoIndex ? { ...r, owner, name } : r
              ),
            }
          : e
      )
    );
    setDirty(true);
  };

  const updateTeamRepoLabel = (entryIndex: number, repoIndex: number, label: string) => {
    setTeamEntries((prev) =>
      prev.map((e, i) =>
        i === entryIndex
          ? {
              ...e,
              repos: e.repos.map((r, j) =>
                j === repoIndex ? { ...r, label: label || undefined } : r
              ),
            }
          : e
      )
    );
    setDirty(true);
  };

  const removeTeamRepo = (entryIndex: number, repoIndex: number) => {
    setTeamEntries((prev) =>
      prev.map((e, i) =>
        i === entryIndex ? { ...e, repos: e.repos.filter((_, j) => j !== repoIndex) } : e
      )
    );
    setDirty(true);
  };

  const addProjectEntry = () => {
    setProjectEntries((prev) => [...prev, { projectId: "", owner: "", name: "" }]);
    setDirty(true);
  };

  const removeProjectEntry = (index: number) => {
    setProjectEntries((prev) => prev.filter((_, i) => i !== index));
    setDirty(true);
  };

  const updateProjectId = (index: number, projectId: string) => {
    setProjectEntries((prev) => prev.map((e, i) => (i === index ? { ...e, projectId } : e)));
    setDirty(true);
  };

  const updateProjectRepo = (index: number, repoFullName: string) => {
    const [owner, name] = repoFullName.split("/");
    setProjectEntries((prev) =>
      prev.map((e, i) => (i === index ? { ...e, owner, name } : e))
    );
    setDirty(true);
  };

  return (
    <Section
      title="Repository Mapping"
      description="Map Linear teams or projects to specific GitHub repositories. Project mappings take priority over team mappings."
    >
      {/* Team Mappings */}
      <div className="mb-6">
        <p className="text-sm font-medium text-foreground mb-2">Team Mappings</p>
        {teamEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground mb-3">
            No team mappings configured. Issues will use Linear API suggestions or LLM classification
            to determine the target repository.
          </p>
        ) : (
          <div className="space-y-3 mb-3">
            {teamEntries.map((entry, entryIndex) => (
              <div
                key={entryIndex}
                className="border border-border rounded-sm px-4 py-3"
              >
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="text"
                    value={entry.teamId}
                    onChange={(e) => updateTeamId(entryIndex, e.target.value)}
                    placeholder="Linear Team ID"
                    className="flex-1 rounded-sm border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => removeTeamEntry(entryIndex)}
                  >
                    Remove
                  </Button>
                </div>

                {entry.repos.map((repo, repoIndex) => (
                  <div key={repoIndex} className="flex items-center gap-2 mb-2 ml-4">
                    <Select
                      value={repo.owner && repo.name ? `${repo.owner}/${repo.name}` : ""}
                      onValueChange={(v) => updateTeamRepo(entryIndex, repoIndex, v)}
                    >
                      <SelectTrigger density="compact" className="flex-1">
                        <SelectValue placeholder="Select repository" />
                      </SelectTrigger>
                      <SelectContent>
                        {availableRepos.map((r) => (
                          <SelectItem key={r.fullName} value={r.fullName}>
                            {r.fullName}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <input
                      type="text"
                      value={repo.label ?? ""}
                      onChange={(e) => updateTeamRepoLabel(entryIndex, repoIndex, e.target.value)}
                      placeholder="Label filter (optional)"
                      className="w-40 rounded-sm border border-border bg-background px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                    />
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => removeTeamRepo(entryIndex, repoIndex)}
                    >
                      &times;
                    </Button>
                  </div>
                ))}

                <Button
                  variant="outline"
                  size="sm"
                  className="ml-4"
                  onClick={() => addTeamRepo(entryIndex)}
                >
                  + Add repo target
                </Button>
              </div>
            ))}
          </div>
        )}
        <Button variant="outline" size="sm" onClick={addTeamEntry}>
          + Add team mapping
        </Button>
      </div>

      {/* Project Mappings */}
      <div className="mb-4">
        <p className="text-sm font-medium text-foreground mb-2">Project Mappings</p>
        {projectEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground mb-3">
            No project mappings configured.
          </p>
        ) : (
          <div className="space-y-2 mb-3">
            {projectEntries.map((entry, index) => (
              <div
                key={index}
                className="flex items-center gap-2 border border-border rounded-sm px-4 py-2"
              >
                <input
                  type="text"
                  value={entry.projectId}
                  onChange={(e) => updateProjectId(index, e.target.value)}
                  placeholder="Linear Project ID"
                  className="flex-1 rounded-sm border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
                <span className="text-muted-foreground text-sm">&rarr;</span>
                <Select
                  value={entry.owner && entry.name ? `${entry.owner}/${entry.name}` : ""}
                  onValueChange={(v) => updateProjectRepo(index, v)}
                >
                  <SelectTrigger density="compact" className="flex-1">
                    <SelectValue placeholder="Select repository" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableRepos.map((r) => (
                      <SelectItem key={r.fullName} value={r.fullName}>
                        {r.fullName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => removeProjectEntry(index)}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}
        <Button variant="outline" size="sm" onClick={addProjectEntry}>
          + Add project mapping
        </Button>
      </div>

      <Button onClick={handleSave} disabled={saving || !dirty}>
        {saving ? "Saving..." : "Save Mappings"}
      </Button>
    </Section>
  );
}

function RepoOverridesSection({
  overrides,
  availableRepos,
  enabledModelOptions,
}: {
  overrides: RepoSettingsEntry[];
  availableRepos: EnrichedRepository[];
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
}) {
  const [addingRepo, setAddingRepo] = useState("");

  const overriddenRepos = new Set(overrides.map((o) => o.repo));
  const availableForOverride = availableRepos.filter(
    (r) => !overriddenRepos.has(r.fullName.toLowerCase())
  );

  const handleAdd = async () => {
    if (!addingRepo) return;
    const [owner, name] = addingRepo.split("/");

    try {
      const res = await fetch(`/api/integration-settings/linear/repos/${owner}/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: {} }),
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        setAddingRepo("");
        toast.success("Override added.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to add override");
      }
    } catch {
      toast.error("Failed to add override");
    }
  };

  return (
    <div>
      {overrides.length > 0 ? (
        <div className="space-y-2 mb-4">
          {overrides.map((entry) => (
            <RepoOverrideRow
              key={entry.repo}
              entry={entry}
              enabledModelOptions={enabledModelOptions}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground mb-4">
          No repository overrides yet. Add one to customize model behavior per repo.
        </p>
      )}

      <div className="flex items-center gap-2">
        <Select value={addingRepo} onValueChange={setAddingRepo}>
          <SelectTrigger className="flex-1">
            <SelectValue placeholder="Select a repository..." />
          </SelectTrigger>
          <SelectContent>
            {availableForOverride.map((repo) => (
              <SelectItem key={repo.fullName} value={repo.fullName.toLowerCase()}>
                {repo.fullName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button onClick={handleAdd} disabled={!addingRepo}>
          Add Override
        </Button>
      </div>
    </div>
  );
}

function RepoOverrideRow({
  entry,
  enabledModelOptions,
}: {
  entry: RepoSettingsEntry;
  enabledModelOptions: { category: string; models: { id: string; name: string }[] }[];
}) {
  const [model, setModel] = useState(entry.settings.model ?? "");
  const [effort, setEffort] = useState(entry.settings.reasoningEffort ?? "");
  const [allowUserPreferenceOverride, setAllowUserPreferenceOverride] = useState(
    entry.settings.allowUserPreferenceOverride ?? true
  );
  const [allowLabelModelOverride, setAllowLabelModelOverride] = useState(
    entry.settings.allowLabelModelOverride ?? true
  );
  const [emitToolProgressActivities, setEmitToolProgressActivities] = useState(
    entry.settings.emitToolProgressActivities ?? true
  );
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const reasoningConfig = model ? MODEL_REASONING_CONFIG[model as ValidModel] : undefined;

  const handleModelChange = (newModel: string) => {
    setModel(newModel);
    setDirty(true);

    if (effort && newModel && !isValidReasoningEffort(newModel, effort)) {
      setEffort("");
    }
  };

  const handleSave = async () => {
    setSaving(true);

    const [owner, name] = entry.repo.split("/");
    const settings: LinearBotSettings = {
      allowUserPreferenceOverride,
      allowLabelModelOverride,
      emitToolProgressActivities,
    };
    if (model) settings.model = model;
    if (effort) settings.reasoningEffort = effort;

    try {
      const res = await fetch(`/api/integration-settings/linear/repos/${owner}/${name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        setDirty(false);
        toast.success(`Override for ${entry.repo} saved.`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save override");
      }
    } catch {
      toast.error("Failed to save override");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const [owner, name] = entry.repo.split("/");

    try {
      const res = await fetch(`/api/integration-settings/linear/repos/${owner}/${name}`, {
        method: "DELETE",
      });

      if (res.ok) {
        mutate(REPO_SETTINGS_KEY);
        toast.success(`Override for ${entry.repo} removed.`);
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to delete override");
      }
    } catch {
      toast.error("Failed to delete override");
    }
  };

  return (
    <div className="grid gap-2 px-4 py-3 border border-border rounded-sm">
      <div className="text-sm font-medium text-foreground">{entry.repo}</div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-2">
        <Select value={model} onValueChange={handleModelChange}>
          <SelectTrigger density="compact">
            <SelectValue placeholder="Default model" />
          </SelectTrigger>
          <SelectContent>
            {enabledModelOptions.map((group) => (
              <SelectGroup key={group.category}>
                <SelectLabel>{group.category}</SelectLabel>
                {group.models.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={effort}
          onValueChange={(v) => {
            setEffort(v);
            setDirty(true);
          }}
          disabled={!reasoningConfig}
        >
          <SelectTrigger density="compact">
            <SelectValue placeholder="Default effort" />
          </SelectTrigger>
          <SelectContent>
            {(reasoningConfig?.efforts ?? []).map((value) => (
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label className="flex items-center justify-between px-2 py-1 text-sm border border-border rounded-sm">
          <span>Tool updates</span>
          <Checkbox
            checked={emitToolProgressActivities}
            onCheckedChange={(checked) => {
              setEmitToolProgressActivities(!!checked);
              setDirty(true);
            }}
          />
        </label>
      </div>

      <div className="grid sm:grid-cols-2 gap-2">
        <label className="flex items-center justify-between px-2 py-1 text-sm border border-border rounded-sm">
          <span>User preference override</span>
          <Checkbox
            checked={allowUserPreferenceOverride}
            onCheckedChange={(checked) => {
              setAllowUserPreferenceOverride(!!checked);
              setDirty(true);
            }}
          />
        </label>
        <label className="flex items-center justify-between px-2 py-1 text-sm border border-border rounded-sm">
          <span>Label model override</span>
          <Checkbox
            checked={allowLabelModelOverride}
            onCheckedChange={(checked) => {
              setAllowLabelModelOverride(!!checked);
              setDirty(true);
            }}
          />
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={handleSave} disabled={saving || !dirty}>
          {saving ? "..." : "Save"}
        </Button>

        <Button variant="destructive" size="sm" onClick={handleDelete}>
          Remove
        </Button>
      </div>
    </div>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="border border-border-muted rounded-md p-5 mb-5">
      <h4 className="text-sm font-semibold uppercase tracking-wider text-foreground mb-1">
        {title}
      </h4>
      <p className="text-sm text-muted-foreground mb-4">{description}</p>
      {children}
    </section>
  );
}

function Message({ tone, text }: { tone: "error" | "success"; text: string }) {
  const classes =
    tone === "error"
      ? "mb-4 bg-red-50 text-red-700 px-4 py-3 border border-red-200 text-sm rounded-sm"
      : "mb-4 bg-green-50 text-green-700 px-4 py-3 border border-green-200 text-sm rounded-sm";

  return (
    <div className={classes} aria-live="polite">
      {text}
    </div>
  );
}
