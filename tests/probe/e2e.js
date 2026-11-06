// Drives the page end to end in headless Chrome against the mock engine, with Deepgram faked
// in the page: save a key, transcribe the Host track, cut a word with Delete, remove fillers,
// add speaker markers. Resolves to what it saw; throws on the first thing that goes wrong.
// ua-builder probe <url> --mock tests/probe/fixture.js --expr "$(cat tests/probe/e2e.js)"
(async () => {
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, what, ms = 8000) => {
    const end = Date.now() + ms;
    while (!fn()) { if (Date.now() > end) throw new Error(`timed out: ${what}; status "${$('status').textContent}"`); await sleep(50); }
  };
  const words = () => [...document.querySelectorAll('.w')].map((s) => s.textContent);

  // LUNA serves the session's file at a ua-content:// URL, which headless Chrome cannot load.
  const wav = new Blob([new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69])], { type: 'audio/wav' });
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    return open.call(this, method, String(url).startsWith('ua-content:') ? URL.createObjectURL(wav) : url, ...rest);
  };
  const seen = [];
  const said = [['So,', 0.2, 0.5, 0], ['um,', 0.9, 1.2, 0], ['today', 1.6, 2.0, 0], ['we', 2.1, 2.3, 0], ['talk.', 2.4, 2.9, 0], ['Uh,', 5.0, 5.3, 1], ['great.', 5.6, 6.1, 1]];
  window.fetch = async (url, init = {}) => {
    url = String(url);
    seen.push({ url, method: init.method ?? 'GET', auth: (init.headers ?? {})['Authorization'], type: (init.headers ?? {})['Content-Type'] });
    if (url.includes('/v1/listen') && init.body && init.body.byteLength === 0) return Response.json({ err_msg: 'no audio' }, { status: 400 });
    if (url.includes('/v1/listen')) {
      return Response.json({ metadata: { duration: 10, model_info: { x: { arch: 'nova-3' } } }, results: { channels: [{ alternatives: [{ words: said.map(([w, start, end, speaker]) => ({ word: w.toLowerCase().replace(/[^a-z]/g, ''), punctuated_word: w, start, end, speaker, confidence: 0.95 })) }] }] } });
    }
    return new Response('{}', { status: 404 });
  };

  const out = {};
  await until(() => $('track').textContent === 'Host', 'the focused track');
  out.coverage = $('coverage').textContent;

  $('transcribe').click(); // no key yet: opens Settings
  await until(() => $('settings').open, 'settings to open without a key');
  $('key-input').value = 'test-key';
  $('save-key').click();
  await until(() => $('key-state').textContent === 'Deepgram ✓', 'the key to save');
  $('close-settings').click();
  await sleep(100);

  $('transcribe').click();
  await until(() => document.querySelectorAll('.w').length === said.length, 'the transcript');
  out.transcript = words().join(' ');
  out.listen = seen.find((s) => s.url.includes('/v1/listen'));

  const um = document.querySelectorAll('.w')[1];
  const range = document.createRange();
  range.selectNodeContents(um);
  getSelection().removeAllRanges();
  getSelection().addRange(range);
  await sleep(50);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true }));
  await until(() => /^Cut/.test($('status').textContent) && !words().includes('um,'), 'the cut');
  out.afterCut = words().join(' ');

  $('fillers').click();
  await until(() => /^Removed fillers/.test($('status').textContent), 'filler removal');
  await until(() => !words().includes('Uh,'), 'fillers to leave the transcript');
  out.afterFillers = words().join(' ');

  $('markers').click();
  await until(() => /^Added/.test($('status').textContent), 'speaker markers');
  out.markers = $('status').textContent;

  if (out.afterFillers !== 'So, today we talk. great.') throw new Error(`unexpected transcript: ${out.afterFillers}`);
  if (out.listen?.auth !== 'Token test-key' || out.listen?.type !== 'audio/wav') throw new Error(`bad listen request: ${JSON.stringify(out.listen)}`);
  out.listen.auth = 'Token ***';
  return out;
})()
