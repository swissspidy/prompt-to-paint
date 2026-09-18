import { generateText, type LanguageModel } from 'ai';

/**
 * Used whenever `--judge` is not given.
 *
 * Qualified like every other judge, so the default is spelled the same way the
 * flag is and `result.json` never records an unattributed model name.
 */
export const DEFAULT_JUDGE = 'anthropic:claude-sonnet-5';

export interface JudgeRequest {
  png: Buffer;
  prompt: string;
}

/**
 * What a run scored by this backend should record as its judge temperature.
 *
 * One place, because three call sites write that field and they must not be
 * able to disagree about it.
 */
export const appliedTemperature = (backend: JudgeBackend): number | null =>
  backend.temperature ? backend.temperature() : JUDGE_TEMPERATURE;

/**
 * Did the provider say it ignored the temperature we asked for?
 *
 * Both spellings are matched deliberately. The provider protocol calls this
 * `{type: 'unsupported-setting', setting}`; what the `ai` package hands back for
 * the same event is `{type: 'unsupported', feature}`. Keying on one of them is
 * how this went unnoticed in the first place -- a check that silently stops
 * matching leaves exactly the wrong claim in result.json, so match the name
 * wherever the shape puts it.
 */
export function dropsTemperature(warnings: readonly unknown[] | undefined): boolean {
  if (!warnings) return false;
  return warnings.some((raw) => {
    const w = raw as { type?: unknown; setting?: unknown; feature?: unknown };
    if (typeof w?.type !== 'string' || !w.type.startsWith('unsupported')) return false;
    return w.setting === 'temperature' || w.feature === 'temperature';
  });
}

/**
 * Sampling temperature for every judge call.
 *
 * Zero, and stated once, because the judge decides the headline number. At a
 * provider's default -- typically 1.0 -- the same screenshot scored twice can
 * come back with different criteria met, so an AUC carries sampling noise that
 * nothing downstream can see or subtract. Worse, the verdict cache then freezes
 * whichever sample happened to land first, so the noise becomes permanent and
 * looks like a measurement.
 *
 * It does not make a judge deterministic -- no provider promises that, even at
 * zero -- but it removes the variance that is ours to remove, and `result.json`
 * records it so a run can say how it was scored.
 */
export const JUDGE_TEMPERATURE = 0;

export interface JudgeBackend {
  name: string;
  model: string | null;
  /** Returns the model's raw text response, or throws. */
  ask(req: JudgeRequest): Promise<string>;
  /** Safe parallelism for this backend. */
  concurrency: number;
  /**
   * The sampling temperature the provider confirms it applied, or null if it
   * told us it ignored the setting.
   *
   * Asking for zero and recording zero are not the same claim, and only the
   * provider knows which happened. `result.json` records this number, and
   * `p2p compare` and the repeat aggregation both refuse to pool runs whose
   * temperatures differ -- so a hardcoded 0 that the provider quietly dropped
   * does not merely misreport, it certifies as noise-free a set of runs that
   * carries exactly the sampling noise the check exists to catch.
   *
   * Optional: a backend that never hears otherwise from a provider got what it
   * asked for, which is what `appliedTemperature` falls back to. A backend that
   * does talk to one should implement this.
   */
  temperature?(): number | null;
  /**
   * One cheap call proving this judge can actually be reached, or a throw
   * carrying the provider's own refusal.
   *
   * `pickBackend` can only check the shape of what was typed -- a known
   * provider, a key in the environment. Whether the *model* exists is a fact
   * only the provider has, and asking it costs one small request against
   * minutes of run. Without this a misspelled model id is discovered after the
   * agent has finished, as sixty identical 404s in the warnings of a run that
   * can no longer be scored.
   */
  preflight?(): Promise<void>;
}

/**
 * A 1x1 PNG, for asking a provider whether it will take a call at all.
 *
 * An image rather than a bare prompt because a text-only round trip proves
 * nothing about the path every real judge call takes: a model that exists but
 * cannot accept an image fails at frame one and nowhere earlier.
 */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

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
 * Split a `provider:model` judge into its parts, or return null if it is not one.
 *
 * Only a known provider prefix counts. A bare `claude-sonnet-5` is not a spec,
 * and neither is a Bedrock id like `us.anthropic.claude-x:0`, whose colon
 * belongs to the model name -- so an id that merely contains one is reported as
 * unqualified rather than mistaken for a provider that does not exist.
 */
export function parseJudge(spec: string): { provider: string; model: string } | null {
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
  /**
   * Set once a provider tells us it ignored `temperature`.
   *
   * Observed against the default judge: `anthropic:claude-sonnet-5` does not
   * take the setting, and the SDK drops it with a warning on stderr that
   * nothing here was reading. Every run then recorded `temperature: 0` while
   * sampling at whatever the provider does by default.
   */
  private temperatureDropped = false;

  constructor(provider: string, modelId: string) {
    this.provider = provider;
    this.modelId = modelId;
    this.model = `${provider}:${modelId}`;
  }

  /** Null once the provider has said it ignored the setting. */
  temperature(): number | null {
    return this.temperatureDropped ? null : JUDGE_TEMPERATURE;
  }

  /**
   * Believe the provider over the request when they disagree.
   *
   * Called for preflight and for every frame, so a judge that only mentions it
   * on the first real call is still caught, and one that never mentions it
   * leaves the recorded temperature as asked.
   */
  private noteWarnings(warnings: readonly unknown[] | undefined): void {
    if (dropsTemperature(warnings)) this.temperatureDropped = true;
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

  /**
   * Ask the provider for one token about one pixel.
   *
   * No retries: a wrong model id is not a transient condition, and backing off
   * four times before saying so turns a two-second answer into half a minute of
   * silence at the exact moment the user is watching for one.
   */
  async preflight(): Promise<void> {
    const model = await this.load();
    const { warnings } = await generateText({
      model,
      maxRetries: 0,
      temperature: JUDGE_TEMPERATURE,
      abortSignal: AbortSignal.timeout(30_000),
      messages: [
        {
          role: 'user',
          content: [
            { type: 'file', mediaType: 'image/png', data: { type: 'data', data: PIXEL_PNG } },
            { type: 'text', text: 'Reply with the single word OK.' },
          ],
        },
      ],
    });
    // One real call is also the cheapest place to find out what the provider
    // will do with the settings, and it happens before the agent starts.
    this.noteWarnings(warnings);
  }

  /** Score one frame. */
  async ask(req: JudgeRequest): Promise<string> {
    const model = await this.load();
    const { text, warnings } = await generateText({
      model,
      maxRetries: 4,
      temperature: JUDGE_TEMPERATURE,
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
    this.noteWarnings(warnings);
    return text;
  }
}

/** No model available. Scores fall back to entity coverage and say so. */
export class NullBackend implements JudgeBackend {
  readonly name = 'none';
  readonly model = null;
  readonly concurrency = 1;
  /**
   * Nothing is sampled, so nothing was dropped.
   *
   * Reported as the temperature that was asked for rather than null, because
   * null is the specific claim "a provider ignored this" and no provider was
   * involved. These runs are flagged degraded in every report that shows them.
   */
  temperature(): number {
    return JUDGE_TEMPERATURE;
  }
  /** Always throws: callers must fall back to mechanical scoring. */
  async ask(): Promise<string> {
    throw new Error('no judge backend configured');
  }
  /** Nothing to check: scoring nothing cannot fail late. */
  async preflight(): Promise<void> {}
}

/**
 * Fail before the run rather than after it.
 *
 * Returns the provider's own message, because that message is the only place
 * the real reason lives -- a model that was renamed, a key without access to
 * it, a region that does not serve it. Guessing which of those it was, and
 * saying so, would be worse than quoting it.
 */
export async function preflightJudge(backend: JudgeBackend): Promise<string | null> {
  if (!backend.preflight) return null;
  try {
    await backend.preflight();
    return null;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.trim() || String(e);
  }
}

/**
 * Choose a judge from the one value that names it.
 *
 * Every provider reaches the judge through the AI SDK, so a run scored by
 * Gemini and one scored by Claude differ in the string on the command line and
 * nowhere else in this code. That string is the provider and the model
 * together -- `google:gemini-2.5-flash` -- because a model id alone does not
 * say who served it, and a report that cannot name its judge cannot be put
 * beside another one. `none` scores nothing.
 */
export function pickBackend(judge?: string): JudgeBackend {
  const wanted = judge ?? DEFAULT_JUDGE;
  if (wanted === 'none') return new NullBackend();

  const spec = parseJudge(wanted);
  if (!spec)
    throw new Error(
      `--judge "${wanted}" does not name a provider. Use <provider>:<model>, ` +
        `e.g. ${DEFAULT_JUDGE}, or none. Providers: ${AI_SDK_PROVIDER_NAMES.join(', ')}.`,
    );

  // Refuse now rather than once per frame: a run that judges nothing takes the
  // same minutes as one that judges everything, and only says so at the end.
  const { envKey } = AI_SDK_PROVIDERS[spec.provider]!;
  if (!process.env[envKey])
    throw new Error(`judge provider "${spec.provider}" requires ${envKey}`);
  return new AiSdkBackend(spec.provider, spec.model);
}
