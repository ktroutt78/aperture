/**
 * Phase 3 service error hierarchy. Follows the Phase 2 pattern
 * (MetadataServiceError / VizqlServiceError / PulseServiceError): named class,
 * optional `cause`, no side effects in the constructor.
 */
import type { ErrorCode } from '../types/copilot.js';

export class ContextAssemblerError extends Error {
  override readonly cause?: unknown;
  readonly failedLuids: readonly string[];
  constructor(message: string, failedLuids: readonly string[] = [], cause?: unknown) {
    super(message);
    this.name = 'ContextAssemblerError';
    this.failedLuids = failedLuids;
    this.cause = cause;
  }
}

export class ClaudeServiceError extends Error {
  override readonly cause?: unknown;
  readonly code: ErrorCode;
  constructor(message: string, code: ErrorCode, cause?: unknown) {
    super(message);
    this.name = 'ClaudeServiceError';
    this.code = code;
    this.cause = cause;
  }
}
