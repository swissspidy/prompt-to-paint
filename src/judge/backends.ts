import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { generateText, type LanguageModel } from 'ai';
import { sleep } from '../sleep.ts';

/** Used whenever a judge model is not named explicitly. */
export const DEFAULT_JUDGE_MODEL = 'claude-sonnet-5';

export interface JudgeRequest {
  imagePath: string;
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

/** Direct Messages API. Preferred: parallel, cheap, and independent of CLI auth. */
export class ApiBackend implements JudgeBackend {
  readonly name = 'api';
  readonly concurrency = 4;
  readonly model: string;
  private apiKey: string;
  private baseUrl: string;

  constructor(
    model: string,
    apiKey: string,
    baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  ) {
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  /**
   * Score one frame over HTTP, retrying 429s and 5xx with exponential backoff.
   */
  async ask(req: JudgeRequest): Promise<string> {
    const body = {
      model: this.model,
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: req.png.toString('base64') },
            },
            { type: 'text', text: req.prompt },
          ],
        },
      ],
    };
    let lastErr = 'unknown';
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/messages`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = `http-${res.status}`;
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        if (!res.ok) throw new Error(`judge api ${res.status}: ${(await res.text()).slice(0, 300)}`);
        const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
        return (json.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text ?? '')
          .join('');
      } catch (e) {
        lastErr = String(e);
        await sleep(1000 * 2 ** attempt);
      }
    }
    throw new Error(`judge api failed after retries: ${lastErr}`);
  }
}

/**
 * Judge through the local `claude` CLI.
 *
 * Slower and serialised, but it works wherever the CLI is already signed in,
 * which means the harness runs on a laptop without provisioning an API key.
 */
export class CliBackend implements JudgeBackend {
  readonly name = 'cli';
  readonly concurrency = 2;
  readonly model: string;
  private bin: string;

  constructor(model: string, bin = 'claude') {
    this.model = model;
    this.bin = bin;
  }

  /**
   * Score one frame by asking the local CLI to read the screenshot off disk.
   */
  async ask(req: JudgeRequest): Promise<string> {
    const prompt = `Read the image file at ${req.imagePath}, then answer.\n\n${req.prompt}`;
    // The prompt goes over stdin, never as a positional argument: --add-dir and
    // --allowedTools are both variadic, so a trailing positional gets swallowed
    // as one of their values and the CLI exits complaining of no input.
    const args = [
      '-p',
      '--output-format', 'json',
      '--model', this.model,
      '--allowedTools', 'Read',
      '--add-dir', dirname(req.imagePath),
    ];
    return await new Promise<string>((resolve, reject) => {
      const child = spawn(this.bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin.write(prompt);
      child.stdin.end();
      let out = '';
      let err = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`claude cli exited ${code}: ${err.slice(0, 300)}`));
        try {
          const parsed = JSON.parse(out) as { result?: string };
          resolve(parsed.result ?? out);
        } catch {
          resolve(out);
        }
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  }
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
 * Null is the ordinary answer, not a failure: `claude-sonnet-5` is a bare
 * Anthropic model and so is a Bedrock id like `us.anthropic.claude-x:0`, whose
 * colon belongs to the model name. Only a known provider prefix counts, so an
 * unrecognised one falls through to the Anthropic backends instead of being
 * mistaken for a provider that does not exist.
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
 * Judge through the Vercel AI SDK, so any provider it supports can score.
 *
 * The rubric prompt and the JSON contract are identical to the other backends
 * -- only the transport differs -- so a run judged by Gemini is scored against
 * the same criteria as one judged by Claude. That does not make the two
 * interchangeable: different judges disagree at the margin, so `result.json`
 * records which one ran and the leaderboard should not mix them.
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

export type JudgeChoice = 'api' | 'cli' | 'ai' | 'none' | 'auto';

/** Build an AI SDK backend, refusing early if its key is not set. */
function aiSdkBackend(spec: { provider: string; model: string }): AiSdkBackend {
  const { envKey } = AI_SDK_PROVIDERS[spec.provider]!;
  if (!process.env[envKey])
    throw new Error(`judge provider "${spec.provider}" requires ${envKey}`);
  return new AiSdkBackend(spec.provider, spec.model);
}

/**
 * Choose a judge backend.
 *
 * `auto` prefers the Anthropic API when a key is present and falls back to the
 * local CLI, so the harness runs on a laptop without provisioning credentials.
 *
 * A provider-qualified model overrides that, even under `auto`: asking for
 * `google:gemini-2.5-flash` and silently being scored by Claude would put the
 * wrong judge in the report, which is worse than refusing.
 */
export function pickBackend(opt: {
  backend?: JudgeChoice;
  model?: string;
}): JudgeBackend {
  const choice = opt.backend ?? 'auto';
  const spec = opt.model ? parseJudgeModel(opt.model) : null;

  if (choice === 'ai') {
    if (!spec)
      throw new Error(
        `judge backend "ai" needs --judge-model <provider>:<model>, ` +
          `e.g. google:gemini-2.5-flash. Providers: ${AI_SDK_PROVIDER_NAMES.join(', ')}.`,
      );
    return aiSdkBackend(spec);
  }
  if (choice === 'none') return new NullBackend();
  if (spec) {
    if (choice === 'auto') return aiSdkBackend(spec);
    throw new Error(
      `--judge ${choice} takes a bare Anthropic model, but --judge-model ` +
        `"${opt.model}" names the ${spec.provider} provider. Use --judge ai, or drop the prefix.`,
    );
  }

  const model = opt.model ?? DEFAULT_JUDGE_MODEL;
  const key = process.env.ANTHROPIC_API_KEY;
  if (choice === 'api') {
    if (!key) throw new Error('judge backend "api" requires ANTHROPIC_API_KEY');
    return new ApiBackend(model, key);
  }
  if (choice === 'cli') return new CliBackend(model);
  if (key) return new ApiBackend(model, key);
  return new CliBackend(model);
}
