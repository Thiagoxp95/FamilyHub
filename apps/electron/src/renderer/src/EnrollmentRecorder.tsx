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
  const pcmRef = useRef<Int16Array | null>(null);

  const onRecord = useCallback(async () => {
    setState((s) => reduceEnrollment(s, { type: "startRecord" }));
    try {
      pcmRef.current = await recordClip({ seconds: 2 });
      setState((s) => reduceEnrollment(s, { type: "clipCaptured" }));
    } catch {
      setState((s) => reduceEnrollment(s, { type: "redo" }));
    }
  }, []);

  const onKeep = useCallback(async () => {
    if (pcmRef.current) {
      const { sampleCount } = await window.familyHub.enrollment.saveClip(
        props.memberId,
        int16ToBase64(pcmRef.current),
      );
      props.onChange?.(sampleCount);
      setState((s) => reduceEnrollment({ ...s, kept: sampleCount - 1 }, { type: "keep" }));
    }
    pcmRef.current = null;
  }, [props]);

  const onRedo = useCallback(() => {
    pcmRef.current = null;
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
    />
  );
}
