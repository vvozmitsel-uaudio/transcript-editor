// Deepgram pre-recorded speech-to-text (https://developers.deepgram.com/reference/listen-file).
//
// The page posts the audio file's bytes to /v1/listen with the key in an Authorization header.
// That needs a CORS preflight, which /v1/listen answers for any origin, so it works from an Add
// On page, whose origin inside LUNA is its own. Deepgram's management API (/v1/projects...)
// refuses browser origins ("Origin is not allowed to make this request", measured 2026-10-28),
// so a page can only ever call /v1/listen; the key check goes there too.

import { isFiller, type Word } from './transcript';

export const API_ROOT = 'https://api.deepgram.com/v1';
export const SECRET_NAME = 'deepgram.api_key';

export interface ListenOptions {
  /** Deepgram model, `nova-3` by default. */
  model?: string;
  /** BCP-47 code such as `en` or `es`, or `multi` for code-switching speech. */
  language?: string;
}

export interface ListenResult {
  words: Word[];
  /** Seconds of audio Deepgram processed. */
  duration: number;
  model: string;
  language: string;
}

export type DeepgramErrorCode = 'no_key' | 'bad_key' | 'no_credit' | 'rate_limited' | 'too_large' | 'unsupported_audio' | 'http' | 'network' | 'aborted';

export class DeepgramError extends Error {
  constructor(readonly code: DeepgramErrorCode, message: string, readonly status?: number) {
    super(message);
    this.name = 'DeepgramError';
  }
}

/** The /v1/listen URL: word timings, punctuation, speaker labels and filler words. */
export function listenUrl(opts: ListenOptions = {}): string {
  const q = new URLSearchParams({
    model: opts.model || 'nova-3',
    language: opts.language || 'en',
    smart_format: 'true',
    punctuate: 'true',
    diarize: 'true',
    filler_words: 'true',
  });
  return `${API_ROOT}/listen?${q}`;
}

/** Words from a /v1/listen reply. Uses the first channel's best alternative. */
export function parseListen(json: unknown, opts: ListenOptions = {}): ListenResult {
  const root = json as {
    metadata?: { duration?: number; model_info?: Record<string, { name?: string; arch?: string }> };
    results?: { channels?: { detected_language?: string; alternatives?: { words?: unknown[] }[] }[] };
  };
  const channel = root?.results?.channels?.[0];
  const raw = channel?.alternatives?.[0]?.words;
  if (!Array.isArray(raw)) throw new DeepgramError('http', 'Deepgram answered without words.');
  const words: Word[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    const text = String(r['punctuated_word'] ?? r['word'] ?? '').trim();
    const start = Number(r['start']), end = Number(r['end']);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    words.push({
      text,
      start,
      end: Math.max(end, start),
      speaker: Number.isInteger(r['speaker']) ? (r['speaker'] as number) : 0,
      confidence: Number(r['confidence'] ?? 0),
      filler: isFiller(String(r['word'] ?? text)),
    });
  }
  const info = Object.values(root?.metadata?.model_info ?? {})[0];
  return {
    words,
    duration: Number(root?.metadata?.duration ?? (words.length ? words[words.length - 1].end : 0)),
    model: info?.arch ?? info?.name ?? opts.model ?? 'nova-3',
    language: channel?.detected_language ?? opts.language ?? 'en',
  };
}

async function errorFor(res: Response): Promise<DeepgramError> {
  let detail = '';
  try {
    const body = (await res.json()) as { err_msg?: string; message?: string; reason?: string };
    detail = body.err_msg ?? body.message ?? body.reason ?? '';
  } catch { /* not JSON */ }
  const say = (fallback: string) => detail || fallback;
  switch (res.status) {
    case 401: return new DeepgramError('bad_key', 'Deepgram refused the API key. Check it in Settings.', 401);
    case 402: return new DeepgramError('no_credit', say('Your Deepgram project is out of credit.'), 402);
    case 413: return new DeepgramError('too_large', 'The audio file is too large for Deepgram (2 GB at most).', 413);
    case 429: return new DeepgramError('rate_limited', 'Deepgram is rate limiting this key. Wait a minute and try again.', 429);
    case 400: return new DeepgramError('unsupported_audio', say('Deepgram could not read that audio.'), 400);
    default: return new DeepgramError('http', `Deepgram answered ${res.status}${detail ? `: ${detail}` : ''}.`, res.status);
  }
}

export class DeepgramClient {
  constructor(
    private readonly getKey: () => string | undefined,
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {}

  private key(): string {
    const key = this.getKey();
    if (!key) throw new DeepgramError('no_key', 'Add your Deepgram API key in Settings first.');
    return key;
  }

  private async call(url: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') throw new DeepgramError('aborted', 'Cancelled.');
      const why = (e as Error)?.message ? ` (${(e as Error).message})` : '';
      throw new DeepgramError('network', `Could not reach Deepgram${why}. Check your internet connection.`);
    }
    if (!res.ok) throw await errorFor(res);
    return res;
  }

  /**
   * True when Deepgram accepts `key`. Posts no audio to /v1/listen: Deepgram checks the key
   * first (401 for a bad one), then refuses the empty body (400), so nothing is transcribed or
   * charged. A key that is valid but out of credit (402) counts as accepted.
   */
  async checkKey(key: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.call(`${API_ROOT}/listen?model=nova-3`, { method: 'POST', headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' }, body: new Uint8Array(0), signal });
      return true;
    } catch (e) {
      if (e instanceof DeepgramError && (e.code === 'bad_key' || e.status === 403)) return false;
      if (e instanceof DeepgramError && (e.code === 'unsupported_audio' || e.code === 'no_credit')) return true;
      throw e;
    }
  }

  /** Transcribe an audio file's bytes (WAV, AIFF, MP3, FLAC, M4A...). */
  async transcribe(audio: Blob | ArrayBuffer | Uint8Array, contentType: string, opts: ListenOptions = {}, signal?: AbortSignal): Promise<ListenResult> {
    const res = await this.call(listenUrl(opts), {
      method: 'POST',
      headers: { Authorization: `Token ${this.key()}`, 'Content-Type': contentType || 'application/octet-stream' },
      body: audio as BodyInit,
      signal,
    });
    return parseListen(await res.json(), opts);
  }
}

/** Content-Type for an audio file name. Deepgram also sniffs the bytes. */
export function audioContentType(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  return ({ wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg', webm: 'audio/webm' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}
