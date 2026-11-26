import { getAdapter } from "./adapters/index.ts";
import { detectPermissionRequest } from "./permissions.ts";
import type { DetectedPermissionRequest } from "./permissions.ts";
import { buildPromptWithContext, createMessageId } from "./session.ts";
import { buildSkillsPromptBlock, prependSkillsToPrompt } from "./skills.ts";
import type { SkillInfo } from "./skills.ts";
import { formatTargetLabel } from "./types.ts";
import type {
  AgentId,
  AgentRunResult,
  AgentTarget,
  ChatMessage,
  McliConfig,
  PermissionMode,
  StreamEvent,
} from "./types.ts";

export type PermissionApprovalDecision = "once" | "session" | "full" | "decline";

export interface DiscussionParticipantOutput {
  target: AgentTarget;
  label: string;
  round: number;
  roundLabel: string;
  result: AgentRunResult;
}

export interface RunDiscussionOptions {
  targets: AgentTarget[];
  userPrompt: string;
  history: ChatMessage[];
  sessionSummary?: string;
  summarizedUpTo?: number;
  transcriptPath?: string;
  skills?: SkillInfo[];
  allowedDirs?: string[];
  cwd: string;
  config: McliConfig;
  rounds: number;
  synthesize: boolean;
  signal: AbortSignal;
  /** Runs participants in parallel within each round (default true; set false for sequential terminal stdout). */
  parallel?: boolean;
  onRoundStart?: (info: {
    round: number;
    totalRounds: number;
    phase: "independent" | "discussion" | "synthesis";
    roundLabel: string;
    participants: AgentTarget[];
  }) => void;
  onParticipantStart?: (info: {
    index: number;
    target: AgentTarget;
    roundLabel: string;
    isRetry?: boolean;
  }) => void;
  onParticipantEvent?: (info: {
    index: number;
    target: AgentTarget;
    roundLabel: string;
    event: StreamEvent;
  }) => void;
  onParticipantDone?: (info: {
    index: number;
    target: AgentTarget;
    roundLabel: string;
    result: AgentRunResult;
  }) => void;
  onPermissionRequest?: (info: {
    index: number;
    target: AgentTarget;
    participantLabel: string;
    roundLabel: string;
    request: DetectedPermissionRequest;
  }) => Promise<PermissionApprovalDecision>;
}

export interface DiscussionRunResult {
  messages: ChatMessage[];
  sessionIds: Partial<Record<AgentId, string>>;
  hadError: boolean;
  aborted: boolean;
}

function buildTranscriptBlock(entries: DiscussionParticipantOutput[], maxChars = 18000): string {
  const parts: string[] = [];
  let remaining = maxChars;

  for (const entry of entries) {
    const body = entry.result.text.trim();
    if (!body) continue;
    const block = `### ${entry.label} [${entry.roundLabel}]\n${body}`;
    if (block.length > remaining) {
      if (remaining > 300) {
        parts.push(block.slice(0, remaining - 20) + "\n...[truncated]");
      }
      break;
    }
    parts.push(block);
    remaining -= block.length + 2;
  }

  return parts.join("\n\n");
}

function buildDiscussionPrompt(opts: {
  basePromptWithHistory: string;
  userPrompt: string;
  selfLabel: string;
  peerLabels: string[];
  round: number;
  totalRounds: number;
  priorEntries: DiscussionParticipantOutput[];
}): string {
  const transcript = buildTranscriptBlock(opts.priorEntries);
  return [
    opts.basePromptWithHistory,
    "",
    `<agent_discussion round="${opts.round}" total_rounds="${opts.totalRounds}">`,
    `You are participating as ${opts.selfLabel} in a multi-agent discussion with: ${opts.peerLabels.join(", ")}.`,
    `Original task: ${opts.userPrompt}`,
    "",
    `Previous round responses from the participating agents:`,
    "",
    transcript,
    `</agent_discussion>`,
    "",
    `Instructions for Round ${opts.round}/${opts.totalRounds} (Agent Discussion):`,
    `1. Carefully evaluate the other agents' findings above.`,
    `2. Explicitly note what you agree with, challenge any mistakes, gaps, or unsupported claims, and update your own position where a peer made a stronger point.`,
    `3. Provide your refined, sharper analysis for the user's task.`,
  ].join("\n");
}

function buildSynthesisPrompt(opts: {
  basePromptWithHistory: string;
  userPrompt: string;
  participantLabels: string[];
  allEntries: DiscussionParticipantOutput[];
}): string {
  const transcript = buildTranscriptBlock(opts.allEntries, 24000);
  return [
    opts.basePromptWithHistory,
    "",
    `<agent_discussion_transcript>`,
    `Participants: ${opts.participantLabels.join(", ")}`,
    `Original task: ${opts.userPrompt}`,
    "",
    transcript,
    `</agent_discussion_transcript>`,
    "",
    `Instructions for Final Synthesis:`,
    `Synthesize the multi-agent discussion above into a clear, decisive final response with:`,
    `1. **Consensus & Key Findings** — what the models converged on`,
    `2. **Disagreements / Open Questions** — where models differed and why`,
    `3. **Final Recommendation / Answer** — the strongest consolidated answer`,
  ].join("\n");
}

export async function runAgentDiscussion(
  opts: RunDiscussionOptions,
): Promise<DiscussionRunResult> {
  const totalRounds = Math.max(1, Math.min(6, Math.floor(opts.rounds)));
  const parallel = opts.parallel !== false;
  const messages: ChatMessage[] = [];
  const sessionIds: Partial<Record<AgentId, string>> = {};
  const allEntries: DiscussionParticipantOutput[] = [];
  let hadError = false;

  const participantLabels = opts.targets.map((t) => formatTargetLabel(t));
  const activeSkills = opts.skills ?? [];
  const skillsPromptBlock = buildSkillsPromptBlock(activeSkills);
  const sessionAllowedDirs: string[] = Array.from(
    new Set([...(opts.config.allowedDirs ?? []), ...(opts.allowedDirs ?? [])]),
  );
  let sessionPerm: PermissionMode = opts.config.permissionMode;

  const mergeDirs = (base: string[], extra: string[]): string[] =>
    Array.from(new Set([...base, ...extra]));

  const runParticipant = async (
    target: AgentTarget,
    index: number,
    roundLabel: string,
    prompt: string,
    rawUserPrompt: string,
    overrides?: { allowedDirs?: string[]; permissionMode?: PermissionMode; isRetry?: boolean },
  ): Promise<AgentRunResult> => {
    const adapter = getAdapter(target.agent);
    const agentConfig = opts.config.agents[target.agent] ?? {};

    opts.onParticipantStart?.({ index, target, roundLabel, isRetry: overrides?.isRetry });

    const res = await adapter.run({
      prompt: prependSkillsToPrompt(prompt, activeSkills),
      rawUserPrompt,
      history: opts.history,
      sessionSummary: opts.sessionSummary,
      summarizedUpTo: opts.summarizedUpTo,
      transcriptPath: opts.transcriptPath,
      skillsPromptBlock,
      cwd: opts.cwd,
      model: target.model,
      permissionMode: overrides?.permissionMode ?? sessionPerm,
      allowedDirs: overrides?.allowedDirs ?? sessionAllowedDirs,
      config: agentConfig,
      signal: opts.signal,
      onEvent: (event) => {
        opts.onParticipantEvent?.({ index, target, roundLabel, event });
      },
    });

    if (res.sessionId) {
      sessionIds[target.agent] = res.sessionId;
    }

    opts.onParticipantDone?.({ index, target, roundLabel, result: res });
    return res;
  };

  for (let round = 1; round <= totalRounds; round++) {
    if (opts.signal.aborted) break;

    const phase = round === 1 ? "independent" : "discussion";
    const roundLabel =
      totalRounds === 1
        ? "Parallel"
        : round === 1
          ? `Round 1/${totalRounds} · Analysis`
          : `Round ${round}/${totalRounds} · Discussion`;

    opts.onRoundStart?.({
      round,
      totalRounds,
      phase,
      roundLabel,
      participants: opts.targets,
    });

    const priorSnapshot = [...allEntries];
    const roundInitialAllowedDirs = [...sessionAllowedDirs];
    const roundInitialPerm = sessionPerm;

    const buildPromptsForTarget = (target: AgentTarget, idx: number) => {
      const baseWithCtx = buildPromptWithContext({
        userPrompt: opts.userPrompt,
        history: opts.history,
        targetAgent: target.agent,
        config: opts.config,
        sessionSummary: opts.sessionSummary,
        summarizedUpTo: opts.summarizedUpTo,
        transcriptPath: opts.transcriptPath,
      });

      const selfLabel = formatTargetLabel(target);
      const peerLabels = participantLabels.filter((_, i) => i !== idx);

      const prompt =
        round === 1
          ? baseWithCtx
          : buildDiscussionPrompt({
              basePromptWithHistory: baseWithCtx,
              userPrompt: opts.userPrompt,
              selfLabel,
              peerLabels,
              round,
              totalRounds,
              priorEntries: priorSnapshot,
            });

      const rawForApi =
        round === 1
          ? opts.userPrompt
          : buildDiscussionPrompt({
              basePromptWithHistory: "",
              userPrompt: opts.userPrompt,
              selfLabel,
              peerLabels,
              round,
              totalRounds,
              priorEntries: priorSnapshot,
            }).trim();

      return { selfLabel, prompt, rawForApi };
    };

    const runOne = async (
      target: AgentTarget,
      idx: number,
    ): Promise<{
      entry: DiscussionParticipantOutput;
      prompt: string;
      rawForApi: string;
    }> => {
      const { selfLabel, prompt, rawForApi } = buildPromptsForTarget(target, idx);
      const result = await runParticipant(target, idx, roundLabel, prompt, rawForApi);
      return {
        entry: { target, label: selfLabel, round, roundLabel, result },
        prompt,
        rawForApi,
      };
    };

    let roundRuns: Array<{
      entry: DiscussionParticipantOutput;
      prompt: string;
      rawForApi: string;
    }>;
    if (parallel) {
      roundRuns = await Promise.all(opts.targets.map((t, idx) => runOne(t, idx)));
    } else {
      roundRuns = [];
      for (let idx = 0; idx < opts.targets.length; idx++) {
        if (opts.signal.aborted) break;
        roundRuns.push(await runOne(opts.targets[idx], idx));
      }
    }

    // Mid-discussion permission approval: if any participant was blocked on an external dir or shell perm,
    // pause BEFORE advancing to the next round, ask the user, and immediately retry that participant if approved.
    if (opts.onPermissionRequest && !opts.signal.aborted) {
      for (let idx = 0; idx < roundRuns.length; idx++) {
        if (opts.signal.aborted) break;
        const runItem = roundRuns[idx];
        if (runItem.entry.result.aborted) continue;

        const detected = detectPermissionRequest({
          text: runItem.entry.result.text,
          error: runItem.entry.result.error,
          cwd: opts.cwd,
          alreadyAllowedDirs: roundInitialAllowedDirs,
          currentPerm: roundInitialPerm,
        });
        if (!detected) continue;

        // If an earlier participant in this same round already got session-wide approval covering this exact request,
        // retry automatically without prompting the user a second time.
        const alreadySatisfiedBySession =
          detected.requestedDirs.every((d) => sessionAllowedDirs.includes(d)) &&
          (!detected.needsFullPerm || sessionPerm === "full");

        let decision: PermissionApprovalDecision;
        if (alreadySatisfiedBySession) {
          decision = "session";
        } else {
          decision = await opts.onPermissionRequest({
            index: idx,
            target: runItem.entry.target,
            participantLabel: runItem.entry.label,
            roundLabel: runItem.entry.roundLabel,
            request: detected,
          });
        }

        if (opts.signal.aborted || decision === "decline") continue;

        const retryDirs = mergeDirs(sessionAllowedDirs, detected.requestedDirs);
        const retryPerm: PermissionMode =
          decision === "full" || detected.needsFullPerm ? "full" : sessionPerm;

        if (decision === "session" || decision === "full") {
          for (const d of detected.requestedDirs) {
            if (!sessionAllowedDirs.includes(d)) sessionAllowedDirs.push(d);
          }
          if (decision === "full" || detected.needsFullPerm) {
            sessionPerm = "full";
          }
        }

        const retryRes = await runParticipant(
          runItem.entry.target,
          idx,
          runItem.entry.roundLabel,
          runItem.prompt,
          runItem.rawForApi,
          { allowedDirs: retryDirs, permissionMode: retryPerm, isRetry: true },
        );
        runItem.entry = { ...runItem.entry, result: retryRes };
      }
    }

    for (const { entry } of roundRuns) {
      if (entry.result.error) hadError = true;
      allEntries.push(entry);
      const agentConfig = opts.config.agents[entry.target.agent] ?? {};
      messages.push({
        id: createMessageId(),
        role: "assistant",
        agent: entry.target.agent,
        model: entry.target.model ?? agentConfig.model,
        roundLabel: entry.roundLabel,
        content: entry.result.text,
        reasoning: entry.result.reasoning || undefined,
        tools: entry.result.tools.length > 0 ? entry.result.tools : undefined,
        timestamp: new Date().toISOString(),
        durationMs: entry.result.durationMs,
        error: entry.result.error,
        aborted: entry.result.aborted,
      });
    }
  }

  // Final Synthesis step when discussion ran >= 2 rounds and wasn't aborted
  const successfulOutputs = allEntries.filter((e) => e.result.text.trim().length > 0);
  if (
    opts.synthesize &&
    totalRounds >= 2 &&
    !opts.signal.aborted &&
    successfulOutputs.length >= 2
  ) {
    const synthTarget = opts.targets[0];
    const roundLabel = "Final Synthesis";
    opts.onRoundStart?.({
      round: totalRounds + 1,
      totalRounds,
      phase: "synthesis",
      roundLabel,
      participants: [synthTarget],
    });

    const baseWithCtx = buildPromptWithContext({
      userPrompt: opts.userPrompt,
      history: opts.history,
      targetAgent: synthTarget.agent,
      config: opts.config,
      sessionSummary: opts.sessionSummary,
      summarizedUpTo: opts.summarizedUpTo,
      transcriptPath: opts.transcriptPath,
    });

    const synthPrompt = buildSynthesisPrompt({
      basePromptWithHistory: baseWithCtx,
      userPrompt: opts.userPrompt,
      participantLabels,
      allEntries,
    });
    const synthRaw = buildSynthesisPrompt({
      basePromptWithHistory: "",
      userPrompt: opts.userPrompt,
      participantLabels,
      allEntries,
    }).trim();

    let synthRes = await runParticipant(synthTarget, 0, roundLabel, synthPrompt, synthRaw);

    if (opts.onPermissionRequest && !opts.signal.aborted && !synthRes.aborted) {
      const detected = detectPermissionRequest({
        text: synthRes.text,
        error: synthRes.error,
        cwd: opts.cwd,
        alreadyAllowedDirs: sessionAllowedDirs,
        currentPerm: sessionPerm,
      });
      if (detected) {
        const decision = await opts.onPermissionRequest({
          index: 0,
          target: synthTarget,
          participantLabel: formatTargetLabel(synthTarget),
          roundLabel,
          request: detected,
        });
        if (!opts.signal.aborted && decision !== "decline") {
          const retryDirs = mergeDirs(sessionAllowedDirs, detected.requestedDirs);
          const retryPerm: PermissionMode =
            decision === "full" || detected.needsFullPerm ? "full" : sessionPerm;
          if (decision === "session" || decision === "full") {
            for (const d of detected.requestedDirs) {
              if (!sessionAllowedDirs.includes(d)) sessionAllowedDirs.push(d);
            }
            if (decision === "full" || detected.needsFullPerm) sessionPerm = "full";
          }
          synthRes = await runParticipant(synthTarget, 0, roundLabel, synthPrompt, synthRaw, {
            allowedDirs: retryDirs,
            permissionMode: retryPerm,
            isRetry: true,
          });
        }
      }
    }

    if (synthRes.error) hadError = true;
    const agentConfig = opts.config.agents[synthTarget.agent] ?? {};
    messages.push({
      id: createMessageId(),
      role: "assistant",
      agent: synthTarget.agent,
      model: synthTarget.model ?? agentConfig.model,
      roundLabel,
      content: synthRes.text,
      reasoning: synthRes.reasoning || undefined,
      tools: synthRes.tools.length > 0 ? synthRes.tools : undefined,
      timestamp: new Date().toISOString(),
      durationMs: synthRes.durationMs,
      error: synthRes.error,
      aborted: synthRes.aborted,
    });
  }

  return {
    messages,
    sessionIds,
    hadError,
    aborted: opts.signal.aborted,
  };
}
