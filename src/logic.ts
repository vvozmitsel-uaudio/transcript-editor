// Engine logic with no DOM, so tests can run it against Luna.MockEngine.
//
// `Luna` is the global that vendor/luna.global.js defines; tsconfig.json types it through
// "@uaudio/luna-builder-sdk/global". Do not import the SDK here: the page already loads it.

import { packWords, speakerLabel, unpackWords, type Piece, type Range, type Transcript, type TranscriptMeta } from './transcript';

export const ADD_ON_ID = 'com.vvozmitsel.transcript_editor';
/** The session-storage context transcripts are kept in, one record per source uid. */
export const STORAGE_CONTEXT = `${ADD_ON_ID}.transcripts`;

// ---- what a track plays -------------------------------------------------------------------

export interface LaneView {
  track: Luna.Track;
  lane: Luna.Playlist;
  pieces: Piece[];
  /** Source uids in the order they first play. */
  sourceUids: string[];
}

/** The active lane of `track`, loaded, with what it plays. Undefined for a track with no lane. */
export async function loadLane(session: Luna.Session, track: Luna.Track): Promise<LaneView | undefined> {
  const lane = session.playlistFor(track);
  if (!lane) return undefined;
  await lane.clips.load();
  await lane.compiledClips.load();
  return { track, lane, ...lanePieces(session, lane) };
}

/**
 * The audio pieces a lane plays, from its compiled clips: what LUNA has resolved after
 * overlaps, so a clip hidden under another contributes nothing (docs/CLIPS.md §1).
 */
export function lanePieces(session: Luna.Session, lane: Luna.Playlist): { pieces: Piece[]; sourceUids: string[] } {
  const timeline = session.musical.timeline;
  const pieces: Piece[] = [];
  for (const seg of lane.compiledClips.inOrder()) {
    const clip = lane.clips.byId(seg.clipUid.value ?? '');
    const sourceUid = clip?.sourceUid.value;
    const type = clip?.clipType.value;
    if (!clip || !sourceUid || (type !== undefined && type !== 'audio')) continue;
    const start = seg.start.value, stop = seg.stop.value, srcStart = seg.sourceStart.value, srcStop = seg.sourceStop.value;
    if (start === undefined || stop === undefined || srcStart === undefined || srcStop === undefined || !(stop > start)) continue;
    pieces.push({ sourceUid, srcStart: srcStart / 1e9, srcStop: srcStop / 1e9, start: timeline.seconds(start), stop: timeline.seconds(stop) });
  }
  const sourceUids = [...new Set(pieces.map((p) => p.sourceUid))];
  return { pieces, sourceUids };
}

// ---- reading a source's audio ---------------------------------------------------------------

/**
 * Where LUNA keeps a source's file: `<session package>/audio/<source uid>.<format>`. This is
 * the session package's layout as found on disk, not an API; the SDK has no call that gives a
 * page a source's audio (see README, "Notes for the LUNA team").
 */
export function sourcePaths(session: Luna.Session, sourceUid: string): string[] {
  const pkg = session.sessionPackagePath.value;
  if (!pkg) return [];
  return ['wav', 'aif', 'aiff'].map((ext) => `${pkg}/audio/${sourceUid}.${ext}`);
}

/** A URL the page can read the source's file from, or undefined when LUNA cannot serve one. */
export async function sourceUrl(luna: Luna.Client, session: Luna.Session, sourceUid: string): Promise<{ url: string; path: string } | undefined> {
  for (const path of sourcePaths(session, sourceUid)) {
    try {
      return { url: await luna.gui.serveMediaFile(ADD_ON_ID, path), path };
    } catch { /* try the next extension */ }
  }
  return undefined;
}

// ---- cutting ----------------------------------------------------------------------------------

export interface CutScope {
  /** Tracks whose content is cut and closed up. */
  trackUids: string[];
  /** Their active lanes. */
  laneUids: string[];
}

export interface CutOptions {
  /** Crossfade at each new edit, in ms; 0 for none. */
  fadeMs: number;
  /** The undo step's name. */
  name: string;
  /**
   * Move markers after each cut back with the audio. LUNA's move_clips leaves markers where
   * they are (measured on LUNA 3.1.1), which is right when one track of several is cut and
   * wrong when the whole session is.
   */
  moveMarkers?: boolean;
  /** For moving markers: LUNA's raw connection, since marker.moveTo waits for a list a batch holds back. */
  raw?: Luna.Client['raw'];
}

/** Where a tick lands after the cuts ([start, stop] ticks): later by none, inside one at its start. */
export function rippledTick(tick: number, cuts: readonly (readonly [number, number])[]): number {
  let t = tick;
  for (const [a, b] of [...cuts].sort((x, y) => y[0] - x[0])) {
    if (t >= b) t -= b - a;
    else if (t > a) t = a;
  }
  return t;
}

/**
 * Remove each range (session seconds) from the scope's tracks and close the gap, as one undo
 * step. Per range, latest first so earlier ranges keep their ticks: select the range and
 * clear it (LUNA splits at both ends and deletes what is between), move everything after it
 * back by its length, then crossfade the new edit. Each verb takes a range, never a clip uid,
 * because a batch transaction shows none of its edits until the commit.
 * Returns the number of ranges cut.
 */
export async function applyCuts(session: Luna.Session, ranges: readonly Range[], scope: CutScope, opts: CutOptions): Promise<number> {
  const timeline = session.musical.timeline;
  const cuts = ranges
    .map(([a, b]) => [Math.max(0, Math.round(timeline.tickAtSeconds(a))), Math.round(timeline.tickAtSeconds(b))] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => y[0] - x[0]);
  if (!cuts.length || !scope.trackUids.length) return 0;

  const lanes = scope.laneUids.map((id) => session.playlists.byId(id)).filter((l): l is Luna.Playlist => !!l);
  for (const lane of lanes) await lane.clips.load();
  // Past every clip, so the move takes everything after a cut.
  const lastStop = Math.max(0, ...lanes.flatMap((l) => l.clips.items.map((c) => c.stop.value ?? 0)), session.transport.maxTick.value ?? 0);
  const end = lastStop + 4 * Luna.WHOLE_NOTE;

  const markerMoves: { rowid: number; location: number }[] = [];
  if (opts.moveMarkers && opts.raw) {
    await session.markers.load();
    for (const m of session.markers.items) {
      const from = m.location.value, rowid = m.rowid.value ?? Number(m.id);
      if (from === undefined || !Number.isFinite(rowid)) continue;
      const to = rippledTick(from, cuts);
      if (to !== from) markerMoves.push({ rowid, location: to });
    }
  }

  const context = session.context;
  await context.refreshSelection().catch(() => {});
  const saved = context.snapshot();
  try {
    await session.transaction(opts.name, async () => {
      for (const [a, b] of cuts) {
        await context.select({ startTick: a, stopTick: b, trackUids: scope.trackUids, playlistUids: scope.laneUids, focus: 'timeline' });
        await context.clear();
        await session.moveClips(a, { startTick: b, stopTick: end, trackUids: scope.trackUids });
        if (opts.fadeMs > 0) {
          // LUNA's batch fades crossfade butted clips, clamped to the range given.
          const half = Math.max(1, Math.round(timeline.tickAtSeconds(timeline.seconds(a) + opts.fadeMs / 2000)) - a);
          for (const lane of lanes) await lane.addFades({ startTick: a - half, stopTick: a + half, lengthNs: opts.fadeMs * 1e6 });
        }
      }
      for (const m of markerMoves) await opts.raw!.post(`/sessions/${session.uid}/set_marker`, { session_uid: session.uid, rowid: m.rowid, location: m.location });
    });
  } finally {
    await context.restore(saved).catch(() => {});
  }
  // LUNA held the batch's pushes until the commit; read the lanes again rather than wait.
  for (const lane of lanes) {
    await lane.clips.reload();
    await lane.compiledClips.reload();
  }
  if (markerMoves.length) await session.markers.reload();
  return cuts.length;
}

// ---- markers --------------------------------------------------------------------------------

/**
 * A marker at each speaker change (session seconds), named "Speaker N", as one undo step.
 * Posts set_marker directly: session.addMarker waits for the marker to be listed, which a
 * batch transaction holds until its commit.
 */
export async function addSpeakerMarkers(session: Luna.Session, changes: readonly { at: number; speaker: number }[], raw: Luna.Client['raw']): Promise<number> {
  const timeline = session.musical.timeline;
  await session.markers.load();
  // Pressing it again adds only what is missing: skip a change with its marker within 50 ms.
  const near = Math.abs(timeline.tickAtSeconds(0.05) - timeline.tickAtSeconds(0));
  const existing = session.markers.items.map((m) => ({ name: m.name.value, at: m.location.value ?? NaN }));
  const todo = changes
    .map((c) => ({ location: Math.max(0, Math.round(timeline.tickAtSeconds(c.at))), name: speakerLabel(c.speaker) }))
    .filter((c) => !existing.some((m) => m.name === c.name && Math.abs(m.at - c.location) <= near));
  if (!todo.length) return 0;
  await session.transaction('Speaker markers', async () => {
    for (const c of todo) await raw.post(`/sessions/${session.uid}/set_marker`, { session_uid: session.uid, location: c.location, name: c.name });
  });
  await session.markers.reload();
  return todo.length;
}

// ---- transcripts kept with the session ------------------------------------------------------

/**
 * Transcripts in session storage, so they travel with the session and come back when it
 * reopens (fact 110). Not undoable: a transcript describes a source, which edits never change.
 */
export class TranscriptStore {
  private readonly context: Luna.StorageContext;
  constructor(session: Luna.Session) {
    this.context = session.storage.context(STORAGE_CONTEXT);
  }

  async load(): Promise<Map<string, Transcript>> {
    await this.context.load();
    const out = new Map<string, Transcript>();
    for (const uid of this.context.records.value ?? []) {
      const t = this.read(uid);
      if (t) out.set(uid, t);
    }
    return out;
  }

  read(sourceUid: string): Transcript | undefined {
    const meta = this.context.value<Partial<TranscriptMeta> | null>(sourceUid, 'meta').value;
    const words = unpackWords(this.context.value(sourceUid, 'words').value);
    // A file with no speech keeps its empty transcript, so it is not sent to Deepgram again.
    if (!meta) return undefined;
    return {
      sourceUid,
      sourceName: String(meta.sourceName ?? ''),
      duration: Number(meta.duration ?? 0),
      model: String(meta.model ?? ''),
      language: String(meta.language ?? ''),
      created: Number(meta.created ?? 0),
      words,
    };
  }

  async save(t: Transcript): Promise<void> {
    const meta: TranscriptMeta = { sourceName: t.sourceName, duration: t.duration, model: t.model, language: t.language, created: t.created };
    // add_field creates the field and leaves an existing one alone, so set after it.
    await this.context.add(t.sourceUid, 'meta', meta);
    await this.context.add(t.sourceUid, 'words', null);
    await this.context.set(t.sourceUid, 'words', packWords(t.words));
    await this.context.set(t.sourceUid, 'meta', meta);
  }

  async remove(sourceUid: string): Promise<void> {
    await this.context.remove(sourceUid);
  }
}
