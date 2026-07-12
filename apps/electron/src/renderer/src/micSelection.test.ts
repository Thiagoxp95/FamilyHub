import { describe, expect, it } from "vitest";
import { pickPreferredMicId } from "./micSelection";

function device(deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    label,
    kind: "audioinput",
    groupId: `group-${deviceId}`,
    toJSON: () => ({}),
  } as MediaDeviceInfo;
}

const builtIn = device("built-in", "MacBook Pro Microphone (Built-in)");
const usb = device("usb-1", "Samson Q2U Microphone (USB Audio)");
const externalNoUsbLabel = device("ext-1", "Blue Yeti Stereo Microphone");
const virtual = device("vb-1", "BlackHole 2ch (Virtual)");
const iphone = device("cont-1", "Thiago’s iPhone Microphone (Continuity)");
const synthetic = device("default", "Default - Samson Q2U Microphone (USB Audio)");

describe("pickPreferredMicId", () => {
  it("pins the USB mic over the OS default and any saved pick", () => {
    expect(pickPreferredMicId([builtIn, usb], "")).toBe("usb-1");
    expect(pickPreferredMicId([builtIn, usb], "built-in")).toBe("usb-1");
  });

  it("prefers a USB-labelled mic over other external devices", () => {
    expect(pickPreferredMicId([externalNoUsbLabel, usb, builtIn], "")).toBe("usb-1");
  });

  it("falls back to any external physical mic when nothing says USB", () => {
    expect(pickPreferredMicId([builtIn, externalNoUsbLabel], "")).toBe("ext-1");
  });

  it("never pins built-in, virtual, continuity or synthetic entries", () => {
    expect(pickPreferredMicId([builtIn, virtual, iphone, synthetic], "")).toBe("");
  });

  it("uses the saved pick when no external mic is present and it still exists", () => {
    expect(pickPreferredMicId([builtIn], "built-in")).toBe("built-in");
  });

  it("drops a saved pick whose device is gone", () => {
    expect(pickPreferredMicId([builtIn], "usb-1")).toBe("");
  });

  it("returns OS default with no devices or before labels are granted", () => {
    expect(pickPreferredMicId([], "")).toBe("");
    // Pre-grant enumeration: labels are empty strings, so nothing can be
    // classified as external yet — stay on the OS default until the first
    // grant populates labels.
    expect(pickPreferredMicId([device("usb-1", "")], "")).toBe("");
  });
});
