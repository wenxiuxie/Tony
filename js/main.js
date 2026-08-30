/* =========================================================
   Tony D — hero prototype
   Class structure follows the Music Tools reference:
   AudioEngine / Waveform / Tilt / Reveal / Ticker
   ========================================================= */

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* One pointer position for the whole page. Several things need to know where
   the cursor is, and each adding its own listener would mean several handlers
   firing on every mouse move. -1,-1 means "not over the document". */
const POINTER = { x: -1, y: -1 };
addEventListener('pointermove', (e) => {
  POINTER.x = e.clientX; POINTER.y = e.clientY;
}, { passive: true });
document.addEventListener('pointerleave', () => { POINTER.x = POINTER.y = -1; });

/* The hero queue is emitted into the page by build.py, out of
   content/shared.json plus the locale file — paths and titles are content,
   not code, and the two locales can label the same file differently.

   Whatever is actually on disk wins: entries that 404 are dropped at boot,
   and if none survive AudioEngine falls back to the synthesised pad. That
   matters because audio/ is gitignored, so a deploy can legitimately have
   no files at all. */
function readPlaylist () {
  const tag = document.getElementById('playlist');
  if (!tag) return [];
  try {
    const list = JSON.parse(tag.textContent);
    return Array.isArray(list) ? list.filter(t => t && t.src) : [];
  } catch {
    return [];              // a malformed queue must not take the page down
  }
}

/* Background level. Deliberately well under unity — this plays while
   someone reads, and it is not the point of the page. */
const LEVEL = 0.42;


/* ---------------------------------------------------------
   AudioEngine — real file if present, synth pad if not
   --------------------------------------------------------- */
class AudioEngine {
  constructor () {
    this.ctx      = null;
    this.analyser = null;
    this.playing  = false;
    this.mode     = null;      // 'file' | 'synth'
    this.el       = null;
    this.voices   = [];
    this.timer    = null;
    this.queue    = [];
    this.index    = 0;
    this.onstate  = () => {};
    this.ontrack  = () => {};
  }

  async _init () {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();

    this.analyser = this.ctx.createAnalyser();
    /* 4096 rather than 2048: the log band split below is finer than a
       23Hz bin down in the bass, so the extra resolution is the difference
       between a low end with detail and one with steps in it. */
    this.analyser.fftSize = 4096;
    /* Lower than the old line wanted: bars read as sluggish long before
       a waveform does. */
    this.analyser.smoothingTimeConstant = 0.75;

    /* Signal chain:  voices -> tone -> [dry + reverb] -> master -> analyser
       The filter and reverb are what make the pad sound like a room
       rather than an oscillator. They sit before the analyser so the
       waveform reacts to what you actually hear. */
    this.master = this.ctx.createGain();
    this.master.gain.value = 0;              // faded up in start()
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    this.tone = this.ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 1400;        // takes the glare off
    this.tone.Q.value = 0.4;

    const wet = this.ctx.createGain();
    wet.gain.value = 0.34;
    const dry = this.ctx.createGain();
    dry.gain.value = 0.72;

    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = this._impulse(3.4, 2.6);

    this.tone.connect(dry).connect(this.master);
    this.tone.connect(this.reverb).connect(wet).connect(this.master);

    /* Probe every entry at once and keep the ones really there, in the
       order content/ gave them. */
    const listed  = readPlaylist();
    const present = await Promise.all(listed.map(
      t => fetch(t.src, { method: 'HEAD' }).then(r => r.ok).catch(() => false)));
    this.queue = listed.filter((_, i) => present[i]);

    if (this.queue.length) {
      this.mode = 'file';
      /* One element for the whole queue, never one per track:
         createMediaElementSource can only be called once for a given
         element, so advancing means swapping .src on this one rather than
         re-wiring the graph — and the node count stays at one. */
      this.el = new Audio();
      this.el.crossOrigin = 'anonymous';
      this.el.preload = 'none';
      this.el.addEventListener('ended', () => this.next());
      // a file that fails to decode should cost one track, not the set
      this.el.addEventListener('error', () => { if (this.playing) this.next(); });
      this.ctx.createMediaElementSource(this.el).connect(this.master);
      this._cue(0);
      return;
    }
    this.mode = 'synth';
  }

  /* Noise burst with an exponential decay — a cheap, decent room. */
  _impulse (seconds, decay) {
    const rate = this.ctx.sampleRate;
    const len  = Math.floor(rate * seconds);
    const buf  = this.ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  get track () { return this.queue[this.index] || null; }

  _cue (i) {
    const n = this.queue.length;
    this.index = ((i % n) + n) % n;          // wraps in both directions
    this.el.src = this.queue[this.index].src;
    this.ontrack(this.track, this.index, n);
  }

  /* Skipping ducks the level across the change. Two different songs butted
     straight together is far more jarring than the half-second it costs. */
  next () {
    if (this.mode !== 'file' || !this.queue.length) return;

    const t = this.ctx.currentTime;
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.0001, t + 0.18);

    this._cue(this.index + 1);
    if (!this.playing) return;

    this.el.play().catch(() => {});
    g.linearRampToValueAtTime(LEVEL, t + 0.72);   // resumes where the duck ended
  }

  async toggle () {
    await this._init();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.playing ? this.stop() : this.start();
  }

  /* In fast, out slow. The 1.4s swell this used to open with was written
     for audio that started under someone who was already reading; it now
     starts under Ignition, and a screen that detonates 1.2 seconds before
     the sound arrives reads as two unrelated events. 0.3s is still a fade
     — nothing clicks — but it lands on the same beat as the flash.
     stop() keeps its long fade: settling is not the same as starting. */
  start () {
    this.playing = true;
    clearTimeout(this.fade);

    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(Math.max(this.master.gain.value, 0.0001), t);
    this.master.gain.linearRampToValueAtTime(LEVEL, t + 0.3);

    if (this.mode === 'file') this.el.play().catch(() => {});
    else this._synthLoop();

    this.onstate(true, this.mode);
  }

  stop () {
    this.playing = false;

    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0.0001, t + 1.1);

    if (this.mode === 'file') {
      // pause only once the fade has actually finished
      this.fade = setTimeout(() => { if (!this.playing) this.el.pause(); }, 1200);
    } else {
      clearTimeout(this.timer);
      this.voices.forEach(v => {
        v.gain.gain.cancelScheduledValues(t);
        v.gain.gain.setTargetAtTime(0, t, 0.4);
        v.osc.stop(t + 2.4);
      });
      this.voices = [];
    }
    this.onstate(false, this.mode);
  }

  /* Ambient pad — placeholder until one of TRACKS exists.

     The old version was triads on a 2.6s cycle, which read as "hold
     music". This is slower and voiced with 7ths and 9ths so nothing
     resolves hard, each chord overlaps the next so there is never a
     seam, and every note is two slightly detuned oscillators for width.
     Written to sit under reading, not to be listened to. */
  _synthLoop () {
    // MIDI note numbers: Am9 / Fmaj7 / Cmaj7 / G6add9
    const CHORDS = [
      [57, 64, 67, 71],
      [53, 60, 64, 69],
      [48, 55, 59, 64],
      [55, 62, 64, 71]
    ];
    const hz = m => 440 * Math.pow(2, (m - 69) / 12);

    const HOLD  = 9.0;    // how long one chord rings
    const CYCLE = 6.2;    // next chord starts before this one ends

    let i = 0;
    const play = () => {
      if (!this.playing) return;
      const now = this.ctx.currentTime;

      CHORDS[i % CHORDS.length].forEach((midi, n) => {
        // two oscillators per note, detuned against each other
        [-6, 6].forEach((cents, k) => {
          const osc  = this.ctx.createOscillator();
          const gain = this.ctx.createGain();
          const pan  = this.ctx.createStereoPanner
                     ? this.ctx.createStereoPanner() : null;

          osc.type = n === 0 ? 'triangle' : 'sine';
          osc.frequency.value = hz(midi);
          osc.detune.value = cents;
          if (pan) pan.pan.value = (k ? 0.28 : -0.28) * (n / 3);

          // quieter for upper voices so the chord doesn't get shrill
          const peak = 0.085 / (1 + n * 0.5);

          gain.gain.setValueAtTime(0.0001, now);
          gain.gain.exponentialRampToValueAtTime(peak, now + 2.4);   // slow swell
          gain.gain.setValueAtTime(peak, now + HOLD - 3.4);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + HOLD);

          osc.connect(gain);
          (pan ? gain.connect(pan) : gain).connect(this.tone);
          osc.start(now);
          osc.stop(now + HOLD + 0.2);
          this.voices.push({ osc, gain });
        });
      });

      // a slow filter drift so the texture is never static
      const open = 1150 + Math.sin(i * 0.7) * 320;
      const f = this.tone.frequency;
      f.cancelScheduledValues(now);
      f.setValueAtTime(f.value, now);        // anchor, else the ramp start is undefined
      f.linearRampToValueAtTime(open, now + CYCLE);

      this.voices = this.voices.slice(-64);
      i++;
      this.timer = setTimeout(play, CYCLE * 1000);
    };
    play();
  }
}


/* ---------------------------------------------------------
   VIZ — the colour of the light, and only of the light.

   This started out driving the spectrum row as well, running a hue ramp
   across its width. That was wrong twice over: a rainbow row reads as a
   stock media-player widget, and it put the loudest colour on the least
   interesting object. The row is plain magenta again, and everything
   here now feeds the bloom, the beams and the rings — the parts that are
   supposed to be looked at.

   One instant is never a rainbow: at any moment the light runs from a
   base hue at the bass end to base+SPREAD at the top, a narrow arc
   inside the site's own family. It is the base that travels — a slow
   crawl through rose, magenta and violet, shoved forward by every hard
   beat, so the colour of the hero is driven by the song rather than by
   a timer.
   --------------------------------------------------------- */
const VIZ = {
  base:   322,      // bass end, degrees — rose/magenta
  target: 322,      // per-track gel; AlbumMood writes this on skip
  SPREAD: -62,      // treble end sits this far round the wheel — violet
  phase:  0,

  /* Ease the gel toward the current track. Shortest path around the
     wheel, so 330 → 34 goes through red rather than all the way around
     via cyan. A timer-crawl used to wander 292–322 regardless of song;
     the song is the point now. */
  step (dt, beat) {
    let d = ((this.target - this.base + 540) % 360) - 180;
    const k = Math.min(1, dt * 0.0032);
    this.base += d * k;
    if (this.base < 0) this.base += 360;
    if (this.base >= 360) this.base -= 360;
    void beat;
  },

  /* The rings are the one thing deliberately NOT in the magenta family.
     Real stage lighting works the same way: a warm wash plus a cold beam,
     and the cold one is what you actually see move. Rings in rose sank
     into the bloom they travel through and stopped reading as objects;
     in ice-white they cut. Swap RING for '255,190,90' if you would rather
     have gold — that is the other combination that works against magenta,
     and it is warmer and less clinical. Nothing else reads this. */
  RING: '190,235,255',

  /* The third colour, and the only warm one in the system.
     34 degrees is the guitar in hero-portrait.webp — I measured the
     photograph's hue histogram and it has two peaks: 195 (the cool light
     on him, which is where RING above already sits) and 30/15 (the wood).
     Everything else here was cool or magenta, so nothing on screen picked
     up the warmest object in the frame. Embers, the floor bloom and the
     low followspot are gelled to it. */
  AMBER: 34,
  warm (l, a) { return 'hsla(' + this.AMBER + ',92%,' + l + '%,' + a + ')'; },

  /* The cool tube of the neon sign, kept opposite the warm one rather
     than pinned to a colour: as the wash drifts 292-322, this drifts
     164-194, so the two are always complementary and the sign never
     collapses into one hue. 194 is, again, the light in the photograph. */
  get cool () { return (this.base + 232) % 360; },

  /* f is 0..1 from bass to treble; l lightness, a alpha. */
  at (f, l, a) {
    return 'hsla(' + (this.base + f * this.SPREAD).toFixed(1) +
           ',100%,' + l + '%,' + a + ')';
  }
};


/* ---------------------------------------------------------
   Sparks — a fixed pool of embers thrown off the bar tips.

   Fed by the transient detector in HeroViz rather than by loudness, so
   they mark kicks, snares and pick attacks: the hero spits fire on the
   beat instead of shimmering continuously. The pool never allocates
   after boot — a per-frame `new` here is what makes visualisers stutter.
   --------------------------------------------------------- */
class Sparks {
  constructor (max) {
    this.n = 0;
    this.max = max;
    this.x  = new Float32Array(max); this.y  = new Float32Array(max);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max);
    this.life = new Float32Array(max); this.age = new Float32Array(max);
    this.r = new Float32Array(max);
  }

  emit (x, y, power) {
    if (this.n >= this.max) return;
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.vx[i] = (Math.random() - 0.5) * 46 * power;
    // upward, and the harder the hit the higher it goes
    this.vy[i] = -(48 + Math.random() * 150) * (0.55 + power);
    this.life[i] = 0.65 + Math.random() * 0.85;
    this.age[i]  = 0;
    this.r[i]    = 0.9 + Math.random() * 1.9;
  }

  update (dt) {
    const s = dt / 1000;
    for (let i = 0; i < this.n; i++) {
      this.age[i] += s;
      if (this.age[i] >= this.life[i]) {
        /* swap-remove: the dead one takes the last slot's values and the
           pool shrinks by one, so the live range stays contiguous */
        const j = --this.n;
        this.x[i]  = this.x[j];  this.y[i]  = this.y[j];
        this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j];
        this.life[i] = this.life[j]; this.age[i] = this.age[j];
        this.r[i] = this.r[j];
        i--; continue;
      }
      this.x[i] += this.vx[i] * s;
      this.y[i] += this.vy[i] * s;
      this.vy[i] += 34 * s;          // a little gravity, so they arc over
      this.vx[i] *= 1 - 1.4 * s;     // and drag, so they don't fly off sideways
    }
  }

  /* Additive, and restored afterwards: the caller is mid-way through its
     own composite bookkeeping.

     Amber, not magenta. These were the colour of the row they come off,
     which was consistent and completely inert — a spark that is the same
     colour as the thing it left just reads as the thing fraying. Real
     embers cool as they fall, so these are born near-white and go gold,
     then deep orange as they die, and they are the warmest thing on the
     screen. */
  draw (ctx) {
    const prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.n; i++) {
      const t = 1 - this.age[i] / this.life[i];
      ctx.fillStyle = 'rgba(255,' + (150 + 92 * t).toFixed(0) + ',' +
                      (38 + 130 * t).toFixed(0) + ',' + (t * t).toFixed(3) + ')';
      ctx.beginPath();
      ctx.arc(this.x[i], this.y[i], this.r[i] * (0.4 + t), 0, 6.283);
      ctx.fill();
    }
    ctx.globalCompositeOperation = prev;
  }
}


/* ---------------------------------------------------------
   JumpCut — two frames of a different photograph, on a hard beat.

   A music-video cut, not a crossfade: it goes fully opaque for about
   33ms and then it is gone. Anything longer stops reading as an edit and
   starts reading as a glitch, and anything softer just looks like the
   image is dirty.

   This is also the only place the low-resolution stills are usable. The
   hero column wants ~1400px on a retina screen and only hero-portrait is
   that big; the others are 557px wide and visibly soft if you hold them
   there. At two frames nobody resolves them — what registers is that the
   shot changed.

   Cheap on purpose: two style writes per cut and nothing at all in
   between, rather than an opacity the render loop rewrites every frame.
   --------------------------------------------------------- */
class JumpCut {
  constructor (el) {
    this.el = el;
    this.n  = el ? (parseInt(el.dataset.frames, 10) || 0) : 0;
    this.i  = 0;
    this.left = 0;      // frames still to show
    this.gap  = 99;     // frames since the last cut
    if (this.n > 1 && !REDUCED) this._warm();
  }

  /* Only --cut-0 is named by a rule that matches at load, so the browser
     has no reason to fetch the others until the first cut selects one —
     and a cut is two frames, which is not enough time to go and get a
     file. The first appearance of each of the other frames would be a
     blank flash. Fetch them once the page is otherwise idle. */
  _warm () {
    const go = () => {
      const cs = getComputedStyle(this.el);
      for (let k = 1; k < this.n; k++) {
        const m = /url\(["']?(.*?)["']?\)/.exec(cs.getPropertyValue('--cut-' + k));
        if (m) new Image().src = m[1];
      }
    };
    if ('requestIdleCallback' in window) requestIdleCallback(go, { timeout: 3000 });
    else setTimeout(go, 1200);
  }

  fire () {
    if (!this.el || !this.n || REDUCED) return;
    /* Refractory. Onset detection already rejects a double-trigger on one
       kick, but cutting on every bar of a fast passage is a strobe — this
       keeps it to roughly one cut a second, so it stays an accent. */
    if (this.gap < 46) return;
    this.gap = 0;
    this.left = 2;
    this.i = (this.i + 1) % this.n;     // never the same frame twice running
    this.el.dataset.f = String(this.i);
    this.el.style.opacity = '1';
  }

  tick () {
    this.gap++;
    if (this.left && --this.left === 0) this.el.style.opacity = '0';
  }
}


/* ---------------------------------------------------------
   Followspot — one lamp with a human on the handle.

   This replaced a fan of nine wedges that all swung on one shared sine
   and lit up band by band. Nine of anything moving together is weather,
   not lighting: at a glance it was a breathing shape at the bottom of
   the screen, and nothing in it was aimed at him. The per-band flicker
   it carried is not lost — drawGlow already paints the spectrum as a
   bank of columns and blurs them into the wash, which is the layer that
   is supposed to carry frequency.

   What a followspot does that a wedge does not is HOLD. An operator
   picks a mark, sits on it while the singer works, and swings only when
   the song gives them a reason. So the three things here are:

     - a spring, not a tween. Aim is integrated with stiffness and
       damping deliberately set under critical, so the lamp arrives a
       little hot and settles back. That overshoot is the whole read of
       a hand on the yoke; an eased tween arrives like an animation.
     - a dwell floor. Every onset asks all three lamps to re-aim and
       almost every time they refuse, because they have not sat still
       long enough yet. Without it a busy bar turns the rig into a disco
       scanner, which is the failure mode this was built to avoid.
     - a fixed iris. The pool stays the same size wherever it lands, so
       the cone NARROWS as the lamp reaches further. Lamps do not open
       their iris because the subject walked upstage, and that one
       constraint is most of what makes these read as instruments
       rather than as gradients.
   --------------------------------------------------------- */
class Followspot {
  constructor (cfg) {
    this.rig   = cfg.rig;      // where it hangs, normalised — outside the frame
    this.k     = cfg.k;        // spring stiffness: how hard it swings
    this.d     = cfg.d;        // damping; under 2*sqrt(k) it overshoots
    this.iris  = cfg.iris;     // pool radius at the mark, as a fraction of height
    this.dwell = cfg.dwell;    // ms it must sit before it will accept a cue
    this.bias  = cfg.bias;     // chance a re-aim goes back to him
    this.gel   = cfg.gel;      // 0..1 into VIZ.at, or 'warm'
    this.idle  = cfg.idle;     // how lit it is before anyone presses play
    this.marks = cfg.marks;    // the places on stage it is allowed to look

    this.x = this.tx = cfg.marks[0][0];
    this.y = this.ty = cfg.marks[0][1];
    this.vx = this.vy = 0;
    this.held  = 9e3;          // starts eligible, so the first kick can move it
    this.onHim = false;
    this.mark  = cfg.marks[0];
    this.wander = Math.random() * 6.283;
    this.speed = 0;
  }

  /* A hard onset asks; dwell answers. Called for every lamp on the same
     beat on purpose — they refuse at different rates, so what comes out
     is one lamp moving while the other two hold, which is what a real
     rig looks like. */
  cue () {
    if (this.held < this.dwell) return;
    this.held = 0;
    this.onHim = Math.random() < this.bias;
    if (!this.onHim) this.mark = this.marks[(Math.random() * this.marks.length) | 0];
  }

  step (dt, him) {
    this.held += dt;
    const m = this.onHim ? him : this.mark;

    /* The slow wander of a hand on the yoke. 0.15Hz and a fifth of the
       iris: held perfectly still for eight seconds a lamp reads as a
       PNG, and anything faster than this reads as a shake — the same
       line the sleeve boil is pinned to. */
    this.wander += dt * 0.00095;
    const wob = this.iris * 0.22;
    this.tx = m[0] + Math.sin(this.wander) * wob * 0.6;
    this.ty = m[1] + Math.sin(this.wander * 0.73 + 1.9) * wob;

    // clamped: a backgrounded tab must not hand the spring a huge step
    const s = Math.min(0.05, dt * 0.001);
    this.vx += ((this.tx - this.x) * this.k - this.vx * this.d) * s;
    this.vy += ((this.ty - this.y) * this.k - this.vy * this.d) * s;
    this.x += this.vx * s;
    this.y += this.vy * s;
    this.speed = Math.hypot(this.vx, this.vy);
  }
}


/* ---------------------------------------------------------
   HeroViz — the whole first screen as one instrument.

   Three canvases rather than one, because they want three different
   resolutions and three different treatments:

     #vizGlow  quarter-res, CSS-blurred to a wash. Carries the colour and
               the sheer size of the thing — a bank of light behind the
               portrait that reaches the top of the screen on a chorus.
     #vizBeam  half-res, lightly blurred. Three followspots working him
               and the empty stage, plus a shockwave on every hard kick.
     #wave     full-res, sharp. The bars, their peak caps and the embers.

   Drawing all three at device resolution was the obvious first version
   and cost about four times the frame time for no visible gain: the two
   lower layers are blurred, so their pixels are thrown away anyway.
   --------------------------------------------------------- */
class HeroViz {
  constructor (glow, beam, wave, engine) {
    if (!wave) return;
    this.engine = engine;
    this.L = [
      { c: glow, x: null, scale: 0.22 },
      { c: beam, x: null, scale: 0.5  },
      { c: wave, x: null, scale: null }   // null = device pixel ratio
    ];
    for (const l of this.L) { if (l.c) l.x = l.c.getContext('2d'); }
    this.g = this.L[0].x; this.b = this.L[1].x; this.s = this.L[2].x;

    this.t = 0; this.last = 0;
    this.mix = 0; this.mixT = 0;
    this.flash = 0;            // whole-row bloom on a kick, decays
    this.prevBass = 0;
    this.rings = [];           // beat rings in flight
    /* Onset detection state — see the detector in loop(). */
    this.bassAvg = 0;          // slow running mean of the low end
    this.sinceRing = 999;      // ms since the last ring, for the refractory
    this.sparks = new Sparks(REDUCED ? 0 : 340);
    this.jump = new JumpCut(document.querySelector('.hero__cut'));

    /* The rig: three lamps, and the differences between them are the
       point. Two hang high and outside the frame so their cones enter
       already spread and travel DOWN across him — every other light on
       this screen (footlights, floor bloom, the old wedges) throws
       upward, so this is the one direction the hero did not have.

       `marks` are where each lamp is allowed to look, normalised to the
       canvas. He stands around (0.72, 0.34), measured live into srcX /
       srcY by resize(), so nobody has to keep a copy of his position in
       sync here.

       Two numbers here are load-bearing and were both wrong first time:

       `dwell` has to outlast the swing. k/d give the key lamp about
       1.5s to arrive and settle, so at the 2400 it started on it was
       still travelling for most of its "hold" and never read as parked
       — it just drifted around him. Every dwell is now comfortably
       longer than that lamp's own settling time.

       `iris` is a pool size, and the cone angle falls out of it and the
       throw. The warm lamp hung at y=1.22 with a 0.17 iris was only
       217px from its nearest mark, which opened its outer wedge to 89
       degrees — that is not a lamp, that is the fog the nine wedges got
       deleted for. Hanging it further under the fold and stopping it
       down brings it back to a believable 30-38. Check that number
       before touching either value. */
    this.spots = REDUCED ? [] : [
      // key: slow, wide, and mostly on him. This is the lamp you read.
      new Followspot({
        rig: [0.06, -0.20], k: 9,    d: 5.2, iris: 0.130,
        dwell: 3800, bias: 0.52, gel: 0.12, idle: 0.50,
        marks: [[0.72, 0.34], [0.55, 0.46], [0.72, 0.15]]
      }),
      // counter: quick, tight, and almost never on him — it works the
      // empty half of the stage so the key has something to be opposite.
      new Followspot({
        rig: [0.97, -0.24], k: 17,   d: 6.2, iris: 0.085,
        dwell: 2200, bias: 0.12, gel: 0.92, idle: 0.08,
        marks: [[0.20, 0.55], [0.30, 0.22], [0.46, 0.78], [0.90, 0.60]]
      }),
      // warm: hung low with the footlights and gelled amber to match
      // them. Barely moves; it is temperature, not choreography.
      new Followspot({
        rig: [0.50, 1.55], k: 3.4,  d: 3.6, iris: 0.120,
        dwell: 4200, bias: 0.25, gel: 'warm', idle: 0.16,
        marks: [[0.34, 0.84], [0.62, 0.88], [0.72, 0.70]]
      })
    ];
    this.round = typeof this.s.roundRect === 'function';

    this.resize();
    addEventListener('resize', () => this.resize());

    /* The canvases are sized as a percentage of the hero, and the hero is
       sized off --nav-h and --ticker-h, which HeightVar measures. A plain
       resize listener therefore misses the case that matters most: the
       webfonts land, the ticker reflows to a different height, and the
       hero changes size without the window doing anything. */
    if ('ResizeObserver' in window) {
      let first = true;
      new ResizeObserver(() => {
        if (first) { first = false; return; }   // the initial call is our own
        this.resize();
      }).observe(wave);
    }

    /* The hero is one screen of a long page, so most of a visit is spent
       with this off-screen — and this costs far more per frame than the
       strip it replaced, so skipping it out of sight matters more than
       it used to. */
    this.visible = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; },
                               { threshold: 0 }).observe(wave);
    }
    this.loop();
  }

  /* Called by Ignition the instant play is pressed: the row is thrown a
     ring and a bank of embers, and every bar blooms for a few frames. */
  ignite () {
    if (!this.w) return;
    this.flash = 1;
    // wider, brighter and faster than any beat ring — this one is the
    // announcement, and every field here is read by drawRings
    this.rings.push({ r: 0, a: 1, w: 6, spd: 1.6 });
    for (let k = 0; k < 90; k++) {
      this.sparks.emit(Math.random() * this.w, this.mid,
                       0.9 + Math.random() * 0.8);
    }
  }

  /* A smaller relative of ignite(), for the frame the queue steps off a
     monochrome record and the colour comes back. Same bloom and one ring,
     but a third of the embers and a slower ring: this is the light in the
     room changing, not the page starting. `k` is how big a jump in grade
     it is answering, so 0 -> 1 detonates and 1 -> 1.3 only glints. */
  surge (k) {
    if (!this.w || REDUCED) return;
    k = Math.max(0, Math.min(1, k));
    this.flash = Math.max(this.flash, 0.9 * k);
    this.rings.push({ r: 0, a: 0.9 * k, w: 4.5, spd: 1.25 });
    const n = Math.round(34 * k);
    for (let i = 0; i < n; i++) {
      this.sparks.emit(Math.random() * this.w, this.mid,
                       0.6 + Math.random() * 0.7);
    }
  }

  resize () {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const r = this.L[2].c.getBoundingClientRect();
    this.w = r.width;
    this.h = r.height;

    for (const l of this.L) {
      if (!l.c) continue;
      const box = l.c.getBoundingClientRect();
      const k = l.scale || dpr;
      l.c.width  = Math.max(1, Math.round(box.width  * k));
      l.c.height = Math.max(1, Math.round(box.height * k));
      l.x.setTransform(k, 0, 0, k, 0, 0);
      l.w = box.width; l.h = box.height;
    }

    /* Narrow screens get narrower bars rather than fewer, so the spectrum
       spans the full width at every size instead of trailing off. */
    this.bw  = this.w < 640 ? 3 : 5;
    this.gap = this.w < 640 ? 2 : 3;
    this.n   = Math.max(8, Math.floor(this.w / (this.bw + this.gap)));

    this.peaks  = new Float32Array(this.n);
    this.vel    = new Float32Array(this.n);
    this.prevUp = new Float32Array(this.n);
    this.hit    = new Float32Array(this.n);
    this.ups    = new Float32Array(this.n);
    this.edges  = null;                     // band edges depend on n

    /* Axis sits on the floor: aurora curtains rise from here, and the
       embers still spawn from the same line so they leave the crests. */
    this.mid   = this.h * 0.88;
    this.upMax = Math.min(this.mid - 8, this.h * 0.78);
    this.dnMax = (this.h - this.mid) - 3;

    /* Where the light comes from. Measured off the portrait rather than
       hard-coded, because the hero is a two-column grid on desktop and a
       single full-bleed stack under 1100px — a fixed fraction of the
       width would put the source in his face on one of them. Expressed
       as a fraction of the glow/beam canvases, which are inset:0 on the
       section and therefore share its box.

       0.34 down the portrait rather than 0.5: the light reads as coming
       from behind his head and shoulders, which is where a backlight
       would actually be, not from his waist. */
    const media = document.querySelector('.hero__media');
    const host  = this.L[0].c || this.L[1].c;
    if (media && host) {
      const m = media.getBoundingClientRect(), b = host.getBoundingClientRect();
      this.srcX = b.width  ? (m.left - b.left + m.width  * 0.50) / b.width  : 0.72;
      this.srcY = b.height ? (m.top  - b.top  + m.height * 0.34) / b.height : 0.34;
    } else {
      this.srcX = 0.72; this.srcY = 0.34;
    }

    /* Vertical, and all one colour. The row briefly ran a travelling hue
       ramp across its width and it was the wrong call: a rainbow reads as
       a stock media-player widget, and it was competing with the bloom
       and the rings — which are the parts actually worth looking at. The
       row is back to being the site's magenta, lighter at the tips and
       dissolving at the roots, and the colour lives in the glow now. */
    this._barFill();
  }

  /* The row is one gel, not a rainbow: the track's hue, hot at the tips.
     Rebuilt when the rounded degree changes — see the lamp write in loop. */
  _barFill () {
    if (!this.s || !this.h) return;
    const h = VIZ.base;
    const g = this.s.createLinearGradient(0, this.mid - this.upMax, 0, this.mid);
    g.addColorStop(0,    'hsla(' + h.toFixed(1) + ',90%,78%,.95)');
    g.addColorStop(0.45, 'hsla(' + h.toFixed(1) + ',100%,54%,1)');
    g.addColorStop(1,    'hsla(' + h.toFixed(1) + ',100%,48%,.45)');
    this.fill = g;
  }

  /* Log-spaced band edges. An even split across FFT bins puts almost
     everything a listener actually hears in the leftmost tenth of the
     canvas, which is why linear analysers always look bass-only. */
  _bands (bins, sampleRate) {
    if (this.edges) return this.edges;
    const LO = 32, HI = 14000, nyq = sampleRate / 2;
    const edges = new Float32Array(this.n + 1);
    for (let i = 0; i <= this.n; i++) {
      const f = LO * Math.pow(HI / LO, i / this.n);
      edges[i] = Math.min(bins - 1, (f / nyq) * bins);  // fractional on purpose
    }
    return (this.edges = edges);
  }

  _bar (ctx, x, y, w, h) {
    if (this.round) ctx.roundRect(x, y, w, h, Math.min(w / 2, h / 2));
    else ctx.rect(x, y, w, h);
  }

  loop () {
    requestAnimationFrame(() => this.loop());
    if (!this.visible || !this.w) return;

    const now = performance.now();
    const dt  = this.last ? Math.min(64, now - this.last) : 16;
    this.last = now;
    this.t += dt * 0.001;

    const an   = this.engine && this.engine.analyser;
    const want = (this.engine && this.engine.playing && an) ? 1 : 0;

    /* Morph between the idle shape and the live one rather than swapping
       them, but asymmetrically: 260ms in, 1100ms out. Play should land
       like a switch being thrown; pause should settle. The old version
       used the same 900ms both ways, and that is most of why the start
       felt apologetic. */
    const MORPH = want ? 260 : 1100;
    this.mixT = Math.max(0, Math.min(1, this.mixT + (want ? dt : -dt) / MORPH));
    this.mix  = this.mixT * this.mixT * (3 - 2 * this.mixT);

    /* Keep reading the analyser all the way through a fade-out: the engine
       ramps its own gain down over about a second, so the bars settle with
       the sound instead of dropping out from under it. */
    const live = an && this.mixT > 0;
    let freq = null, edges = null, bins = 0;
    if (live) {
      bins = an.frequencyBinCount;
      if (!this.freq || this.freq.length !== bins) this.freq = new Uint8Array(bins);
      an.getByteFrequencyData(this.freq);
      freq  = this.freq;
      edges = this._bands(bins, an.context.sampleRate);
    }

    const beat = (Pulse.current && Pulse.current.beat) || 0;
    VIZ.step(dt, beat);

    /* The neon reads its two tube colours off the same drift the light
       show runs on, so the sign travels with the room instead of being a
       frozen pink. Written only when the rounded degree actually changes
       — the drift is slow, so this is a handful of style writes a second
       rather than two per frame. */
    const lw = Math.round(VIZ.base), lc = Math.round(VIZ.cool);
    if (lw !== this.lampW || lc !== this.lampC) {
      this.lampW = lw; this.lampC = lc;
      const root = document.documentElement.style;
      root.setProperty('--lamp-warm', lw);
      root.setProperty('--lamp-cool', lc);
      this._barFill();
    }

    /* ---- one pass over the bands, shared by all three layers ---- */
    const ups = this.ups;
    const lowN = Math.max(1, Math.floor(this.n * 0.14));
    let bass = 0;

    for (let i = 0; i < this.n; i++) {
      // the idle shape is always computed — it is half of the crossfade
      let idle;
      if (REDUCED) {
        idle = 0.10;                     // present, but holding still
      } else {
        idle = 0.08
          + 0.07 * (Math.sin(i * 0.22 - this.t * 1.6) + 1)
          + 0.045 * (Math.sin(i * 0.07 + this.t * 0.7) + 1);
      }

      let v = idle;
      if (live) {
        const a = edges[i], b = edges[i + 1];
        if (b - a < 1) {
          /* Band narrower than a single bin — true right across the bass,
             where the log split is finest. Reading one bin per bar there
             gives a dozen neighbours the same value and the low end comes
             out as a staircase, so interpolate between bins instead. */
          const c = (a + b) / 2, f0 = Math.floor(c), tt = c - f0;
          v = (freq[f0] * (1 - tt) + freq[Math.min(f0 + 1, bins - 1)] * tt) / 255;
        } else {
          let peak = 0;
          for (let k = Math.floor(a); k <= Math.ceil(b) && k < bins; k++) {
            if (freq[k] > peak) peak = freq[k];
          }
          v = peak / 255;
        }
        /* Recorded music carries far less energy up top; without a tilt
           the right two-thirds of the row barely moves. */
        v = Math.min(1, v * (1 + 1.25 * (i / this.n)));
        v = Math.pow(v, 1.28);          // deepens the floor so quiet is not a slab
        v = idle + (v - idle) * this.mix;
      }
      if (i < lowN) bass += v;

      const up = Math.max(1.5, v * this.upMax);
      ups[i] = up;

      // caps latch onto a new high instantly, then fall under gravity
      if (up >= this.peaks[i]) { this.peaks[i] = up; this.vel[i] = 0; }
      else { this.vel[i] += 0.30; this.peaks[i] = Math.max(up, this.peaks[i] - this.vel[i]); }

      /* A band that jumps hard in a single frame is a transient — a kick,
         a snare, a pick attack. Flag it, let the flag decay, and spend it
         on embers and on a brighter cap. */
      const jump = (up - this.prevUp[i]) / this.upMax;
      if (jump > 0.11) {
        this.hit[i] = 1;
        if (this.mix > 0.35) {
          const count = jump > 0.26 ? 3 : 1;
          const x = i * (this.bw + this.gap) + this.gap * 0.5 + this.bw * 0.5;
          for (let k = 0; k < count; k++) {
            this.sparks.emit(x, this.mid - up, Math.min(1.4, jump * 3.4));
          }
        }
      } else {
        this.hit[i] *= 0.86;
      }
      this.prevUp[i] = up;
    }
    bass = Math.min(1, bass / lowN);

    /* ---- onset detection ----
       The first version fired on `bass - prevBass > 0.13`, a fixed jump
       between two frames. That is why the rings only really showed up at
       the start of a section: a fixed threshold is measured against
       nothing, so it fires constantly on a loud track and almost never
       on a quiet one, and it misses every kick that arrives while the
       low end is already busy.

       This compares the low end against its own slow running mean
       instead, so what counts as a hit scales with the track, plus a
       refractory gap so a single kick spread over three frames is one
       ring and not three. The result is a ring on essentially every
       kick, all the way through the song, which is the point. */
    this.sinceRing += dt;
    const rising = bass > this.prevBass;
    const hit = this.mix > 0.35 && rising &&
                bass > 0.06 &&                       // ignore the noise floor
                bass > this.bassAvg * 1.15 + 0.012 &&
                this.sinceRing > 165;                // ~360bpm ceiling
    if (hit) {
      this.flash = Math.min(1, this.flash + 0.85);
      this.sinceRing = 0;
      if (!REDUCED) {
        /* Strength of the hit sets how far and how bright it travels, so
           a chorus throws wide bright rings and a verse throws small
           ones — the array is the dynamics of the track, visible. */
        const power = Math.min(1, (bass - this.bassAvg) * 3.2);
        // only the hard ones earn a cut; rings fire on all of them
        if (power > 0.55) this.jump.fire();
        this.rings.push({ r: 0, a: 0.5 + 0.5 * power, w: 2 + 3.5 * power,
                          spd: 0.8 + 0.7 * power });
        if (this.rings.length > 14) this.rings.shift();
        /* Only the hard hits get to move the rig, and even then each
           lamp still has to be past its own dwell. Cueing on every ring
           was the first version and it was a scanner. */
        if (power > 0.30) { for (const s of this.spots) s.cue(); }
      }
    }
    // slow enough to sit under the beat, fast enough to track a section change
    this.bassAvg += (bass - this.bassAvg) * 0.045;
    this.prevBass = bass;
    this.flash *= 0.90;

    this.sparks.update(dt);
    this.jump.tick();

    this.drawGlow(bass);
    this.drawBeams(bass, dt);
    this.drawRings(dt);
    this.drawAurora();
  }

  /* ---- layer 1: the wash ------------------------------------------- */
  drawGlow (bass) {
    const ctx = this.g;
    if (!ctx) return;
    const L = this.L[0], w = L.w, h = L.h;
    ctx.clearRect(0, 0, w, h);
    if (REDUCED) return;

    ctx.globalCompositeOperation = 'lighter';

    /* The bank of light: every fourth band, four times as wide, tall
       enough to reach the top of the screen on a chorus. CSS blurs this
       into a wash, so the individual columns never read as bars. */
    const per   = w / Math.ceil(this.n / 4);
    const amp   = h * (0.40 + 0.60 * this.mix) * (0.75 + 0.55 * this.flash);
    const light = 50 + 16 * this.flash;
    const alpha = (0.16 + 0.56 * this.mix).toFixed(3);
    for (let i = 0, k = 0; i < this.n; i += 4, k++) {
      const v = this.ups[i] / this.upMax;
      ctx.fillStyle = VIZ.at(i / this.n, light, alpha);
      ctx.fillRect(k * per, h - v * amp, per * 0.92, v * amp);
    }

    /* Footlights — a low warm sun under the fold that swells on the kick,
       and the reason the bottom of the screen feels hot.

       Amber at the core rather than rose. This was the same magenta as
       everything above it, which made the whole frame one temperature;
       running the floor warm and the air above it cool is the oldest
       trick in stage lighting and it is what gives the screen depth
       rather than just brightness. The gradient crosses from amber
       through rose so there is no seam between the two systems. */
    const rad = h * (0.32 + 0.5 * bass * this.mix + 0.3 * this.flash);
    const gr = ctx.createRadialGradient(w * 0.5, h, 0, w * 0.5, h, Math.max(1, rad));
    gr.addColorStop(0,    VIZ.warm(64, (0.14 + 0.36 * this.mix + 0.42 * this.flash).toFixed(3)));
    gr.addColorStop(0.34, VIZ.warm(52, (0.08 + 0.18 * this.mix).toFixed(3)));
    gr.addColorStop(0.68, VIZ.at(0.35, 52, (0.06 + 0.12 * this.mix).toFixed(3)));
    gr.addColorStop(1,    'hsla(0,0%,0%,0)');
    ctx.fillStyle = gr;
    ctx.fillRect(0, 0, w, h);

    /* ---- backlight ----
       An ANNULUS, not a disc, and that is the whole trick. This canvas
       composites over the portrait rather than under it — there is
       nothing under it but the page — so a filled bloom centred on him
       washes his face out and reads as a lens flare. A ring of light
       whose dark hole sits exactly where he does spills around his
       outline instead, which is what a lamp behind someone actually
       looks like, and it costs one gradient rather than a cutout.

       Radius breathes with the low end; the inner stop is transparent so
       his face stays his face however hard the track hits. */
    const sx = this.srcX * w, sy = this.srcY * h;
    const R  = h * (0.44 + 0.30 * bass * this.mix + 0.16 * this.flash);
    const bl = ctx.createRadialGradient(sx, sy, R * 0.20, sx, sy, R);
    bl.addColorStop(0,    'hsla(0,0%,0%,0)');
    bl.addColorStop(0.30, VIZ.at(0.15, 58, (0.10 + 0.20 * this.mix + 0.30 * this.flash).toFixed(3)));
    bl.addColorStop(0.52, VIZ.at(0.55, 52, (0.12 + 0.22 * this.mix + 0.22 * this.flash).toFixed(3)));
    bl.addColorStop(1,    'hsla(0,0%,0%,0)');
    ctx.fillStyle = bl;
    ctx.fillRect(0, 0, w, h);

    /* The rim itself: a much tighter, brighter band on the same centre,
       driven by the kick alone. This is the edge that lights up on him. */
    if (this.flash > 0.02) {
      const rr = R * 0.62;
      const rim = ctx.createRadialGradient(sx, sy, rr * 0.74, sx, sy, rr);
      rim.addColorStop(0, 'hsla(0,0%,0%,0)');
      rim.addColorStop(0.6, VIZ.at(0.1, 72, (0.5 * this.flash).toFixed(3)));
      rim.addColorStop(1, 'hsla(0,0%,0%,0)');
      ctx.fillStyle = rim;
      ctx.fillRect(0, 0, w, h);
    }

    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---- layer 2: the followspots ------------------------------------- */
  drawBeams (bass, dt) {
    const ctx = this.b;
    if (!ctx) return;
    const L = this.L[1], w = L.w, h = L.h;
    // clears for drawRings too, which paints onto this same canvas after
    ctx.clearRect(0, 0, w, h);
    if (REDUCED) return;

    /* Before anyone presses play the rig is not "the show, dimmed" —
       it is one lamp already found him and the other two cold. That is
       a stage waiting, and it makes Play a cue rather than a fade-up:
       two more lamps strike and everything starts moving. Nine wedges
       could get away with a flat 0.16 floor because there were nine of
       them and they filled the frame; three narrow cones at that level
       are simply not on screen. */
    const him = [this.srcX, this.srcY];

    /* The counter lamp is fed by the top third of the spectrum, the warm
       one by the low end. So the cool lamp flickers with cymbals and
       vocal air while the amber one moves with the kick — the two are
       never pumping on the same thing, which is what stops the rig
       reading as one object. */
    let top = 0;
    const from = Math.floor(this.n * 0.62);
    for (let i = from; i < this.n; i++) top += this.ups[i];
    top = Math.min(1, top / ((this.n - from) * this.upMax) * 1.9);

    const drive = [
      0.60 + 0.40 * this.flash,
      0.34 + 0.66 * top,
      0.42 + 0.58 * bass
    ];

    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.spots.length; i++) {
      const s = this.spots[i];
      s.step(dt, him);
      const lit = this.mix + (1 - this.mix) * s.idle;
      /* A lamp brightens while it travels. Air that a beam is sweeping
         through scatters more of it than air it has been sitting in,
         and without this the swing is the quietest moment on screen
         instead of the loudest. */
      this._cone(ctx, s, w, h, lit * drive[i] * (1 + Math.min(0.45, s.speed * 1.1)));
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /* One lamp: three nested wedges and the pool where it lands.

     Three wedges rather than one because a single gradient-filled
     triangle has a hard edge down each side and reads as paper. Stacked
     wide-dim / mid / narrow-hot under `lighter`, the edges sum into a
     falloff across the width and the middle becomes a core — which is
     what a beam in air actually looks like. */
  _cone (ctx, s, w, h, level) {
    if (level < 0.015) return;

    const ox = s.rig[0] * w, oy = s.rig[1] * h;
    const mx = s.x * w,      my = s.y * h;
    const dist = Math.hypot(mx - ox, my - oy) || 1;
    const ang  = Math.atan2(my - oy, mx - ox);
    const rSpot = s.iris * h;
    const half  = Math.atan2(rSpot, dist);   // fixed iris, so reach narrows it
    const len   = dist * 1.22;               // overshoots the mark a little

    const col = s.gel === 'warm'
      ? (l, a) => VIZ.warm(l, a)
      : (l, a) => VIZ.at(s.gel, l, a);

    // spread, alpha, lightness
    const LAY = [[1.95, 0.15, 58], [1.0, 0.29, 65], [0.42, 0.38, 78]];
    for (let k = 0; k < LAY.length; k++) {
      const hw = half * LAY[k][0], a = LAY[k][1] * level, li = LAY[k][2];
      const g = ctx.createLinearGradient(ox, oy,
                                         ox + Math.cos(ang) * len,
                                         oy + Math.sin(ang) * len);
      /* Brightest partway down rather than at the lens: the first
         stretch out of a lamp is the part you are least likely to be
         looking at, and peaking at the source drags the eye off frame. */
      g.addColorStop(0,    col(li, (a * 0.55).toFixed(3)));
      g.addColorStop(0.42, col(li, a.toFixed(3)));
      g.addColorStop(1,    'hsla(0,0%,0%,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(ox + Math.cos(ang - hw) * len, oy + Math.sin(ang - hw) * len);
      ctx.lineTo(ox + Math.cos(ang + hw) * len, oy + Math.sin(ang + hw) * len);
      ctx.closePath();
      ctx.fill();
    }

    /* The pool. A followspot you cannot see land is not following
       anything — this is the bright patch that sits on his face while
       the key lamp holds, and it is the difference between a beam that
       points at him and a beam that has found him. Stretched along the
       throw because the light arrives at an angle. */
    ctx.save();
    ctx.translate(mx, my);
    ctx.rotate(ang);
    ctx.scale(1.35, 1);
    const R = rSpot * 1.5;
    const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
    pool.addColorStop(0,    col(84, (0.50 * level).toFixed(3)));
    pool.addColorStop(0.48, col(66, (0.20 * level).toFixed(3)));
    pool.addColorStop(1,    'hsla(0,0%,0%,0)');
    ctx.fillStyle = pool;
    ctx.fillRect(-R, -R, R * 2, R * 2);
    ctx.restore();
  }

  /* ---- beat rings ----------------------------------------------------
     One ring per kick, expanding out of the same point the backlight
     comes from, so the light and the pulse share a source and he reads
     as where the sound is coming from.

     Full circles, not the half-circles this started as: those were
     anchored under the fold and only ever showed their top edge, which
     is a ripple, not a ring. Each one thins and fades as it grows, so
     a busy bar has four or five in flight at different radii and the
     screen keeps breathing instead of flashing.

     Painted onto the beam canvas — drawBeams() has already cleared it —
     rather than a fifth layer of its own: they want the same soft blur
     and the same half resolution, and one canvas is one composite. */
  drawRings (dt) {
    const ctx = this.b;
    if (!ctx || REDUCED) { this.rings.length = 0; return; }
    const L = this.L[1], w = L.w, h = L.h;
    if (!this.rings.length) return;

    const sx = this.srcX * w, sy = this.srcY * h;
    /* Far enough to leave the screen from a source that is off-centre,
       measured on the diagonal so a ring never stops short in a corner. */
    const far = Math.hypot(w, h) * 1.05;

    ctx.globalCompositeOperation = 'lighter';
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.r += dt * 0.0016 * far * r.spd;
      r.a *= 0.982;
      if (r.a < 0.015 || r.r > far) { this.rings.splice(i, 1); continue; }

      /* Thinning is a share of the distance travelled, not a fixed rate:
         a ring should look like it is being stretched thinner as it
         expands, which is what makes it read as one expanding object
         rather than a circle that happens to be growing. */
      const life = 1 - r.r / far;
      ctx.strokeStyle = 'rgba(' + VIZ.RING + ',' + (r.a * life).toFixed(3) + ')';
      ctx.lineWidth = Math.max(0.4, r.w * life * life);
      ctx.beginPath();
      ctx.arc(sx, sy, r.r, 0, 6.283);
      ctx.stroke();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /* ---- layer 3: aurora curtains ------------------------------------- */
  drawAurora () {
    const ctx = this.s, w = this.w, h = this.h;
    if (!ctx) return;

    /* Trails. Same destination-out fade as the old bar row: a black wash
       would slab over the portrait. Slower than the bars so the curtains
       smear into one sheet of light. */
    if (REDUCED) {
      ctx.clearRect(0, 0, w, h);
    } else {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,.16)';
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'lighter';

    /* Four sheets: a green curtain (the aurora people actually picture),
       the room's cool tube, the song as a thinner ribbon, and a violet
       edge. Amber is kept off this canvas — against the orange portrait
       it read as fire, not as polar light. */
    const layers = [
      { hue: 148,          y: 0.94, amp: 0.62, spd: 0.18, ph: 0,   a: 0.28 },
      { hue: VIZ.cool,     y: 0.93, amp: 0.52, spd: 0.27, ph: 1.6, a: 0.22 },
      { hue: VIZ.base,     y: 0.95, amp: 0.40, spd: 0.21, ph: 2.4, a: 0.14 },
      { hue: 280,          y: 0.96, amp: 0.34, spd: 0.33, ph: 0.7, a: 0.16 }
    ];

    const steps = 48;
    for (let L = 0; L < layers.length; L++) {
      const layer = layers[L];
      const pts = new Array(steps + 1);
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const bi = Math.min(this.n - 1, Math.round(u * (this.n - 1)));
        const energy = this.ups[bi] / this.upMax;
        const fold = Math.sin(u * 14.5 + this.t * layer.spd + layer.ph) * 0.16
                   + Math.sin(u * 4.4 - this.t * layer.spd * 0.55) * 0.38
                   + Math.sin(u * 22 + layer.ph) * 0.07;
        const rise = (0.18 + 0.72 * energy * (0.35 + 0.65 * this.mix) + 0.14 * this.flash)
                   * layer.amp * (0.78 + fold);
        pts[i] = { x: u * w, y: h * layer.y - rise * h };
      }

      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1], p1 = pts[i];
        ctx.quadraticCurveTo(p0.x, p0.y, (p0.x + p1.x) * 0.5, (p0.y + p1.y) * 0.5);
      }
      ctx.lineTo(w, h);
      ctx.closePath();

      const alpha = layer.a * (0.35 + 0.65 * this.mix) + 0.12 * this.flash;
      const g = ctx.createLinearGradient(0, h * 0.12, 0, h);
      g.addColorStop(0,    'hsla(' + layer.hue.toFixed(1) + ',95%,72%,0)');
      g.addColorStop(0.28, 'hsla(' + layer.hue.toFixed(1) + ',100%,64%,' + alpha.toFixed(3) + ')');
      g.addColorStop(0.62, 'hsla(' + layer.hue.toFixed(1) + ',90%,48%,' + (alpha * 0.45).toFixed(3) + ')');
      g.addColorStop(1,    'hsla(' + layer.hue.toFixed(1) + ',80%,40%,0)');
      ctx.fillStyle = g;
      ctx.fill();
    }

    if (this.mix > 0.05 && !REDUCED) {
      ctx.lineWidth = 1.4;
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'hsla(' + VIZ.base.toFixed(1) + ',100%,78%,' +
                        (0.18 + 0.45 * this.mix + 0.3 * this.flash).toFixed(3) + ')';
      ctx.beginPath();
      for (let i = 0; i <= steps; i++) {
        const u = i / steps;
        const bi = Math.min(this.n - 1, Math.round(u * (this.n - 1)));
        const energy = this.ups[bi] / this.upMax;
        const fold = Math.sin(u * 6.2 + this.t * 0.22) * 0.22;
        const y = h * 0.88 - (0.18 + 0.72 * energy + 0.14 * this.flash) * 0.72 * (0.8 + fold) * h;
        if (i === 0) ctx.moveTo(u * w, y);
        else ctx.lineTo(u * w, y);
      }
      ctx.stroke();
    }

    this.sparks.draw(ctx);

    ctx.globalCompositeOperation = 'destination-out';
    const mask = ctx.createLinearGradient(0, 0, w, 0);
    mask.addColorStop(0,    'rgba(0,0,0,.85)');
    mask.addColorStop(0.12, 'rgba(0,0,0,0)');
    mask.addColorStop(0.88, 'rgba(0,0,0,0)');
    mask.addColorStop(1,    'rgba(0,0,0,.85)');
    ctx.fillStyle = mask;
    ctx.fillRect(0, 0, w, h);

    const vmask = ctx.createLinearGradient(0, 0, 0, h);
    vmask.addColorStop(0,    'rgba(0,0,0,1)');
    vmask.addColorStop(0.42, 'rgba(0,0,0,.72)');
    vmask.addColorStop(0.78, 'rgba(0,0,0,0)');
    ctx.fillStyle = vmask;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }
}


/* ---------------------------------------------------------
   Ignition — the one-shot when play is pressed.

   Everything else on this screen is a loop reacting to a signal. This is
   the only part that is an event, and it is what the first screen was
   missing: the moment the button is hit the page detonates once — a
   frame of white, a ring across the whole hero, the portrait torn into
   its colour channels — and then settles into the running state.

   The screen half is CSS animations on one element rather than JS, so it
   costs nothing while idle and cannot drift out of sync with a busy main
   thread; HeroViz.ignite() handles the canvas half.
   --------------------------------------------------------- */
class Ignition {
  constructor (el, viz) {
    this.viz = viz;
    /* The class goes on the section, not on the flash element: the veil,
       the ring, the punch on the portrait and its two torn colour copies
       are five animations on four different elements, and they have to
       start on the same frame. One class on their common ancestor is the
       only way to guarantee that. */
    this.hero = el ? el.closest('.hero') : null;
  }

  fire () {
    if (REDUCED) return;
    if (this.viz) this.viz.ignite();
    if (!this.hero) return;
    // restart cleanly even if the previous one is still running
    this.hero.classList.remove('is-igniting');
    void this.hero.offsetWidth;          // reflow, or the class never re-applies
    this.hero.classList.add('is-igniting');
    clearTimeout(this.t);
    // dropped again so the animations are not left holding their `both`
    // end state on the portrait for the rest of the visit
    this.t = setTimeout(() => this.hero.classList.remove('is-igniting'), 1200);
  }
}


/* ---------------------------------------------------------
   AlbumMood — while a track plays, the first screen walks a loop.

   Idle is the photograph as shot. Play starts a ~22s cycle the portrait
   and the lights share: hold colour, take the song's gel, silver, take
   a cooler green/cyan gel, return to colour, repeat. Pause eases back to
   the natural print. Skip restarts the loop so a new track does not
   inherit the previous one's place in the wheel.

   Three numbers, all inherited: `--print` (silver), `--gel` (sepia
   strength), `--shift` (hue-rotate off that sepia, so the gel lands
   near the track hue rather than a fixed brown). The lights stay on
   the song's hue; the aurora and the print are what walk the cycle.

   The wordmark is deliberately not part of the switch. There is only one
   piece of his handwriting, it belongs to Overthinking, and a logo that
   swaps with the queue is not a logo.
   --------------------------------------------------------- */
class AlbumMood {
  constructor (sel, viz) {
    this.el   = document.querySelector(sel);
    this.viz  = viz;
    this.print = 0;
    this.gel   = 0;
    this.shift = 0;
    this.hue   = 322;
    this.trackId = null;
    this.playing = false;
    this.clock   = 0;
    this.running = false;
    this.written = '';
  }

  set (playing, track) {
    const id = track && track.id;
    if (id && id !== this.trackId) {
      this.trackId = id;
      this.clock = 0;
    }
    if (track && typeof track.hue === 'number') this.hue = track.hue;
    this.playing = !!(playing && !REDUCED);
    if (!this.playing) VIZ.target = this.hue;
    this._run();
  }

  /* t seconds into the loop → print, gel, hue-rotate, light offset. */
  _pose (sec) {
    const cycle = 22;
    const t = ((sec % cycle) + cycle) % cycle;
    const song = this.hue - 40;
    const keys = [
      { t: 0,    print: 0,    gel: 0,    shift: 0,              light: 0 },
      { t: 3.5,  print: 0,    gel: 0,    shift: 0,              light: 0 },
      { t: 7.0,  print: 0.06, gel: 0.48, shift: song,           light: 0 },
      { t: 10.8, print: 1,    gel: 0.04, shift: song,           light: 0 },
      { t: 14.8, print: 0.08, gel: 0.40, shift: 152,            light: 192 - this.hue },
      { t: 18.6, print: 0,    gel: 0.10, shift: 0,              light: 192 - this.hue },
      { t: 22.0, print: 0,    gel: 0,    shift: 0,              light: 0 }
    ];
    let a = keys[0], b = keys[1];
    for (let i = 0; i < keys.length - 1; i++) {
      if (t >= keys[i].t && t <= keys[i + 1].t) { a = keys[i]; b = keys[i + 1]; break; }
    }
    const u = (t - a.t) / ((b.t - a.t) || 1);
    const s = u * u * (3 - 2 * u);
    return {
      print: a.print + (b.print - a.print) * s,
      gel:   a.gel   + (b.gel   - a.gel)   * s,
      shift: a.shift + (b.shift - a.shift) * s,
      light: a.light + (b.light - a.light) * s
    };
  }

  _run () {
    if (this.running || !this.el) return;
    this.running = true;
    let last = performance.now();
    const tick = (now) => {
      const dt = Math.min(64, now - last);
      last = now;
      let tPrint = 0, tGel = 0, tShift = 0;
      if (this.playing) {
        this.clock += dt;
        const pose = this._pose(this.clock / 1000);
        tPrint = pose.print;
        tGel   = pose.gel;
        tShift = pose.shift;
        VIZ.target = this.hue;
      }
      const k = this.playing ? 0.055 : 0.12;
      this.print += (tPrint - this.print) * k;
      this.gel   += (tGel   - this.gel)   * k;
      this.shift += (tShift - this.shift) * k;

      const parked = !this.playing
        && Math.abs(this.print) < 0.004
        && Math.abs(this.gel)   < 0.004
        && Math.abs(this.shift) < 0.4;
      if (parked) {
        this.print = this.gel = this.shift = 0;
        this.clock = 0;
        this._write();
        this.running = false;
        return;
      }
      this._write();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  _write () {
    const s = this.print.toFixed(3) + '|' + this.gel.toFixed(3) + '|' + this.shift.toFixed(1);
    if (s === this.written) return;
    this.written = s;
    this.el.style.setProperty('--print', this.print.toFixed(3));
    this.el.style.setProperty('--gel',   this.gel.toFixed(3));
    this.el.style.setProperty('--shift', this.shift.toFixed(1));
  }
}


/* ---------------------------------------------------------
   Parallax — the hero answers the cursor.

   Every other thing on the first screen moves on a timer: the grain, the
   wordmark drawing itself, the pip on the eyebrow, the halo on the play
   button, the idle swell in the spectrum. The portrait had only its 26s
   Ken Burns, which is about two thousandths of a percent of scale per
   frame — mathematically moving, visually a photograph nailed to the
   wall. Sitting still in a frame where everything else drifts is what
   made it read as dead rather than as calm.

   A timer would not have fixed that; another loop is just more wallpaper.
   Responding to the pointer is different in kind, because the motion is
   caused by the person looking at it.

   Depth is the point, so the layers disagree: the portrait leans AWAY
   from the cursor and the wordmark in front of it leans WITH it, which
   is what parallax is. Amplitudes are small — this is a head turning,
   not a funhouse mirror.

   Driven from one rAF off the shared POINTER rather than a mousemove
   handler, so the value is eased and the photograph glides to a stop
   instead of snapping to wherever the mouse last was.
   --------------------------------------------------------- */
class Parallax {
  constructor (sel) {
    this.el = document.querySelector(sel);
    // no pointer to follow on a touch screen, and it is motion either way
    if (!this.el || REDUCED || matchMedia('(hover: none)').matches) return;

    this.x = 0; this.y = 0;          // eased, -1..1
    this.visible = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; },
                               { threshold: 0 }).observe(this.el);
    }
    this.loop();
  }

  loop () {
    requestAnimationFrame(() => this.loop());
    if (!this.visible) return;

    let tx = 0, ty = 0;
    if (POINTER.x >= 0) {
      const r = this.el.getBoundingClientRect();
      if (r.width && r.height) {
        /* Clamped rather than left unbounded: the pointer is tracked for
           the whole document, and without this the hero would keep
           leaning further the further down the page you moved. */
        tx = Math.max(-1, Math.min(1, ((POINTER.x - r.left) / r.width  - 0.5) * 2));
        ty = Math.max(-1, Math.min(1, ((POINTER.y - r.top)  / r.height - 0.5) * 2));
      }
    }
    // slow enough to feel like weight, fast enough not to lag behind
    this.x += (tx - this.x) * 0.055;
    this.y += (ty - this.y) * 0.055;

    const st = this.el.style;
    st.setProperty('--par-x', this.x.toFixed(4));
    st.setProperty('--par-y', this.y.toFixed(4));
  }
}


/* ---------------------------------------------------------
   HeightVar — publishes an element's height as a custom property

   Two things on this page have to be laid out around rather than guessed
   at: the sticky nav, which anchor targets and the sticky rails in About
   and Press must clear, and the awards ticker, whose height the hero gives
   up so the strip lands at the foot of the first screen. Both move with the
   viewport, the locale and their own type, so both are measured. The CSS
   carries fallbacks for before this runs.
   --------------------------------------------------------- */
class HeightVar {
  constructor (sel, prop) {
    const el = document.querySelector(sel);
    if (!el) return;

    const publish = () => {
      const h = el.offsetHeight;
      if (h) document.documentElement.style.setProperty(prop, h + 'px');
    };
    publish();

    /* What the property feeds (the hero's height, scroll margins) never
       feeds back into these two elements, so observing them cannot loop. */
    if ('ResizeObserver' in window) new ResizeObserver(publish).observe(el);
    else addEventListener('resize', publish);
  }
}


/* ---------------------------------------------------------
   Tilt — the reference effect, dialled back from 10deg to 4

   It also publishes the pointer on the card as --tx / --ty in -0.5..0.5.
   The Overthinking sleeve is stacked from four depth planes and slides
   each of them off those two numbers, which is why they are variables
   rather than another transform: a plane inside .card__sleeve cannot be
   pushed in Z, because that element clips its overflow and clipping
   flattens 3D. See .sleeve in the stylesheet.
   --------------------------------------------------------- */
class Tilt {
  constructor (sel = '[data-tilt]', max = 4) {
    if (REDUCED || matchMedia('(hover: none)').matches) return;
    this.max = max;
    document.querySelectorAll(sel).forEach(el => {
      el.style.transition = 'transform .5s cubic-bezier(.22,.61,.36,1)';
      el.addEventListener('mousemove', e => this.move(e, el));
      el.addEventListener('mouseleave', () => this.reset(el));
      el.addEventListener('mouseenter', () => { el.style.transition = 'transform .12s linear'; });
    });
  }
  move (e, el) {
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width  - 0.5;
    const py = (e.clientY - r.top)  / r.height - 0.5;
    el.style.transform =
      `perspective(900px) rotateX(${-py * this.max * 2}deg) ` +
      `rotateY(${px * this.max * 2}deg) translateY(-4px)`;
    el.style.setProperty('--tx', px.toFixed(3));
    el.style.setProperty('--ty', py.toFixed(3));
  }
  reset (el) {
    el.style.transition = 'transform .5s cubic-bezier(.22,.61,.36,1)';
    el.style.transform = '';
    // back to the stylesheet's 0, rather than 0 set inline: the planes
    // ease home on the same curve as the card because they are reading the
    // same value it is
    el.style.removeProperty('--tx');
    el.style.removeProperty('--ty');
  }
}


/* ---------------------------------------------------------
   Reveal — staggered scroll-in
   --------------------------------------------------------- */
class Reveal {
  constructor (sel = '.reveal') {
    const items = document.querySelectorAll(sel);
    if (REDUCED || !('IntersectionObserver' in window)) {
      items.forEach(el => el.classList.add('is-in'));
      return;
    }
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry, i) => {
        if (!entry.isIntersecting) return;
        setTimeout(() => entry.target.classList.add('is-in'), i * 90);
        io.unobserve(entry.target);
      });
    }, { threshold: 0.15, rootMargin: '0px 0px -8% 0px' });
    items.forEach(el => io.observe(el));

    // Failsafe: nothing should stay invisible just because the observer
    // never fired (print, full-page capture, odd scroll containers).
    setTimeout(() => items.forEach(el => el.classList.add('is-in')), 4000);
  }
}


/* ---------------------------------------------------------
   Ticker — seamless marquee, duplicated to fill the width
   --------------------------------------------------------- */
class Ticker {
  /* `pauseSel` names an ancestor of the track; while the pointer is inside
     it the marquee coasts to a stop, so something scrolling past can still
     be read and clicked, and winds back up once the pointer leaves. */
  constructor (trackSel, speed = 42, setSel = '.ticker__set', pauseSel = null) {
    const track = document.querySelector(trackSel);
    if (!track) return;
    const set = track.querySelector(setSel);
    if (!set) return;

    // duplicate until we have at least 2x viewport, then one more for the wrap
    while (track.scrollWidth < innerWidth * 2) {
      track.appendChild(set.cloneNode(true));
    }
    track.appendChild(set.cloneNode(true));

    if (REDUCED) return;

    let cycle = set.getBoundingClientRect().width;
    let x = 0, last = performance.now();
    let factor = 1, held = false;

    // A late webfont swap changes how wide a set is. Re-measure, or the wrap
    // point drifts off the real width and opens a gap in the loop.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(() => { cycle = set.getBoundingClientRect().width; });
    }

    const zone = pauseSel ? track.closest(pauseSel) : null;

    /* Whether the row is held is worked out from geometry each frame, not
       from enter/leave events.

       Two ways events get this wrong. A card drifting under a pointer that
       is not moving fires enter, stops the marquee, and then never fires
       leave, because a stopped card never leaves the pointer. And scrolling
       the row out from under a resting cursor does not reliably fire leave
       either, so it stays frozen until the mouse is moved.

       Comparing the live pointer position against the row's current
       rectangle has neither problem: scroll away and the rectangle moves,
       so the hold ends on its own. */
    const overZone = () => {
      if (!zone || POINTER.x < 0) return false;
      const r = zone.getBoundingClientRect();
      return POINTER.x >= r.left && POINTER.x <= r.right &&
             POINTER.y >= r.top  && POINTER.y <= r.bottom;
    };

    const step = (now) => {
      // clamped so a backgrounded tab doesn't resume with one enormous jump
      const dt = Math.min((now - last) / 1000, 0.05); last = now;

      held = overZone();

      // ease toward a standstill rather than stopping dead
      factor += ((held ? 0 : 1) - factor) * Math.min(1, dt * 3.5);

      // and lean into the low end, so the row moves with the music
      const swing = 1 + (Pulse.current ? Pulse.current.beat : 0) * 0.45;

      x -= speed * factor * swing * dt;
      if (-x >= cycle) x += cycle;
      track.style.transform = `translate3d(${x}px,0,0)`;
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}


/* ---------------------------------------------------------
   Pulse — one read of the analyser per frame, published for
   anything that wants to move with the music. Spectrum draws
   its own bars off the same node; this is the cheap shared
   signal for everything else.
   --------------------------------------------------------- */
class Pulse {
  constructor (engine) {
    this.engine = engine;
    this.level = 0;          // 0..1, everything
    this.beat  = 0;          // 0..1, the low end you actually feel
    this.glitch = 0;         // 0..1, spikes on an attack and decays fast
    this.focus = 0;          // 0..1, how far OUT of focus the portrait is
    this.was   = false;
    Pulse.current = this;
    this.loop();
  }

  loop () {
    requestAnimationFrame(() => this.loop());

    const an = this.engine && this.engine.analyser;
    const on = !!(an && this.engine.playing) && !REDUCED;

    let level = 0, beat = 0;
    if (!on && !REDUCED) {
      /* A slow idle breath so the portrait and the Play halo are already
         alive before anyone presses. Far below an attack, so no tear. */
      const t = performance.now() * 0.001;
      beat  = 0.05 + 0.045 * (0.5 + 0.5 * Math.sin(t * 1.15));
      level = beat * 0.55;
    } else if (on) {
      const bins = an.frequencyBinCount;
      if (!this.buf || this.buf.length !== bins) this.buf = new Uint8Array(bins);
      an.getByteFrequencyData(this.buf);

      /* Bass rather than overall loudness. Overall level tracks vocals and
         cymbals too, which shimmers constantly; 20-150Hz tracks the kick,
         which is what reads as a beat. */
      const nyq = an.context.sampleRate / 2;
      const lo  = Math.max(1, Math.round((20  / nyq) * bins));
      const hi  = Math.max(lo + 1, Math.round((150 / nyq) * bins));
      let b = 0;
      for (let i = lo; i < hi; i++) b += this.buf[i];
      beat = b / (hi - lo) / 255;

      let t = 0;
      for (let i = 0; i < bins; i++) t += this.buf[i];
      level = t / bins / 255;
    }

    /* The attack, before the easing below smooths it away. A kick that
       arrives inside one frame is the only thing that should tear the
       portrait into its colour channels; a loud sustained passage is
       not an attack, however loud it is, so this is a rising edge on
       the raw value rather than a threshold on the eased one. */
    const attack = beat - this.beat;
    if (attack > 0.13) this.glitch = Math.min(1, attack * 3.6);
    // fast decay: a tear that lingers stops reading as a hit and starts
    // reading as a broken image
    this.glitch *= 0.74;
    if (this.glitch < 0.01) this.glitch = 0;

    // eased, so it swells and settles instead of strobing
    this.beat  += (beat  - this.beat)  * 0.20;
    this.level += (level - this.level) * 0.12;

    /* Focus breathing, inverted on purpose: soft between the beats and
       snapping sharp ON them, rather than the other way round. The music
       pulling the photograph into focus is a far better read than the
       music knocking it out of focus, and it stacks with the grayscale
       burning off the same way.

       2.4x so a normal kick reaches a true zero — a portrait that never
       quite resolves reads as a rendering fault, not as an effect. It is
       computed from the eased beat rather than the raw one so the recovery
       is a lens settling, not a step. */
    const wantFocus = on ? Math.max(0, 1 - this.beat * 2.4) : 0;
    this.focus += (wantFocus - this.focus) * 0.35;

    const root = document.documentElement;
    root.style.setProperty('--beat',   this.beat.toFixed(3));
    root.style.setProperty('--level',  this.level.toFixed(3));
    root.style.setProperty('--glitch', this.glitch.toFixed(3));
    root.style.setProperty('--focus',  this.focus.toFixed(3));

    // one class toggle, not one per frame
    if (on !== this.was) {
      root.classList.toggle('is-playing', on);
      this.was = on;
    }
  }
}
Pulse.current = null;


/* ---------------------------------------------------------
   Platter — the record on the play button actually behaves
   like a record: it takes about a second to come up to speed
   and it coasts to a stop, holding wherever it stopped.

   This is JS rather than a CSS animation because a CSS
   animation can only be on or off. Toggling it snaps the
   groove back to 0deg on every pause, which reads as a
   glitch, and it starts at full 33 1/3 on the first frame,
   which reads as a spinning gif rather than a turntable.
   One transform write per frame on a 44px element is
   cheaper than the ::before it sits on.
   --------------------------------------------------------- */
class Platter {
  constructor (sel) {
    this.el = document.querySelector(sel);
    this.angle = 0;        // deg, kept across pauses, read by Groove too
    this.rate  = 0;        // deg/sec, what it is doing now
    this.want  = 0;        // deg/sec, what it is being asked to do
    this.last  = 0;
    this.raf   = 0;
  }

  // 33 1/3 rpm is 200 deg/s. Matching the real speed is free and it is
  // the one number a musician looking at this will notice.
  set (on) {
    this.want = (on && !REDUCED) ? 200 : 0;
    if (REDUCED) return;             // no motor, no coast, no frames
    if (!this.raf) { this.last = performance.now(); this.tick(this.last); }
  }

  tick (now) {
    const dt = Math.min((now - this.last) / 1000, 0.05);   // tab-switch guard
    this.last = now;

    /* Asymmetric on purpose: a belt drive pulls up to speed faster than
       an unpowered platter sheds it. 4.2 gets there in about 0.8s, 1.9
       coasts down over roughly 1.6s. */
    const k = this.want > this.rate ? 4.2 : 1.9;
    this.rate += (this.want - this.rate) * Math.min(1, k * dt);

    this.angle = (this.angle + this.rate * dt) % 360;
    if (this.el) this.el.style.transform = 'rotate(' + this.angle.toFixed(2) + 'deg)';

    // stopped and asked to stay stopped: drop the frame loop entirely
    if (this.want === 0 && this.rate < 0.4) { this.rate = 0; this.raf = 0; return; }
    this.raf = requestAnimationFrame(t => this.tick(t));
  }
}


/* ---------------------------------------------------------
   PressStage — four items in view around the photograph;
   the arrows step that window along, the photograph does not
   move. Falls back to the plain grid of everything if there
   is nothing to page through.
   --------------------------------------------------------- */
class PressStage {
  constructor (sel) {
    const stage = document.querySelector(sel);
    if (!stage) return;

    const items = [...stage.querySelectorAll('.press__item')];
    const prev  = stage.querySelector('.press-arrow--prev');
    const next  = stage.querySelector('.press-arrow--next');
    const SHOWN = 4;

    // with four or fewer there is no window to move: leave the fallback alone
    if (items.length <= SHOWN || !prev || !next) return;

    stage.classList.add('is-live');
    let at = 0;

    const paint = () => {
      items.forEach(el => { el.hidden = true; delete el.dataset.slot; });
      for (let k = 0; k < SHOWN; k++) {
        const el = items[(at + k) % items.length];
        el.hidden = false;                 // hidden, so it is skipped by AT too
        el.dataset.slot = String(k);
        // A hidden element never intersects, so Reveal would never mark it in
        // and it would arrive at opacity:0. Anything on show is shown.
        el.classList.add('is-in');
      }
    };

    const step = (d) => {
      at = (at + d + items.length) % items.length;
      paint();
    };

    prev.addEventListener('click', () => step(-1));
    next.addEventListener('click', () => step(1));
    stage.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); step(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    });

    paint();
  }
}


/* ---------------------------------------------------------
   CursorGlow — the same idea as NavGlow, across the whole
   page and much fainter
   --------------------------------------------------------- */
class CursorGlow {
  constructor (sel) {
    const el = document.querySelector(sel);
    if (!el || REDUCED || matchMedia('(hover: none)').matches) return;

    // one write per frame off the shared pointer, not one per pointer event
    const tick = () => {
      requestAnimationFrame(tick);
      if (POINTER.x < 0) return;
      el.style.setProperty('--px', `${POINTER.x}px`);
      el.style.setProperty('--py', `${POINTER.y}px`);
    };
    tick();

    el.classList.add('is-on');
  }
}


/* ---------------------------------------------------------
   NavGlow — publishes the cursor's position along the bar so
   the CSS can paint a faint light under it
   --------------------------------------------------------- */
class NavGlow {
  constructor (sel) {
    const nav = document.querySelector(sel);
    if (!nav || REDUCED || matchMedia('(hover: none)').matches) return;

    nav.addEventListener('pointermove', (e) => {
      const r = nav.getBoundingClientRect();
      nav.style.setProperty('--mx', `${e.clientX - r.left}px`);
      nav.style.setProperty('--my', `${e.clientY - r.top}px`);
    });
  }
}


/* ---------------------------------------------------------
   MobileNav — the link row becomes a drop panel under 900px
   --------------------------------------------------------- */
class MobileNav {
  constructor (navSel, burgerSel) {
    this.nav    = document.querySelector(navSel);
    this.burger = document.querySelector(burgerSel);
    if (!this.nav || !this.burger) return;

    this.burger.addEventListener('click', () => this.toggle());

    // any link closes it — they are all same-page anchors
    this.nav.querySelectorAll('.nav__links a')
      .forEach(a => a.addEventListener('click', () => this.close()));

    addEventListener('keydown', e => { if (e.key === 'Escape') this.close(); });

    // resizing past the breakpoint must not strand the panel open
    matchMedia('(min-width: 901px)').addEventListener('change', e => {
      if (e.matches) this.close();
    });
  }

  toggle () { this.nav.classList.contains('nav--open') ? this.close() : this.open(); }

  open () {
    this.nav.classList.add('nav--open');
    this.burger.setAttribute('aria-expanded', 'true');
    this.burger.setAttribute('aria-label', 'Close menu');
    document.body.classList.add('is-locked');
  }

  close () {
    if (!this.nav.classList.contains('nav--open')) return;
    this.nav.classList.remove('nav--open');
    this.burger.setAttribute('aria-expanded', 'false');
    this.burger.setAttribute('aria-label', 'Open menu');
    document.body.classList.remove('is-locked');
  }
}


/* ---------------------------------------------------------
   ScrollSpy — marks the nav link for the section in view
   --------------------------------------------------------- */
class ScrollSpy {
  constructor (linkSel = '.nav__links a[href^="#"]') {
    const links = [...document.querySelectorAll(linkSel)];
    const map = new Map();

    links.forEach(a => {
      const id = a.getAttribute('href').slice(1);
      const target = id && document.getElementById(id);
      if (target) map.set(target, a);
    });
    if (!map.size || !('IntersectionObserver' in window)) return;

    const io = new IntersectionObserver(entries => {
      entries.forEach(e => {
        // `is-visible` is bookkeeping only; the class the CSS reads is set below
        e.target.dataset.inview = e.isIntersecting ? '1' : '';
      });

      // topmost section still on screen wins, so overlaps don't flicker
      const current = [...map.keys()]
        .filter(el => el.dataset.inview)
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0];

      links.forEach(a => a.classList.remove('is-active'));
      if (current) map.get(current).classList.add('is-active');
    }, { rootMargin: '-45% 0px -45% 0px' });

    map.forEach((_, section) => io.observe(section));
  }
}


/* ---------------------------------------------------------
   VideoFacade — poster now, iframe only once asked for

   Each tile is a plain link in the markup, so with JS off it still
   works; here we upgrade it to load the player in place.

   Two back ends. Which one a tile uses is decided by the page, via
   <html data-video="bilibili">, because YouTube is unreachable from
   mainland China and Bilibili is what that audience actually uses:

     data-yt   YouTube id   — used by the English page
     data-bv   Bilibili BV  — used by the Chinese page

   A Chinese tile whose BV id is not filled in yet is deliberately left
   alone: it stays an ordinary outbound YouTube link rather than
   becoming an embedded player that would never load in China.
   --------------------------------------------------------- */
class VideoFacade {
  constructor (sel = '[data-yt],[data-bv]') {
    // 'youtube' unless the page opts into Bilibili
    this.prefer = document.documentElement.dataset.video || 'youtube';

    document.querySelectorAll(sel).forEach(el => {
      const bv = (el.dataset.bv || '').trim();
      const yt = (el.dataset.yt || '').trim();

      // Bilibili page + a real BV id -> Bilibili. Otherwise YouTube, but
      // only when this page hasn't declared itself Bilibili-first.
      const useBili = this.prefer === 'bilibili' && bv;
      if (!useBili && this.prefer === 'bilibili') {
        el.classList.add('vid--pending');   // no BV id yet; leave the link be
        return;
      }
      if (!useBili && !yt) return;

      const label = el.querySelector('.vid__title');
      const name  = label ? label.textContent.trim() : 'video';
      el.setAttribute('aria-label',
        useBili ? `播放《${name}》（哔哩哔哩）` : `Play ${name} (YouTube)`);

      if (useBili) el.href = `https://www.bilibili.com/video/${bv}`;

      el.addEventListener('click', e => {
        // let modified clicks do the normal thing: open the site properly
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        this.embed(el, useBili ? { kind: 'bilibili', id: bv }
                               : { kind: 'youtube',  id: yt });
      });
    });
  }

  embed (el, src) {
    const frame = el.querySelector('.vid__frame');
    if (!frame || frame.dataset.loaded) return;
    frame.dataset.loaded = '1';

    const iframe = document.createElement('iframe');
    iframe.src = src.kind === 'bilibili'
      ? `https://player.bilibili.com/player.html?bvid=${src.id}&autoplay=1&high_quality=1`
      : `https://www.youtube-nocookie.com/embed/${src.id}?autoplay=1&rel=0`;
    iframe.title = el.getAttribute('aria-label') || 'video';
    iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
    iframe.allowFullscreen = true;
    iframe.loading = 'lazy';

    frame.replaceChildren(iframe);

    // it is a player now, not a link
    el.removeAttribute('href');
    el.removeAttribute('target');
    el.removeAttribute('aria-label');
  }
}


/* ---------------------------------------------------------
   boot
   --------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  const btn  = document.getElementById('playBtn');
  const skip = document.getElementById('skipBtn');
  const note = document.getElementById('audioNote');

  // Only the homepage carries the player, so on the other four pages no
  // AudioEngine is built and none of the queue is probed for.
  const engine = btn ? new AudioEngine() : null;
  if (engine) new Pulse(engine);

  new Parallax('.hero');
  new HeightVar('#nav', '--nav-h');
  new HeightVar('#ticker', '--ticker-h');
  const viz = new HeroViz(
    document.getElementById('vizGlow'),
    document.getElementById('vizBeam'),
    document.getElementById('wave'),
    engine);
  const ignition = new Ignition(document.getElementById('vizFlash'), viz);
  const mood = new AlbumMood('.hero', viz);
  const platter = new Platter('.btn--play .vinyl');
  new Tilt();
  new Reveal();
  new Ticker('#tickerTrack');
  new Ticker('#singlesTrack', 34);
  new Ticker('#pressRailTrack', 30, '.rail__set', '.rail');
  new MobileNav('#nav', '#navBurger');
  new NavGlow('#nav');
  new CursorGlow('.glow');
  new PressStage('#pressStage');
  new ScrollSpy();
  new VideoFacade();

  const year = document.getElementById('year');
  if (year) year.textContent = new Date().getFullYear();

  // everything below wires the player up, and there isn't one here
  if (!btn) return;

  // the button label and the audio note are the only strings JS writes,
  // so they have to follow the page's language like everything else
  const zh = document.documentElement.lang.toLowerCase().startsWith('zh');
  const T = zh
    ? { play: '播放', pause: '暂停',
        placeholder: '当前为占位环境音 — 正式音频待上线' }
    : { play: 'Play', pause: 'Pause',
        placeholder: 'Placeholder ambient pad — drop MP3s in audio/' };

  // "Now playing" is content, so it rides in on the element, not in here
  const NOW = (note && note.dataset.now) || '';
  let current = null;

  engine.ontrack = (track) => {
    current = track;
    if (engine.playing) paint(true, engine.mode);
  };

  // fires on the rising edge only, so track changes and repaints from
  // ontrack don't re-detonate the screen mid-song
  let wasPlaying = false;

  function paint (playing, mode) {
    if (playing && !wasPlaying) ignition.fire();
    wasPlaying = playing;

    // the first screen takes on the identity of the record now playing
    mood.set(playing, current || engine.track);
    platter.set(playing);

    btn.setAttribute('aria-pressed', String(playing));
    btn.querySelector('.btn__label').textContent = playing ? T.pause : T.play;

    // a queue of one has nothing to skip to
    if (skip) skip.hidden = !(mode === 'file' && engine.queue.length > 1);

    if (playing && mode === 'synth') {
      note.hidden = false;
      note.textContent = T.placeholder;
    } else if (playing && current) {
      note.hidden = false;
      /* The album rides along only once the track -> album table is the
         real one; build.py withholds the name while it is a stand-in,
         so this line can never claim a track is on a record it is not. */
      const what = current.album
        ? `${current.title} · ${current.album}` : current.title;
      note.textContent = NOW ? `${NOW} — ${what}` : what;
    } else {
      note.hidden = true;
    }
  }

  engine.onstate = paint;

  btn.addEventListener('click', () => engine.toggle());
  if (skip) skip.addEventListener('click', () => engine.next());

  // space bar toggles playback, as in the reference
  addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      engine.toggle();
    }
  });
});
