import { DEFAULT_MODEL } from "@open-inspect/shared";

export function getHydratedSelectedModel(
  enabledModels: string[],
  storedModel: string | null,
  fallbackModel: string = DEFAULT_MODEL
): string {
  if (storedModel && enabledModels.includes(storedModel)) {
    return storedModel;
  }

  return enabledModels[0] ?? fallbackModel;
}

export function shouldResetSelectedModel(
  enabledModels: string[],
  selectedModel: string,
  hasHydratedModelPreferences: boolean
): boolean {
  return (
    hasHydratedModelPreferences &&
    enabledModels.length > 0 &&
    !enabledModels.includes(selectedModel)
  );
}
