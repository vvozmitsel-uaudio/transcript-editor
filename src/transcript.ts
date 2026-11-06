// Transcripts and edit planning, with no engine and no DOM.
//
// A transcript belongs to a session *source* (an audio file in the session package), with
// word times in seconds of that file. Edits never change a source, only which parts of it
// the clips play, so a transcript stays valid through every cut, undo and redo. What the
// track says right now comes from mapping each word through the pieces of clips that play
// that source (placeWords). Cuts are planned on those placed words, in session seconds.

export interface Word {
  /** The word as shown, with punctuation and capitals when the service gives them. */
  text: string;
  /** Seconds into the source. */
  start: number;
  end: number;
  /** Speaker number from diarization, 0 when there is none. */
  speaker: number;
  /** 0..1. */
  confidence: number;
  filler: boolean;
}

export interface TranscriptMeta {
  sourceName: string;
  /** Seconds of audio the service transcribed. */
  duration: number;
  model: string;
  language: string;
  /** Epoch ms. */
  created: number;
}

export interface Transcript extends TranscriptMeta {
  sourceUid: string;
  words: Word[];
}

/** What a lane plays of one source, from a compiled clip: [srcStart, srcStop] of the file plays over [start, stop] of the session. */
export interface Piece {
  sourceUid: string;
  /** Seconds into the source. */
  srcStart: number;
  srcStop: number;
  /** Session seconds. */
  start: number;
  stop: number;
}

/** A word where it plays now. */
export interface Placed {
  sourceUid: string;
  /** Index into its transcript's words. */
  index: number;
  text: string;
  speaker: number;
  confidence: number;
  filler: boolean;
  /** Session seconds. */
  start: number;
  end: number;
}

/** A stretch of session time to remove, in seconds. */
export type Range = readonly [number, number];

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'er', 'erm', 'ah', 'eh', 'hmm', 'hm', 'mm', 'mhm']);

/** True for a hesitation sound such as "um" or "uh,", whatever its case or punctuation. */
export function isFiller(text: string): boolean {
  return FILLERS.has(text.toLowerCase().replace(/[^a-z]/g, ''));
}

// ---- storage ------------------------------------------------------------------------------
// Session storage holds any JSON. Words go in as rows of [text, startMs, endMs, speaker,
// confidence %], about a third the size of objects, since an hour of speech is ~9,000 words.

export type WordRow = [string, number, number, number, number];

export function packWords(words: readonly Word[]): WordRow[] {
  return words.map((w) => [w.text, Math.round(w.start * 1000), Math.round(w.end * 1000), w.speaker, Math.round(w.confidence * 100)]);
}

export function unpackWords(rows: unknown): Word[] {
  if (!Array.isArray(rows)) return [];
  const out: Word[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[1] !== 'number' || typeof r[2] !== 'number') continue;
    out.push({ text: r[0], start: r[1] / 1000, end: r[2] / 1000, speaker: Number(r[3]) || 0, confidence: (Number(r[4]) || 0) / 100, filler: isFiller(r[0]) });
  }
  return out;
}

// ---- placing words on the timeline --------------------------------------------------------

/** Session seconds where `srcSec` of the piece's source plays, stretched clips included. */
export function sessionSecondsAt(piece: Piece, srcSec: number): number {
  const srcSpan = piece.srcStop - piece.srcStart;
  const scale = srcSpan > 0 ? (piece.stop - piece.start) / srcSpan : 1;
  return piece.start + (srcSec - piece.srcStart) * scale;
}

/**
 * Every word that plays, in session order. A word plays when the middle of it is inside a
 * piece of its source; a word whose middle was cut out is left out. A source played twice
 * (a copied clip) places its words twice.
 */
export function placeWords(transcripts: ReadonlyMap<string, Transcript>, pieces: readonly Piece[]): Placed[] {
  const out: Placed[] = [];
  for (const piece of pieces) {
    const t = transcripts.get(piece.sourceUid);
    if (!t) continue;
    for (let i = firstEndingAfter(t.words, piece.srcStart); i < t.words.length; i++) {
      const w = t.words[i];
      if (w.start >= piece.srcStop) break;
      const mid = (w.start + w.end) / 2;
      if (mid < piece.srcStart || mid >= piece.srcStop) continue;
      out.push({
        sourceUid: piece.sourceUid, index: i, text: w.text, speaker: w.speaker, confidence: w.confidence, filler: w.filler,
        start: sessionSecondsAt(piece, Math.max(w.start, piece.srcStart)),
        end: sessionSecondsAt(piece, Math.min(w.end, piece.srcStop)),
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function firstEndingAfter(words: readonly Word[], sec: number): number {
  let lo = 0, hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].end <= sec) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Index of the placed word playing at `sec`, else the last one before it, else -1. */
export function wordAt(placed: readonly Placed[], sec: number): number {
  let lo = 0, hi = placed.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (placed[mid].start <= sec) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}

// ---- planning cuts --------------------------------------------------------------------------

export interface CutOptions {
  /** At most this much silence goes with a word on either side, in seconds. */
  maxLead: number;
}

export const DEFAULT_CUT: CutOptions = { maxLead: 0.25 };

/**
 * The session time to remove for placed words p..q (inclusive). It reaches halfway into the
 * silence on each side, no further than `maxLead`, so what is left keeps a natural gap.
 */
export function rangeForWords(placed: readonly Placed[], p: number, q: number, opts: CutOptions = DEFAULT_CUT): Range {
  const first = placed[p], last = placed[q];
  const prev = placed[p - 1], next = placed[q + 1];
  const lo = prev && prev.end <= first.start ? Math.max((prev.end + first.start) / 2, first.start - opts.maxLead) : first.start - (prev ? 0 : opts.maxLead / 2);
  const hi = next && next.start >= last.end ? Math.min((last.end + next.start) / 2, last.end + opts.maxLead) : last.end + (next ? 0 : opts.maxLead / 2);
  return [Math.max(0, lo), hi];
}

/** Ranges for a set of placed-word indices: each run of neighbours is one range. */
export function rangesForSelection(placed: readonly Placed[], indices: Iterable<number>, opts: CutOptions = DEFAULT_CUT): Range[] {
  const sorted = [...new Set(indices)].filter((i) => i >= 0 && i < placed.length).sort((a, b) => a - b);
  const out: Range[] = [];
  for (let k = 0; k < sorted.length; ) {
    let j = k;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    out.push(rangeForWords(placed, sorted[k], sorted[j], opts));
    k = j + 1;
  }
  return mergeRanges(out);
}

/** Every filler word, each run of them as one range. */
export function fillerRanges(placed: readonly Placed[], opts: CutOptions = DEFAULT_CUT): Range[] {
  return rangesForSelection(placed, placed.flatMap((w, i) => (w.filler ? [i] : [])), opts);
}

export interface PauseOptions {
  /** Shorten silences longer than this, in seconds. */
  longerThan: number;
  /** ...down to this. */
  keep: number;
  /**
   * Pieces with no transcript (music, a file not transcribed yet). A gap that overlaps one is
   * not silence as far as anyone knows, so it is left alone.
   */
  unknown?: readonly Piece[];
}

/** The middle of each pause between placed words longer than `longerThan`, leaving `keep`. */
export function pauseRanges(placed: readonly Placed[], opts: PauseOptions): Range[] {
  const keep = Math.min(opts.keep, opts.longerThan);
  const out: Range[] = [];
  for (let i = 1; i < placed.length; i++) {
    const from = placed[i - 1].end, to = placed[i].start;
    if (to - from <= opts.longerThan) continue;
    if (opts.unknown?.some((p) => p.start < to && p.stop > from)) continue;
    out.push([from + keep / 2, to - keep / 2]);
  }
  return out;
}

/** Sorted, with overlapping or touching ranges joined. Ranges shorter than 1 ms are dropped. */
export function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = ranges.filter(([a, b]) => b - a >= 0.001).map(([a, b]) => [a, b] as [number, number]).sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 0.001) last[1] = Math.max(last[1], r[1]);
    else out.push(r);
  }
  return out;
}

/** Seconds the ranges remove in total. */
export function totalSeconds(ranges: readonly Range[]): number {
  return ranges.reduce((sum, [a, b]) => sum + (b - a), 0);
}

/** Session seconds where the speaker changes, with the new speaker, first word included. */
export function speakerChanges(placed: readonly Placed[]): { at: number; speaker: number }[] {
  const out: { at: number; speaker: number }[] = [];
  let current = -1;
  for (const w of placed) {
    if (w.speaker !== current) out.push({ at: w.start, speaker: w.speaker });
    current = w.speaker;
  }
  return out;
}

// ---- export ---------------------------------------------------------------------------------

/** "Speaker 1: ..." paragraphs, a new one at each speaker change or pause over `paragraphGap`. */
export function plainText(placed: readonly Placed[], opts: { speakers: boolean; paragraphGap?: number } = { speakers: true }): string {
  const gap = opts.paragraphGap ?? 2;
  const paras: string[] = [];
  let line: string[] = [];
  let speaker = -1;
  placed.forEach((w, i) => {
    const prev = placed[i - 1];
    if (i > 0 && (w.speaker !== speaker || w.start - (prev?.end ?? 0) > gap)) {
      paras.push(line.join(' '));
      line = [];
    }
    if (!line.length && opts.speakers && (i === 0 || w.speaker !== speaker)) line.push(`${speakerLabel(w.speaker)}:`);
    speaker = w.speaker;
    line.push(w.text);
  });
  if (line.length) paras.push(line.join(' '));
  return paras.join('\n\n');
}

export function speakerLabel(speaker: number): string {
  return `Speaker ${speaker + 1}`;
}

/** SubRip captions in session time, at most `maxWords` words or `maxSeconds` per cue, broken after sentence ends. */
export function srt(placed: readonly Placed[], opts: { maxWords?: number; maxSeconds?: number } = {}): string {
  const maxWords = opts.maxWords ?? 8, maxSeconds = opts.maxSeconds ?? 3.5;
  const cues: Placed[][] = [];
  let cue: Placed[] = [];
  for (const w of placed) {
    const first = cue[0];
    const last = cue[cue.length - 1];
    if (first && (cue.length >= maxWords || w.end - first.start > maxSeconds || w.speaker !== first.speaker || /[.?!]$/.test(last.text) || w.start - last.end > 1)) {
      cues.push(cue);
      cue = [];
    }
    cue.push(w);
  }
  if (cue.length) cues.push(cue);
  return cues.map((c, i) => `${i + 1}\n${timecode(c[0].start)} --> ${timecode(c[c.length - 1].end)}\n${c.map((w) => w.text).join(' ')}\n`).join('\n');
}

export function timecode(sec: number): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** "1:05" or "1:02:05". */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
