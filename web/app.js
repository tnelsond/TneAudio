// USB Audio Recorder — raw capture + non-destructive processing chain.
const $ = (s) => document.querySelector(s);
const FFT_N = 2048;
const DEFAULTS = {
  inputGain: 0,
  outputGain: 0,
  hpf: { on: true, freq: 80, slope: 12 },
  lpf: { on: false, freq: 16000, slope: 12 },
  denoise: { on: false, reduction: 12, sensitivity: 6, smoothing: 0.6 },
  gate: { on: false, threshold: -50, range: -60, attack: 2, hold: 60, release: 150 },
};
const SCHEMA = [
  { title: 'Levels', items: [
    { path: 'inputGain', label: 'Input trim', min: -24, max: 24, step: 0.5, unit: 'dB' },
    { path: 'outputGain', label: 'Output level', min: -24, max: 24, step: 0.5, unit: 'dB' }] },
  { title: 'High-pass', toggle: 'hpf.on', items: [
    { path: 'hpf.freq', label: 'Cutoff', min: 20, max: 2000, log: true, unit: 'Hz' },
    { path: 'hpf.slope', label: 'Slope', choices: [12, 24], unit: 'dB/oct' }] },
  { title: 'Low-pass', toggle: 'lpf.on', items: [
    { path: 'lpf.freq', label: 'Cutoff', min: 1000, max: 20000, log: true, unit: 'Hz' },
    { path: 'lpf.slope', label: 'Slope', choices: [12, 24], unit: 'dB/oct' }] },
  { title: 'Noise reduction', toggle: 'denoise.on', note: true, items: [
    { path: 'denoise.reduction', label: 'Reduction', min: 0, max: 40, step: 1, unit: 'dB' },
    { path: 'denoise.sensitivity', label: 'Threshold', min: 0, max: 20, step: 0.5, unit: 'dB' },
    { path: 'denoise.smoothing', label: 'Smoothing', min: 0, max: 0.95, step: 0.01, unit: '%' }] },
  { title: 'Noise gate', toggle: 'gate.on', gr: true, items: [
    { path: 'gate.threshold', label: 'Threshold', min: -80, max: 0, step: 1, unit: 'dB' },
    { path: 'gate.range', label: 'Range', min: -80, max: 0, step: 1, unit: 'dB' },
    { path: 'gate.attack', label: 'Attack', min: 0.1, max: 50, log: true, unit: 'ms' },
    { path: 'gate.hold', label: 'Hold', min: 0, max: 500, step: 5, unit: 'ms' },
    { path: 'gate.release', label: 'Release', min: 5, max: 1000, log: true, unit: 'ms' }] },
];

const clone = (o) => JSON.parse(JSON.stringify(o));
const dbToLin = (d) => Math.pow(10, d / 20);
const getPath = (o, p) => p.split('.').reduce((a, k) => a[k], o);
const setPath = (o, p, v) => { const ks = p.split('.'); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };
function mergeDefaults(s) {
  const d = clone(DEFAULTS); if (!s) return d;
  for (const k in d) { if (typeof d[k] === 'object') Object.assign(d[k], s[k] || {}); else if (k in s) d[k] = s[k]; }
  return d;
}
const fmtTime = (t) => { t = Math.max(0, t); const m = Math.floor(t / 60); const s = t - m * 60; return `${m}:${s.toFixed(1).padStart(4, '0')}`; };
function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), ms); }
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ---------- IndexedDB (meta + audio stored separately) ----------
const db = (() => {
  let p;
  const open = () => (p ||= new Promise((res, rej) => {
    const r = indexedDB.open('usb-recorder', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('meta', { keyPath: 'id' }); r.result.createObjectStore('audio', { keyPath: 'id' }); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction(store, mode); const req = fn(t.objectStore(store));
      t.oncomplete = () => res(req && req.result); t.onerror = () => rej(t.error);
    });
  };
  return {
    all: (s) => tx(s, 'readonly', (st) => st.getAll()),
    get: (s, id) => tx(s, 'readonly', (st) => st.get(id)),
    put: (s, v) => tx(s, 'readwrite', (st) => st.put(v)),
    del: (s, id) => tx(s, 'readwrite', (st) => st.delete(id)),
  };
})();

// ---------- DSP helpers ----------
function makeFFT(n) {
  const levels = Math.round(Math.log2(n));
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let x = i, r = 0; for (let b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  return (re, im) => {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) for (let j = i, k = 0; j < i + half; j++, k += step) {
        const c = cos[k], s = sin[k], xr = re[j + half], xi = im[j + half];
        const tr = xr * c + xi * s, ti = xi * c - xr * s;
        re[j + half] = re[j] - tr; im[j + half] = im[j] - ti; re[j] += tr; im[j] += ti;
      }
    }
  };
}
// Average magnitude spectrum over a region — same window/scale as the denoise worklet.
function computeProfile(chs, a, b) {
  const N = FFT_N, hop = N / 4, half = N / 2, fft = makeFFT(N);
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const re = new Float32Array(N), im = new Float32Array(N), acc = new Float64Array(half + 1);
  let frames = 0;
  for (let s = a; s + N <= b; s += hop) for (const ch of chs) {
    for (let i = 0; i < N; i++) { re[i] = ch[s + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= half; k++) acc[k] += Math.hypot(re[k], im[k]);
    frames++;
  }
  if (!frames) return null;
  const p = new Float32Array(half + 1); for (let k = 0; k <= half; k++) p[k] = acc[k] / frames;
  return p;
}

// ---------- Processing chain (shared by live, playback and offline export) ----------
function buildChain(ctx, s, profile, offline) {
  const g = () => ctx.createGain();
  const input = g(), head = g(), inGain = g(), outGain = g(), output = g();
  input.connect(head);
  const bq = (t) => { const f = ctx.createBiquadFilter(); f.type = t; return f; };
  const hp = [bq('highpass'), bq('highpass')], lp = [bq('lowpass'), bq('lowpass')];
  const dn = new AudioWorkletNode(ctx, 'denoise', { processorOptions: { fftSize: FFT_N, profile } });
  const gate = new AudioWorkletNode(ctx, 'gate');
  const all = [head, inGain, ...hp, ...lp, dn, gate, outGain];
  const ids = new Map(all.map((n, i) => [n, i])); ids.set(output, 99);
  let wiring = '';
  const set = (p, v) => { if (offline) p.value = v; else p.setTargetAtTime(v, ctx.currentTime, 0.015); };
  const qs = (slope) => (slope === 24 ? [0.5412, 1.3066] : [Math.SQRT1_2]);
  const chain = {
    input, output, gate, dn, hp, lp,
    apply(s, bypass = false) {
      const ny = ctx.sampleRate / 2 * 0.95;
      set(inGain.gain, dbToLin(s.inputGain)); set(outGain.gain, dbToLin(s.outputGain));
      const hq = qs(s.hpf.slope), lq = qs(s.lpf.slope);
      hq.forEach((q, i) => { set(hp[i].frequency, Math.min(s.hpf.freq, ny)); hp[i].Q.value = q; });
      lq.forEach((q, i) => { set(lp[i].frequency, Math.min(s.lpf.freq, ny)); lp[i].Q.value = q; });
      const P = (n, k) => n.parameters.get(k);
      P(dn, 'reduction').value = s.denoise.reduction;
      P(dn, 'sensitivity').value = s.denoise.sensitivity;
      P(dn, 'smoothing').value = s.denoise.smoothing;
      for (const k of ['threshold', 'range', 'attack', 'hold', 'release']) P(gate, k).value = s.gate[k];
      const seq = [head];
      if (!bypass) {
        seq.push(inGain);
        if (s.hpf.on) seq.push(...hp.slice(0, hq.length));
        if (s.lpf.on) seq.push(...lp.slice(0, lq.length));
        if (s.denoise.on) seq.push(dn);
        if (s.gate.on) seq.push(gate);
        seq.push(outGain);
      }
      seq.push(output);
      const key = seq.map((n) => ids.get(n)).join(',');
      if (key !== wiring) {
        all.forEach((n) => n.disconnect());
        for (let i = 0; i < seq.length - 1; i++) seq[i].connect(seq[i + 1]);
        wiring = key;
      }
      chain.latency = !bypass && s.denoise.on ? FFT_N : 0;
    },
    setProfile(p) { dn.port.postMessage({ profile: p || null }); },
  };
  chain.apply(s);
  return chain;
}

// ---------- App state ----------
let ctx = null, chain = null, anIn = null, anOut = null, speaker = null, recorderNode = null;
let micStream = null, micSrc = null, micToChain = false;
let liveSettings = mergeDefaults(lsGet('liveSettings', null));
let settings = liveSettings;
let takes = [];
let current = null, currentAudio = null, currentBuffer = null;
let playing = null, playPos = 0, selection = null;
let bypassAll = false, loop = false, gateGR = 0;
let recording = null, wakeLock = null;
let monitor = lsGet('monitor', false);

async function ensureCtx(rate) {
  if (ctx && (!rate || ctx.sampleRate === rate)) { if (ctx.state === 'suspended') await ctx.resume(); return; }
  if (ctx) { stopPlayback(); try { await ctx.close(); } catch {} }
  try { ctx = new AudioContext(rate ? { latencyHint: 'interactive', sampleRate: rate } : { latencyHint: 'interactive' }); }
  catch { ctx = new AudioContext({ latencyHint: 'interactive' }); }
  await ctx.audioWorklet.addModule('worklets.js');
  chain = buildChain(ctx, settings, current?.noiseProfile || null, false);
  chain.apply(settings, bypassAll);
  chain.gate.port.onmessage = (e) => { gateGR = e.data.gr; };
  anIn = ctx.createAnalyser(); anIn.fftSize = 2048;
  anOut = ctx.createAnalyser(); anOut.fftSize = 8192; anOut.smoothingTimeConstant = 0.8;
  speaker = ctx.createGain(); speaker.gain.value = 0;
  chain.input.connect(anIn);
  chain.output.connect(anOut); chain.output.connect(speaker); speaker.connect(ctx.destination);
  recorderNode = new AudioWorkletNode(ctx, 'recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  recorderNode.connect(ctx.destination);
  recorderNode.port.onmessage = onRecorderMsg;
  currentBuffer = null; micSrc = null; micToChain = false;
  if (micStream) attachMic();
  updateSpeaker();
}
function attachMic() {
  micSrc = ctx.createMediaStreamSource(micStream);
  micSrc.connect(recorderNode);
  if (!playing) { micSrc.connect(chain.input); micToChain = true; }
}
function updateSpeaker() {
  if (!speaker) return;
  const on = playing ? 1 : micSrc && monitor ? 1 : 0;
  speaker.gain.setTargetAtTime(on, ctx.currentTime, 0.01);
}

// ---------- Devices ----------
async function refreshDevices(activeId) {
  const sel = $('#deviceSelect');
  let devs = [];
  try { devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch {}
  const saved = activeId || lsGet('deviceId', '');
  const isUsb = (d) => /usb|interface|scarlett|focusrite|behringer|zoom|tascam|presonus|motu|rode|shure|audio-technica|blue|yeti/i.test(d.label);
  devs.sort((a, b) => isUsb(b) - isUsb(a));
  sel.innerHTML = '<option value="">System default input</option>' + devs.filter((d) => d.deviceId && d.deviceId !== 'default')
    .map((d, i) => `<option value="${d.deviceId}">${isUsb(d) ? 'USB · ' : ''}${(d.label || `Input ${i + 1}`).replace(/</g, '&lt;')}</option>`).join('');
  if ([...sel.options].some((o) => o.value === saved)) sel.value = saved;
  else { const usb = devs.find(isUsb); if (usb && !lsGet('deviceId', '')) sel.value = usb.deviceId; }
}
async function armMic() {
  if (!navigator.mediaDevices?.getUserMedia) { toast('This browser cannot access audio inputs (needs HTTPS).'); return; }
  try {
    const id = $('#deviceSelect').value;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      deviceId: id ? { exact: id } : undefined,
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 },
    } });
    disarm(true);
    micStream = stream;
    const tr = stream.getAudioTracks()[0], st = tr.getSettings();
    try { await ensureCtx(st.sampleRate); if (!micSrc) attachMic(); }
    catch (e) { ctx = null; await ensureCtx(st.sampleRate); }
    tr.onended = () => { toast('Input device disconnected'); disarm(); };
    $('#deviceInfo').textContent = `${tr.label || 'Input'} · ${st.sampleRate || ctx.sampleRate} Hz · ${st.channelCount || micSrc.channelCount} ch · browser processing off`;
    if (st.deviceId) lsSet('deviceId', id || '');
    await refreshDevices(id);
    updateSpeaker(); updateUI();
  } catch (e) { showInputError(e); }
}
async function showInputError(e) {
  let state = '';
  try { state = (await navigator.permissions.query({ name: 'microphone' })).state; } catch {}
  let msg;
  if (e.name === 'NotAllowedError' || e.name === 'SecurityError') {
    msg = state === 'denied'
      ? (window.AndroidBridge ? 'Microphone permission is off. Open Android Settings → Apps → USB Recorder → Permissions → Microphone → Allow.' : 'Microphone is blocked for this site. Tap the ⓘ / lock icon by the address → Permissions (Site settings) → Microphone → Allow, then reload. Also check Android Settings → Apps → your browser → Permissions → Microphone.')
      : 'The browser refused microphone access. Allow the microphone for this site and for the browser app itself in Android Settings → Apps → your browser → Permissions, then try again.';
  } else if (e.name === 'NotFoundError' || e.name === 'OverconstrainedError') {
    lsSet('deviceId', ''); $('#deviceSelect').value = '';
    msg = 'That input was not found. Re-plug the USB device, tap ↻, and arm again.';
  } else if (e.name === 'NotReadableError') {
    msg = 'The input is in use by another app (or the USB device stalled). Close other audio apps or re-plug it, then try again.';
  } else msg = 'Could not open input: ' + (e.message || e.name);
  $('#deviceInfo').textContent = msg;
  toast(msg, 9000);
}
function disarm(quiet) {
  if (recording) return;
  if (micSrc) { try { micSrc.disconnect(); } catch {} micSrc = null; micToChain = false; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  if (!quiet) { $('#deviceInfo').textContent = 'Input disarmed.'; updateSpeaker(); updateUI(); }
}

// ---------- Recording ----------
async function startRecording() {
  if (!micSrc) await armMic();
  if (!micSrc) return;
  stopPlayback();
  recording = { chunks: [], length: 0, t0: performance.now(), sr: ctx.sampleRate };
  recorderNode.port.postMessage({ cmd: 'start' });
  try { window.AndroidBridge ? AndroidBridge.keepAwake(true) : (wakeLock = await navigator.wakeLock?.request('screen')); } catch {}
  updateUI();
}
function stopRecording() { if (recording) { recording.stopping = true; recorderNode.port.postMessage({ cmd: 'stop' }); updateUI(); } }
function onRecorderMsg(e) {
  const d = e.data;
  if (d.chunk && recording) { recording.chunks.push(d.chunk); recording.length += d.chunk[0].length; }
  if (d.done && recording) finishRecording();
}
async function finishRecording() {
  const r = recording; recording = null;
  try { window.AndroidBridge ? AndroidBridge.keepAwake(false) : await wakeLock?.release(); } catch {} wakeLock = null;
  updateUI();
  if (!r.length) { toast('Nothing was recorded.'); return; }
  const nch = Math.max(...r.chunks.map((c) => c.length));
  const chans = Array.from({ length: nch }, () => new Float32Array(r.length));
  let off = 0;
  for (const c of r.chunks) { for (let ch = 0; ch < nch; ch++) chans[ch].set(c[ch] || c[0], off); off += c[0].length; }
  const n = lsGet('takeCounter', 0) + 1; lsSet('takeCounter', n);
  const meta = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: `Take ${n}`, created: Date.now(),
    sampleRate: r.sr, channels: nch, length: r.length, settings: clone(settings), noiseProfile: null, noiseRegion: null };
  try { await db.put('audio', { id: meta.id, channels: chans }); await db.put('meta', meta); }
  catch (err) { toast('Could not save to storage: ' + err.message); }
  takes.unshift(meta);
  renderTakes();
  await selectTake(meta.id, chans);
}

// ---------- Takes ----------
async function loadTakes() {
  try { takes = (await db.all('meta')).sort((a, b) => b.created - a.created); } catch { takes = []; }
  renderTakes();
}
function fxBadges(s) {
  const b = [];
  if (s.hpf.on) b.push('HP'); if (s.lpf.on) b.push('LP'); if (s.denoise.on) b.push('NR'); if (s.gate.on) b.push('Gate');
  if (s.inputGain || s.outputGain) b.push('Gain');
  return b.map((x) => `<span class="badge">${x}</span>`).join('');
}
function renderTakes() {
  const ul = $('#takeList');
  const live = `<li class="take live ${current ? '' : 'sel'}" data-id=""><div><b>Live input</b><span class="small">Settings for monitoring and new takes</span></div><div class="badges">${fxBadges(liveSettings)}</div></li>`;
  ul.innerHTML = live + takes.map((t) => `<li class="take ${current?.id === t.id ? 'sel' : ''}" data-id="${t.id}">
    <div><b>${t.name.replace(/</g, '&lt;')}</b><span class="small">${fmtTime(t.length / t.sampleRate)} · ${t.channels === 1 ? 'mono' : t.channels + ' ch'} · ${(t.sampleRate / 1000).toFixed(1)} kHz · ${new Date(t.created).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span></div>
    <div class="badges">${fxBadges(mergeDefaults(t.settings))}${t.imported ? '<span class="badge file">File</span>' : ''}</div></li>`).join('');
  $('#takeCount').textContent = takes.length ? takes.length : '';
  $('#takesEmpty').hidden = takes.length > 0;
}
async function selectTake(id, audio) {
  stopPlayback();
  selection = null; playPos = 0;
  if (!id) { current = null; currentAudio = null; settings = liveSettings; }
  else {
    current = takes.find((t) => t.id === id);
    current.settings = mergeDefaults(current.settings);
    settings = current.settings;
    currentAudio = audio ? { channels: audio } : await db.get('audio', id);
    if (!currentAudio) { toast('Audio for this take is missing.'); }
  }
  currentBuffer = null; waveCache = null;
  if (chain) { chain.setProfile(current?.noiseProfile || null); chain.apply(settings, bypassAll); }
  $('#editorCard').hidden = !current;
  if (current) { $('#takeName').value = current.name; $('#takeMeta').textContent = `${fmtTime(current.length / current.sampleRate)} · ${current.sampleRate} Hz · ${current.channels} ch`; }
  $('#fxTarget').textContent = current ? `· ${current.name}` : '· live input';
  renderTakes(); syncControls(); updateSel(); updateUI();
}
let saveTimer;
function settingsChanged() {
  if (chain) chain.apply(settings, bypassAll);
  syncControls();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (current) db.put('meta', current).catch(() => {});
    else lsSet('liveSettings', liveSettings);
    renderTakes();
  }, 300);
}

// ---------- Playback ----------
async function play() {
  if (!currentAudio) return;
  await ensureCtx();
  if (!currentBuffer) {
    const chs = currentAudio.channels;
    currentBuffer = ctx.createBuffer(chs.length, chs[0].length, current.sampleRate);
    chs.forEach((c, i) => currentBuffer.copyToChannel(c, i));
  }
  stopPlayback();
  if (micToChain) { micSrc.disconnect(chain.input); micToChain = false; }
  const src = ctx.createBufferSource(); src.buffer = currentBuffer;
  src.connect(chain.input);
  const dur = currentBuffer.duration;
  const hasSel = selection && selection[1] - selection[0] > 0.05;
  const a = hasSel ? selection[0] : 0, b = hasSel ? selection[1] : dur;
  let start = hasSel ? (playPos >= a && playPos < b ? playPos : a) : (playPos >= dur - 0.01 ? 0 : playPos);
  if (loop) { src.loop = true; src.loopStart = a; src.loopEnd = b; src.start(0, start); }
  else src.start(0, start, b - start);
  playing = { src, t0: ctx.currentTime, offset: start, a, b };
  src.onended = () => { if (playing?.src === src) { playing = null; playPos = hasSel ? a : 0; afterStop(); } };
  updateSpeaker(); updateUI();
}
function curPos() {
  if (!playing) return playPos;
  const t = playing.offset + (ctx.currentTime - playing.t0);
  if (loop && t >= playing.b) return playing.a + ((t - playing.a) % (playing.b - playing.a));
  return Math.min(t, playing.b);
}
function stopPlayback() {
  if (!playing) return;
  playPos = curPos();
  const p = playing; playing = null;
  p.src.onended = null; try { p.src.stop(); } catch {} try { p.src.disconnect(); } catch {}
  afterStop();
}
function afterStop() {
  if (micSrc && !micToChain) { micSrc.connect(chain.input); micToChain = true; }
  updateSpeaker(); updateUI();
}

// ---------- Export ----------
async function renderProcessed() {
  const s = settings, chs = currentAudio.channels, sr = current.sampleRate, len = chs[0].length;
  const lat = s.denoise.on ? FFT_N : 0;
  const octx = new OfflineAudioContext(chs.length, len + lat, sr);
  await octx.audioWorklet.addModule('worklets.js');
  const buf = octx.createBuffer(chs.length, len, sr); chs.forEach((c, i) => buf.copyToChannel(c, i));
  const src = octx.createBufferSource(); src.buffer = buf;
  const ch = buildChain(octx, s, current.noiseProfile || null, true);
  src.connect(ch.input); ch.output.connect(octx.destination); src.start();
  const out = await octx.startRendering();
  return Array.from({ length: out.numberOfChannels }, (_, i) => out.getChannelData(i).slice(lat, lat + len));
}
function encodeWav(chs, sr) {
  const nch = chs.length, len = chs[0].length, block = nch * 3, dataSize = len * block;
  const buf = new ArrayBuffer(44 + dataSize), v = new DataView(buf), u = new Uint8Array(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) u[o + i] = s.charCodeAt(i); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); ws(8, 'WAVE'); ws(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nch, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * block, true); v.setUint16(32, block, true); v.setUint16(34, 24, true);
  ws(36, 'data'); v.setUint32(40, dataSize, true);
  let o = 44, peak = 0;
  for (let i = 0; i < len; i++) for (let c = 0; c < nch; c++) {
    let s = chs[c][i]; const a = Math.abs(s); if (a > peak) peak = a;
    s = s > 1 ? 1 : s < -1 ? -1 : s;
    let x = Math.round(s * 8388607); if (x < 0) x += 16777216;
    u[o++] = x & 255; u[o++] = (x >> 8) & 255; u[o++] = (x >> 16) & 255;
  }
  return { blob: new Blob([buf], { type: 'audio/wav' }), peak };
}
async function deliver(blob, name) {
  if (window.AndroidBridge) { // native app: stream bytes to Android, which shows a Save dialog
    const bytes = new Uint8Array(await blob.arrayBuffer());
    AndroidBridge.beginFile(name);
    const CH = 3 * 262144;
    for (let o = 0; o < bytes.length; o += CH) {
      const part = bytes.subarray(o, o + CH); let bin = '';
      for (let i = 0; i < part.length; i += 32768) bin += String.fromCharCode.apply(null, part.subarray(i, i + 32768));
      AndroidBridge.appendBase64(btoa(bin));
    }
    AndroidBridge.finishFile();
    return;
  }
  const file = new File([blob], name, { type: 'audio/wav' });
  if (/Android|iPhone|iPad/i.test(navigator.userAgent) && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
const safeName = () => (current.name || 'take').replace(/[^\w\- ]+/g, '').trim() || 'take';
async function exportTake(processed) {
  if (!currentAudio) return;
  const btn = processed ? $('#exportBtn') : $('#exportRawBtn'); const label = btn.textContent;
  btn.disabled = true; btn.textContent = processed ? 'Rendering…' : 'Encoding…';
  try {
    const chs = processed ? await renderProcessed() : currentAudio.channels;
    const { blob, peak } = encodeWav(chs, current.sampleRate);
    await deliver(blob, `${safeName()}${processed ? '' : ' (raw)'}.wav`);
    if (peak > 1) toast(`Export clipped (peak +${(20 * Math.log10(peak)).toFixed(1)} dB). Lower the output level and export again.`, 6000);
  } catch (e) { toast('Export failed: ' + e.message); }
  btn.disabled = false; btn.textContent = label;
}

// ---------- Import existing audio files ----------
async function importBuffer(name, ab) {
  await ensureCtx();
  const buf = await ctx.decodeAudioData(ab);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, i) => buf.getChannelData(i).slice());
  const meta = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: name.replace(/\.[^.]+$/, '') || 'Imported', created: Date.now(),
    sampleRate: buf.sampleRate, channels: chans.length, length: buf.length, settings: clone(settings), noiseProfile: null, noiseRegion: null, imported: true };
  await db.put('audio', { id: meta.id, channels: chans }); await db.put('meta', meta);
  takes.unshift(meta);
  return { meta, chans };
}
async function importMany(items) { // items: [{name, load: () => Promise<ArrayBuffer>}]
  let last = null, ok = 0;
  for (const it of items) {
    toast(`Importing ${it.name}…`, 60000);
    try { last = await importBuffer(it.name, await it.load()); ok++; }
    catch (e) { toast(`Could not import ${it.name}: ${e.message || 'unsupported format'}`, 6000); }
  }
  renderTakes();
  if (last) { await selectTake(last.meta.id, last.chans); toast(`Imported ${ok} file${ok === 1 ? '' : 's'}. Your current settings were applied; adjust freely.`); }
}
window.importSharedAudio = (list) => importMany(list.map((x) => ({ name: x.name, load: () => fetch(x.url).then((r) => { if (!r.ok) throw new Error('read failed'); return r.arrayBuffer(); }) })));

// ---------- Controls UI ----------
const logTo = (it, v) => Math.round(1000 * Math.log(v / it.min) / Math.log(it.max / it.min));
const logFrom = (it, x) => it.min * Math.pow(it.max / it.min, x / 1000);
function fmtVal(it, v) {
  if (it.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`;
  if (it.unit === 'ms') return `${v < 10 ? v.toFixed(1) : Math.round(v)} ms`;
  if (it.unit === '%') return `${Math.round(v * 100)}%`;
  if (it.unit === 'dB') return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  return `${v} ${it.unit}`;
}
const ITEMS = new Map();
function renderControls() {
  const root = $('#controls');
  root.innerHTML = SCHEMA.map((g, gi) => `<div class="group" data-g="${gi}">
    <div class="ghead"><span class="gtitle">${g.title}</span>
      ${g.gr ? '<span class="gr" id="gateGR">—</span>' : ''}
      ${g.toggle ? `<label class="switch"><input type="checkbox" data-toggle="${g.toggle}" aria-label="${g.title} on"><span></span></label>` : ''}</div>
    ${g.items.map((it) => { ITEMS.set(it.path, it); return `<div class="ctl">
      <label for="c-${it.path}" data-reset="${it.path}" title="Double-tap to reset">${it.label}</label>
      ${it.choices ? `<div class="seg" id="c-${it.path}">${it.choices.map((c) => `<button type="button" data-choice="${it.path}" data-v="${c}">${c} ${it.unit}</button>`).join('')}</div>`
        : `<input type="range" id="c-${it.path}" data-path="${it.path}" ${it.log ? 'min="0" max="1000" step="1"' : `min="${it.min}" max="${it.max}" step="${it.step}"`}>`}
      <output id="o-${it.path}"></output></div>`; }).join('')}
    ${g.note ? `<div class="note"><span id="dnNote"></span> <button type="button" class="link" id="forgetProfile" hidden>Forget profile</button></div>` : ''}
  </div>`).join('');
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.path) { const it = ITEMS.get(t.dataset.path); setPath(settings, it.path, it.log ? logFrom(it, +t.value) : +t.value); settingsChanged(); }
    if (t.dataset.toggle) { setPath(settings, t.dataset.toggle, t.checked); settingsChanged(); }
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-choice]');
    if (b) { setPath(settings, b.dataset.choice, +b.dataset.v); settingsChanged(); }
    if (e.target.id === 'forgetProfile' && current) { current.noiseProfile = null; current.noiseRegion = null; chain?.setProfile(null); settingsChanged(); drawWave(); }
  });
  root.addEventListener('dblclick', (e) => {
    const p = e.target.dataset?.reset; if (!p) return;
    setPath(settings, p, getPath(DEFAULTS, p)); settingsChanged();
  });
}
function syncControls() {
  for (const [p, it] of ITEMS) {
    const v = getPath(settings, p);
    if (it.choices) document.querySelectorAll(`[data-choice="${p}"]`).forEach((b) => b.classList.toggle('on', +b.dataset.v === v));
    else { const el = document.getElementById('c-' + p); el.value = it.log ? logTo(it, v) : v; }
    document.getElementById('o-' + p).textContent = fmtVal(it, v);
  }
  SCHEMA.forEach((g, gi) => {
    if (!g.toggle) return;
    const on = getPath(settings, g.toggle);
    document.querySelector(`[data-toggle="${g.toggle}"]`).checked = on;
    document.querySelector(`[data-g="${gi}"]`).classList.toggle('off', !on);
  });
  const note = $('#dnNote'), fp = $('#forgetProfile');
  if (current?.noiseProfile) {
    const r = current.noiseRegion; note.textContent = `Noise profile learned from ${r ? (r[1] - r[0]).toFixed(1) + ' s' : 'selection'}.`; fp.hidden = false;
  } else { note.textContent = current ? 'Adaptive mode. For best results, select a stretch of room noise only and tap “Learn noise”.' : 'Adaptive mode while monitoring. Learn a noise profile on a take for best results.'; fp.hidden = true; }
}

// ---------- Waveform ----------
let waveCache = null, drag = null;
function fitCanvas(c) {
  const dpr = window.devicePixelRatio || 1, w = Math.round(c.clientWidth * dpr), h = Math.round(c.clientHeight * dpr);
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; return true; }
  return false;
}
function drawWave() {
  const c = $('#wave'); if (!current || !currentAudio || c.offsetParent === null) return;
  if (fitCanvas(c)) waveCache = null;
  const W = c.width, H = c.height, g = c.getContext('2d'), chs = currentAudio.channels, len = chs[0].length, dur = len / current.sampleRate;
  if (!waveCache) {
    const mins = new Float32Array(W), maxs = new Float32Array(W), spp = len / W;
    for (let x = 0; x < W; x++) {
      let mn = 0, mx = 0; const a = Math.floor(x * spp), b = Math.min(len, Math.floor((x + 1) * spp) + 1);
      const st = Math.max(1, Math.floor((b - a) / 400));
      for (const ch of chs) for (let i = a; i < b; i += st) { const v = ch[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      mins[x] = mn; maxs[x] = mx;
    }
    waveCache = { mins, maxs };
  }
  const cs = getComputedStyle(document.documentElement);
  g.clearRect(0, 0, W, H);
  const tx = (t) => (t / dur) * W;
  if (current.noiseRegion) { const [a, b] = current.noiseRegion; g.fillStyle = cs.getPropertyValue('--noise'); g.fillRect(tx(a), 0, tx(b) - tx(a), H); }
  if (selection) { const [a, b] = selection; g.fillStyle = cs.getPropertyValue('--sel'); g.fillRect(tx(a), 0, Math.max(1, tx(b) - tx(a)), H); }
  g.fillStyle = cs.getPropertyValue('--line'); g.fillRect(0, H / 2, W, 1);
  g.fillStyle = cs.getPropertyValue('--wave');
  const { mins, maxs } = waveCache, m = H / 2 * 0.95;
  for (let x = 0; x < W; x++) { const y1 = H / 2 - maxs[x] * m, y2 = H / 2 - mins[x] * m; g.fillRect(x, y1, 1, Math.max(1, y2 - y1)); }
  if (current.noiseRegion) { g.fillStyle = cs.getPropertyValue('--muted'); g.font = `${11 * (devicePixelRatio || 1)}px system-ui`; g.fillText('noise profile', tx(current.noiseRegion[0]) + 4, 14 * (devicePixelRatio || 1)); }
  const px = tx(curPos()); g.fillStyle = cs.getPropertyValue('--accent'); g.fillRect(px - 1, 0, 2 * (devicePixelRatio || 1), H);
}
function waveTime(e) {
  const r = $('#wave').getBoundingClientRect(); const dur = current.length / current.sampleRate;
  return Math.max(0, Math.min(dur, ((e.clientX - r.left) / r.width) * dur));
}
function updateSel() {
  if (!current) return;
  $('#selInfo').textContent = selection ? `Selection ${fmtTime(selection[0])} – ${fmtTime(selection[1])} (${(selection[1] - selection[0]).toFixed(2)} s)` : 'Drag across the waveform to select. Tap to set the play position.';
  $('#learnBtn').disabled = !selection; $('#clearSelBtn').disabled = !selection;
}

// ---------- Meters & spectrum ----------
const meters = { in: { peak: -90, hold: -90, holdT: 0, clip: 0 }, out: { peak: -90, hold: -90, holdT: 0, clip: 0 } };
const tbuf = new Float32Array(2048);
function readMeter(an, m, now) {
  let pk = 0;
  if (an) { an.getFloatTimeDomainData(tbuf); for (let i = 0; i < tbuf.length; i++) { const a = Math.abs(tbuf[i]); if (a > pk) pk = a; } }
  const db = pk > 0 ? 20 * Math.log10(pk) : -90;
  m.peak = db > m.peak ? db : Math.max(db, m.peak - 1.2);
  if (db >= m.hold || now - m.holdT > 1500) { m.hold = db; m.holdT = now; }
  if (pk >= 0.999) m.clip = now;
}
function drawMeter(c, m, now) {
  fitCanvas(c); const g = c.getContext('2d'), W = c.width, H = c.height;
  const cs = getComputedStyle(document.documentElement);
  const x = (db) => Math.max(0, Math.min(1, (db + 60) / 60)) * W;
  g.fillStyle = cs.getPropertyValue('--well'); g.fillRect(0, 0, W, H);
  const grad = g.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#3fbf7f'); grad.addColorStop(0.7, '#3fbf7f'); grad.addColorStop(0.82, '#e8c547'); grad.addColorStop(0.95, '#ef5b4c');
  g.fillStyle = grad; g.fillRect(0, 0, x(m.peak), H);
  g.fillStyle = cs.getPropertyValue('--ink'); g.fillRect(x(m.hold) - 1, 0, 2, H);
  g.fillStyle = cs.getPropertyValue('--well-tick');
  for (const d of [-48, -36, -24, -18, -12, -6, -3]) g.fillRect(x(d), 0, 1, H);
  if (now - m.clip < 1500) { g.fillStyle = '#ef5b4c'; g.fillRect(W - 8 * (devicePixelRatio || 1), 0, 8 * (devicePixelRatio || 1), H); }
}
let fbuf = null, respF = null, respW = 0;
function drawSpectrum() {
  const c = $('#spectrum'); fitCanvas(c);
  const g = c.getContext('2d'), W = c.width, H = c.height, dpr = devicePixelRatio || 1;
  const cs = getComputedStyle(document.documentElement);
  g.clearRect(0, 0, W, H);
  const fx = (f) => (Math.log(f / 20) / Math.log(1000)) * W;
  g.fillStyle = cs.getPropertyValue('--line'); g.font = `${10 * dpr}px system-ui`;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { g.fillRect(fx(f), 0, 1, H); g.fillStyle = cs.getPropertyValue('--muted'); g.fillText(f >= 1000 ? f / 1000 + 'k' : f, fx(f) + 3 * dpr, H - 4 * dpr); g.fillStyle = cs.getPropertyValue('--line'); }
  if (!ctx || !anOut) return;
  if (!fbuf || fbuf.length !== anOut.frequencyBinCount) fbuf = new Float32Array(anOut.frequencyBinCount);
  anOut.getFloatFrequencyData(fbuf);
  const ny = ctx.sampleRate / 2;
  g.beginPath();
  for (let x = 0; x <= W; x += 2) {
    const f = 20 * Math.pow(1000, x / W), bin = Math.min(fbuf.length - 1, Math.round((f / ny) * fbuf.length));
    const db = Math.max(-110, fbuf[bin]); const y = H - ((db + 110) / 110) * H;
    x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
  }
  g.lineTo(W, H); g.lineTo(0, H); g.closePath();
  g.fillStyle = cs.getPropertyValue('--spec'); g.fill();
  // filter response (HP/LP), scale +6..-36 dB
  const n = Math.ceil(W / 3);
  if (!respF || respW !== n) { respW = n; respF = new Float32Array(n); for (let i = 0; i < n; i++) respF[i] = 20 * Math.pow(1000, i / (n - 1)); }
  const tot = new Float32Array(n).fill(0), mag = new Float32Array(n), ph = new Float32Array(n);
  const add = (f) => { f.getFrequencyResponse(respF, mag, ph); for (let i = 0; i < n; i++) tot[i] += 20 * Math.log10(Math.max(mag[i], 1e-6)); };
  if (!bypassAll) {
    if (settings.hpf.on) chain.hp.slice(0, settings.hpf.slope === 24 ? 2 : 1).forEach(add);
    if (settings.lpf.on) chain.lp.slice(0, settings.lpf.slope === 24 ? 2 : 1).forEach(add);
  }
  g.beginPath();
  for (let i = 0; i < n; i++) { const y = ((6 - Math.max(-36, Math.min(6, tot[i]))) / 42) * H * 0.92 + H * 0.04; const x = (i / (n - 1)) * W; i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.strokeStyle = cs.getPropertyValue('--accent'); g.lineWidth = 2 * dpr; g.stroke();
}
function frame(now) {
  readMeter(ctx ? anIn : null, meters.in, now); readMeter(ctx ? anOut : null, meters.out, now);
  drawMeter($('#meterIn'), meters.in, now); drawMeter($('#meterOut'), meters.out, now);
  $('#meterInVal').textContent = meters.in.hold > -89 ? meters.in.hold.toFixed(1) : '−∞';
  $('#meterOutVal').textContent = meters.out.hold > -89 ? meters.out.hold.toFixed(1) : '−∞';
  const gr = $('#gateGR'); if (gr) gr.textContent = settings.gate.on && !bypassAll && ctx ? `GR ${gateGR.toFixed(0)} dB` : '';
  drawSpectrum();
  if (current) { drawWave(); $('#posInfo').textContent = `${fmtTime(curPos())} / ${fmtTime(current.length / current.sampleRate)}`; }
  if (recording) $('#recTimer').textContent = fmtTime((performance.now() - recording.t0) / 1000);
  requestAnimationFrame(frame);
}

// ---------- UI wiring ----------
function updateUI() {
  const armed = !!micSrc;
  $('#armBtn').textContent = armed ? 'Disarm' : 'Arm input';
  $('#armBtn').classList.toggle('on', armed);
  $('#armBtn').disabled = !!recording;
  $('#deviceSelect').disabled = !!recording;
  $('#recBtn').classList.toggle('active', !!recording);
  $('#recLabel').textContent = recording ? (recording.stopping ? 'Saving…' : 'Stop') : 'Record';
  $('#playBtn').textContent = playing ? '■ Stop' : '▶ Play';
  $('#playBtn').disabled = !!recording || !currentAudio;
  $('#monitorToggle').checked = monitor;
  $('#bypassToggle').checked = bypassAll;
  $('#loopToggle').checked = loop;
  document.body.classList.toggle('recording', !!recording);
}
function bind() {
  $('#armBtn').onclick = () => (micSrc ? disarm() : armMic());
  $('#recBtn').onclick = () => (recording ? stopRecording() : startRecording());
  $('#refreshDevices').onclick = () => refreshDevices();
  $('#deviceSelect').onchange = (e) => { lsSet('deviceId', e.target.value); if (micSrc) armMic(); };
  navigator.mediaDevices?.addEventListener?.('devicechange', () => refreshDevices());
  $('#monitorToggle').onchange = (e) => { monitor = e.target.checked; lsSet('monitor', monitor); if (monitor) toast('Use headphones while monitoring to avoid feedback.'); updateSpeaker(); };
  $('#bypassToggle').onchange = (e) => { bypassAll = e.target.checked; chain?.apply(settings, bypassAll); };
  $('#loopToggle').onchange = (e) => { loop = e.target.checked; if (playing) play(); };
  $('#playBtn').onclick = () => (playing ? stopPlayback() : play());
  $('#takeList').onclick = (e) => { const li = e.target.closest('.take'); if (li) selectTake(li.dataset.id || null); };
  $('#takeName').onchange = (e) => { if (!current) return; current.name = e.target.value.trim() || current.name; db.put('meta', current); renderTakes(); $('#fxTarget').textContent = `· ${current.name}`; };
  $('#importBtn').onclick = () => $('#importInput').click();
  $('#importInput').onchange = (e) => { const fs = [...e.target.files]; e.target.value = ''; importMany(fs.map((f) => ({ name: f.name, load: () => f.arrayBuffer() }))); };
  let fxClip = lsGet('fxClipboard', null); $('#pasteFx').disabled = !fxClip;
  $('#copyFx').onclick = () => { fxClip = clone(settings); lsSet('fxClipboard', fxClip); $('#pasteFx').disabled = false; toast('Settings copied. Select another take and tap Paste.'); };
  $('#pasteFx').onclick = () => { if (!fxClip) return; const c = mergeDefaults(fxClip); for (const k in c) settings[k] = c[k]; settingsChanged(); toast('Settings pasted.'); };
  $('#resetFx').onclick = () => { const fresh = clone(DEFAULTS); for (const k in fresh) settings[k] = fresh[k]; settingsChanged(); };
  $('#clearSelBtn').onclick = () => { selection = null; updateSel(); if (playing) play(); };
  $('#learnBtn').onclick = () => {
    if (!selection || !currentAudio) return;
    const sr = current.sampleRate, a = Math.floor(selection[0] * sr), b = Math.floor(selection[1] * sr);
    if (b - a < FFT_N * 2) { toast('Select at least ~0.1 s of noise.'); return; }
    current.noiseProfile = computeProfile(currentAudio.channels, a, b);
    current.noiseRegion = [...selection];
    settings.denoise.on = true;
    chain?.setProfile(current.noiseProfile);
    selection = null; updateSel(); settingsChanged();
    toast('Noise profile learned. Noise reduction is on.');
  };
  $('#deleteBtn').onclick = async () => {
    if (!current) return;
    const b = $('#deleteBtn');
    if (!b.dataset.confirm) { b.dataset.confirm = 1; b.textContent = 'Tap again to delete'; setTimeout(() => { delete b.dataset.confirm; b.textContent = 'Delete take'; }, 3000); return; }
    delete b.dataset.confirm; b.textContent = 'Delete take';
    const id = current.id; await db.del('meta', id); await db.del('audio', id);
    takes = takes.filter((t) => t.id !== id); await selectTake(null);
  };
  $('#exportBtn').onclick = () => exportTake(true);
  $('#exportRawBtn').onclick = () => exportTake(false);
  const wave = $('#wave');
  wave.addEventListener('pointerdown', (e) => { if (!current) return; wave.setPointerCapture(e.pointerId); drag = { x0: e.clientX, t0: waveTime(e), moved: false }; });
  wave.addEventListener('pointermove', (e) => {
    if (!drag) return;
    if (Math.abs(e.clientX - drag.x0) > 5) drag.moved = true;
    if (drag.moved) { const t = waveTime(e); selection = [Math.min(drag.t0, t), Math.max(drag.t0, t)]; updateSel(); }
  });
  wave.addEventListener('pointerup', (e) => {
    if (!drag) return;
    if (!drag.moved) { selection = null; playPos = drag.t0; updateSel(); if (playing) play(); }
    else if (playing) play();
    drag = null;
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input[type=text], input:not([type]), select')) return;
    if (e.code === 'Space' && currentAudio) { e.preventDefault(); playing ? stopPlayback() : play(); }
    if (e.key === 'r' && !e.metaKey && !e.ctrlKey) recording ? stopRecording() : startRecording();
  });
  let deferred;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#installBtn').hidden = false; });
  $('#installBtn').onclick = async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#installBtn').hidden = true; };
  window.addEventListener('resize', () => { waveCache = null; });
  window.addEventListener('beforeunload', (e) => { if (recording) { e.preventDefault(); e.returnValue = ''; } });
}

// ---------- Boot ----------
renderControls(); bind(); syncControls(); updateUI();
loadTakes();
refreshDevices();
navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator && location.protocol !== 'file:' && !window.AndroidBridge) navigator.serviceWorker.register('sw.js').catch(() => {});
requestAnimationFrame(frame);
