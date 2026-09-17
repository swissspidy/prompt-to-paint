import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { sleep } from '../sleep.ts';

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

/**
 * Choose a judge backend.
 *
 * `auto` prefers the API when a key is present and falls back to the local
 * CLI, so the harness runs on a laptop without provisioning credentials.
 */
export function pickBackend(opt: {
  backend?: 'api' | 'cli' | 'none' | 'auto';
  model?: string;
}): JudgeBackend {
  const model = opt.model ?? 'claude-sonnet-5';
  const key = process.env.ANTHROPIC_API_KEY;
  const choice = opt.backend ?? 'auto';
  if (choice === 'api') {
    if (!key) throw new Error('judge backend "api" requires ANTHROPIC_API_KEY');
    return new ApiBackend(model, key);
  }
  if (choice === 'cli') return new CliBackend(model);
  if (choice === 'none') return new NullBackend();
  if (key) return new ApiBackend(model, key);
  return new CliBackend(model);
}
