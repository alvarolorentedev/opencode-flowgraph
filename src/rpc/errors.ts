import { WorkflowFileError } from "../workflow/loader.js"
import { StateCorruptionError, RevisionConflictError } from "../state/store.js"
import { ProjectBusyError, RunOwnershipError } from "../state/concurrency.js"
import {
  AmbiguousResumeError,
  NotResumableError,
  PermissionPendingError,
  RunNotFoundError,
} from "../execution/runner.js"
import {
  IdempotencyConflictError,
  InvalidStateError,
  InvalidWorkflowError,
  StaleWorkflowError,
  TooManyRunsError,
  WorkflowNotFoundError,
} from "../service.js"
import { errorMessage } from "../util/redact.js"

export type ErrorContext = {
  error(type: string, message: string, data?: unknown): unknown
}

export function toRpcError(context: ErrorContext, error: unknown): unknown {
  if (error instanceof WorkflowNotFoundError) {
    return context.error("not_found", error.message, { workflowID: error.workflowID })
  }
  if (error instanceof RunNotFoundError) {
    return context.error("not_found", error.message, { runID: error.runID })
  }
  if (error instanceof InvalidWorkflowError) {
    return context.error("invalid_workflow", error.message, { diagnostics: error.diagnostics })
  }
  if (error instanceof StaleWorkflowError) {
    return context.error("stale_revision", error.message, { message: error.message })
  }
  if (error instanceof WorkflowFileError) {
    const type =
      error.code === "unsafe_path"
        ? "unsafe_path"
        : error.code === "stale_revision"
          ? "stale_revision"
          : error.code === "not_found"
            ? "not_found"
            : error.code === "invalid_workflow" || error.code === "invalid_workflow_id"
              ? "invalid_workflow"
              : "invalid_state"
    return context.error(type, error.message, {
      message: error.message,
      ...(error.diagnostics.length === 0 ? {} : { diagnostics: error.diagnostics }),
    })
  }
  if (error instanceof RevisionConflictError) {
    return context.error("stale_revision", error.message, {
      message: error.message,
      currentRevision: error.currentRevision,
    })
  }
  if (error instanceof RunOwnershipError) {
    return context.error("not_owner", error.message, { message: error.message })
  }
  if (error instanceof ProjectBusyError) {
    return context.error("project_busy", error.message, { message: error.message })
  }
  if (error instanceof IdempotencyConflictError) {
    return context.error("idempotency_conflict", error.message, { message: error.message })
  }
  if (error instanceof TooManyRunsError) {
    return context.error("too_many_runs", error.message, { message: error.message })
  }
  if (error instanceof PermissionPendingError) {
    return context.error("permission_pending", error.message, {
      message: error.message,
      permissions: error.permissions,
    })
  }
  if (error instanceof AmbiguousResumeError) {
    return context.error("ambiguous_requires_confirmation", error.message, { message: error.message })
  }
  if (error instanceof NotResumableError) {
    return context.error("not_resumable", error.message, { message: error.message })
  }
  if (error instanceof InvalidStateError || error instanceof StateCorruptionError) {
    return context.error("invalid_state", error.message, { message: error.message })
  }
  return context.error("unavailable", errorMessage(error, "workflow operation failed"), {
    message: errorMessage(error, "workflow operation failed"),
  })
}
