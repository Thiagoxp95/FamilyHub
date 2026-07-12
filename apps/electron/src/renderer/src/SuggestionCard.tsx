export interface ActiveCard {
  id: number;
  kind: string;
  text: string;
}

// Suggestion kinds the assistant can act on directly (writes a reminder,
// calendar event, or shopping-list item). Everything else — "question",
// "other", and any future kind — is informational only: there's nothing to
// accept, so the card nudges the family to invoke the wake word instead.
const ACTIONABLE_KINDS = new Set(["reminder", "calendar", "shopping"]);

export function SuggestionCard(props: {
  card: ActiveCard;
  onAccept: (id: number) => void;
  onDismiss: (id: number) => void;
}): React.JSX.Element {
  const { card, onAccept, onDismiss } = props;
  const canAccept = ACTIONABLE_KINDS.has(card.kind);

  return (
    <div className="ambient-suggestion" role="status">
      <p className="ambient-suggestion__text">{card.text}</p>
      {canAccept ? null : (
        <p className="ambient-suggestion__hint">Say “Hey James” to ask</p>
      )}
      <div className="ambient-suggestion__actions">
        {canAccept ? (
          <button
            className="ambient-suggestion__accept"
            onClick={() => onAccept(card.id)}
            type="button"
          >
            Accept
          </button>
        ) : null}
        <button
          className="ambient-suggestion__dismiss secondary-button"
          onClick={() => onDismiss(card.id)}
          type="button"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
