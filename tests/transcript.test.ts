import { describe, expect, it } from 'vitest';
import {
  fillerRanges, isFiller, mergeRanges, packWords, pauseRanges, placeWords, plainText, rangesForSelection, sessionSecondsAt,
  speakerChanges, srt, timecode, unpackWords, wordAt, type Piece, type Placed, type Transcript, type Word,
} from '../src/transcript';

const w = (text: string, start: number, end: number, speaker = 0): Word => ({ text, start, end, speaker, confidence: 0.98, filler: isFiller(text) });
const transcript = (words: Word[], sourceUid = 's1'): Transcript => ({ sourceUid, sourceName: 'a.wav', duration: 10, model: 'nova-3', language: 'en', created: 0, words });
const placedOf = (words: Word[]): Placed[] => placeWords(new Map([['s1', transcript(words)]]), [{ sourceUid: 's1', srcStart: 0, srcStop: 100, start: 0, stop: 100 }]);

describe('isFiller', () => {
  it('knows hesitations whatever their case and punctuation', () => {
    expect(['um', 'Um,', 'uh...', 'Uhm', 'hmm?', 'mhm'].every(isFiller)).toBe(true);
    expect(['umbrella', 'a', 'mum', 'her'].some(isFiller)).toBe(false);
  });
});

describe('packWords', () => {
  it('round-trips at millisecond precision', () => {
    const words = [w('Hello,', 0.123, 0.456, 1), w('um', 0.5, 0.75, 1)];
    expect(unpackWords(JSON.parse(JSON.stringify(packWords(words))))).toEqual(words);
  });
  it('skips rows it cannot read', () => {
    expect(unpackWords([['ok', 0, 10, 0, 90], ['bad'], null, 'x'])).toHaveLength(1);
    expect(unpackWords(null)).toEqual([]);
  });
});

describe('placeWords', () => {
  const words = [w('one', 0, 0.5), w('two', 1, 1.5), w('three', 2, 2.5), w('four', 3, 3.5)];

  it('places words through each piece, in session order', () => {
    const pieces: Piece[] = [
      { sourceUid: 's1', srcStart: 2, srcStop: 4, start: 10, stop: 12 },   // "three four", moved later
      { sourceUid: 's1', srcStart: 0, srcStop: 1.2, start: 0, stop: 1.2 }, // "one", "two" cut through the middle
    ];
    const placed = placeWords(new Map([['s1', transcript(words)]]), pieces);
    expect(placed.map((p) => [p.text, p.start])).toEqual([['one', 0], ['three', 10], ['four', 11]]);
  });

  it('follows a stretched clip', () => {
    const piece: Piece = { sourceUid: 's1', srcStart: 0, srcStop: 4, start: 0, stop: 8 };
    expect(sessionSecondsAt(piece, 3)).toBe(6);
  });

  it('ignores sources with no transcript', () => {
    expect(placeWords(new Map(), [{ sourceUid: 's1', srcStart: 0, srcStop: 4, start: 0, stop: 4 }])).toEqual([]);
  });
});

describe('wordAt', () => {
  it('finds the word at or before a time', () => {
    const placed = placedOf([w('a', 1, 2), w('b', 3, 4)]);
    expect([0.5, 1, 2.5, 3.2, 9].map((s) => wordAt(placed, s))).toEqual([-1, 0, 0, 1, 1]);
  });
});

describe('cut ranges', () => {
  const placed = placedOf([w('So,', 0, 0.4), w('um,', 1.0, 1.3), w('today', 1.5, 1.9), w('we', 2.0, 2.2), w('uh', 4.0, 4.2), w('talk.', 4.3, 4.7)]);

  it('takes half the silence on each side, at most maxLead', () => {
    // um: from halfway between "So," and it (0.7), capped at 0.25 before it (0.75); to halfway to "today" (1.4).
    expect(rangesForSelection(placed, [1])).toEqual([[0.75, 1.4]]);
  });

  it('joins neighbouring words into one range', () => {
    expect(rangesForSelection(placed, [3, 2])).toEqual([[1.4, 2.45]]);
  });

  it('finds every filler', () => {
    expect(fillerRanges(placed).map(([a, b]) => [+a.toFixed(3), +b.toFixed(3)])).toEqual([[0.75, 1.4], [3.75, 4.25]]);
  });

  it('shortens long pauses, keeping some silence', () => {
    const [[a, b], ...rest] = pauseRanges(placed, { longerThan: 1, keep: 0.4 });
    expect([a, b]).toEqual([expect.closeTo(2.4, 9), expect.closeTo(3.8, 9)]);
    expect(rest).toEqual([]);
  });

  it('leaves a gap alone when untranscribed audio plays in it', () => {
    const music: Piece = { sourceUid: 'm', srcStart: 0, srcStop: 1, start: 3, stop: 3.5 };
    expect(pauseRanges(placed, { longerThan: 1, keep: 0.4, unknown: [music] })).toEqual([]);
    expect(pauseRanges(placed, { longerThan: 1, keep: 0.4, unknown: [{ ...music, start: 8, stop: 9 }] })).toHaveLength(1);
  });

  it('merges overlapping ranges', () => {
    expect(mergeRanges([[3, 4], [1, 2], [1.5, 2.5], [5, 5.0001]])).toEqual([[1, 2.5], [3, 4]]);
  });
});

describe('export', () => {
  const placed = placedOf([w('Hi', 0, 0.3), w('there.', 0.4, 0.8), w('Hello!', 1, 1.4, 1), w('Bye.', 5, 5.3, 1)]);

  it('writes paragraphs with speakers', () => {
    expect(plainText(placed)).toBe('Speaker 1: Hi there.\n\nSpeaker 2: Hello!\n\nBye.');
  });

  it('writes SubRip captions in session time', () => {
    expect(srt(placed)).toBe('1\n00:00:00,000 --> 00:00:00,800\nHi there.\n\n2\n00:00:01,000 --> 00:00:01,400\nHello!\n\n3\n00:00:05,000 --> 00:00:05,300\nBye.\n');
    expect(timecode(3725.5)).toBe('01:02:05,500');
  });

  it('lists speaker changes', () => {
    expect(speakerChanges(placed)).toEqual([{ at: 0, speaker: 0 }, { at: 1, speaker: 1 }]);
  });
});
