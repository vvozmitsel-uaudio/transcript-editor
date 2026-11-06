// Transcript Editor: DOM wiring. Follows LUNA's focused track, shows what it says, and turns
// edits to the text into edits to the audio. Engine work lives in logic.ts, transcript maths in
// transcript.ts, Deepgram in deepgram.ts; this file connects them to the page.
//
// npm run build bundles this file and everything it imports into dist/main.js, one classic
// script (an IIFE) that index.html loads after vendor/luna.global.js.

import { audioContentType, DeepgramClient, DeepgramError, SECRET_NAME } from './deepgram';
import { ADD_ON_ID, addSpeakerMarkers, applyCuts, lanePieces, loadLane, sourceUrl, TranscriptStore, type LaneView } from './logic';
import {
  clock, fillerRanges, pauseRanges, placeWords, plainText, rangesForSelection, speakerChanges, speakerLabel, srt, totalSeconds, wordAt,
  type Placed, type Range, type Transcript,
} from './transcript';

function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`index.html has no #${id}`);
  return el as T;
}

// ---- settings (per viewer, so web storage is fine; the API key is not kept here) -----------

interface Settings { language: string; scope: 'track' | 'all'; fadeMs: number; pauseOver: number; pauseKeep: number }
const DEFAULTS: Settings = { language: 'en', scope: 'track', fadeMs: 10, pauseOver: 0.8, pauseKeep: 0.35 };
function loadSettings(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('settings') ?? '{}') }; } catch { return { ...DEFAULTS }; }
}
let settings = loadSettings();
function saveSettings(): void {
  try { localStorage.setItem('settings', JSON.stringify(settings)); } catch { /* private mode */ }
}

// ---- state --------------------------------------------------------------------------------------

let luna: Luna.Client;
let session: Luna.Session | undefined;
let store: TranscriptStore | undefined;
let transcripts = new Map<string, Transcript>();
let view: LaneView | undefined;
let placed: Placed[] = [];
let spans: HTMLElement[] = [];
let apiKey: string | undefined;
let busy = false;
let job: AbortController | undefined;
let nowIndex = -1;

const deepgram = new DeepgramClient(() => apiKey);

const sessionReleases: Luna.Unsubscribe[] = [];
const laneReleases: Luna.Unsubscribe[] = [];
const releaseAll = (list: Luna.Unsubscribe[]) => { for (const u of list.splice(0)) u(); };

// ---- status -------------------------------------------------------------------------------------

function status(text: string, kind: 'info' | 'ok' | 'error' = 'info'): void {
  const el = $('status');
  el.textContent = text;
  el.dataset.kind = kind;
  el.title = text;
  // The footer is easy to miss: flash it when an action finishes.
  if (kind !== 'info') {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
}

function progress(on: boolean, cancellable = false): void {
  $('progress').hidden = !on;
  $('cancel').hidden = !(on && cancellable);
}

function errorText(e: unknown): string {
  if (e instanceof DeepgramError) return e.message;
  const err = e as { code?: string; message?: string };
  if (err?.code === 'uasrv.not_permitted') return 'LUNA did not allow that file.';
  return err?.message ? String(err.message) : String(e);
}

// ---- rendering ------------------------------------------------------------------------------------

function sourceName(uid: string): string {
  return session?.sources?.byId(uid)?.name.value ?? transcripts.get(uid)?.sourceName ?? uid;
}

function missingSources(): string[] {
  return (view?.sourceUids ?? []).filter((uid) => !transcripts.has(uid));
}

/** What Tighten pauses would cut: never across audio that has no transcript. */
function pauses(): Range[] {
  const unknown = (view?.pieces ?? []).filter((p) => !transcripts.has(p.sourceUid));
  return pauseRanges(placed, { longerThan: settings.pauseOver, keep: settings.pauseKeep, unknown });
}

/** Sets text only when it changes: replacing text under the pointer makes WebKit drop clicks. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function recompute(): void {
  if (session && view) Object.assign(view, lanePieces(session, view.lane));
  placed = view ? placeWords(transcripts, view.pieces) : [];
  render();
}

function render(): void {
  const main = $('words');
  main.innerHTML = '';
  spans = [];
  nowIndex = -1;
  const sources = view?.sourceUids ?? [];
  const missing = missingSources();

  setText($('track'), view ? (view.track.name.value ?? 'Track') : session ? 'No audio track' : 'No session');
  const models = [...new Set(trackTranscripts().map((t) => t.model).filter(Boolean))];
  setText($('coverage'), sources.length ? `${sources.length - missing.length} of ${sources.length} file${sources.length === 1 ? '' : 's'} transcribed${models.length ? ` (${models.join(', ')})` : ''}` : '');
  const transcribe = $<HTMLButtonElement>('transcribe');
  if (transcribe.disabled !== (busy || !missing.length)) transcribe.disabled = busy || !missing.length;
  setText(transcribe, missing.length && missing.length < sources.length ? `Transcribe ${missing.length} more` : 'Transcribe');
  updateButtons();

  if (!session) return void (main.innerHTML = '<div class="empty">Open a session in LUNA.</div>');
  if (!view) return void (main.innerHTML = '<div class="empty">Select an <b>audio track</b> in LUNA. The transcript follows the track you select.</div>');
  if (!sources.length) return void (main.innerHTML = `<div class="empty"><b>${escapeHtml(view.track.name.value ?? 'This track')}</b> has no audio clips yet. Record or import some dialogue, then transcribe it here.</div>`);
  if (!placed.length) {
    main.innerHTML = missing.length
      ? '<div class="empty">Press <b>Transcribe</b> to send this track\'s audio to Deepgram. Then select words and press <b>Delete</b> to cut them from the audio, or remove every “um” in one go. Each edit is a single undo step in LUNA.</div>'
      : '<div class="empty">No words play on this track right now.</div>';
    return;
  }

  const frag = document.createDocumentFragment();
  let para: HTMLParagraphElement | undefined;
  let speaker = -1;
  const multipleSpeakers = new Set(placed.map((w) => w.speaker)).size > 1;
  const long = new Set(pauses().map(([, b]) => b));
  placed.forEach((w, i) => {
    const prev = placed[i - 1];
    const gap = prev ? w.start - prev.end : 0;
    if (!para || w.speaker !== speaker || gap > 2.5) {
      para = document.createElement('p');
      para.className = 'para';
      if (multipleSpeakers && w.speaker !== speaker) {
        const label = document.createElement('span');
        label.className = 'spk';
        label.dataset.s = String(w.speaker % 4);
        label.textContent = speakerLabel(w.speaker);
        para.appendChild(label);
      }
      frag.appendChild(para);
      speaker = w.speaker;
    } else {
      para.appendChild(document.createTextNode(' '));
    }
    // Every pause Tighten pauses would shorten, at a paragraph start too: most fall where the
    // speaker changes, and an unmarked one leaves nothing on screen to show the cut happened.
    if (long.has(w.start - Math.min(settings.pauseKeep, settings.pauseOver) / 2)) {
      const g = document.createElement('span');
      g.className = 'gap long';
      g.title = `${gap.toFixed(1)} s of silence. Tighten pauses shortens it to ${settings.pauseKeep} s.`;
      g.textContent = `[${gap.toFixed(1)}s] `;
      para.appendChild(g);
    }
    const span = document.createElement('span');
    span.className = 'w';
    if (w.filler) span.classList.add('filler');
    else if (w.confidence < 0.6) span.classList.add('unsure');
    span.dataset.i = String(i);
    span.textContent = w.text;
    para.appendChild(span);
    spans.push(span);
  });
  main.appendChild(frag);
  markFind();
  followPlayhead(false);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function updateButtons(): void {
  const fillerCount = placed.filter((w) => w.filler).length;
  const pauseCount = pauses().length;
  const sel = selectedIndices();
  const set = (id: string, enabled: boolean, label?: string) => {
    const b = $<HTMLButtonElement>(id);
    const disabled = busy || !enabled;
    if (b.disabled !== disabled) b.disabled = disabled;
    // Only when it changes: this runs on every selectionchange, which fires between mousedown
    // and mouseup when a click collapses the transcript selection. Replacing the button's text
    // node then makes WebKit drop the click.
    if (label !== undefined) setText(b, label);
  };
  set('cut', sel.length > 0, sel.length ? `Cut ${sel.length} word${sel.length === 1 ? '' : 's'}` : 'Cut selection');
  set('fillers', fillerCount > 0, fillerCount ? `Remove fillers (${fillerCount})` : 'Remove fillers');
  set('pauses', pauseCount > 0, pauseCount ? `Tighten pauses (${pauseCount})` : 'Tighten pauses');
  set('markers', new Set(placed.map((w) => w.speaker)).size > 1);
  set('copy-text', placed.length > 0);
  set('copy-srt', placed.length > 0);
}

// ---- playhead -----------------------------------------------------------------------------------

let frame = 0;
function followPlayhead(scroll = true): void {
  if (!session || !placed.length) return;
  let sec: number;
  try { sec = session.transport.seconds; } catch { return; }
  let i = wordAt(placed, sec);
  if (i >= 0 && sec > placed[i].end + 0.5) i = -1;
  if (i === nowIndex) return;
  spans[nowIndex]?.classList.remove('now');
  nowIndex = i;
  const span = spans[i];
  if (!span) return;
  span.classList.add('now');
  if (scroll && session.transport.playing.value) span.scrollIntoView({ block: 'nearest' });
}

async function seekTo(sec: number): Promise<void> {
  if (!session) return;
  const tick = Math.max(0, Math.round(session.musical.timeline.tickAtSeconds(sec)));
  await session.transport.setPlayStart(tick).catch((e) => status(errorText(e), 'error'));
}

// ---- selection ------------------------------------------------------------------------------------

function selectedIndices(): number[] {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
  const main = $('words');
  if (!main.contains(sel.anchorNode) && !main.contains(sel.focusNode)) return [];
  const out: number[] = [];
  for (const span of spans) if (sel.containsNode(span, true)) out.push(Number(span.dataset.i));
  return out;
}

// ---- binding to LUNA ------------------------------------------------------------------------------

let refreshTimer = 0;
function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(recompute, 60);
}

let trackBinding = 0;
async function bindTrack(): Promise<void> {
  const mine = ++trackBinding;
  releaseAll(laneReleases);
  const track = session?.focusedTrack.value;
  let next: LaneView | undefined;
  if (session && track && track.trackType.value !== 'instrument') next = await loadLane(session, track).catch(() => undefined);
  if (mine !== trackBinding) return; // the focus moved on while this one loaded
  view = next;
  if (view) {
    laneReleases.push(view.lane.clips.onChange(scheduleRefresh));
    laneReleases.push(view.lane.compiledClips.onChange(scheduleRefresh));
    laneReleases.push(view.track.name.onChange(() => setText($('track'), view?.track.name.value ?? '')));
  }
  recompute();
}

let sessionBinding = 0;
let boundUid: string | undefined | null = null; // null: never bound
async function bindSession(): Promise<void> {
  const next = luna.sessions.current();
  // The session list changes for other reasons too (a session saved or renamed): only rebind
  // when the session itself changes, so a running transcription is not cancelled for nothing.
  if (boundUid !== null && next?.uid === boundUid) return;
  boundUid = next?.uid;
  const mine = ++sessionBinding;
  releaseAll(sessionReleases);
  releaseAll(laneReleases);
  job?.abort();
  session = next;
  view = undefined;
  store = undefined;
  transcripts = new Map();
  if (!session) {
    status('No session open in LUNA.');
    return render();
  }
  const s = session;
  try {
    await s.ready();
    const st = new TranscriptStore(s);
    const loaded = await st.load().catch((e) => {
      status(`Could not read saved transcripts: ${errorText(e)}`, 'error');
      return new Map<string, Transcript>();
    });
    if (mine !== sessionBinding) return; // another session took over while this one loaded
    store = st;
    transcripts = loaded;
  } catch (e) {
    if (mine === sessionBinding) status(`Could not open the session: ${errorText(e)}`, 'error');
    return;
  }
  sessionReleases.push(s.focusedTrack.onChange(() => void bindTrack()));
  sessionReleases.push(s.playlists.onChange(() => void bindTrack()));
  sessionReleases.push(s.musical.timeline.onChange(scheduleRefresh));
  sessionReleases.push(s.transport.location.onChange(() => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => followPlayhead());
  }));
  await bindTrack();
  status(transcripts.size ? `${transcripts.size} saved transcript${transcripts.size === 1 ? '' : 's'} in “${s.name.value ?? ''}”.` : `Connected to “${s.name.value ?? ''}”.`);
}

// ---- transcribing -----------------------------------------------------------------------------------

function readBlob(url: string, signal: AbortSignal): Promise<Blob> {
  // XMLHttpRequest, not fetch: on Windows LUNA serves media as file:///, which fetch refuses.
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', url);
    xhr.responseType = 'blob';
    xhr.onload = () => (xhr.response ? resolve(xhr.response as Blob) : reject(new Error(`Cannot read ${url}`)));
    xhr.onerror = () => reject(new Error('LUNA did not serve the audio file.'));
    if (signal.aborted) return reject(new DeepgramError('aborted', 'Cancelled.'));
    signal.addEventListener('abort', () => { xhr.abort(); reject(new DeepgramError('aborted', 'Cancelled.')); }, { once: true });
    xhr.send();
  });
}

function mediaSeconds(url: string): Promise<number> {
  return new Promise((resolve) => {
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => resolve(a.duration);
    a.onerror = () => resolve(NaN);
    a.src = url;
  });
}

function pickFile(signal: AbortSignal): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = $<HTMLInputElement>('file');
    input.value = '';
    input.onchange = () => resolve(input.files?.[0]);
    // Not every browser sends cancel: Cancel in the footer ends the wait too.
    input.oncancel = () => resolve(undefined);
    signal.addEventListener('abort', () => resolve(undefined), { once: true });
    input.click();
  });
}

/** The audio of a source: from the session package, or from a file the user points at. */
async function audioFor(s: Luna.Session, uid: string, signal: AbortSignal): Promise<{ blob: Blob; name: string }> {
  const found = await sourceUrl(luna, s, uid);
  if (found) return { blob: await readBlob(found.url, signal), name: found.path };

  // LUNA would not serve it: a package laid out differently, or no /gui outside LUNA.
  const expected = s.sources?.byId(uid)?.seconds;
  status(`LUNA did not hand over “${sourceName(uid)}”. Choose the original file to transcribe it.`);
  let blob: Blob, name: string, url: string;
  if (await luna.gui.available().catch(() => false)) {
    const [path] = await luna.gui.chooseFiles({ title: `Original file for “${sourceName(uid)}”` });
    if (!path) throw new DeepgramError('aborted', 'Cancelled.');
    url = await luna.gui.serveMediaFile(ADD_ON_ID, path);
    blob = await readBlob(url, signal);
    name = path;
  } else {
    const file = await pickFile(signal);
    if (!file) throw new DeepgramError('aborted', 'Cancelled.');
    blob = file;
    name = file.name;
    url = URL.createObjectURL(file);
  }
  const seconds = await mediaSeconds(url);
  if (expected && Number.isFinite(seconds) && Math.abs(seconds - expected) > Math.max(0.25, expected * 0.005)) {
    throw new Error(`That file is ${clock(seconds)} long, but “${sourceName(uid)}” is ${clock(expected)}. Choose the file it was recorded or imported from.`);
  }
  return { blob, name };
}

async function transcribeMissing(): Promise<void> {
  if (!session || !view || busy) return;
  if (!apiKey) {
    status('Add your Deepgram API key to transcribe.', 'error');
    return openSettings();
  }
  const todo = missingSources();
  if (!todo.length || !store) return;
  const s = session, st = store;
  busy = true;
  job = new AbortController();
  const { signal } = job;
  progress(true, true);
  render();
  let done = 0, seconds = 0;
  try {
    for (const uid of todo) {
      if (signal.aborted) throw new DeepgramError('aborted', 'Cancelled.');
      const label = `“${sourceName(uid)}”${todo.length > 1 ? ` (${done + 1} of ${todo.length})` : ''}`;
      status(`Reading ${label} from the session…`);
      const { blob, name } = await audioFor(s, uid, signal);
      status(`Uploading ${label}, ${(blob.size / 1e6).toFixed(1)} MB, to Deepgram and transcribing…`);
      const result = await deepgram.transcribe(blob, audioContentType(name), { language: settings.language }, signal);
      const t: Transcript = { sourceUid: uid, sourceName: sourceName(uid), duration: result.duration, model: result.model, language: result.language, created: Date.now(), words: result.words };
      await st.save(t);
      if (session !== s) return; // the session changed; the transcript is saved with its own
      transcripts.set(uid, t);
      seconds += result.duration;
      done++;
      recompute();
    }
    status(`Transcribed ${clock(seconds)} of audio. Select words and press Delete to cut them.`, 'ok');
  } catch (e) {
    if (e instanceof DeepgramError && e.code === 'aborted') status(done ? `Stopped after ${done} file${done === 1 ? '' : 's'}.` : 'Cancelled.');
    else status(errorText(e), 'error');
    if (e instanceof DeepgramError && e.code === 'bad_key') { apiKey = undefined; renderKeyState(); }
  } finally {
    busy = false;
    job = undefined;
    progress(false);
    recompute();
  }
}

// ---- editing ---------------------------------------------------------------------------------------

function cutScope(): { trackUids: string[]; laneUids: string[] } {
  const s = session!;
  const tracks = settings.scope === 'all'
    ? s.visibleTracks.filter((t) => t.trackType.value !== 'instrument' && s.playlistFor(t))
    : [view!.track];
  return { trackUids: tracks.map((t) => t.id), laneUids: tracks.map((t) => s.playlistFor(t)!.id) };
}

async function cut(ranges: Range[], name: string, what: string): Promise<void> {
  if (!session || !view || busy || !ranges.length) return;
  busy = true;
  updateButtons();
  progress(true);
  status(`${what}…`);
  try {
    const n = await applyCuts(session, ranges, cutScope(), { fadeMs: settings.fadeMs, name, moveMarkers: settings.scope === 'all', raw: luna.raw });
    window.getSelection()?.removeAllRanges();
    status(`${what}: ${n} edit${n === 1 ? '' : 's'}, ${totalSeconds(ranges).toFixed(1)} s shorter. ⌘Z in LUNA undoes it in one step.`, 'ok');
  } catch (e) {
    status(`${what} failed: ${errorText(e)}`, 'error');
  } finally {
    busy = false;
    progress(false);
    recompute();
  }
}

function cutSelection(): void {
  const sel = selectedIndices();
  if (!sel.length) return;
  const words = sel.length === 1 ? `“${placed[sel[0]].text}”` : `${sel.length} words`;
  void cut(rangesForSelection(placed, sel), `Cut ${words}`, `Cut ${words}`);
}

async function speakerMarkers(): Promise<void> {
  if (!session || busy) return;
  busy = true;
  updateButtons();
  try {
    const n = await addSpeakerMarkers(session, speakerChanges(placed), luna.raw);
    status(n ? `Added ${n} speaker marker${n === 1 ? '' : 's'}. ⌘Z removes them.` : 'Every speaker change already has its marker.', 'ok');
  } catch (e) {
    status(`Markers failed: ${errorText(e)}`, 'error');
  } finally {
    busy = false;
    updateButtons();
  }
}

// ---- find -----------------------------------------------------------------------------------------

let hits: number[] = [];
/** The first word of each match: where Enter goes next. */
let starts: number[] = [];
let hitAt = -1;
const bare = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

function markFind(): void {
  for (const i of hits) spans[i]?.classList.remove('hit', 'current');
  hits = [];
  starts = [];
  hitAt = -1;
  const terms = $<HTMLInputElement>('find').value.trim().split(/\s+/).map(bare).filter(Boolean);
  if (!terms.length) return;
  for (let i = 0; i + terms.length <= placed.length; i++) {
    if (!terms.every((t, k) => bare(placed[i + k].text).startsWith(t))) continue;
    starts.push(i);
    for (let k = 0; k < terms.length; k++) hits.push(i + k);
  }
  for (const i of hits) spans[i]?.classList.add('hit');
}

function nextHit(): void {
  if (!starts.length) return status('No matches.');
  for (const el of document.querySelectorAll('.w.current')) el.classList.remove('current');
  hitAt = (hitAt + 1) % starts.length;
  const i = starts[hitAt];
  const n = $<HTMLInputElement>('find').value.trim().split(/\s+/).map(bare).filter(Boolean).length;
  for (let k = 0; k < n; k++) spans[i + k]?.classList.add('current');
  spans[i]?.scrollIntoView({ block: 'center' });
  void seekTo(placed[i].start);
}

// ---- copy -----------------------------------------------------------------------------------------

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) return status(`Could not copy ${what}: the clipboard is not available here.`, 'error');
  }
  status(`Copied ${what}.`, 'ok');
}

// ---- settings dialog ----------------------------------------------------------------------------------

function renderKeyState(): void {
  const el = $('key-state');
  el.textContent = apiKey ? 'Deepgram ✓' : 'No API key';
  el.dataset.kind = apiKey ? 'ok' : 'error';
}

function openSettings(): void {
  $<HTMLSelectElement>('language').value = settings.language;
  $<HTMLSelectElement>('scope').value = settings.scope;
  $<HTMLInputElement>('fade-ms').value = String(settings.fadeMs);
  $<HTMLInputElement>('pause-over').value = String(settings.pauseOver);
  $<HTMLInputElement>('pause-keep').value = String(settings.pauseKeep);
  $('key-msg').textContent = apiKey ? 'A key is saved. Paste a new one to replace it.' : '';
  renderTranscriptInfo();
  $('storage-note').textContent = luna?.secrets.storage === 'keychain'
    ? 'Saved in your system keychain through LUNA, readable only by this Add On.'
    : 'Outside LUNA the key is kept in memory until this page reloads.';
  $<HTMLDialogElement>('settings').showModal();
  if (!apiKey) $('key-input').focus();
}

function readSettings(): void {
  const num = (id: string, fallback: number, min: number, max: number) => {
    const raw = $<HTMLInputElement>(id).value.trim();
    const v = Number(raw);
    return raw && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  };
  settings = {
    language: $<HTMLSelectElement>('language').value || 'en',
    scope: $<HTMLSelectElement>('scope').value === 'all' ? 'all' : 'track',
    fadeMs: num('fade-ms', DEFAULTS.fadeMs, 0, 200),
    pauseOver: num('pause-over', DEFAULTS.pauseOver, 0.2, 10),
    pauseKeep: num('pause-keep', DEFAULTS.pauseKeep, 0, 5),
  };
  saveSettings();
  render();
}

async function saveKey(): Promise<void> {
  const input = $<HTMLInputElement>('key-input');
  const key = input.value.trim();
  const msg = $('key-msg');
  if (!key) return void (msg.textContent = 'Paste a key first.');
  msg.textContent = 'Checking with Deepgram…';
  try {
    if (!(await deepgram.checkKey(key))) return void (msg.textContent = 'Deepgram refused that key.');
    await luna.secrets.set(SECRET_NAME, key);
    apiKey = key;
    input.value = '';
    msg.textContent = 'Saved.';
    renderKeyState();
    render();
    status('Deepgram key saved.', 'ok');
  } catch (e) {
    msg.textContent = errorText(e);
  }
}

async function removeKey(): Promise<void> {
  try {
    await luna.secrets.delete(SECRET_NAME);
  } catch (e) {
    return void ($('key-msg').textContent = `Could not remove the key: ${errorText(e)}`);
  }
  apiKey = undefined;
  renderKeyState();
  $('key-msg').textContent = 'Key removed.';
}

/** The saved transcripts of the files this track plays. */
function trackTranscripts(): Transcript[] {
  return (view?.sourceUids ?? []).flatMap((uid) => transcripts.get(uid) ?? []);
}

function renderTranscriptInfo(): void {
  const list = trackTranscripts();
  $('transcript-info').textContent = list.length
    ? list.map((t) => `“${t.sourceName}”: ${t.words.length} words, ${t.model || 'unknown model'}, ${new Date(t.created).toLocaleString()}.`).join(' ')
    : 'Nothing transcribed on this track yet.';
  $<HTMLButtonElement>('forget').disabled = busy || !list.length;
}

/** Deletes this track's saved transcripts, so Transcribe sends the audio again. Edits stay. */
async function forgetTranscripts(): Promise<void> {
  if (!store || busy) return;
  for (const t of trackTranscripts()) {
    await store.remove(t.sourceUid).catch((e) => status(errorText(e), 'error'));
    transcripts.delete(t.sourceUid);
  }
  renderTranscriptInfo();
  recompute();
  status('Transcript discarded. Press Transcribe to transcribe this track again.');
}

async function openExternal(url: string): Promise<void> {
  try {
    if (luna && (await luna.gui.available())) return void (await luna.gui.openUrl(url));
  } catch { /* fall back */ }
  window.open(url, '_blank', 'noopener');
}

// ---- events -----------------------------------------------------------------------------------------

function wire(): void {
  $('transcribe').onclick = () => void transcribeMissing();
  $('cancel').onclick = () => job?.abort();
  $('cut').onclick = cutSelection;
  $('fillers').onclick = () => void cut(fillerRanges(placed), 'Remove fillers', 'Removed fillers');
  $('pauses').onclick = () => void cut(pauses(), 'Tighten pauses', 'Tightened pauses');
  $('markers').onclick = () => void speakerMarkers();
  $('copy-text').onclick = () => void copy(plainText(placed, { speakers: new Set(placed.map((w) => w.speaker)).size > 1 }), 'the transcript');
  $('copy-srt').onclick = () => void copy(srt(placed), 'captions (SRT)');
  $('open-settings').onclick = openSettings;
  $('close-settings').onclick = () => $<HTMLDialogElement>('settings').close();
  $<HTMLDialogElement>('settings').addEventListener('close', readSettings);
  // A click on the backdrop lands on the dialog itself (its content fills it): close.
  $<HTMLDialogElement>('settings').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) $<HTMLDialogElement>('settings').close();
  });
  $('save-key').onclick = () => void saveKey();
  $('remove-key').onclick = () => void removeKey();
  $('forget').onclick = () => void forgetTranscripts();
  $<HTMLInputElement>('key-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void saveKey(); } });
  $('dg-link').onclick = (e) => { e.preventDefault(); void openExternal('https://console.deepgram.com/signup'); };

  const find = $<HTMLInputElement>('find');
  find.addEventListener('input', markFind);
  find.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); nextHit(); } });

  // A click on a word without dragging moves the playhead there.
  $('words').addEventListener('click', (e) => {
    const span = (e.target as HTMLElement).closest<HTMLElement>('.w');
    if (!span || !window.getSelection()?.isCollapsed) return;
    void seekTo(placed[Number(span.dataset.i)].start);
  });
  document.addEventListener('selectionchange', () => updateButtons());
  // A toolbar press must not touch the transcript selection. Otherwise the selection collapses
  // on mousedown, Cut's label shrinks, the wrapping toolbar reflows, and the button moves out
  // from under the pointer before mouseup: WebKit then sends no click.
  document.querySelector('body > header')!.addEventListener('mousedown', (e) => {
    if ((e.target as HTMLElement).closest('button')) e.preventDefault();
  });

  // Delete cuts the selected words. Other keys go on to LUNA (play, undo...), so they keep
  // working while this panel has the focus.
  document.addEventListener('keydown', (e) => {
    if ($<HTMLDialogElement>('settings').open) return;
    if ((e.key === 'Delete' || e.key === 'Backspace') && !(e.target instanceof HTMLInputElement) && selectedIndices().length) {
      e.preventDefault();
      cutSelection();
    }
  });
}

// ---- start ------------------------------------------------------------------------------------------

async function connect(): Promise<void> {
  for (;;) {
    try {
      luna = await Luna.connect();
      break;
    } catch (e) {
      status(e instanceof Luna.NotRunning ? 'Waiting for LUNA…' : String((e as Error).message ?? e));
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  Luna.bindShortcuts(luna);
  apiKey = (await luna.secrets.get(SECRET_NAME).catch(() => undefined)) || undefined;
  renderKeyState();
  await luna.sessions.ready();
  luna.sessions.focused.onChange(() => void bindSession());
  luna.sessions.items.onChange(() => void bindSession());
  luna.status.onChange(() => {
    if (luna.status.value === 'disconnected') status('Reconnecting to LUNA…');
  });
  await bindSession();
}

wire();
renderKeyState();
void connect();
