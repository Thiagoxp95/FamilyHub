import { useState } from "react";
import { EnrollmentRecorder } from "./EnrollmentRecorder";
import { enrollmentStatus } from "./enrollment";

interface FamilySetupProps {
  speakers: EnrolledSpeaker[];
  onClose: () => void;
}

export function FamilySetup({ speakers, onClose }: FamilySetupProps): React.JSX.Element {
  const [name, setName] = useState("");
  const [active, setActive] = useState<EnrolledSpeaker | null>(null);

  const addPerson = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await window.familyHub.assistant.enrollSpeaker(trimmed);
    setName("");
  };

  if (active) {
    const latest = speakers.find((s) => s.id === active.id) ?? active;
    return (
      <div className="family-setup">
        <EnrollmentRecorder
          speakerId={latest.id}
          speakerName={latest.name}
          sampleCount={latest.sampleCount}
          onClose={() => setActive(null)}
        />
      </div>
    );
  }

  return (
    <div className="family-setup">
      <header className="family-setup-header">
        <h2>Family</h2>
        <button type="button" onClick={onClose}>
          Done
        </button>
      </header>

      <div className="family-add">
        <input
          value={name}
          placeholder="Add family member"
          onChange={(event) => setName(event.target.value)}
        />
        <button type="button" onClick={() => void addPerson()} disabled={!name.trim()}>
          + Add
        </button>
      </div>

      <ul className="family-list">
        {speakers.map((speaker) => (
          <li key={speaker.id} className="family-row">
            <span className="family-name">{speaker.name}</span>
            <span className={`family-count ${enrollmentStatus(speaker.sampleCount)}`}>
              {speaker.sampleCount} samples
            </span>
            <button type="button" onClick={() => setActive(speaker)}>
              {speaker.sampleCount > 0 ? "Re-record" : "Enroll"}
            </button>
            <label>
              <input
                type="checkbox"
                checked={speaker.allowed}
                onChange={(event) =>
                  void window.familyHub.assistant.setSpeakerAllowed(
                    speaker.id,
                    event.target.checked,
                  )
                }
              />
              allowed
            </label>
            <button
              type="button"
              onClick={() => void window.familyHub.assistant.deleteSpeaker(speaker.id)}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
