import { PulsingBorder } from "@paper-design/shaders-react";

// Full-screen neon rim that says "James is awake" at a glance. Rendered ONLY
// while the assistant has been triggered — from the wake firing ("connecting")
// through the live conversation. While the app merely waits for the wake word
// there is no rim at all.
//
// The shader fills its canvas with colorBack; fully transparent ("#00000000")
// leaves only the glow, which composites cleanly over this app's light theme
// (a screen/multiply blend would not). pointer-events stays none on the
// wrapper so the overlay never eats taps.

export type ListeningBorderMode = "connecting" | "live";

// One knob-set per session state: connecting is a softer ramp-up, live is the
// full glow so the border itself communicates the mode.
const modeKnobs: Record<
  ListeningBorderMode,
  { intensity: number; speed: number; bloom: number; pulse: number }
> = {
  connecting: { intensity: 0.5, speed: 1.6, bloom: 0.4, pulse: 0.45 },
  live: { intensity: 0.8, speed: 2.2, bloom: 0.6, pulse: 0.6 },
};

export function ListeningBorder({
  mode,
}: {
  mode: ListeningBorderMode;
}): React.JSX.Element {
  const knobs = modeKnobs[mode];

  return (
    <div className="listening-border" aria-hidden="true">
      <PulsingBorder
        fit="contain"
        scale={1}
        rotation={0}
        offsetX={0}
        offsetY={0}
        originX={0.5}
        originY={0.5}
        speed={knobs.speed}
        colorBack="#00000000"
        colors={["#0dc1fd", "#d915ef", "#ff3f2ecc"]}
        roundness={0.05}
        thickness={0.02}
        margin={0}
        marginLeft={0}
        marginRight={0}
        marginTop={0}
        marginBottom={0}
        aspectRatio="auto"
        softness={0.75}
        intensity={knobs.intensity}
        bloom={knobs.bloom}
        spots={5}
        spotSize={0.5}
        pulse={knobs.pulse}
        smoke={0.3}
        smokeSize={0.6}
        style={{ width: "100%", height: "100%" }}
      />
    </div>
  );
}
