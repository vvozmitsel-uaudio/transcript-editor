import { describe, expect, it } from 'vitest';
import { audioContentType, DeepgramClient, DeepgramError, listenUrl, parseListen } from '../src/deepgram';

// The shape of a /v1/listen reply with diarize, smart_format and filler_words.
const reply = {
  metadata: { duration: 13.458, model_info: { 'abc-123': { name: 'general-nova-3', arch: 'nova-3' } } },
  results: {
    channels: [{
      alternatives: [{
        transcript: 'So, um, today...',
        words: [
          { word: 'so', start: 0.08, end: 0.4, confidence: 0.99, speaker: 0, punctuated_word: 'So,' },
          { word: 'um', start: 0.56, end: 0.88, confidence: 0.91, speaker: 0, punctuated_word: 'um,' },
          { word: 'today', start: 1.2, end: 1.6, confidence: 0.99, speaker: 1, punctuated_word: 'today' },
        ],
      }],
    }],
  },
};

function fakeFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('listenUrl', () => {
  it('asks for words, punctuation, speakers and fillers', () => {
    const u = new URL(listenUrl({ language: 'es' }));
    expect(u.origin + u.pathname).toBe('https://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ model: 'nova-3', language: 'es', diarize: 'true', filler_words: 'true', smart_format: 'true' });
  });
});

describe('parseListen', () => {
  it('reads words, speakers, fillers and the model', () => {
    const r = parseListen(reply);
    expect(r.duration).toBe(13.458);
    expect(r.model).toBe('nova-3');
    expect(r.words.map((x) => [x.text, x.speaker, x.filler])).toEqual([['So,', 0, false], ['um,', 0, true], ['today', 1, false]]);
  });

  it('refuses a reply without words', () => {
    expect(() => parseListen({ results: {} })).toThrow(DeepgramError);
  });
});

describe('DeepgramClient', () => {
  it('posts the audio with the key in the Authorization header', async () => {
    const { impl, calls } = fakeFetch(() => Response.json(reply));
    const client = new DeepgramClient(() => 'k123', impl);
    const audio = new Uint8Array([82, 73, 70, 70]);
    const r = await client.transcribe(audio, 'audio/wav');
    expect(r.words).toHaveLength(3);
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Token k123');
    expect((calls[0].init.headers as Record<string, string>)['Content-Type']).toBe('audio/wav');
    expect(calls[0].url).not.toContain('k123');
  });

  it('needs a key', async () => {
    const client = new DeepgramClient(() => undefined, fakeFetch(() => Response.json(reply)).impl);
    await expect(client.transcribe(new Uint8Array(1), 'audio/wav')).rejects.toMatchObject({ code: 'no_key' });
  });

  it('turns HTTP failures into codes', async () => {
    for (const [status, code] of [[401, 'bad_key'], [402, 'no_credit'], [429, 'rate_limited'], [400, 'unsupported_audio'], [500, 'http']] as const) {
      const client = new DeepgramClient(() => 'k', fakeFetch(() => Response.json({ err_msg: 'nope' }, { status })).impl);
      await expect(client.transcribe(new Uint8Array(1), 'audio/wav')).rejects.toMatchObject({ code });
    }
    const offline = new DeepgramClient(() => 'k', fakeFetch(() => { throw new TypeError('Failed to fetch'); }).impl);
    await expect(offline.transcribe(new Uint8Array(1), 'audio/wav')).rejects.toMatchObject({ code: 'network' });
  });

  it('checks a key with an empty /v1/listen post, the only endpoint open to pages', async () => {
    // A good key gets past auth and has its empty body refused: nothing is transcribed.
    const { impl, calls } = fakeFetch(() => Response.json({ err_code: 'Bad Request', err_msg: 'no audio' }, { status: 400 }));
    expect(await new DeepgramClient(() => undefined, impl).checkKey('good')).toBe(true);
    expect(new URL(calls[0].url).pathname).toBe('/v1/listen');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.body as Uint8Array).byteLength).toBe(0);
    expect((calls[0].init.headers as Record<string, string>)['Authorization']).toBe('Token good');
    for (const [status, accepted] of [[401, false], [403, false], [402, true]] as const) {
      const client = new DeepgramClient(() => undefined, fakeFetch(() => new Response('', { status })).impl);
      expect(await client.checkKey('k')).toBe(accepted);
    }
  });

  it('says why a request never got an answer', async () => {
    const blocked = new DeepgramClient(() => 'k', fakeFetch(() => { throw new TypeError('Load failed'); }).impl);
    await expect(blocked.transcribe(new Uint8Array(1), 'audio/wav')).rejects.toThrow('Could not reach Deepgram (Load failed)');
  });
});

describe('audioContentType', () => {
  it('names common audio types', () => {
    expect(audioContentType('a.WAV')).toBe('audio/wav');
    expect(audioContentType('take.aif')).toBe('audio/aiff');
    expect(audioContentType('x.bin')).toBe('application/octet-stream');
  });
});
