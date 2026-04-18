// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import type { Session } from "./onboard-session";

export type ResumeConflictField =
  | "sandbox"
  | "provider"
  | "model"
  | "fromDockerfile"
  | "agent";

export interface ResumeSandboxConflict {
  requestedSandboxName: string;
  recordedSandboxName: string;
}

export interface ResumeConfigConflict {
  field: ResumeConflictField;
  requested: string | null;
  recorded: string | null;
}

export interface ResumeConfigConflictOptions {
  requestedSandboxName?: string | null;
  requestedProvider?: string | null;
  requestedModel?: string | null;
  requestedFromDockerfile?: string | null;
  requestedAgent?: string | null;
}

export function detectResumeSandboxConflict(
  session: Pick<Session, "sandboxName"> | null | undefined,
  requestedSandboxName: string | null,
): ResumeSandboxConflict | null {
  if (!requestedSandboxName || !session?.sandboxName) {
    return null;
  }
  return requestedSandboxName !== session.sandboxName
    ? { requestedSandboxName, recordedSandboxName: session.sandboxName }
    : null;
}

export function collectResumeConfigConflicts(
  session: Session | null | undefined,
  options: ResumeConfigConflictOptions = {},
): ResumeConfigConflict[] {
  const conflicts: ResumeConfigConflict[] = [];

  const sandboxConflict = detectResumeSandboxConflict(session, options.requestedSandboxName ?? null);
  if (sandboxConflict) {
    conflicts.push({
      field: "sandbox",
      requested: sandboxConflict.requestedSandboxName,
      recorded: sandboxConflict.recordedSandboxName,
    });
  }

  if (options.requestedProvider && session?.provider && options.requestedProvider !== session.provider) {
    conflicts.push({
      field: "provider",
      requested: options.requestedProvider,
      recorded: session.provider,
    });
  }

  if (options.requestedModel && session?.model && options.requestedModel !== session.model) {
    conflicts.push({
      field: "model",
      requested: options.requestedModel,
      recorded: session.model,
    });
  }

  const requestedFrom = options.requestedFromDockerfile
    ? path.resolve(options.requestedFromDockerfile)
    : null;
  const recordedFrom = session?.metadata?.fromDockerfile
    ? path.resolve(session.metadata.fromDockerfile)
    : null;
  if (requestedFrom !== recordedFrom) {
    conflicts.push({
      field: "fromDockerfile",
      requested: requestedFrom,
      recorded: recordedFrom,
    });
  }

  const requestedAgent = options.requestedAgent ?? null;
  const recordedAgent = session?.agent ?? null;
  if (requestedAgent && recordedAgent && requestedAgent !== recordedAgent) {
    conflicts.push({
      field: "agent",
      requested: requestedAgent,
      recorded: recordedAgent,
    });
  }

  return conflicts;
}

function formatResumeConflictLine(conflict: ResumeConfigConflict): string {
  if (conflict.field === "sandbox") {
    return `  Resumable state belongs to sandbox '${conflict.recorded}', not '${conflict.requested}'.`;
  }
  if (conflict.field === "agent") {
    return `  Session was started with agent '${conflict.recorded}', not '${conflict.requested}'.`;
  }
  if (conflict.field === "fromDockerfile") {
    if (!conflict.recorded) {
      return "  Session was started without --from; rerun without --from to resume it.";
    }
    if (!conflict.requested) {
      return `  Session was started with --from '${conflict.recorded}'; rerun with that path to resume it.`;
    }
    return `  Session was started with --from '${conflict.recorded}', not '${conflict.requested}'.`;
  }
  return `  Resumable state recorded ${conflict.field} '${conflict.recorded}', not '${conflict.requested}'.`;
}

export function buildResumeConflictLines(conflicts: readonly ResumeConfigConflict[]): string[] {
  if (conflicts.length === 0) {
    return [];
  }
  return [
    ...conflicts.map(formatResumeConflictLine),
    "  Run: nemoclaw onboard              # start a fresh onboarding session",
    "  Or rerun with the original settings to continue that session.",
  ];
}
