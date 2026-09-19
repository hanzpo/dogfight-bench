/**
 * The TypeSafe System One client, and the reading of what it answers.
 *
 * Nothing malformed becomes an action: a decision that cannot be trusted is a
 * provider error, counted against the model, rather than a silently misflown
 * manoeuvre that looks like bad piloting.
 */
export interface ChoiceAnswer {
  type?: string;
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type?: string;
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
  legend?: Record<string, string>;
}

interface NoulAnswer {
  type?: string;
  noul: number;
}

export interface SystemOneResponse {
  model?: string;
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function probability(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
}

function require<T>(valid: boolean, answer: T | undefined, kind: string): T {
  if (!valid || answer === undefined) throw new Error(`Invalid TypeSafe ${kind}; no action taken`);
  return answer;
}

export function firstSentence(text: string): string {
  return text.split(".")[0]!;
}

export function readChoice(value: unknown, ids: readonly string[]): ChoiceAnswer {
  const answer = value as ChoiceAnswer | undefined;
  const probabilities = answer?.probabilities;
  const values = probabilities ? Object.values(probabilities) : [];
  const valid =
    answer !== undefined &&
    ids.includes(answer.choice) &&
    probabilities !== undefined &&
    ids.every((id) => id in probabilities) &&
    [...values, answer.confidence].every(probability) &&
    Math.abs(values.reduce((sum, entry) => sum + entry, 0) - 1) < 0.02;
  return require(valid, answer, "choice");
}

export function readScore(value: unknown, levels: number): ScoreAnswer {
  const answer = value as ScoreAnswer | undefined;
  const valid =
    answer !== undefined &&
    finite(answer.score) &&
    answer.score >= 0 &&
    answer.score <= levels - 1 &&
    probability(answer.confidence);
  return require(valid, answer, "score");
}

export function readNoul(value: unknown): number {
  const answer = value as NoulAnswer | undefined;
  return require(probability(answer?.noul), answer?.noul, "noul");
}


export async function askSystemOne(
  endpoint: { url: string; key: string; model: string },
  state: string,
  questions: unknown,
  signal?: AbortSignal,
): Promise<SystemOneResponse> {
  const response = await fetch(endpoint.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${endpoint.key}` },
    signal,
    body: JSON.stringify({ model: endpoint.model, state, questions }),
  });
  if (!response.ok) throw new Error(`TypeSafe returned HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()) as SystemOneResponse;
}
