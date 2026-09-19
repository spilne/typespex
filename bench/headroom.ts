import { summarize, type DistributionSummary } from "./benchmark-common.js";

interface Cell {
  readonly trial: number;
  readonly serverId: string;
  readonly scenarioId: string;
}

interface Rate extends Cell {
  readonly requestsPerSecond: number;
}

export interface HeadroomAssessment {
  readonly scenarioId: string;
  readonly verified: boolean;
  readonly requiredRatio: number;
  readonly ratioToFastest: DistributionSummary | null;
  readonly trials: readonly { trial: number; ratio: number }[];
}

// This is a conservative measurement eligibility threshold, not a claim about
// the client's absolute ceiling or a statistical significance test for a gap.
const REQUIRED_RATIO = 1.25;

export function headroomReport(assessments: readonly HeadroomAssessment[]): string {
  const verified = assessments.length > 0 && assessments.every((row) => row.verified);
  const rows = assessments.map(
    (row) =>
      `| ${row.scenarioId} | ${row.ratioToFastest?.min.toFixed(3) ?? "n/a"} | ${row.verified ? "Verified" : "UNVERIFIED — ratios withheld"} |`,
  );
  return [
    "## HTTP benchmark headroom",
    "",
    verified
      ? "All scenarios passed the observed headroom check."
      : "**Warning: headroom was not demonstrated for every scenario. Do not use unverified measurements for framework comparisons.**",
    "",
    "| Scenario | Minimum control / fastest implementation | Headroom |",
    "| --- | ---: | --- |",
    ...rows,
    "",
    "Requires at least 1.25× in every trial. This sequential calibration does not establish statistical significance or exclude shared-machine contention. See the raw JSON artifact for rates, variability, and sampled-body validation counts.",
    "",
  ].join("\n");
}

export function assessHeadroom(
  samples: readonly Rate[],
  schedule: readonly Cell[],
): readonly HeadroomAssessment[] {
  return [...new Set(schedule.map((cell) => cell.scenarioId))].map((scenarioId) => {
    const expected = schedule.filter((cell) => cell.scenarioId === scenarioId);
    const trialIds = [...new Set(expected.map((cell) => cell.trial))];
    const trials: { trial: number; ratio: number }[] = [];
    for (const trial of trialIds) {
      const cells = expected.filter((cell) => cell.trial === trial);
      const measured = samples.filter(
        (sample) => sample.scenarioId === scenarioId && sample.trial === trial,
      );
      if (
        measured.length !== cells.length ||
        cells.some(
          (cell) => measured.filter((sample) => sample.serverId === cell.serverId).length !== 1,
        ) ||
        measured.some(
          (sample) => !Number.isFinite(sample.requestsPerSecond) || sample.requestsPerSecond <= 0,
        )
      )
        continue;
      const control = measured.find((sample) => sample.serverId === "calibration");
      const implementations = measured.filter((sample) => sample.serverId !== "calibration");
      if (!control || implementations.length === 0) continue;
      trials.push({
        trial,
        ratio:
          control.requestsPerSecond /
          Math.max(...implementations.map((sample) => sample.requestsPerSecond)),
      });
    }
    const ratioToFastest =
      trials.length === 0 ? null : summarize(trials.map((trial) => trial.ratio));
    return {
      scenarioId,
      verified:
        trials.length === trialIds.length &&
        ratioToFastest !== null &&
        ratioToFastest.min >= REQUIRED_RATIO,
      requiredRatio: REQUIRED_RATIO,
      ratioToFastest,
      trials,
    };
  });
}
