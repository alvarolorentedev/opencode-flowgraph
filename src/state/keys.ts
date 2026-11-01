import { safeSegment } from "../util/ids.js"

const ROOT = "v1"

export const StorageKeys = {
  runsPrefix(projectID: string): string {
    return `${ROOT}/runs/${safeSegment(projectID)}/`
  },
  run(projectID: string, runID: string): string {
    return `${this.runsPrefix(projectID)}${runID}`
  },
  stepsPrefix(projectID: string, runID: string): string {
    return `${ROOT}/steps/${safeSegment(projectID)}/${runID}/`
  },
  step(projectID: string, runID: string, stepID: string): string {
    return `${this.stepsPrefix(projectID, runID)}${stepID}`
  },
  reportsPrefix(projectID: string, runID: string): string {
    return `${ROOT}/reports/${safeSegment(projectID)}/${runID}/`
  },
  report(projectID: string, runID: string, stepID: string): string {
    return `${this.reportsPrefix(projectID, runID)}${stepID}`
  },
  source(projectID: string, runID: string): string {
    return `${ROOT}/run-sources/${safeSegment(projectID)}/${runID}`
  },
  backup(projectID: string, workflowID: string, hash: string): string {
    return `${ROOT}/workflow-backups/${safeSegment(projectID)}/${workflowID}/${hash}`
  },
  backupPrefix(projectID: string, workflowID: string): string {
    return `${ROOT}/workflow-backups/${safeSegment(projectID)}/${workflowID}/`
  },
  idem(projectID: string, requestHash: string): string {
    return `${ROOT}/idem/${safeSegment(projectID)}/${requestHash}`
  },
  lease(projectID: string): string {
    return `${ROOT}/leases/${safeSegment(projectID)}`
  },
}
