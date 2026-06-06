import { resolveSidecarPython, resolveSidecarScript } from "./localTranscriber";
import type { AssistantConfigStatus } from "./types";

export function localListenerAvailable(): boolean {
  return resolveSidecarPython() !== null && resolveSidecarScript() !== null;
}

export function readAssistantConfigStatus(
  environment: NodeJS.ProcessEnv = process.env,
  isLocalListenerAvailable: () => boolean = localListenerAvailable,
): AssistantConfigStatus {
  return {
    gemini:
      hasValue(environment.GEMINI_API_KEY) ||
      hasValue(environment.GOOGLE_API_KEY) ||
      hasValue(environment.GOOGLE_API),
    googleSpeech:
      hasValue(environment.GOOGLE_APPLICATION_CREDENTIALS) ||
      hasValue(environment.GOOGLE_CLOUD_PROJECT),
    localListener: isLocalListenerAvailable(),
  };
}

function hasValue(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
