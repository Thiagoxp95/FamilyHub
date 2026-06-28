import { useCallback, useRef, useState } from "react";
import {
  createEnrollmentState,
  isComplete,
  reduceEnrollment,
  type EnrollmentState,
} from "./enrollmentMachine";
import { int16ToBase64, recordClip } from "./audioClip";

export function recorderPrompt(state: EnrollmentState): { counter: string; action: string } {
  const counter = `${Math.min(state.kept + 1, state.target)} / ${state.target}`;
  if (state.phase === "review") return { counter, action: "Keep or redo" };
  if (state.phase === "recording") return { counter, action: "Listening…" };
  return { counter, action: "Record" };
}

export function EnrollmentRecorderView(props: {
  state: EnrollmentState;
  memberName: string;
  onRecord: () => void;
  onKeep: () => void;
  onRedo: () => void;
  onClose: () => void;
  error?: string;
}): React.JSX.Element {
  const { counter, action } = recorderPrompt(props.state);
  return (
    <div className="enroll-recorder">
      <header>
        <h3>{props.memberName}</h3>
        <button onClick={props.onClose}>Done</button>
      </header>
      <p className="enroll-counter">{counter}</p>
      <p className="enroll-phrase">Say: &ldquo;Hey James&rdquo;</p>
      <p className="enroll-action">{action}</p>
      {props.error ? (
        <p className="enroll-error" role="alert">{props.error}</p>
      ) : null}
      {props.state.phase === "idle" && (
        <button onClick={props.onRecord}>Record</button>
      )}
      {props.state.phase === "review" && (
        <div>
          <button onClick={props.onKeep}>Keep</button>
          <button onClick={props.onRedo}>Redo</button>
        </div>
      )}
      {isComplete(props.state) && (
        <p className="enroll-done">All set — {props.state.target} samples ✓</p>
      )}
    </div>
  );
}

export function EnrollmentRecorder(props: {
  memberId: string;
  memberName: string;
  target: number;
  kept: number;
  onClose: () => void;
  onChange?: (kept: number) => void;
}): React.JSX.Element {
  const [state, setState] = useState<EnrollmentState>(() =>
    createEnrollmentState(props.target, props.kept),
  );
  const [error, setError] = useState<string | null>(null);
  const pcmRef = useRef<Int16Array | null>(null);

  const onRecord = useCallback(async () => {
    setError(null);
    setState((s) => reduceEnrollment(s, { type: "startRecord" }));
    try {
      pcmRef.current = await recordClip({ seconds: 2 });
      setState((s) => reduceEnrollment(s, { type: "clipCaptured" }));
    } catch {
      // Mic denied or recordClip rejected/timed out — redo lands back in idle,
      // so the Record button reappears and the user can retry.
      pcmRef.current = null;
      setError("Couldn't record that — check the microphone and try again.");
      setState((s) => reduceEnrollment(s, { type: "redo" }));
    }
  }, []);

  const onKeep = useCallback(async () => {
    if (!pcmRef.current) return;
    try {
      const { sampleCount } = await window.familyHub.enrollment.saveClip(
        props.memberId,
        int16ToBase64(pcmRef.current),
      );
      props.onChange?.(sampleCount);
      setError(null);
      pcmRef.current = null;
      setState((s) => reduceEnrollment({ ...s, kept: sampleCount - 1 }, { type: "keep" }));
    } catch {
      // Save failed — stay in review (sample not counted) and keep the clip so
      // the user can re-keep or redo.
      setError("Couldn't save that sample — try keeping it again or redo.");
    }
  }, [props]);

  const onRedo = useCallback(() => {
    pcmRef.current = null;
    setError(null);
    setState((s) => reduceEnrollment(s, { type: "redo" }));
  }, []);

  return (
    <EnrollmentRecorderView
      state={state}
      memberName={props.memberName}
      onRecord={() => void onRecord()}
      onKeep={() => void onKeep()}
      onRedo={onRedo}
      onClose={props.onClose}
      {...(error ? { error } : {})}
    />
  );
}
