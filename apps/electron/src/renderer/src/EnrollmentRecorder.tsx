import { useState } from "react";
import { int16ToBase64, playClip, recordClip } from "./audioClip";
import { ENROLLMENT_TARGET } from "./enrollment";

interface EnrollmentRecorderProps {
  speakerId: string;
  speakerName: string;
  sampleCount: number;
  onClose: () => void;
}

type Phase = "idle" | "recording" | "review" | "saving" | "error";

export function EnrollmentRecorder({
  speakerId,
  speakerName,
  sampleCount,
  onClose,
}: EnrollmentRecorderProps): React.JSX.Element {
  const [count, setCount] = useState(sampleCount);
  const [phase, setPhase] = useState<Phase>("idle");
  const [clip, setClip] = useState<Int16Array | null>(null);
  const [error, setError] = useState<string | null>(null);

  const record = async () => {
    setPhase("recording");
    setError(null);
    try {
      const pcm = await recordClip();
      setClip(pcm);
      setPhase("review");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recording failed.");
      setPhase("error");
    }
  };

  const keep = async () => {
    if (!clip) return;
    setPhase("saving");
    try {
      const { sampleCount: next } =
        await window.familyHub.assistant.saveEnrollmentClip(
          speakerId,
          int16ToBase64(clip),
        );
      setCount(next);
      setClip(null);
      setPhase("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Saving failed.");
      setPhase("error");
    }
  };

  // Redo discards the in-memory take before it is ever saved (no disk delete).
  const redo = () => {
    setClip(null);
    setPhase("idle");
  };

  return (
    <div className="enroll-recorder">
      <h3>
        Enroll {speakerName} — sample {Math.min(count + 1, ENROLLMENT_TARGET)} /{" "}
        {ENROLLMENT_TARGET}
      </h3>
      <p className="enroll-prompt">
        Say: <strong>Hey James</strong>
      </p>
      <div className="enroll-status">
        {phase === "recording" && <span>● recording…</span>}
        {phase === "saving" && <span>saving…</span>}
        {phase === "error" && <span className="enroll-error">{error}</span>}
        {(phase === "idle" || phase === "review") && <span>{count} saved</span>}
      </div>

      {phase === "review" && clip ? (
        <div className="enroll-actions">
          <button type="button" onClick={() => playClip(clip)}>
            ▶ Play
          </button>
          <button type="button" onClick={redo}>
            ↻ Redo
          </button>
          <button type="button" onClick={() => void keep()}>
            ✓ Keep
          </button>
        </div>
      ) : (
        <div className="enroll-actions">
          <button
            type="button"
            onClick={() => void record()}
            disabled={phase === "recording" || phase === "saving"}
          >
            {count >= ENROLLMENT_TARGET ? "Record more" : "Record"}
          </button>
          <button
            type="button"
            onClick={() => {
              void window.familyHub.assistant.finalizeEnrollment(speakerId);
              onClose();
            }}
          >
            Done
          </button>
        </div>
      )}
    </div>
  );
}
