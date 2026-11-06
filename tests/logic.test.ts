// Runs against Luna.MockEngine: no LUNA needed. `npm test`.
import { describe, expect, it } from 'vitest';
import { ADD_ON_ID, addSpeakerMarkers, applyCuts, loadLane, rippledTick, sourcePaths, sourceUrl, TranscriptStore } from '../src/logic';
import { placeWords, type Transcript, type Word } from '../src/transcript';

const SPEECH_NS = 13_458_000_000;

/**
 * LUNA's `clear` on a timeline range selection deletes the audio in the range, splitting clips
 * at both ends (measured on LUNA 3.1.1, 2026-10-27). The mock's `clear` deletes selected MIDI
 * notes only, so the tests model the audio case here.
 */
function modelAudioClear(engine: Luna.MockEngine, sessionUid: string, timeline: () => Luna.Timeline): void {
  const base = `/sessions/${sessionUid}`;
  let made = 0;
  const handler = (): null => {
    const ctx = `${base}/contexts/main`;
    const a = Number(engine.value(ctx, 'selection_start'));
    const b = Number(engine.value(ctx, 'selection_stop'));
    const lanes = (engine.value(ctx, 'selection_playlists') as string[] | null) ?? [];
    const ns = (from: number, to: number) => Math.round((timeline().seconds(to) - timeline().seconds(from)) * 1e9);
    for (const pl of lanes) {
      for (const uid of engine.children(`${base}/playlists/${pl}/clips`)) {
        const path = `${base}/playlists/${pl}/clips/${uid}`;
        const start = Number(engine.value(path, 'start')), stop = Number(engine.value(path, 'stop'));
        const srcStart = Number(engine.value(path, 'source_start'));
        if (stop <= a || start >= b) continue;
        if (start >= a && stop <= b) { engine.removeNode(path); continue; }
        if (start < a && stop > b) {
          const props = Object.fromEntries(engine.propertyNames(path).map((k) => [k, engine.value(path, k)]));
          const id = `cut${++made}`;
          engine.addNode(`${base}/playlists/${pl}/clips/${id}`, { properties: { ...props, uid: id, start: b, source_start: srcStart + ns(start, b) } });
          engine.setValue(path, 'stop', a);
          engine.setValue(path, 'source_stop', srcStart + ns(start, a));
        } else if (start < a) {
          engine.setValue(path, 'stop', a);
          engine.setValue(path, 'source_stop', srcStart + ns(start, a));
        } else {
          engine.setValue(path, 'start', b);
          engine.setValue(path, 'source_start', srcStart + ns(start, b));
        }
      }
    }
    return null;
  };
  engine.overrideCommand(`${base}/contexts/main/commands/clear`, handler);
}

async function speechSession() {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'Podcast', tracks: ['Host', 'Guest'], packageUid: 'pkg' });
  engine.addSource('pkg', 'src1', { name: 'speech.wav', lengthNs: SPEECH_NS, stemFormat: 'mono' });
  engine.addNode(`/gui/add_ons/${ADD_ON_ID}`, { properties: { name: 'Transcript Editor' } });
  await engine.settled();
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  const timeline = session.musical.timeline;
  modelAudioClear(engine, 'abc', () => session.musical.timeline);
  const host = session.tracks.byId('Host')!;
  await session.insertClip({ trackUid: host.id, sourceUid: 'src1', startTick: 0, stopTick: Math.round(timeline.tickAtSeconds(SPEECH_NS / 1e9)), sourceStartNs: 0, sourceStopNs: SPEECH_NS, name: 'speech' });
  await engine.settled();
  await luna.settled();
  return { engine, luna, session, host, timeline };
}

const word = (text: string, start: number, end: number, speaker = 0): Word => ({ text, start, end, speaker, confidence: 0.9, filler: /^u[hm]/i.test(text) });

describe('lanes', () => {
  it('reads what a track plays, in session seconds', async () => {
    const { session, host } = await speechSession();
    const view = await loadLane(session, host);
    expect(view?.sourceUids).toEqual(['src1']);
    expect(view?.pieces).toHaveLength(1);
    expect(view!.pieces[0]).toMatchObject({ sourceUid: 'src1', srcStart: 0, start: 0 });
    expect(view!.pieces[0].srcStop).toBeCloseTo(13.458, 3);
    expect(view!.pieces[0].stop).toBeCloseTo(13.458, 2);
  });
});

describe('applyCuts', () => {
  it('removes a range, closes the gap and crossfades the edit, as one undo step', async () => {
    const { engine, luna, session, host, timeline } = await speechSession();
    const lane = session.playlistFor(host)!;
    engine.transactions.length = 0;
    const n = await applyCuts(session, [[2, 3]], { trackUids: [host.id], laneUids: [lane.id] }, { fadeMs: 10, name: 'Cut words' });
    await engine.settled();
    await luna.settled();
    expect(n).toBe(1);
    expect(engine.transactions).toEqual(['begin', 'commit']);

    const clips = [...lane.clips.items].sort((x, y) => x.start.value! - y.start.value!);
    const t2 = Math.round(timeline.tickAtSeconds(2));
    expect(clips.map((c) => [c.start.value, c.sourceStart.value, c.sourceStop.value])).toEqual([
      [0, 0, 2e9],
      [t2, 3e9, SPEECH_NS],
    ]);
    await lane.compiledClips.load();
    const [left, right] = lane.compiledClips.inOrder();
    expect(left.fadeOut.value?.crossfade).toBe(true);
    expect(right.fadeIn.value?.crossfade).toBe(true);
    const fade = left.fadeOut.value!;
    expect(timeline.seconds(fade.stop) - timeline.seconds(fade.start)).toBeCloseTo(0.01, 3);
  });

  it('cuts several ranges latest first, so each lands where the words were', async () => {
    const { engine, luna, session, host, timeline } = await speechSession();
    const lane = session.playlistFor(host)!;
    engine.transactions.length = 0;
    await applyCuts(session, [[2, 3], [8, 9], [5, 6]], { trackUids: [host.id], laneUids: [lane.id] }, { fadeMs: 0, name: 'Remove fillers' });
    await engine.settled();
    await luna.settled();
    expect(engine.transactions).toEqual(['begin', 'commit']);
    const clips = [...lane.clips.items].sort((x, y) => x.start.value! - y.start.value!);
    expect(clips.map((c) => [timeline.seconds(c.start.value!), c.sourceStart.value! / 1e9])).toEqual([
      [0, 0], [2, 3], [4, 6], [6, 9],
    ]);
  });

  it('leaves the user\'s selection as it was', async () => {
    const { engine, luna, session, host } = await speechSession();
    const lane = session.playlistFor(host)!;
    await session.context.select({ startTick: 10, stopTick: 20, trackUids: ['Guest'] });
    await engine.settled();
    await applyCuts(session, [[1, 1.5]], { trackUids: [host.id], laneUids: [lane.id] }, { fadeMs: 10, name: 'Cut words' });
    await engine.settled();
    await luna.settled();
    expect(engine.value('/sessions/abc/contexts/main', 'selection_start')).toBe(10);
    expect(engine.value('/sessions/abc/contexts/main', 'selection_tracks')).toEqual(['Guest']);
  });

  it('keeps transcript words in step with the cut', async () => {
    const { engine, luna, session, host } = await speechSession();
    const t: Transcript = {
      sourceUid: 'src1', sourceName: 'speech.wav', duration: 13.458, model: 'nova-3', language: 'en', created: 0,
      words: [word('So,', 0.2, 0.5), word('um,', 0.9, 1.2), word('today', 1.6, 2.0), word('we', 2.1, 2.3)],
    };
    const lane = session.playlistFor(host)!;
    await applyCuts(session, [[0.7, 1.4]], { trackUids: [host.id], laneUids: [lane.id] }, { fadeMs: 0, name: 'Cut' });
    await engine.settled();
    await luna.settled();
    const view = (await loadLane(session, host))!;
    const placed = placeWords(new Map([['src1', t]]), view.pieces);
    expect(placed.map((w) => w.text)).toEqual(['So,', 'today', 'we']);
    expect(placed[1].start).toBeCloseTo(1.6 - 0.7, 6);
  });
});

describe('markers', () => {
  it('ripple with the audio when the whole session is cut', async () => {
    const { engine, luna, session, timeline } = await speechSession();
    const tick = (s: number) => Math.round(timeline.tickAtSeconds(s));
    await session.addMarker(tick(1), 'Before');
    await session.addMarker(tick(2.5), 'Inside');
    await session.addMarker(tick(10), 'After');
    const lanes = session.visibleTracks.map((t) => session.playlistFor(t)!.id);
    engine.transactions.length = 0;
    await applyCuts(session, [[2, 3], [5, 6]], { trackUids: session.visibleTracks.map((t) => t.id), laneUids: lanes }, { fadeMs: 0, name: 'Cut', moveMarkers: true, raw: luna.raw });
    await engine.settled();
    expect(engine.transactions).toEqual(['begin', 'commit']);
    const at = Object.fromEntries(session.markers.items.map((m) => [m.name.value, timeline.seconds(m.location.value!)]));
    expect(at).toEqual({ Before: 1, Inside: 2, After: 8 });
  });

  it('computes where a tick lands', () => {
    const cuts = [[100, 200], [500, 600]] as const;
    expect([50, 150, 300, 550, 700].map((t) => rippledTick(t, cuts))).toEqual([50, 100, 200, 400, 500]);
  });
});

describe('source audio', () => {
  it('looks for the source file in the session package', async () => {
    const { engine, luna, session } = await speechSession();
    const pkg = session.sessionPackagePath.value;
    expect(sourcePaths(session, 'src1')[0]).toBe(`${pkg}/audio/src1.wav`);
    engine.mediaFiles[`${pkg}/audio/src1.wav`] = true;
    const found = await sourceUrl(luna, session, 'src1');
    expect(found?.path).toBe(`${pkg}/audio/src1.wav`);
    expect(engine.mediaServed.at(-1)).toMatchObject({ addOnId: ADD_ON_ID });
  });

  it('says so when LUNA cannot serve it', async () => {
    const { luna, session } = await speechSession();
    expect(await sourceUrl(luna, session, 'missing')).toBeUndefined();
  });
});

describe('TranscriptStore', () => {
  it('keeps transcripts with the session', async () => {
    const { engine, session } = await speechSession();
    const store = new TranscriptStore(session);
    const t: Transcript = { sourceUid: 'src1', sourceName: 'speech.wav', duration: 13.458, model: 'nova-3', language: 'en', created: 123, words: [word('Hello', 0.25, 0.5, 1), word('um', 0.75, 1, 1)] };
    await store.save(t);
    await engine.settled();
    const again = await new TranscriptStore(session).load();
    expect(again.get('src1')).toEqual(t);
    await store.remove('src1');
    await engine.settled();
    expect((await new TranscriptStore(session).load()).size).toBe(0);
  });
});

describe('addSpeakerMarkers', () => {
  it('adds one marker per change in one undo step', async () => {
    const { engine, luna, session, timeline } = await speechSession();
    engine.transactions.length = 0;
    await addSpeakerMarkers(session, [{ at: 0, speaker: 0 }, { at: 4, speaker: 1 }], luna.raw);
    await engine.settled();
    await session.markers.load();
    expect(engine.transactions).toEqual(['begin', 'commit']);
    expect(session.markers.items.map((m) => [m.name.value, m.location.value])).toEqual([
      ['Speaker 1', 0],
      ['Speaker 2', Math.round(timeline.tickAtSeconds(4))],
    ]);
  });

  it('adds only the missing markers when pressed again', async () => {
    const { engine, luna, session } = await speechSession();
    expect(await addSpeakerMarkers(session, [{ at: 0, speaker: 0 }, { at: 4, speaker: 1 }], luna.raw)).toBe(2);
    await engine.settled();
    expect(await addSpeakerMarkers(session, [{ at: 0.01, speaker: 0 }, { at: 4, speaker: 1 }, { at: 8, speaker: 0 }], luna.raw)).toBe(1);
    await engine.settled();
    await session.markers.reload();
    expect(session.markers.items).toHaveLength(3);
  });
});
