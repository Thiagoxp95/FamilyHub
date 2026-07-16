import { useCallback, useEffect, useRef, useState } from "react";
import { base64ToInt16, convertFloatSamplesToLinear16, int16ToBase64 } from "./audioClip";
import { CalendarPanel } from "./CalendarPanel";
import { FamilySetup } from "./FamilySetup";
import { familySetupTransition } from "./familySetupControl";
import { MicPicker } from "./MicPicker";
import { pickPreferredMicId } from "./micSelection";
import { NotesPanel } from "./NotesPanel";
import { RemindersPanel } from "./RemindersPanel";
import { ListeningBorder } from "./ListeningBorder";
import {
  createNightWatchState,
  reduceNightWatch,
  type NightWatchEvent,
  type NightWatchState,
} from "./nightWatch";
import { type ActiveCard, SuggestionCard } from "./SuggestionCard";
import { UpdateControl } from "./UpdateControl";
import { WeatherPanel, WeatherStrip } from "./WeatherPanel";

// Persisted across restarts so the kitchen Mac keeps the chosen wake-word mic.
// Empty string means "let the OS pick the default input".
const MIC_DEVICE_STORAGE_KEY = "familyhub.micDeviceId";

function loadSavedMicId(): string {
  try {
    return window.localStorage.getItem(MIC_DEVICE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveMicId(deviceId: string): void {
  try {
    if (deviceId) {
      window.localStorage.setItem(MIC_DEVICE_STORAGE_KEY, deviceId);
    } else {
      window.localStorage.removeItem(MIC_DEVICE_STORAGE_KEY);
    }
  } catch {
    // localStorage unavailable (private mode / disabled) — the choice just
    // won't survive a restart, which is acceptable.
  }
}

const emptySnapshot: AssistantSnapshot = {
  config: {
    gemini: false,
    googleSpeech: false,
    localListener: false,
  },
  events: [],
  isListening: false,
  lastAssistantResponse: null,
  lastTranscript: null,
  wakePhrase: "Hey James",
};

// Mic capture + Gemini Live both use 16 kHz LINEAR16 mono.
const captureSampleRate = 16000;

export function App(): React.JSX.Element {
  const [autoStartAttempted, setAutoStartAttempted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AssistantSnapshot>(emptySnapshot);
  const [liveMode, setLiveMode] = useState<LiveMode>("wake");
  const [liveInput, setLiveInput] = useState("");
  const [liveOutput, setLiveOutput] = useState("");
  const [focusedPanel, setFocusedPanel] = useState<DashboardPanel>(null);
  const [reminderList, setReminderList] = useState<string | null>(null);
  const [audioInputs, setAudioInputs] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState<string>(loadSavedMicId);
  const [familySetupOpen, setFamilySetupOpen] = useState(false);
  const [suggestion, setSuggestion] = useState<ActiveCard | null>(null);
  const playerRef = useRef<AudioPlayer | null>(null);

  // Night blanking: after a sustained stretch with no sound on the wake mic
  // the display goes black (no light leaking toward the bedroom). Sustained
  // sound, a touch/key, or an assistant session wakes it. Wake-word capture
  // keeps running underneath, so "Hey James" also lights it back up.
  const [screenOff, setScreenOff] = useState(false);
  const nightRef = useRef<NightWatchState>(createNightWatchState(Date.now()));
  const liveModeRef = useRef<LiveMode>("wake");

  const dispatchNight = useCallback((event: NightWatchEvent): void => {
    const next = reduceNightWatch(nightRef.current, event);
    nightRef.current = next;
    // Same-boolean sets bail out of re-rendering, so feeding this from the
    // ~32 ms mic-level callback is cheap.
    setScreenOff(next.screenOff);
  }, []);

  const handleMicLevel = useCallback(
    (level: number): void => {
      dispatchNight({ type: "level", level, now: Date.now() });
    },
    [dispatchNight],
  );

  // Device labels are only populated once a getUserMedia grant has happened, so
  // this is also called from the capture loop's onReady (not just on mount).
  const refreshAudioInputs = useCallback(async (): Promise<void> => {
    if (!navigator.mediaDevices?.enumerateDevices) {
      return;
    }

    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      setAudioInputs(
        devices.filter((device) => device.kind === "audioinput" && device.deviceId),
      );
    } catch {
      // Enumeration is best-effort; the dropdown just stays on its last list.
    }
  }, []);

  const handleMicChange = useCallback((deviceId: string): void => {
    setMicDeviceId(deviceId);
    saveMicId(deviceId);
  }, []);

  // Brute-force external-USB pin: whenever a real external mic is plugged in,
  // capture uses it — overriding both the OS default and the saved pick. The
  // saved pick only matters when no external mic is present. (Labels appear
  // after the first getUserMedia grant, so this converges on the second pass:
  // loop starts on saved/default → onReady refreshes devices with labels →
  // effectiveMicId flips to the USB mic → the capture effect rebuilds onto it.)
  const effectiveMicId = pickPreferredMicId(audioInputs, micDeviceId);

  // Bumping this forces the capture effect to tear down and rebuild the whole
  // getUserMedia → AudioContext graph, even when the device id is unchanged.
  // That's the load-bearing recovery: a clamshell lid-close swaps the default
  // output device that clocks the capture context, killing it with the input
  // mic still "live", so re-picking the same mic (a no-op) can't recover it.
  const [captureEpoch, setCaptureEpoch] = useState(0);
  const restartTimerRef = useRef<number | undefined>(undefined);
  // Consecutive stalls with no recovery → exponential backoff on the watchdog
  // so a setup with no working audio output (clamshell + a monitor with no
  // speakers) can't rebuild the capture graph forever in a tight loop. Reset
  // the moment a rebuilt loop produces audio (onHealthy).
  const stallCountRef = useRef(0);
  // Coalesce restart triggers (the watchdog and a lost input track can both
  // fire) into a single debounced rebuild.
  const restartCapture = useCallback((): void => {
    if (restartTimerRef.current !== undefined) {
      window.clearTimeout(restartTimerRef.current);
    }
    restartTimerRef.current = window.setTimeout(() => {
      restartTimerRef.current = undefined;
      stallCountRef.current += 1;
      setCaptureEpoch((epoch) => epoch + 1);
    }, 400);
  }, []);
  const markCaptureHealthy = useCallback((): void => {
    stallCountRef.current = 0;
  }, []);

  useEffect(
    () => () => {
      if (restartTimerRef.current !== undefined) {
        window.clearTimeout(restartTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    window.familyHub.assistant
      .getSnapshot()
      .then(setSnapshot)
      .catch((error: unknown) => {
        setErrorMessage(readErrorMessage(error));
      });

    return window.familyHub.assistant.onSnapshot(setSnapshot);
  }, []);

  // Live audio conversation: react to state events and play streamed replies.
  useEffect(() => {
    const player = createAudioPlayer();
    playerRef.current = player;

    const offLive = window.familyHub.assistant.onLive((event) => {
      switch (event.type) {
        case "mode":
          setLiveMode(event.mode);

          if (event.mode === "connecting" || event.mode === "live") {
            setLiveInput("");
            setLiveOutput("");
          } else {
            // Session ended (goodbye / timeout / drop) — collapse any
            // full-screen quadrant back to the four-up grid.
            setFocusedPanel(null);
          }
          break;
        case "inputTranscript":
          setLiveInput(event.text);
          break;
        case "outputTranscript":
          setLiveOutput(event.text);
          break;
        case "status":
          break;
        case "interrupted":
          player.stop();
          break;
        case "turnComplete":
          break;
        case "suggestion":
          setSuggestion({ id: event.id, kind: event.kind, text: event.text });
          playSuggestionChime();
          break;
        case "suggestionResolved":
          setSuggestion((current) => (current?.id === event.id ? null : current));
          break;
      }
    });

    const offAudio = window.familyHub.assistant.onLiveAudio((chunk) => {
      player.play(chunk.data, parseSampleRate(chunk.mimeType));
    });

    return () => {
      offLive();
      offAudio();
      player.close();
      playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (autoStartAttempted || snapshot.isListening) {
      return;
    }

    setAutoStartAttempted(true);
    void runAction(() => window.familyHub.assistant.startListening());
  }, [autoStartAttempted, snapshot.isListening]);

  // A session opening (wake word fired) is direct presence — wake the screen
  // the instant "connecting" lands, before any UI renders under the overlay.
  useEffect(() => {
    liveModeRef.current = liveMode;

    if (liveMode !== "wake") {
      dispatchNight({ type: "activity", now: Date.now() });
    }
  }, [liveMode, dispatchNight]);

  // Idle timer + human input. Touch/keys wake immediately; the coarse tick is
  // the only thing that can blank. An open conversation counts as presence even
  // in a quiet moment (echo cancellation keeps James' own voice off the mic).
  useEffect(() => {
    const onActivity = (): void =>
      dispatchNight({ type: "activity", now: Date.now() });

    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);

    const tickId = window.setInterval(() => {
      if (liveModeRef.current !== "wake") {
        dispatchNight({ type: "activity", now: Date.now() });
        return;
      }

      dispatchNight({ type: "tick", now: Date.now() });
    }, 10_000);

    return () => {
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.clearInterval(tickId);
    };
  }, [dispatchNight]);

  // Mic capture must keep running (it streams frames to the wake listener), but
  // there's no meter UI anymore — only surface a hard failure to the banner.
  // Re-runs when the chosen input changes so the new device takes over.
  useEffect(() => {
    // Family Setup owns the mic while open: tear the renderer capture down so the
    // enrollment recorder's recordClip can acquire getUserMedia on its own (no
    // second concurrent stream) and the stall watchdog can't fire restartCapture
    // mid-enrollment. The effect re-runs and rebuilds capture when it closes.
    if (familySetupOpen) {
      return undefined;
    }

    // Back off the watchdog after repeated failed rebuilds: 3s, 6s, 12s … 60s.
    // Resets to 3s as soon as a rebuilt loop produces audio (markCaptureHealthy).
    const stallTimeoutMs = Math.min(
      3000 * 2 ** stallCountRef.current,
      60000,
    );

    const cleanup = startMicrophoneLoop({
      deviceId: effectiveMicId,
      onError: setErrorMessage,
      // Smoothed level feeds the night watcher (presence detection), not a
      // meter — there's no meter UI anymore.
      onLevel: handleMicLevel,
      // Labels are available now that the mic is granted — refresh so the
      // dropdown shows real device names instead of "Microphone N".
      onReady: () => void refreshAudioInputs(),
      // The saved device vanished and we fell back to the default; reflect that
      // in the dropdown rather than leaving a dead selection.
      onDeviceUnavailable: () => handleMicChange(""),
      // Capture stalled mid-stream (clamshell output-device swap killed the
      // context, or the input track died) — rebuild the graph.
      onStall: restartCapture,
      onHealthy: markCaptureHealthy,
      stallTimeoutMs,
    });

    return () => {
      void cleanup.then((stop) => stop());
    };
  }, [
    effectiveMicId,
    captureEpoch,
    familySetupOpen,
    refreshAudioInputs,
    handleMicChange,
    handleMicLevel,
    restartCapture,
    markCaptureHealthy,
  ]);

  // Keep the input list fresh as devices are plugged/unplugged.
  useEffect(() => {
    void refreshAudioInputs();

    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) {
      return undefined;
    }

    // Keep the dropdown list fresh only. Do NOT rebuild capture here: a
    // clamshell lid-close kills the output device that clocks the context, but
    // so does any benign topology change (AirPods, a USB DAC), and rebuilding
    // on every event causes periodic wake gaps. The liveness watchdog inside
    // startMicrophoneLoop detects the actual stall and rebuilds (with backoff).
    const handler = (): void => void refreshAudioInputs();
    mediaDevices.addEventListener("devicechange", handler);
    return () => mediaDevices.removeEventListener("devicechange", handler);
  }, [refreshAudioInputs]);

  useEffect(() => {
    window.familyHub.dashboard
      .getFocusedPanel()
      .then(setFocusedPanel)
      .catch(() => undefined);

    return window.familyHub.dashboard.onFocus(setFocusedPanel);
  }, []);

  useEffect(() => {
    window.familyHub.dashboard
      .getReminderList()
      .then(setReminderList)
      .catch(() => undefined);

    return window.familyHub.dashboard.onReminderList(setReminderList);
  }, []);

  useEffect(() => {
    if (!focusedPanel) {
      return undefined;
    }

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setFocusedPanel(null);
      }
    };

    document.body.classList.add("hub-modal-open");
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.classList.remove("hub-modal-open");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [focusedPanel]);

  // The strip shows from the instant the wake fires ("connecting") so the user
  // gets immediate feedback instead of waiting out the Gemini connect.
  const sessionActive = liveMode !== "wake";

  async function runAction(action: () => Promise<unknown>): Promise<void> {
    setErrorMessage(null);

    try {
      const result = await action();

      if (isAssistantSnapshot(result)) {
        setSnapshot(result);
      }
    } catch (error) {
      setErrorMessage(readErrorMessage(error));
    }
  }

  return (
    <div className={sessionActive ? "kiosk kiosk--live" : "kiosk"}>
      {/* Neon rim shown ONLY while James is invoked: it lights the instant the
          wake fires ("connecting") and stays through the live conversation.
          While merely waiting for the wake word there is no border at all. */}
      {sessionActive && !familySetupOpen ? (
        <ListeningBorder
          mode={liveMode === "connecting" ? "connecting" : "live"}
        />
      ) : null}

      {/* Seamless top-left corner (clears the inset traffic lights): pick which
          microphone listens for the wake word. */}
      <div className="mic-corner">
        {/* Shows the EFFECTIVE input: when an external USB mic is plugged in
            it is auto-pinned and wins over any manual pick (micSelection.ts). */}
        <MicPicker
          devices={audioInputs}
          onChange={handleMicChange}
          selectedDeviceId={effectiveMicId}
        />
        <button
          className="family-voices-btn"
          onClick={() => {
            const plan = familySetupTransition(true);
            if (plan.listening === "stop") void window.familyHub.assistant.stopListening();
            if (plan.bumpCapture) setCaptureEpoch((e) => e + 1);
            setFamilySetupOpen(true);
          }}
          type="button"
        >
          Family voices
        </button>
      </div>

      {/* Seamless top-right corner: shows only when an update is actionable. */}
      <div className="update-corner">
        <UpdateControl />
      </div>

      {/* The top card is always present: while James is invoked it holds the
          conversation; otherwise it shows the Brasília/Montreal clocks. */}
      {sessionActive ? (
        <header className="voice-strip voice-strip--live" aria-live="polite">
          <div className="voice-orb active" />
          <div className="voice-strip-main">
            <p className="eyebrow">FamilyHub Voice · {snapshot.wakePhrase}</p>
            <p className="voice-transcript">
              {liveOutput ||
                (liveMode === "connecting" ? "Waking…" : "Listening…")}
            </p>
            {liveInput ? <p className="voice-heard">You: {liveInput}</p> : null}
          </div>
        </header>
      ) : (
        <header className="voice-strip voice-strip--clock">
          <div className="voice-orb" />
          <IdleClock />
          {/* Weather lives up here now (its old quadrant is gone); tapping it
              still opens the fullscreen weather view. */}
          <WeatherStrip onExpand={() => setFocusedPanel("weather")} />
        </header>
      )}

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      {/* Two big panels readable from across the kitchen: Calendar and
          Reminders each take a full-height column. Weather moved to the top
          strip; Notes is hidden for now (still reachable fullscreen via the
          voice show_notes_card tool). */}
      <main className="quad-grid">
        <section className="quad quad--calendar">
          <PanelHeader
            accessory="Today"
            onExpand={() => setFocusedPanel("calendar")}
            title="Calendar"
          />
          <div className="quad-body">
            <CalendarPanel />
          </div>
        </section>

        <section className="quad quad--reminders">
          <PanelHeader
            onExpand={() => setFocusedPanel("reminders")}
            title="Reminders"
          />
          <div className="quad-body">
            <RemindersPanel focusList={reminderList} />
          </div>
        </section>
      </main>

      {focusedPanel ? (
        <FullscreenPanel
          panel={focusedPanel}
          reminderList={reminderList}
          onClose={() => setFocusedPanel(null)}
        />
      ) : null}

      {familySetupOpen ? (
        <FamilySetup
          onClose={() => {
            const plan = familySetupTransition(false);
            if (plan.listening === "start") void window.familyHub.assistant.startListening();
            if (plan.bumpCapture) setCaptureEpoch((e) => e + 1);
            setFamilySetupOpen(false);
          }}
        />
      ) : null}

      {suggestion ? (
        <SuggestionCard
          card={suggestion}
          onAccept={(id) => {
            setSuggestion(null);
            void window.familyHub.assistant.suggestionAction(id, "accept");
          }}
          onDismiss={(id) => {
            setSuggestion(null);
            void window.familyHub.assistant.suggestionAction(id, "dismiss");
          }}
        />
      ) : null}

      {/* Night blanking: pure black sheet over everything (including the
          listening border) once the room has been silent long enough. The
          window-level pointerdown listener wakes it, so no handler here. */}
      {screenOff ? <div className="night-screen" aria-hidden="true" /> : null}
    </div>
  );
}

const clockZones = [
  { label: "Brasília", timeZone: "America/Sao_Paulo" },
  { label: "Montreal", timeZone: "America/Montreal" },
] as const;

function formatClock(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

// Self-contained so the per-second tick re-renders only the clock, not the app.
function IdleClock(): React.JSX.Element {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const intervalId = window.setInterval(() => setNow(new Date()), 1_000);
    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <div className="clock-row">
      {clockZones.map((zone) => (
        <div className="clock-zone" key={zone.timeZone}>
          <p className="eyebrow">{zone.label}</p>
          <p className="clock-time">{formatClock(now, zone.timeZone)}</p>
        </div>
      ))}
    </div>
  );
}

function PanelHeader({
  accessory,
  onExpand,
  title,
}: {
  accessory?: string;
  onExpand: () => void;
  title: string;
}): React.JSX.Element {
  return (
    <header className="quad-head">
      <h2>{title}</h2>
      <div className="quad-head-actions">
        {accessory ? <span>{accessory}</span> : null}
        <button
          aria-label={`Expand ${title.toLowerCase()}`}
          className="quad-expand"
          onClick={onExpand}
          title={`Expand ${title.toLowerCase()}`}
          type="button"
        >
          ⛶
        </button>
      </div>
    </header>
  );
}

function FullscreenPanel({
  onClose,
  panel,
  reminderList,
}: {
  onClose: () => void;
  panel: Exclude<DashboardPanel, null>;
  reminderList?: string | null;
}): React.JSX.Element {
  const title = panelTitle(panel);

  return (
    <div
      className={`hub-fullscreen-backdrop ${panel}-fullscreen`}
      onClick={onClose}
      role="presentation"
    >
      <section
        aria-label={`${title} expanded`}
        aria-modal="true"
        className={`hub-fullscreen-panel ${panel}-expanded`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <button
          aria-label={`Close ${title.toLowerCase()}`}
          className="hub-fullscreen-close"
          onClick={onClose}
          title="Close"
          type="button"
        >
          ×
        </button>
        <header className="fullscreen-head">
          <p>{title}</p>
          <h2>{fullscreenHeadline(panel)}</h2>
        </header>
        <div className="fullscreen-body">
          {panel === "calendar" ? <CalendarPanel /> : null}
          {panel === "weather" ? <WeatherPanel variant="expanded" /> : null}
          {panel === "reminders" ? (
            <RemindersPanel focusList={reminderList ?? null} />
          ) : null}
          {panel === "notes" ? <NotesPanel variant="expanded" /> : null}
        </div>
      </section>
    </div>
  );
}

function panelTitle(panel: Exclude<DashboardPanel, null>): string {
  switch (panel) {
    case "calendar":
      return "Calendar";
    case "weather":
      return "Weather";
    case "reminders":
      return "Reminders";
    case "notes":
      return "Notes";
  }
}

function fullscreenHeadline(panel: Exclude<DashboardPanel, null>): string {
  switch (panel) {
    case "calendar":
      return "Family agenda";
    case "weather":
      return "Current conditions";
    case "reminders":
      return "Open tasks";
    case "notes":
      return "Family board";
  }
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected assistant error.";
}

function isAssistantSnapshot(value: unknown): value is AssistantSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "events" in value &&
    "isListening" in value
  );
}

export async function startMicrophoneLoop({
  deviceId,
  onLevel,
  onError,
  onReady,
  onDeviceUnavailable,
  onStall,
  onHealthy,
  stallTimeoutMs = 3000,
}: {
  deviceId?: string;
  onDeviceUnavailable?: () => void;
  onError: (message: string) => void;
  onLevel: (level: number) => void;
  onReady: (sampleRate: number) => void;
  // Called when capture stalls mid-stream (output device that clocks the
  // AudioContext died on a clamshell lid-close, or the input track ended/muted).
  // The owner rebuilds the whole graph — recovery can't be done in place.
  onStall?: () => void;
  // Fired once the first audio callback actually arrives, i.e. this loop is
  // producing frames. The owner uses it to reset stall backoff.
  onHealthy?: () => void;
  // How long with no audio callback before the watchdog declares a stall. The
  // owner grows this (backoff) across consecutive stalls so a setup with no
  // working audio output never busy-loops rebuilding.
  stallTimeoutMs?: number;
}): Promise<() => void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    onError("Microphone unavailable");
    return () => {};
  }

  const audioConstraints: MediaTrackConstraints = {
    autoGainControl: true,
    channelCount: 1,
    echoCancellation: true,
    // OFF: Chrome's noise suppression eats the soft consonants of casual
    // far-field speech — exactly the "Hey James" said from across the
    // kitchen — and the wake model + Stage-2 ASRs all handle raw room
    // audio better than processed audio. Keep echoCancellation (barge-in
    // while James speaks) and AGC (lifts quiet far speech).
    noiseSuppression: false,
  };

  // Pin to the chosen input; omit entirely to take the OS default.
  if (deviceId) {
    audioConstraints.deviceId = { exact: deviceId };
  }

  // Hoisted so a throw mid-setup (e.g. `new AudioContext` failing during an
  // unstable CoreAudio route transition) can still tear down whatever was
  // created — otherwise a leaked stream/AudioContext eventually trips
  // Chromium's per-page context cap and bricks wake permanently on a device
  // that can't be hand-fixed.
  let stream: MediaStream | undefined;
  let audioContext: AudioContext | undefined;
  let micTrack: MediaStreamTrack | undefined;
  let watchdogId: number | undefined;
  const handleTrackLost = (): void => onStall?.();
  let handleStateChange: (() => void) | undefined;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
    });

    // If the OS resets the input (CoreAudio HAL reset on a lid/power
    // transition, or a genuine unplug), the track ends/mutes while the rest of
    // the graph looks healthy. Rebuild rather than going deaf.
    [micTrack] = stream.getAudioTracks();
    micTrack?.addEventListener("ended", handleTrackLost);
    micTrack?.addEventListener("mute", handleTrackLost);

    const AudioContextConstructor =
      window.AudioContext ?? window.webkitAudioContext;
    audioContext = new AudioContextConstructor({
      sampleRate: captureSampleRate,
    });
    const ctx = audioContext;

    // The capture context (unlike the playback one) was never resumed. A
    // context created while the page is briefly occluded — or interrupted by an
    // audio-route change — can sit "suspended" forever, so resume on creation
    // and again whenever it slips back to suspended.
    void ctx.resume().catch(() => {});
    handleStateChange = (): void => {
      if (ctx.state === "suspended") {
        void ctx.resume().catch(() => {});
      }
    };
    ctx.addEventListener("statechange", handleStateChange);

    const source = ctx.createMediaStreamSource(stream);
    // 512 samples @ 16 kHz = 32 ms callbacks. Historically 4096 (256 ms), then
    // 1024 (64 ms) — each halving trims average delay before audio reaches the
    // wake sidecar and, mid-session, the Gemini Live socket.
    const processor = ctx.createScriptProcessor(512, 1, 1);
    const mutedOutput = ctx.createGain();
    let pendingSamples: number[] = [];
    let smoothedLevel = 0;
    // Liveness, not loudness: a silent kitchen still fires onaudioprocess. When
    // the lid closes in clamshell the default OUTPUT device that clocks this
    // context can die — onaudioprocess stops with NO statechange — so the only
    // reliable signal is "callbacks stopped arriving".
    let lastCallbackAt = Date.now();
    let stalled = false;
    let healthy = false;

    mutedOutput.gain.value = 0;
    processor.onaudioprocess = (event) => {
      lastCallbackAt = Date.now();
      if (!healthy) {
        healthy = true;
        onHealthy?.();
      }
      const channel = event.inputBuffer.getChannelData(0);

      for (const sample of channel) {
        pendingSamples.push(sample);
      }

      const currentLevel = calculateMicrophoneLevel(channel);
      smoothedLevel = Math.round(smoothedLevel * 0.72 + currentLevel * 0.28);
      onLevel(smoothedLevel);
    };

    source.connect(processor);
    processor.connect(mutedOutput);
    mutedOutput.connect(ctx.destination);

    // The main process is always listening (local Parakeet) and decides what to
    // buffer/forward, so the renderer streams every frame unconditionally.
    const intervalId = window.setInterval(() => {
      if (pendingSamples.length === 0) {
        return;
      }

      const samples = pendingSamples;
      pendingSamples = [];
      const pcm = convertFloatSamplesToLinear16(samples);
      window.familyHub.assistant.sendMicFrame(int16ToBase64(pcm));
    }, 30);

    // Fire onStall once if the audio render thread stops pulling frames. The
    // owner tears this loop down (clearing this watchdog) and rebuilds against
    // the now-current default output device. stallTimeoutMs grows on repeated
    // stalls (owner-driven backoff) so a no-audio-output setup can't busy-loop.
    watchdogId = window.setInterval(() => {
      if (!stalled && Date.now() - lastCallbackAt > stallTimeoutMs) {
        stalled = true;
        onStall?.();
      }
    }, 1000);

    onReady(ctx.sampleRate);

    return () => {
      window.clearInterval(intervalId);
      if (watchdogId !== undefined) {
        window.clearInterval(watchdogId);
      }
      if (handleStateChange) {
        ctx.removeEventListener("statechange", handleStateChange);
      }
      micTrack?.removeEventListener("ended", handleTrackLost);
      micTrack?.removeEventListener("mute", handleTrackLost);
      processor.disconnect();
      mutedOutput.disconnect();
      source.disconnect();
      stream?.getTracks().forEach((track) => track.stop());
      void ctx.close().catch(() => {});
    };
  } catch (error) {
    // Best-effort teardown of anything created before the throw, then return a
    // no-op (never rethrow — the caller relies on always getting a stop fn).
    if (watchdogId !== undefined) {
      window.clearInterval(watchdogId);
    }
    if (audioContext && handleStateChange) {
      audioContext.removeEventListener("statechange", handleStateChange);
    }
    micTrack?.removeEventListener("ended", handleTrackLost);
    micTrack?.removeEventListener("mute", handleTrackLost);
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => {});
    }
    stream?.getTracks().forEach((track) => track.stop());

    // A pinned device that's been unplugged throws here. Don't leave the
    // kitchen without a wake word: drop the selection and retry on the default.
    if (deviceId) {
      onError("Selected microphone unavailable — using the default.");
      onDeviceUnavailable?.();
      return () => {};
    }

    onError(`Microphone blocked: ${readErrorMessage(error)}`);
    return () => {};
  }
}

interface AudioPlayer {
  play: (base64: string, sampleRate: number) => void;
  stop: () => void;
  close: () => void;
}

// Schedules streamed PCM chunks back-to-back so playback is gapless, and can be
// stopped instantly for barge-in.
function createAudioPlayer(): AudioPlayer {
  const AudioContextConstructor =
    window.AudioContext ?? window.webkitAudioContext;
  let context: AudioContext | null = null;
  let nextStartTime = 0;
  const active = new Set<AudioBufferSourceNode>();

  function ensureContext(): AudioContext {
    if (!context) {
      context = new AudioContextConstructor();
      nextStartTime = 0;
    }

    return context;
  }

  return {
    play(base64, sampleRate) {
      const samples = base64ToInt16(base64);

      if (samples.length === 0) {
        return;
      }

      const audioContext = ensureContext();
      void audioContext.resume();

      const buffer = audioContext.createBuffer(1, samples.length, sampleRate);
      const channel = buffer.getChannelData(0);

      for (let index = 0; index < samples.length; index += 1) {
        channel[index] = (samples[index] ?? 0) / 0x8000;
      }

      const node = audioContext.createBufferSource();
      node.buffer = buffer;
      node.connect(audioContext.destination);

      const startAt = Math.max(audioContext.currentTime + 0.02, nextStartTime);
      node.start(startAt);
      nextStartTime = startAt + buffer.duration;

      active.add(node);
      node.onended = () => {
        active.delete(node);
      };
    },
    stop() {
      for (const node of active) {
        try {
          node.stop();
        } catch {
          // Already stopped.
        }
      }

      active.clear();

      if (context) {
        nextStartTime = context.currentTime;
      }
    },
    close() {
      this.stop();

      if (context) {
        void context.close();
        context = null;
      }
    },
  };
}

function parseSampleRate(mimeType: string): number {
  const match = /rate=(\d+)/.exec(mimeType);
  return match ? Number(match[1]) : 24000;
}

// Soft two-tone chime that announces an ambient suggestion card without
// pulling in an audio asset. Opens its own short-lived AudioContext (separate
// from the live-reply player) and lets it close once the tones finish.
function playSuggestionChime(): void {
  try {
    const AudioContextConstructor = window.AudioContext ?? window.webkitAudioContext;
    const context = new AudioContextConstructor();
    const toneMs = 120;

    [880, 1320].forEach((frequency, index) => {
      const startAt = context.currentTime + (index * toneMs) / 1000;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.value = 0.08;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(startAt);
      oscillator.stop(startAt + toneMs / 1000);
    });

    window.setTimeout(() => void context.close().catch(() => {}), toneMs * 2 + 50);
  } catch {
    // WebAudio unavailable — the visual card still appears, so this is
    // best-effort only.
  }
}

export function calculateMicrophoneLevel(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }

  let sumSquares = 0;

  for (const sample of samples) {
    const clampedSample = Math.max(-1, Math.min(1, sample));
    sumSquares += clampedSample * clampedSample;
  }

  return Math.min(100, Math.round(Math.sqrt(sumSquares / samples.length) * 100));
}
