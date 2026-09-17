import { generateText, type LanguageModel } from 'ai';

/**
 * Used whenever a judge model is not named explicitly.
 *
 * Qualified like every other judge model, so the default is spelled the same
 * way the flag is and `result.json` never records an unattributed model name.
 */
export const DEFAULT_JUDGE_MODEL = 'anthropic:claude-sonnet-5';

export interface JudgeRequest {
  png: Buffer;
  prompt: string;
}

export interface JudgeBackend {
  name: string;
  model: string | null;
  /** Returns the model's raw text response, or throws. */
  ask(req: JudgeRequest): Promise<string>;
  /** Safe parallelism for this backend. */
  concurrency: number;
}

/**
 * Providers the AI SDK judge can address.
 *
 * Deliberately a closed list rather than a free-form package name: the value
 * comes off the command line, and `await import(userInput)` is arbitrary code
 * execution. Each entry names the package's default provider export and the
 * environment variable that package reads its key from, so a missing key can
 * be reported before the first frame is sent rather than sixty failures later.
 */
const AI_SDK_PROVIDERS: Record<string, { pkg: string; envKey: string }> = {
  google: { pkg: '@ai-sdk/google', envKey: 'GOOGLE_GENERATIVE_AI_API_KEY' },
  anthropic: { pkg: '@ai-sdk/anthropic', envKey: 'ANTHROPIC_API_KEY' },
  openai: { pkg: '@ai-sdk/openai', envKey: 'OPENAI_API_KEY' },
};

export const AI_SDK_PROVIDER_NAMES = Object.keys(AI_SDK_PROVIDERS);

/**
 * Split a `provider:model` judge spec, or return null if it is not one.
 *
 * Only a known provider prefix counts. A bare `claude-sonnet-5` is not a spec,
 * and neither is a Bedrock id like `us.anthropic.claude-x:0`, whose colon
 * belongs to the model name -- so an id that merely contains one is reported as
 * unqualified rather than mistaken for a provider that does not exist.
 */
export function parseJudgeModel(spec: string): { provider: string; model: string } | null {
  const i = spec.indexOf(':');
  if (i <= 0) return null;
  const provider = spec.slice(0, i);
  const model = spec.slice(i + 1);
  if (!model || !(provider in AI_SDK_PROVIDERS)) return null;
  return { provider, model };
}

/**
 * Judge through the Vercel AI SDK: the only backend that talks to a model.
 *
 * One transport for every provider is the whole point. Gemini, GPT and Claude
 * get the same rubric prompt and the same JSON contract, so a disagreement
 * between two runs is a disagreement between two judges rather than between
 * two hand-written clients. That does not make them interchangeable -- judges
 * differ at the margin -- so `result.json` records which one scored a run, and
 * a leaderboard should not mix them.
 *
 * Retries are the SDK's, which already backs off on 429s and 5xx.
 */
export class AiSdkBackend implements JudgeBackend {
  readonly name = 'ai';
  readonly concurrency = 4;
  /** Qualified, because `gemini-2.5-flash` alone does not say who served it. */
  readonly model: string;
  private provider: string;
  private modelId: string;
  private loaded: Promise<LanguageModel> | null = null;

  constructor(provider: string, modelId: string) {
    this.provider = provider;
    this.modelId = modelId;
    this.model = `${provider}:${modelId}`;
  }

  /**
   * Resolve the provider package once, on first use.
   *
   * Imported lazily so that installing the harness does not require every
   * provider to be usable, and so `p2p briefs` does not pay for an SDK it will
   * never call. The promise is cached rather than the model, so concurrent
   * workers racing the first frame still import only once.
   */
  private load(): Promise<LanguageModel> {
    this.loaded ??= (async (): Promise<LanguageModel> => {
      const entry = AI_SDK_PROVIDERS[this.provider]!;
      const mod = (await import(entry.pkg)) as Record<string, unknown>;
      const factory = mod[this.provider];
      if (typeof factory !== 'function')
        throw new Error(`${entry.pkg} does not export a "${this.provider}" provider`);
      return (factory as (id: string) => LanguageModel)(this.modelId);
    })();
    return this.loaded;
  }

  /** Score one frame. */
  async ask(req: JudgeRequest): Promise<string> {
    const model = await this.load();
    const { text } = await generateText({
      model,
      maxRetries: 4,
      abortSignal: AbortSignal.timeout(120_000),
      messages: [
        {
          role: 'user',
          content: [
            // The tagged file part rather than the deprecated `image` part:
            // same bytes, and it is what the SDK will keep supporting.
            { type: 'file', mediaType: 'image/png', data: { type: 'data', data: req.png } },
            { type: 'text', text: req.prompt },
          ],
        },
      ],
    });
    return text;
  }
}

/** No model available. Scores fall back to entity coverage and say so. */
export class NullBackend implements JudgeBackend {
  readonly name = 'none';
  readonly model = null;
  readonly concurrency = 1;
  /** Always throws: callers must fall back to mechanical scoring. */
  async ask(): Promise<string> {
    throw new Error('no judge backend configured');
  }
}

export type JudgeChoice = 'auto' | 'none';

/** Backends that used to exist, so a stale command line says why it stopped. */
const REMOVED_BACKENDS: Record<string, string> = {
  api: 'the AI SDK now covers it',
  cli: 'it shelled out to `claude` once per frame',
};

/**
 * Choose a judge backend.
 *
 * There is one real backend: every provider reaches the judge through the AI
 * SDK, so a run scored by Gemini and one scored by Claude differ in the model
 * named on the command line and nowhere else in this code. Which provider is
 * chosen by the model itself -- `google:gemini-2.5-flash` -- because a model id
 * alone does not say who served it, and a report that cannot name its judge
 * cannot be compared with another.
 */
export function pickBackend(opt: {
  backend?: JudgeChoice | string;
  model?: string;
}): JudgeBackend {
  const choice = opt.backend ?? 'auto';
  if (choice === 'none') return new NullBackend();

  const gone = REMOVED_BACKENDS[choice];
  if (gone)
    throw new Error(
      `judge backend "${choice}" was removed (${gone}). Name the model instead: ` +
        `--judge-model <provider>:<model>, e.g. ${DEFAULT_JUDGE_MODEL}.`,
    );
  if (choice !== 'auto')
    throw new Error(`unknown judge backend "${choice}". Use auto or none.`);

  const wanted = opt.model ?? DEFAULT_JUDGE_MODEL;
  const spec = parseJudgeModel(wanted);
  if (!spec)
    throw new Error(
      `--judge-model "${wanted}" does not name a provider. Use <provider>:<model>, ` +
        `e.g. ${DEFAULT_JUDGE_MODEL}. Providers: ${AI_SDK_PROVIDER_NAMES.join(', ')}.`,
    );

  // Refuse now rather than once per frame: a run that judges nothing takes the
  // same minutes as one that judges everything, and only says so at the end.
  const { envKey } = AI_SDK_PROVIDERS[spec.provider]!;
  if (!process.env[envKey])
    throw new Error(`judge provider "${spec.provider}" requires ${envKey}`);
  return new AiSdkBackend(spec.provider, spec.model);
}
