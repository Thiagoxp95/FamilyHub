import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMicrophoneLoop } from "./App";

// Regression coverage for the clamshell wake-word stall: when the laptop lid
// closes in clamshell mode the default OUTPUT device that clocks the capture
// AudioContext dies, so onaudioprocess silently stops (often with NO
// statechange) while the input mic stays "live". The loop must self-heal:
// resume a suspended context, rebuild on a lost input track, rebuild when audio
// callbacks stop arriving (watchdog), AND never leak a stream/context when
// setup throws partway (which would eventually brick wake permanently).

interface FakeListeners {
  [type: string]: Array<() => void>;
}

interface FakeProcessor {
  connect: () => void;
  disconnect: () => void;
  onaudioprocess: ((event: unknown) => void) | null;
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static throwOnConstruct = false;
  static failCreateScriptProcessor = false;

  state: "suspended" | "running" | "closed" = "suspended";
  sampleRate = 16000;
  destination = {};
  lastProcessor: FakeProcessor | null = null;
  resume = vi.fn(async () => {
    this.state = "running";
  });
  close = vi.fn(async () => {
    this.state = "closed";
  });
  private listeners: FakeListeners = {};

  constructor(options?: { sampleRate?: number }) {
    if (FakeAudioContext.throwOnConstruct) {
      throw new Error("simulated AudioContext construction failure");
    }
    if (options?.sampleRate) {
      this.sampleRate = options.sampleRate;
    }
    FakeAudioContext.instances.push(this);
  }

  addEventListener(type: string, cb: () => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  removeEventListener(type: string, cb: () => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== cb);
  }
  emit(type: string): void {
    for (const cb of this.listeners[type] ?? []) cb();
  }

  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createScriptProcessor(): FakeProcessor {
    if (FakeAudioContext.failCreateScriptProcessor) {
      throw new Error("simulated createScriptProcessor failure");
    }
    const processor: FakeProcessor = {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null,
    };
    this.lastProcessor = processor;
    return processor;
  }
  createGain(): {
    gain: { value: number };
    connect: () => void;
    disconnect: () => void;
  } {
    return { gain: { value: 0 }, connect: vi.fn(), disconnect: vi.fn() };
  }
}

function makeTrack(): {
  handlers: Record<string, () => void>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const handlers: Record<string, () => void> = {};
  return {
    handlers,
    addEventListener: vi.fn((type: string, cb: () => void) => {
      handlers[type] = cb;
    }),
    removeEventListener: vi.fn(),
    stop: vi.fn(),
  };
}

let track: ReturnType<typeof makeTrack>;
let getUserMedia: ReturnType<typeof vi.fn>;
let sendMicFrame: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeAudioContext.instances = [];
  FakeAudioContext.throwOnConstruct = false;
  FakeAudioContext.failCreateScriptProcessor = false;
  track = makeTrack();
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  getUserMedia = vi.fn().mockResolvedValue(stream);
  sendMicFrame = vi.fn();

  // The renderer reads window.AudioContext / window.familyHub / window.setInterval
  // and navigator.mediaDevices — alias window to globalThis so the faked timers
  // apply, then attach the rest. vi.stubGlobal handles getter-only globals.
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("familyHub", { assistant: { sendMicFrame } });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const noop = (): void => {};

function firstCtx(): FakeAudioContext {
  const ctx = FakeAudioContext.instances[0];
  if (!ctx) {
    throw new Error("no AudioContext was created");
  }
  return ctx;
}

interface StartOverrides {
  onStall?: () => void;
  onHealthy?: () => void;
  onError?: (message: string) => void;
  stallTimeoutMs?: number;
  deviceId?: string;
}

async function start(overrides: StartOverrides = {}): Promise<() => void> {
  return startMicrophoneLoop({
    onError: overrides.onError ?? noop,
    onLevel: noop,
    onReady: noop,
    ...(overrides.deviceId ? { deviceId: overrides.deviceId } : {}),
    ...(overrides.onStall ? { onStall: overrides.onStall } : {}),
    ...(overrides.onHealthy ? { onHealthy: overrides.onHealthy } : {}),
    ...(overrides.stallTimeoutMs !== undefined
      ? { stallTimeoutMs: overrides.stallTimeoutMs }
      : {}),
  });
}

function fireAudioCallback(ctx: FakeAudioContext): void {
  ctx.lastProcessor?.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array(1024) },
  });
}

describe("startMicrophoneLoop resilience", () => {
  it("resumes the capture context on creation (parity with playback)", async () => {
    await start();
    expect(firstCtx().resume).toHaveBeenCalled();
  });

  it("re-resumes when the context slips back to suspended", async () => {
    await start();
    const ctx = firstCtx();
    ctx.resume.mockClear();
    ctx.state = "suspended";
    ctx.emit("statechange");
    expect(ctx.resume).toHaveBeenCalledTimes(1);
  });

  it("does not resume on a statechange that is not suspended", async () => {
    await start();
    const ctx = firstCtx();
    ctx.resume.mockClear();
    ctx.state = "running";
    ctx.emit("statechange");
    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it("requests a rebuild when the input track ends", async () => {
    const onStall = vi.fn();
    await start({ onStall });
    track.handlers.ended?.();
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("requests a rebuild when the input track mutes", async () => {
    const onStall = vi.fn();
    await start({ onStall });
    track.handlers.mute?.();
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("requests a rebuild once when audio callbacks stop arriving (watchdog)", async () => {
    const onStall = vi.fn();
    await start({ onStall });
    // No onaudioprocess fires (dead output device); the watchdog should trip.
    await vi.advanceTimersByTimeAsync(5000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("honours the backoff stallTimeoutMs before tripping the watchdog", async () => {
    const onStall = vi.fn();
    await start({ onStall, stallTimeoutMs: 10000 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(onStall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000);
    expect(onStall).toHaveBeenCalledTimes(1);
  });

  it("does not trip the watchdog while audio callbacks keep arriving", async () => {
    const onStall = vi.fn();
    await start({ onStall });
    const ctx = firstCtx();
    // A silent room still fires callbacks; keep them coming for 6s.
    for (let i = 0; i < 6; i += 1) {
      fireAudioCallback(ctx);
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(onStall).not.toHaveBeenCalled();
  });

  it("fires onHealthy once on the first audio callback", async () => {
    const onHealthy = vi.fn();
    await start({ onHealthy });
    const ctx = firstCtx();
    fireAudioCallback(ctx);
    fireAudioCallback(ctx);
    expect(onHealthy).toHaveBeenCalledTimes(1);
  });

  it("stops the stream when AudioContext construction throws (no leak)", async () => {
    FakeAudioContext.throwOnConstruct = true;
    const onError = vi.fn();
    const stop = await start({ onError });
    expect(track.stop).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
    expect(typeof stop).toBe("function");
    expect(() => stop()).not.toThrow();
  });

  it("closes the context and stops the stream when graph wiring throws", async () => {
    FakeAudioContext.failCreateScriptProcessor = true;
    const onError = vi.fn();
    await start({ onError });
    expect(firstCtx().close).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it("clears timers and listeners on teardown", async () => {
    const onStall = vi.fn();
    const stop = await start({ onStall });
    const ctx = firstCtx();
    stop();
    expect(ctx.close).toHaveBeenCalled();
    expect(track.stop).toHaveBeenCalled();
    expect(track.removeEventListener).toHaveBeenCalledWith(
      "ended",
      expect.any(Function),
    );
    // After teardown the watchdog must not fire.
    await vi.advanceTimersByTimeAsync(5000);
    expect(onStall).not.toHaveBeenCalled();
  });
});
