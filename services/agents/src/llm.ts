import type { Facts } from './facts.ts';
import type { Logger } from './log.ts';
import { errMsg, silentLogger } from './log.ts';

export interface Summary { summary: string; model: string }

export interface Summarizer {
  summarize(target: string, facts: Facts): Promise<Summary>;
  /** true/false when a remote LLM is configured, null when running the offline template. */
  health(): Promise<boolean | null>;
}

/** Deterministic zero-cost summarizer (used when LLM_API_KEY is empty, and as the error fallback). */
export class TemplateSummarizer implements Summarizer {
  static MODEL = 'template-v1';
  async summarize(target: string, f: Facts): Promise<Summary> {
    const keys = `${f.full_access_keys} full-access and ${f.function_call_keys} function-call access key(s)`;
    const risk = f.full_access_keys > 0
      ? 'A full-access key exists, so the code can be redeployed or the account drained by its holder.'
      : 'No full-access key exists, so the code is locked and cannot be redeployed by key.';
    const code = f.code_hash === '11111111111111111111111111111111' ? 'The account has no contract deployed.' : `Deployed code hash ${f.code_hash}.`;
    const summary = `${target} at block ${f.fetched_at_block}: ${code} It uses ${f.storage_usage} bytes of storage, holds ${f.balance} yoctoNEAR and has ${keys}. ${risk}`;
    return { summary, model: TemplateSummarizer.MODEL };
  }
  async health(): Promise<boolean | null> { return null; }
}

export interface LlmOptions { baseUrl: string; apiKey: string; model: string; timeoutMs?: number; log?: Logger }

/** OpenAI-compatible chat/completions client (NEAR AI Cloud by default). Falls back to the template on any error. */
export class OpenAiCompatSummarizer implements Summarizer {
  private o: LlmOptions;
  private fallback = new TemplateSummarizer();
  private log: Logger;
  private healthCache: { at: number; ok: boolean } | null = null;
  constructor(o: LlmOptions) { this.o = o; this.log = o.log ?? silentLogger; }

  async summarize(target: string, facts: Facts): Promise<Summary> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), this.o.timeoutMs ?? 30_000);
      const res = await fetch(`${this.o.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({
          model: this.o.model, temperature: 0, max_tokens: 300,
          messages: [
            { role: 'system', content: 'You write 3-sentence smart-contract health briefs. Use ONLY the JSON facts given. Do not invent numbers or claims.' },
            { role: 'user', content: `Account: ${target}\nFacts (JSON): ${JSON.stringify(facts)}` },
          ],
        }),
      }).finally(() => clearTimeout(t));
      if (!res.ok) throw new Error(`llm http ${res.status}`);
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[]; model?: string };
      const text = body.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error('llm empty response');
      return { summary: text, model: body.model ?? this.o.model };
    } catch (e) {
      this.log.warn('llm failed, using template summarizer', { error: errMsg(e) });
      return this.fallback.summarize(target, facts);
    }
  }

  async health(): Promise<boolean> {
    if (this.healthCache && Date.now() - this.healthCache.at < 60_000) return this.healthCache.ok;
    let ok = false;
    try {
      const res = await fetch(`${this.o.baseUrl.replace(/\/$/, '')}/models`, { headers: { authorization: `Bearer ${this.o.apiKey}` }, signal: AbortSignal.timeout(5000) });
      ok = res.ok;
    } catch { ok = false; }
    this.healthCache = { at: Date.now(), ok };
    return ok;
  }
}

export function createSummarizer(env: Record<string, string | undefined>, log?: Logger): Summarizer {
  const key = env.LLM_API_KEY?.trim();
  if (!key) return new TemplateSummarizer();
  return new OpenAiCompatSummarizer({
    baseUrl: env.LLM_BASE_URL || 'https://cloud-api.near.ai/v1', apiKey: key, model: env.LLM_MODEL || 'default', log,
  });
}
