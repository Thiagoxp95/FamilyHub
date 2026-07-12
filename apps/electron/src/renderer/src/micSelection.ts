// External-mic auto-pin for the kitchen appliance: capture must ALWAYS come
// from the external USB mic when one is plugged in — never silently fall back
// to the laptop's built-in mic because macOS reshuffled the default input or a
// stale saved pick points elsewhere. The wake model is benched against the
// counter mic; the built-in (often lid-closed in clamshell) hears mush.

// Built-in laptop/desktop mics — never auto-pinned.
const BUILT_IN_RE = /\b(built-?in|internal)\b|macbook|imac/i;
// Virtual/loopback/continuity devices that enumerate as audioinput but are not
// real room microphones.
const VIRTUAL_RE =
  /blackhole|loopback|soundflower|aggregate|zoomaudio|teams|virtual|iphone|continuity|cadefaultdevice/i;
// Chromium's synthetic entries that alias another physical device.
const SYNTHETIC_IDS = new Set(["", "default", "communications"]);

function isExternalCandidate(device: MediaDeviceInfo): boolean {
  return (
    device.kind === "audioinput" &&
    !SYNTHETIC_IDS.has(device.deviceId) &&
    device.label !== "" &&
    !BUILT_IN_RE.test(device.label) &&
    !VIRTUAL_RE.test(device.label)
  );
}

/**
 * Returns the deviceId the capture loop should use:
 *  1. an external mic, preferring labels that say USB, else the first
 *     non-built-in non-virtual physical input;
 *  2. else the saved pick, if that device still exists;
 *  3. else "" (OS default).
 *
 * Labels are empty until a getUserMedia grant has happened, so before the
 * first capture starts this returns the saved pick; once the loop is up and
 * devices are re-enumerated with labels, the external pin takes over and the
 * capture effect rebuilds onto it.
 */
export function pickPreferredMicId(
  devices: MediaDeviceInfo[],
  savedId: string,
): string {
  const candidates = devices.filter(isExternalCandidate);
  const usb = candidates.find((device) => /\busb\b|usb audio/i.test(device.label));
  const external = usb ?? candidates[0];
  if (external) {
    return external.deviceId;
  }
  if (savedId && devices.some((device) => device.deviceId === savedId)) {
    return savedId;
  }
  return "";
}
