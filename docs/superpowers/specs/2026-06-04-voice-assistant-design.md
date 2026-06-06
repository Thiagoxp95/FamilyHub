# Google Diarization Session-Locked Voice Assistant Design

## Goal

Build a desktop home-assistant workflow in FamilyHub that behaves like a small household assistant and only responds to the Google Speech-to-Text diarization speaker label locked for the active session. The assistant uses Gemini Live for responses and Google Cloud Speech-to-Text diarization to split multi-speaker audio into anonymous, session-scoped speaker labels.

## Non-Goals

- Do not treat Google Speech-to-Text diarization as persistent identity. Diarization labels anonymous speakers within a stream, such as speaker 1 and speaker 2; it does not prove that speaker 1 is Max across app restarts.
- Do not implement smart-home device control in this first slice.
- Do not build a cloud backend yet. The MVP runs inside the Electron app and uses vendor APIs directly from local app code where acceptable for a local desktop app.
- Do not treat voice recognition as high-security authentication. The feature is a household convenience and personalization gate.

## Product Behavior

FamilyHub starts with an assistant dashboard instead of the placeholder setup screen. The dashboard shows microphone state, Gemini connection state, enrolled household members, the locked Google speaker label, and the last ignored/accepted utterance.

Enrollment stores household member names only. During each listening session, the user locks one household member to a Google diarization label such as `speakerLabel: "1"`. That label is valid only for the active session.

During listening, Google Speech-to-Text receives audio with diarization enabled and returns transcript words tagged with anonymous speaker labels. FamilyHub groups transcript words into turns and only sends turns whose `speakerLabel` matches the locked session label to Gemini Live.

If a turn's speaker label does not match the locked label, FamilyHub marks the utterance as ignored and does not invoke Gemini. If the speaker label matches, FamilyHub forwards the verified transcript text to Gemini Live and displays Gemini's response.

## Architecture

### Renderer

The React renderer owns the user interface:

- enrollment form and recording status
- household member list
- listen/stop controls
- live state display for microphone, verification, transcript, and assistant response

The renderer requests microphone access through browser media APIs and sends audio frames through the preload bridge. It does not store vendor API secrets directly in React state.

### Preload Bridge

The preload bridge exposes a narrow `window.familyHub.assistant` API:

- `getConfigStatus()`
- `listSpeakers()`
- `enrollSpeaker(name)`
- `lockSessionSpeaker(speakerId, speakerLabel)`
- `deleteSpeaker(id)`
- `setSpeakerAllowed(id, allowed)`
- `startListening()`
- `appendLiveAudio(frame)`
- `stopListening()`
- event subscription for assistant state updates

The bridge keeps context isolation enabled and validates payload shapes before forwarding IPC calls.

### Main Process

The Electron main process owns long-lived assistant services:

- local household member storage
- Google Speech-to-Text streaming request lifecycle with diarization enabled
- Gemini Live WebSocket lifecycle
- session speaker-label gate and state machine

Main process code is split into focused modules rather than adding all behavior to `src/main/index.ts`.

### Local Storage

Household members are stored under Electron's user data directory:

```text
speaker-profiles/
  speakers.json
```

`speakers.json` stores stable metadata: id, display name, allowed flag, and created timestamp. No voiceprint files are stored.

## Data Flow

1. Renderer captures microphone PCM frames.
2. Main process streams frames to Google Speech-to-Text with diarization enabled.
3. Google returns transcript words with speaker labels.
4. Main process groups words into a user turn based on timing, silence, and speaker-label changes.
5. Main process compares the turn label with the locked session label.
6. If the label matches, the verified transcript text is sent to Gemini Live.
7. Gemini Live streams or returns the assistant response for display.
8. Rejected turns are logged in transient UI state as ignored.

## Vendor Responsibilities

Google Speech-to-Text:

- streaming transcription
- speaker diarization for anonymous speaker turn labeling
- word timing and speaker labels

Gemini Live:

- realtime conversational reasoning
- spoken assistant responses
- future tool use for home actions

## Configuration

The MVP reads required secrets from environment variables:

- `GOOGLE_APPLICATION_CREDENTIALS` or equivalent Google ADC setup for Speech-to-Text
- `GEMINI_API_KEY` for Gemini Live
The UI displays missing configuration as setup-required state and disables enrollment/listening until the required credentials are present.

## Error Handling

- Microphone denied: show a blocked microphone state and keep setup usable.
- Missing credentials: show which provider is not configured.
- No enrolled speakers: disable listening and guide the user to enroll someone.
- No locked speaker label: ignore the turn and prompt the user to lock the session speaker.
- Speaker label mismatch: ignore the turn and show which label was rejected.
- Google STT disconnect: stop listening and show reconnect action.
- Gemini Live disconnect: stop assistant response playback, preserve transcript state, and show reconnect action.

## Testing

Use test-driven development for pure app logic first:

- household member metadata storage
- assistant state reducer
- session speaker-label gate
- transcript word grouping into speaker turns
- gating behavior that forwards only accepted turns

Vendor SDK integration will be wrapped behind interfaces so tests can use deterministic fake adapters. Manual verification will cover microphone permission, enrollment, live listening, ignored speaker behavior, and Gemini response playback.

## MVP Acceptance Criteria

- A user can add at least two named household members.
- The app persists household members across restarts.
- A turn before a session speaker label is locked does not trigger Gemini.
- A turn from a different speaker label does not trigger Gemini.
- A turn from the locked session speaker label triggers Gemini.
- The UI clearly shows whether an utterance was accepted or ignored.
- `npm run typecheck` and `npm run lint` pass.

## Open Decisions

- The first implementation sends verified transcript text into Gemini Live and uses Gemini's streamed audio response. This avoids forwarding raw unverified household audio to Gemini while preserving Gemini Live as the response engine.
- Wake word detection is deferred. The MVP uses an explicit listen button to keep scope small and testable.

## Source Notes

- Google Cloud Speech-to-Text diarization labels distinct voices by anonymous speaker number and supports streaming recognition. These labels are session-scoped and not persistent identity.
- Gemini Live supports low-latency real-time voice interactions over WebSocket with raw PCM audio input and output.
