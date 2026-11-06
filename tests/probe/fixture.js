// ua-builder probe --mock tests/probe/fixture.js: a two-track interview with one 10 s clip on
// Host, and the Add On installed so LUNA would serve the clip's file to it.
globalThis.LunaMockSetup = (engine) => {
  const TICKS_PER_SECOND = 192e9; // the mock's 120 BPM
  engine.addSession('demo', { name: 'Probe Session', tracks: ['Host', 'Guest'], packageUid: 'pkg' });
  engine.addSource('pkg', 'src1', { name: 'interview.wav', lengthNs: 10e9, stemFormat: 'mono' });
  engine.addNode('/sessions/demo/playlists/pl_Host_1/clips/clip1', {
    properties: { uid: 'clip1', name: 'interview', start: 0, stop: 10 * TICKS_PER_SECOND, source_uid: 'src1', source_start: 0, source_stop: 10e9, clip_type: 0, gain: 0, bypass: false, midi_source_start: 0, layer: 0, mute: false },
  });
  engine.addNode('/gui/add_ons/com.vvozmitsel.transcript_editor', { properties: { name: 'Transcript Editor' } });
  engine.mediaFiles['/tmp/demo.luna/audio/src1.wav'] = true;

  // LUNA's clear on a timeline range deletes the audio in it, splitting clips at both ends
  // (measured on LUNA 3.1.1). The mock's clear deletes MIDI notes only.
  const base = '/sessions/demo';
  let made = 0;
  engine.overrideCommand(`${base}/contexts/main/commands/clear`, () => {
    const ctx = `${base}/contexts/main`;
    const a = Number(engine.value(ctx, 'selection_start')), b = Number(engine.value(ctx, 'selection_stop'));
    const ns = (ticks) => Math.round((ticks / TICKS_PER_SECOND) * 1e9);
    for (const pl of engine.value(ctx, 'selection_playlists') ?? []) {
      for (const uid of engine.children(`${base}/playlists/${pl}/clips`)) {
        const path = `${base}/playlists/${pl}/clips/${uid}`;
        const start = engine.value(path, 'start'), stop = engine.value(path, 'stop'), src = engine.value(path, 'source_start');
        if (stop <= a || start >= b) continue;
        if (start >= a && stop <= b) { engine.removeNode(path); continue; }
        if (start < a && stop > b) {
          const props = Object.fromEntries(engine.propertyNames(path).map((k) => [k, engine.value(path, k)]));
          const id = `cut${++made}`;
          engine.addNode(`${base}/playlists/${pl}/clips/${id}`, { properties: { ...props, uid: id, start: b, source_start: src + ns(b - start) } });
        }
        if (start < a) { engine.setValue(path, 'stop', a); engine.setValue(path, 'source_stop', src + ns(a - start)); }
        else { engine.setValue(path, 'start', b); engine.setValue(path, 'source_start', src + ns(b - start)); }
      }
    }
    return null;
  });
};
