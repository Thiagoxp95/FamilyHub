import { useEffect, useState } from "react";
import { EnrollmentRecorder } from "./EnrollmentRecorder";

const TARGET = 15;

export function memberRowLabel(member: EnrolledMember, target: number): string {
  return member.sampleCount >= target
    ? `${member.name} — ${member.sampleCount}/${target} ✓`
    : `${member.name} — ${member.sampleCount}/${target}`;
}

export function FamilySetupView(props: {
  members: EnrolledMember[];
  target: number;
  nameValue?: string;
  onNameChange?: (name: string) => void;
  onAdd: (name: string) => void;
  onDelete: (id: string) => void;
  onEnroll: (id: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="hub-fullscreen-backdrop family-setup">
      <div className="hub-fullscreen-panel">
        <header className="fullscreen-head">
          <h2>Family voices</h2>
          <button className="hub-fullscreen-close" onClick={props.onClose}>
            Close
          </button>
        </header>
        <ul className="family-list">
          {props.members.map((m) => (
            <li key={m.id}>
              <span>{memberRowLabel(m, props.target)}</span>
              <button onClick={() => props.onEnroll(m.id)}>Record</button>
              <button onClick={() => props.onDelete(m.id)}>Delete</button>
            </li>
          ))}
        </ul>
        <div className="family-add-row">
          <input
            type="text"
            placeholder="Member name"
            value={props.nameValue ?? ""}
            onChange={(e) => props.onNameChange?.(e.target.value)}
          />
          <button
            className="family-add"
            onClick={() => {
              const name = props.nameValue ?? "";
              if (name) props.onAdd(name);
            }}
          >
            Add member
          </button>
        </div>
      </div>
    </div>
  );
}

export function FamilySetup(props: { onClose: () => void }): React.JSX.Element {
  const [members, setMembers] = useState<EnrolledMember[]>([]);
  const [enrolling, setEnrolling] = useState<EnrolledMember | null>(null);
  const [newName, setNewName] = useState("");

  useEffect(() => {
    void window.familyHub.enrollment.listMembers().then(setMembers);
    return window.familyHub.enrollment.onMembers(setMembers);
  }, []);

  if (enrolling) {
    const live = members.find((m) => m.id === enrolling.id) ?? enrolling;
    return (
      <EnrollmentRecorder
        memberId={live.id}
        memberName={live.name}
        target={TARGET}
        kept={live.sampleCount}
        onClose={() => setEnrolling(null)}
      />
    );
  }

  return (
    <FamilySetupView
      members={members}
      target={TARGET}
      nameValue={newName}
      onNameChange={(name) => setNewName(name)}
      onAdd={(name) => {
        void window.familyHub.enrollment.addMember(name).then((updated) => {
          setMembers(updated);
          setNewName("");
        });
      }}
      onDelete={(id) => void window.familyHub.enrollment.deleteMember(id).then(setMembers)}
      onEnroll={(id) => setEnrolling(members.find((m) => m.id === id) ?? null)}
      onClose={props.onClose}
    />
  );
}
