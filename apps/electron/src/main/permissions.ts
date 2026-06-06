import type {
  PermissionCheckHandlerHandlerDetails,
  PermissionRequest,
  Session,
  SystemPreferences,
  WebContents,
} from "electron";

interface MediaPermissionInput {
  mediaType: string | undefined;
  permission: string;
  url: string;
}

interface RequestMicrophoneAccessInput {
  platform?: NodeJS.Platform;
  systemPreferences: Pick<SystemPreferences, "askForMediaAccess">;
}

export function configureMediaPermissions(defaultSession: Session): void {
  defaultSession.setPermissionCheckHandler(
    (webContents, permission, _requestingOrigin, details) =>
      isAllowedMediaPermission({
        mediaType: details.mediaType,
        permission,
        url: readWebContentsUrl(webContents),
      }),
  );

  defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      callback(
        isAllowedMediaPermission({
          mediaType: readRequestMediaType(details),
          permission,
          url: readWebContentsUrl(webContents),
        }),
      );
    },
  );
}

export async function requestMicrophoneAccess({
  platform = process.platform,
  systemPreferences,
}: RequestMicrophoneAccessInput): Promise<boolean> {
  if (platform !== "darwin") {
    return true;
  }

  return systemPreferences.askForMediaAccess("microphone");
}

export function isAllowedMediaPermission({
  mediaType,
  permission,
  url,
}: MediaPermissionInput): boolean {
  return permission === "media" && mediaType === "audio" && isAppWindowUrl(url);
}

function readWebContentsUrl(webContents: WebContents | null): string {
  return webContents?.getURL() ?? "";
}

function readRequestMediaType(details: PermissionRequest): string | undefined {
  const mediaTypes =
    "mediaTypes" in details
      ? (details as { mediaTypes?: unknown }).mediaTypes
      : undefined;

  if (Array.isArray(mediaTypes) && mediaTypes.includes("audio")) {
    return "audio";
  }

  if (
    "mediaType" in details &&
    typeof (details as PermissionCheckHandlerHandlerDetails).mediaType === "string"
  ) {
    return (details as PermissionCheckHandlerHandlerDetails).mediaType;
  }

  return undefined;
}

function isAppWindowUrl(value: string): boolean {
  if (value.startsWith("file://")) {
    return true;
  }

  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    );
  } catch {
    return false;
  }
}
