export const ENROLLMENT_TARGET = 15;

export type EnrollmentStatus = "none" | "under" | "complete";

export function enrollmentStatus(
  sampleCount: number,
  target: number = ENROLLMENT_TARGET,
): EnrollmentStatus {
  if (sampleCount <= 0) return "none";
  if (sampleCount < target) return "under";
  return "complete";
}
