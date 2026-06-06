import { useEffect, useRef, useState } from "react";
import { CalendarPanel } from "./CalendarPanel";
import { RemindersPanel } from "./RemindersPanel";
import { WeatherPanel } from "./WeatherPanel";

const emptySnapshot: AssistantSnapshot = {
  config: {
    gemini: false,
    googleSpeech: false,
    localListener: false,
  },
  currentSpeakerName: null,
  events: [],
  isListening: false,
  lastAssistantResponse: null,
  lastTranscript: null,
  lockedSpeakerLabel: null,
  sessionExpiresAt: null,
  speakers: [],
  wakePhrase: "James",
};

// Mic capture + Gemini Live both use 16 kHz LINEAR16 mono.
const captureSampleRate = 16000;

export function App(): React.JSX.Element {
  const [autoStartAttempted, setAutoStartAttempted] = useState(false);
  const [bridgeStatus, setBridgeStatus] = useState("Checking bridge...");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [micLevel, setMicLevel] = useState(0);
  const [micStatus, setMicStatus] = useState("Requesting microphone...");
  const [snapshot, setSnapshot] = useState<AssistantSnapshot>(emptySnapshot);
  const [liveMode, setLiveMode] = useState<LiveMode>("wake");
  const [liveStatus, setLiveStatus] = useState("");
  const [liveInput, setLiveInput] = useState("");
  const [liveOutput, setLiveOutput] = useState("");
  const [listenerState, setListenerState] = useState<
    "loading" | "ready" | "offline" | null
  >(null);
  const [listenerDetail, setListenerDetail] = useState("");
  const [listenerElapsed, setListenerElapsed] = useState(0);
  const micStartedRef = useRef(false);
  const playerRef = useRef<AudioPlayer | null>(null);

  useEffect(() => {
    window.familyHub
      .ping()
      .then((response) => setBridgeStatus(`Bridge online: ${response}`))
      .catch(() => setBridgeStatus("Bridge unavailable"));

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

          // On "live" reset the transcript. On returning to "wake" we leave any
          // queued audio playing so a spoken goodbye finishes naturally.
          if (event.mode === "live") {
            setLiveInput("");
            setLiveOutput("");
          }
          break;
        case "inputTranscript":
          setLiveInput(event.text);
          break;
        case "outputTranscript":
          setLiveOutput(event.text);
          break;
        case "status":
          setLiveStatus(event.message);
          break;
        case "listener":
          setListenerState(event.state);
          setListenerDetail(event.detail ?? "");
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
    const cleanup = startMicrophoneLoop({
      onError: (message) => {
        setMicLevel(0);
        setMicStatus(message);
      },
      onLevel: setMicLevel,
      onReady: (sampleRate) => {
        setMicStatus(`Microphone live (${Math.round(sampleRate)} Hz)`);
      },
    });

    return () => {
      void cleanup.then((stop) => stop());
    };
  }, []);

  // Tick an elapsed-seconds counter while the local model is loading, so a long
  // first-run download reads differently from a fast cached start.
  useEffect(() => {
    if (listenerState !== "loading") {
      setListenerElapsed(0);
      return;
    }

    const startedAt = Date.now();
    const intervalId = window.setInterval(() => {
      setListenerElapsed(Math.round((Date.now() - startedAt) / 1000));
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [listenerState]);

  const listenerLabel =
    listenerState === "ready"
      ? 'Listener ready — say "James"'
      : listenerState === "loading"
        ? `Listener loading model… ${listenerElapsed}s (first run downloads ~600 MB)${
            listenerDetail ? ` — ${lastLine(listenerDetail).slice(0, 60)}` : ""
          }`
        : listenerState === "offline"
          ? "Listener offline"
          : "Listener: waiting…";

  const configuredProviderCount = [
    snapshot.config.localListener,
    snapshot.config.gemini,
  ].filter(Boolean).length;
  const sessionActive = liveMode === "live";
  const headline = !snapshot.isListening
    ? "Voice paused"
    : sessionActive
      ? "Live with James"
      : `Waiting for "${snapshot.wakePhrase}"`;
  const sessionDetail = sessionActive
    ? liveStatus || "Listening…"
    : 'Say "James" to start talking';
  const heardText = sessionActive
    ? liveInput || "Listening…"
    : (snapshot.lastTranscript ?? "Nothing yet");
  const replyText = sessionActive
    ? liveOutput || "…"
    : (snapshot.lastAssistantResponse ?? "Ready");

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
    <div className="kiosk">
      <header className="voice-strip">
        <div className={sessionActive ? "voice-orb active" : "voice-orb"} />
        <div className="voice-strip-main">
          <p className="eyebrow">FamilyHub Voice · {snapshot.wakePhrase}</p>
          <h1 className="voice-headline">{headline}</h1>
          <p className="voice-transcript">
            {sessionActive ? replyText : sessionDetail}
          </p>
          {sessionActive && heardText ? (
            <p className="voice-heard">You: {heardText}</p>
          ) : null}
        </div>
        <div className="voice-strip-side">
          <MicrophoneMeter
            active={micStatus.startsWith("Microphone live")}
            level={micLevel}
          />
          {sessionActive ? (
            <button
              className="secondary-button"
              onClick={() => {
                playerRef.current?.stop();
                void window.familyHub.assistant.endLive();
              }}
              type="button"
            >
              End conversation
            </button>
          ) : null}
        </div>
      </header>

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <main className="quad-grid">
        <section className="quad quad--calendar">
          <header className="quad-head">
            <h2>Calendar</h2>
            <span>Today</span>
          </header>
          <div className="quad-body">
            <CalendarPanel />
          </div>
        </section>

        <section className="quad quad--weather">
          <WeatherPanel />
        </section>

        <section className="quad quad--reminders">
          <header className="quad-head">
            <h2>Reminders</h2>
          </header>
          <div className="quad-body">
            <RemindersPanel />
          </div>
        </section>

        <section className="quad quad--empty">
          <div className="quad-body quad-body--empty" />
        </section>
      </main>

      <details className="diag">
        <summary>Diagnostics</summary>
        <div className="diag-body">
          <div className="diag-providers">
            <p className="section-label">Providers · {configuredProviderCount}/2</p>
            <ProviderRow
              configured={snapshot.config.localListener}
              name="Local listener (Parakeet)"
            />
            <ProviderRow
              configured={snapshot.config.gemini}
              name="Gemini Live (conversation)"
            />
            <div className="bridge-row">
              <StatusDot active={bridgeStatus.includes("online")} />
              <span>{bridgeStatus}</span>
            </div>
            <div className="bridge-row">
              <StatusDot active={micStatus.startsWith("Microphone live")} />
              <span>{micStatus}</span>
            </div>
            <div className="bridge-row">
              <StatusDot active={listenerState === "ready"} />
              <span>{listenerLabel}</span>
            </div>
          </div>
          <div className="control-row">
            <button
              disabled={snapshot.isListening}
              onClick={() =>
                void runAction(() => window.familyHub.assistant.startListening())
              }
              type="button"
            >
              Start
            </button>
            <button
              className="secondary-button"
              disabled={!snapshot.isListening}
              onClick={() =>
                void runAction(() => window.familyHub.assistant.stopListening())
              }
              type="button"
            >
              Stop
            </button>
          </div>
          {snapshot.events.length > 0 ? (
            <ol className="event-list">
              {snapshot.events.map((event) => (
                <li
                  className={`event-item ${event.type}`}
                  key={`${event.at}-${event.message}`}
                >
                  <span>{formatEventTime(event.at)}</span>
                  <p>{event.message}</p>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </details>
    </div>
  );
}

function ProviderRow({
  configured,
  name,
}: {
  configured: boolean;
  name: string;
}): React.JSX.Element {
  return (
    <div className="provider-row">
      <StatusDot active={configured} />
      <span>{name}</span>
      <strong>{configured ? "Ready" : "Missing"}</strong>
    </div>
  );
}

function StatusDot({ active }: { active: boolean }): React.JSX.Element {
  return <span className={active ? "status-dot active" : "status-dot"} />;
}

function MicrophoneMeter({
  active,
  level,
}: {
  active: boolean;
  level: number;
}): React.JSX.Element {
  const displayLevel = active ? level : 0;

  return (
    <div
      aria-label={`Microphone input level ${displayLevel}%`}
      className="mic-meter"
      role="meter"
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={displayLevel}
    >
      <span>Input</span>
      <div className="mic-meter-track">
        <div
          className="mic-meter-fill"
          style={{ inlineSize: `${displayLevel}%` }}
        />
      </div>
      <strong>{displayLevel}%</strong>
    </div>
  );
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected assistant error.";
}

// Sidecar stderr can arrive as multi-line chunks (e.g. a progress bar); show the
// most recent non-empty line so the loading detail stays compact.
function lastLine(text: string): string {
  const lines = text.split(/[\r\n]+/).filter((line) => line.trim().length > 0);
  return lines.at(-1) ?? text;
}

function isAssistantSnapshot(value: unknown): value is AssistantSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "speakers" in value &&
    "events" in value
  );
}

function formatEventTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
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
        noiseSuppression: true,
      },
    });
    const AudioContextConstructor =
      window.AudioContext ?? window.webkitAudioContext;
    const audioContext = new AudioContextConstructor({
      sampleRate: captureSampleRate,
    });
    const source = audioContext.createMediaStreamSource(stream);
    const processor = audioContext.createScriptProcessor(4096, 1, 1);
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
    }, 120);

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

function base64ToInt16(base64: string): Int16Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new Int16Array(
    bytes.buffer,
    bytes.byteOffset,
    Math.floor(bytes.byteLength / 2),
  );
}

function int16ToBase64(samples: Int16Array): string {
  const bytes = new Uint8Array(
    samples.buffer,
    samples.byteOffset,
    samples.byteLength,
  );
  let binary = "";
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...slice);
  }

  return btoa(binary);
}

function convertFloatSamplesToLinear16(samples: number[]): Int16Array {
  const pcm = new Int16Array(samples.length);

  for (const [index, sample] of samples.entries()) {
    const clampedSample = Math.max(-1, Math.min(1, sample));
    pcm[index] =
      clampedSample < 0 ? clampedSample * 0x8000 : clampedSample * 0x7fff;
  }

  return pcm;
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
