import { getAdapter } from "./adapters/index.ts";
import { buildPromptWithContext, createMessageId } from "./session.ts";
import { formatTargetLabel } from "./types.ts";
import type {
  AgentId,
  AgentRunResult,
  AgentTarget,
  ChatMessage,
  McliConfig,
  StreamEvent,
} from "./types.ts";

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

  const runParticipant = async (
    target: AgentTarget,
    index: number,
    roundLabel: string,
    prompt: string,
    rawUserPrompt: string,
  ): Promise<AgentRunResult> => {
    const adapter = getAdapter(target.agent);
    const agentConfig = opts.config.agents[target.agent] ?? {};

    opts.onParticipantStart?.({ index, target, roundLabel });

    const res = await adapter.run({
      prompt,
      rawUserPrompt,
      history: opts.history,
      sessionSummary: opts.sessionSummary,
      summarizedUpTo: opts.summarizedUpTo,
      transcriptPath: opts.transcriptPath,
      cwd: opts.cwd,
      model: target.model,
      config: agentConfig,
      signal: opts.signal,
      onEvent: (event) => {
        opts.onParticipantEvent?.({ index, target, roundLabel, event });
      },
    });

    if (res.sessionId) {
      sessionIds[target.agent] = res.sessionId;
    }
    if (res.error) hadError = true;

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

    const runOne = async (target: AgentTarget, idx: number): Promise<DiscussionParticipantOutput> => {
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

      const result = await runParticipant(target, idx, roundLabel, prompt, rawForApi);
      return { target, label: selfLabel, round, roundLabel, result };
    };

    let roundOutputs: DiscussionParticipantOutput[];
    if (parallel) {
      roundOutputs = await Promise.all(opts.targets.map((t, idx) => runOne(t, idx)));
    } else {
      roundOutputs = [];
      for (let idx = 0; idx < opts.targets.length; idx++) {
        if (opts.signal.aborted) break;
        roundOutputs.push(await runOne(opts.targets[idx], idx));
      }
    }

    for (const entry of roundOutputs) {
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

    const synthRes = await runParticipant(synthTarget, 0, roundLabel, synthPrompt, synthRaw);
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
