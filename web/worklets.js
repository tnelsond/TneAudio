// AudioWorklet processors: raw recorder, spectral noise reduction, noise gate.
// These run identically in the live AudioContext (monitoring / playback)
// and in an OfflineAudioContext (export), so what you hear is what you export.

function makeFFT(n) {
  const levels = Math.round(Math.log2(n));
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) { let x = i, r = 0; for (let b = 0; b < levels; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
  return function fft(re, im, inverse) {
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const c = cos[k], s = inverse ? -sin[k] : sin[k];
          const xr = re[j + half], xi = im[j + half];
          const tr = xr * c + xi * s, ti = xi * c - xr * s;
          re[j + half] = re[j] - tr; im[j + half] = im[j] - ti;
          re[j] += tr; im[j] += ti;
        }
      }
    }
  };
}

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rec = false; this.buf = []; this.len = 0;
    this.port.onmessage = (e) => {
      if (e.data.cmd === 'start') { this.buf = []; this.len = 0; this.rec = true; }
      if (e.data.cmd === 'stop') { this.flush(); this.rec = false; this.port.postMessage({ done: true }); }
    };
  }
  flush() {
    if (!this.len) return;
    const nch = Math.max(...this.buf.map(b => b.length));
    const out = [];
    for (let c = 0; c < nch; c++) {
      const a = new Float32Array(this.len); let o = 0;
      for (const b of this.buf) { a.set(b[c] || b[0], o); o += b[0].length; }
      out.push(a);
    }
    this.port.postMessage({ chunk: out }, out.map(a => a.buffer));
    this.buf = []; this.len = 0;
  }
  process(inputs) {
    const inp = inputs[0];
    if (this.rec && inp && inp.length) {
      this.buf.push(inp.map(a => a.slice()));
      this.len += inp[0].length;
      if (this.len >= 16384) this.flush();
    }
    return true;
  }
}
registerProcessor('recorder', RecorderProcessor);

// Spectral gating noise reduction (STFT, Hann, 75% overlap).
// Uses a learned noise profile if given; otherwise tracks the noise floor adaptively.
class DenoiseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'reduction', defaultValue: 12, minValue: 0, maxValue: 60, automationRate: 'k-rate' },
      { name: 'sensitivity', defaultValue: 6, minValue: -12, maxValue: 30, automationRate: 'k-rate' },
      { name: 'smoothing', defaultValue: 0.6, minValue: 0, maxValue: 0.99, automationRate: 'k-rate' },
    ];
  }
  constructor(opts) {
    super();
    const po = (opts && opts.processorOptions) || {};
    const N = this.N = po.fftSize || 2048;
    this.hop = N / 4; this.latency = N - this.hop; this.half = N / 2;
    this.profile = po.profile || null;
    this.fft = makeFFT(N);
    this.win = new Float32Array(N);
    for (let i = 0; i < N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    this.scale = 1 / (N * 1.5); // 1/N for IFFT, 1/1.5 for Hann^2 overlap-add at hop N/4
    this.re = new Float32Array(N); this.im = new Float32Array(N);
    this.mag = new Float32Array(this.half + 1); this.g2 = new Float32Array(this.half + 1);
    this.ch = [];
    this.port.onmessage = (e) => { if ('profile' in e.data) { this.profile = e.data.profile; for (const s of this.ch) if (s) s.noise = null; } };
  }
  state(c) {
    if (!this.ch[c]) {
      const N = this.N;
      this.ch[c] = { inF: new Float32Array(N), outF: new Float32Array(N), acc: new Float32Array(N), rover: this.latency, gains: new Float32Array(this.half + 1).fill(1), noise: null };
    }
    return this.ch[c];
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || !input.length) return true;
    const floorLin = Math.pow(10, -params.reduction[0] / 20);
    const sensLin = Math.pow(10, params.sensitivity[0] / 20);
    const sm = params.smoothing[0];
    const lat = this.latency, N = this.N;
    for (let c = 0; c < output.length; c++) {
      const x = input[c] || input[0], y = output[c], st = this.state(c);
      for (let i = 0; i < y.length; i++) {
        st.inF[st.rover] = x[i];
        y[i] = st.outF[st.rover - lat];
        if (++st.rover >= N) { st.rover = lat; this.frame(st, floorLin, sensLin, sm); }
      }
    }
    return true;
  }
  frame(st, floorLin, sensLin, sm) {
    const { N, half, hop, re, im, win, mag, g2 } = this;
    for (let i = 0; i < N; i++) { re[i] = st.inF[i] * win[i]; im[i] = 0; }
    this.fft(re, im, false);
    for (let k = 0; k <= half; k++) mag[k] = Math.hypot(re[k], im[k]);
    let noise = this.profile;
    if (!noise) { // adaptive floor: follows minimum, rises ~3 dB/s
      if (!st.noise) st.noise = Float32Array.from(mag);
      const n = st.noise;
      for (let k = 0; k <= half; k++) n[k] = mag[k] < n[k] ? n[k] * 0.7 + mag[k] * 0.3 : n[k] * 1.002 + 1e-9;
      noise = n;
    }
    const g = st.gains;
    for (let k = 0; k <= half; k++) {
      const target = mag[k] > noise[k] * sensLin ? 1 : floorLin;
      g[k] += (target - g[k]) * (target > g[k] ? 0.8 : 1 - sm);
    }
    g2[0] = g[0]; g2[half] = g[half];
    for (let k = 1; k < half; k++) g2[k] = (g[k - 1] + 2 * g[k] + g[k + 1]) * 0.25;
    for (let k = 0; k <= half; k++) { re[k] *= g2[k]; im[k] *= g2[k]; }
    for (let k = 1; k < half; k++) { re[N - k] *= g2[k]; im[N - k] *= g2[k]; }
    this.fft(re, im, true);
    const s = this.scale;
    for (let i = 0; i < N; i++) st.acc[i] += re[i] * win[i] * s;
    for (let i = 0; i < hop; i++) st.outF[i] = st.acc[i];
    st.acc.copyWithin(0, hop); st.acc.fill(0, N - hop);
    st.inF.copyWithin(0, hop);
  }
}
registerProcessor('denoise', DenoiseProcessor);

// Noise gate with hysteresis, hold, attack/release and a range (floor) control.
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -50, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'range', defaultValue: -80, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 2, minValue: 0.01, maxValue: 500, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: 50, minValue: 0, maxValue: 2000, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 150, minValue: 1, maxValue: 5000, automationRate: 'k-rate' },
    ];
  }
  constructor() { super(); this.env = 0; this.gain = 1; this.holdLeft = 0; this.open = false; this.tick = 0; }
  process(inputs, outputs, p) {
    const input = inputs[0], output = outputs[0];
    if (!input || !input.length) return true;
    const sr = sampleRate;
    const thrOpen = Math.pow(10, p.threshold[0] / 20), thrClose = thrOpen * 0.63; // ~4 dB hysteresis
    const floor = Math.pow(10, p.range[0] / 20);
    const att = 1 - Math.exp(-1 / Math.max(1, p.attack[0] * sr / 1000));
    const rel = 1 - Math.exp(-1 / Math.max(1, p.release[0] * sr / 1000));
    const holdN = p.hold[0] * sr / 1000;
    const det = Math.exp(-1 / (0.005 * sr));
    const n = input[0].length;
    for (let i = 0; i < n; i++) {
      let pk = 0;
      for (let c = 0; c < input.length; c++) { const v = Math.abs(input[c][i]); if (v > pk) pk = v; }
      this.env = pk > this.env ? pk : this.env * det;
      if (this.env > thrOpen) this.open = true;
      else if (this.env < thrClose) this.open = false;
      let target;
      if (this.open) { this.holdLeft = holdN; target = 1; }
      else if (this.holdLeft > 0) { this.holdLeft--; target = 1; }
      else target = floor;
      this.gain += (target - this.gain) * (target > this.gain ? att : rel);
      for (let c = 0; c < output.length; c++) output[c][i] = (input[c] || input[0])[i] * this.gain;
    }
    if (++this.tick >= 24) { this.tick = 0; this.port.postMessage({ gr: 20 * Math.log10(Math.max(this.gain, 1e-5)) }); }
    return true;
  }
}
registerProcessor('gate', GateProcessor);
