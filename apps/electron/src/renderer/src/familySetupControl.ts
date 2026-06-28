// Pure plan for the side effects when Family Setup opens/closes: who owns the mic.
// Opening hands the mic to the enrollment recorder (stop wake + tear down capture);
// closing returns it (resume wake + rebuild capture).
export function familySetupTransition(open: boolean): { listening: "stop" | "start"; bumpCapture: boolean } {
  return { listening: open ? "stop" : "start", bumpCapture: true };
}
