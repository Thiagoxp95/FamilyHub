import { useEffect, useRef, useState } from "react";
import { base64ToInt16, convertFloatSamplesToLinear16, int16ToBase64 } from "./audioClip";
import { CalendarPanel } from "./CalendarPanel";
import { NotesPanel } from "./NotesPanel";
import { RemindersPanel } from "./RemindersPanel";
import { UpdateControl } from "./UpdateControl";
import { WeatherPanel } from "./WeatherPanel";

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
  const micStartedRef = useRef(false);
  const playerRef = useRef<AudioPlayer | null>(null);

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

  useEffect(() => {
    if (micStartedRef.current) {
      return;
    }

    micStartedRef.current = true;
    // Mic capture must keep running (it streams frames to the wake listener), but
    // there's no meter UI anymore — only surface a hard failure to the banner.
    const cleanup = startMicrophoneLoop({
      onError: setErrorMessage,
      onLevel: () => {},
      onReady: () => {},
    });

    return () => {
      void cleanup.then((stop) => stop());
    };
  }, []);

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
        </header>
      )}

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

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

        <section className="quad quad--weather">
          <button
            aria-label="Expand weather"
            className="quad-expand quad-expand--floating"
            onClick={() => setFocusedPanel("weather")}
            title="Expand weather"
            type="button"
          >
            ⛶
          </button>
          <WeatherPanel />
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

        <section className="quad quad--notes">
          <PanelHeader
            onExpand={() => setFocusedPanel("notes")}
            title="Notes"
          />
          <div className="quad-body">
            <NotesPanel />
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

async function startMicrophoneLoop({
  onLevel,
  onError,
  onReady,
}: {
  onError: (message: string) => void;
  onLevel: (level: number) => void;
  onReady: (sampleRate: number) => void;
}): Promise<() => void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    onError("Microphone unavailable");
    return () => {};
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        // OFF: Chrome's noise suppression eats the soft consonants of casual
        // far-field speech — exactly the "Hey James" said from across the
        // kitchen — and the wake model + Stage-2 ASRs all handle raw room
        // audio better than processed audio. Keep echoCancellation (barge-in
        // while James speaks) and AGC (lifts quiet far speech).
        noiseSuppression: false,
      },
    });
    const AudioContextConstructor =
      window.AudioContext ?? window.webkitAudioContext;
    const audioContext = new AudioContextConstructor({
      sampleRate: captureSampleRate,
    });
    const source = audioContext.createMediaStreamSource(stream);
    // 1024 samples @ 16 kHz = 64 ms callbacks. The previous 4096 (256 ms)
    // buffer added ~190 ms average delay before audio even reached the wake
    // sidecar — a big slice of the perceived wake latency.
    const processor = audioContext.createScriptProcessor(1024, 1, 1);
    const mutedOutput = audioContext.createGain();
    let pendingSamples: number[] = [];
    let smoothedLevel = 0;

    mutedOutput.gain.value = 0;
    processor.onaudioprocess = (event) => {
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
    mutedOutput.connect(audioContext.destination);

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
    }, 60);

    onReady(audioContext.sampleRate);

    return () => {
      window.clearInterval(intervalId);
      processor.disconnect();
      mutedOutput.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void audioContext.close();
    };
  } catch (error) {
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
