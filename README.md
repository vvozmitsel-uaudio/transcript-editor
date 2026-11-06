# Transcript Editor

A [LUNA](https://www.uaudio.com/luna) Add On for editing dialogue by editing text. It
transcribes a track with [Deepgram](https://deepgram.com) and shows the words in a panel under
LUNA's timeline. Select words and press Delete, and the audio is cut, the gap closed and the
edit crossfaded, as one undo step in LUNA.

> Transcript Editor is a community project. It is not made or supported by Universal Audio or
> Deepgram.

## Features

- **Transcribe** the selected track. The panel follows the track you select in LUNA and
  transcribes the audio files its clips play, with punctuation, speaker labels and filler
  words.
- **Cut words.** Select any words and press **Delete** (or **Cut selection**). The audio goes,
  later clips move up to close the gap, and the new edit gets a short crossfade.
- **Remove fillers** cuts every "um", "uh" and "hmm" at once.
- **Tighten pauses** shortens every silence longer than a limit you set. The pauses it will
  shorten show in the transcript as yellow marks, such as `[2.0s]`.
- **Speaker markers** adds a LUNA marker wherever a new speaker starts.
- **One undo step each.** Every action above, however many edits it makes, is a single ⌘Z in
  LUNA, and the transcript follows the undo.
- **It keeps up with LUNA.** Move, trim, slip or delete clips in LUNA and the transcript
  updates: it shows what the track plays now.
- **Click a word** to move the playhead there. The word being played is highlighted.
- **Find** words in the transcript; Enter jumps to the next match.
- **Copy text** or **Copy SRT**: captions timed to the edited session, ready for a video.
- Transcripts are **saved in the session**, so they come back when you reopen it, and you are
  not charged for the same audio twice.

## Install

1. You need **LUNA 3.1.1 or newer**, with its latest update. (An older build of 3.1.1 cannot save
   transcripts: Transcribe ends with `uasrv.invalid_object`.)
2. Download `transcript-editor.lunaaddon` from the [latest release](../../releases/latest) and
   double-click it. LUNA installs it.
3. Open it from **Add Ons > Editors > Transcript Editor**. It opens in the editor panel under
   the timeline.
4. Get a Deepgram API key: sign up at <https://console.deepgram.com/signup> (new accounts get
   free credit), open **API Keys**, create a key and paste it into the Add On's **Settings**.

The key is checked with Deepgram, then saved in your system keychain through LUNA, where only
this Add On can read it.

## Good to know

- **Your audio is uploaded to Deepgram** when you press Transcribe, and is processed under
  your Deepgram account and its terms. Nothing is uploaded until then. Transcripts are kept in
  the session file, not online.
- **Settings** has the language (or Multilingual), whether cuts apply to **this track only**
  or to **all audio tracks**, the crossfade length, and the pause limits. With all tracks, markers
  after a cut move with the audio. With this track only, other tracks and markers stay where
  they are.
- **Accuracy.** Words with low confidence are underlined. Check a cut by ear: timings are
  Deepgram's, usually within a few hundredths of a second.
- **What gets transcribed** is each audio file on the track's active playlist, in full, once.
  Cut words stay in the saved transcript, so ⌘Z brings them back. To transcribe a track again
  (another language, say), use **Settings > Discard transcript**, then **Transcribe**.

## Known limitations

- Keep the panel open while it transcribes. Closing it, or opening another editor Add On in
  its place, cancels the job.
- With **all audio tracks**, instrument (MIDI) tracks, automation and tempo changes are not
  moved by a cut, so they can drift out of step after it.
- Deepgram numbers speakers separately in each file, so with several files on one track,
  "Speaker 1" in one file and in another can be different people.
- Cuts follow Deepgram's word timings. Listen back to each one: very fast speech can leave a
  breath or clip a consonant.

## Build from source

TypeScript, built with [Vite](https://vite.dev) into one classic script, on the LUNA Builder
SDK (`@uaudio/luna-builder-sdk`, 3.1.1 or newer). The SDK is not on npm: `package.json` points
to a local copy under `devDependencies`. Edit that `file:` path to match yours.

```sh
npm install
cp "<path to SDK>/dist/luna.global.js" vendor/   # the SDK bundle the page loads
npm test                 # unit tests on the SDK's mock engine, Deepgram faked
npm run build            # type-check, then src/ -> dist/main.js
npx ua-builder serve     # http://localhost:8790/ (LUNA running = live data)
npm run test:page        # with serve running: the page end to end in headless Chrome
npx ua-builder install   # link this folder into LUNA's Add Ons folder
npm run pack             # build, then transcript-editor.lunaaddon for a release
```

| Path | Purpose |
|---|---|
| `manifest.json` | What LUNA reads: id, name, `editor` target. |
| `index.html` | The panel and its styles. Loads `vendor/luna.global.js`, then `dist/main.js`. |
| `src/transcript.ts` | No engine, no DOM: words placed through what plays, cut ranges, fillers, pauses, text and SRT. |
| `src/logic.ts` | Engine logic: what a lane plays, reading a source's audio, cutting, markers, saving transcripts. |
| `src/deepgram.ts` | Deepgram pre-recorded API client and reply parsing. |
| `src/main.ts` | DOM wiring. |
| `tests/*.test.ts` | Vitest on `Luna.MockEngine` and a fake `fetch`. No LUNA or key needed. |
| `tests/probe/` | `npm run test:page`: the built page on the mock engine with Deepgram faked. |

### How it works

- **A transcript belongs to an audio file, not a clip.** Word times are seconds into the
  session's source file, and edits never change a source. The panel maps each word through the
  pieces of clips that play it now (`playlist.compiledClips`), so a transcript survives every
  cut, move, undo and redo.
- **A cut is three range commands in one transaction:** select the range on the timeline and
  `context.clear()` it (LUNA splits at both ends and deletes the middle), `session.moveClips()`
  everything after it back, then `playlist.addFades()` across the new edit for the crossfade.
  Several cuts run latest first, so the earlier ones keep their positions. Ranges, never clip
  ids, because a batch transaction shows none of its results until it commits.
- **Getting the audio.** The page asks LUNA to serve the source file from the session package
  (`luna.gui.serveMediaFile`), then posts the bytes to Deepgram's `/v1/listen` with the key in
  an `Authorization` header. `/v1/listen` answers the CORS preflight for any origin; Deepgram's
  management API (`/v1/projects`...) refuses browser origins, so the key is checked with an
  empty `/v1/listen` post, which Deepgram rejects after accepting the key, for nothing. If LUNA
  cannot serve the file, the panel asks you for the original.

## License

[Apache-2.0](LICENSE). Release builds bundle the LUNA Builder SDK
(`vendor/luna.global.js`, © Universal Audio, Inc., Apache-2.0); see [NOTICE](NOTICE).
