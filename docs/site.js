// Biscuit's website. Biscuit lives on the page itself, in the corner of
// the browser window, the way the app lives in the corner of the real
// screen -- and it behaves the same as the app (renderer.js): asleep by
// default, wakes when petted, walks, sniffs, then a stream of random
// reactions until the cursor leaves. The site version also wanders off on
// its own now and then, so a visitor who hasn't touched anything yet still
// sees it pottering about.
(() => {
  'use strict';

  const FRAME_COUNTS = {
    bow: 28, lick: 30, paw: 20, roll: 16, run: 25, sleep: 19,
    smile: 8, sniff: 21, spin: 14, stand: 5, walk: 16, yawn: 6,
  };
  const SETS = {};
  Object.entries(FRAME_COUNTS).forEach(([name, count]) => {
    SETS[name] = Array.from({ length: count },
      (_, i) => `anim/${name}/${name}_${String(i + 1).padStart(2, '0')}.webp`);
  });

  // Warm the cache so an animation's first playback doesn't stutter while
  // its frames load. The ones visible straight away go first.
  const warmed = new Set();
  function warm(names) {
    names.forEach((name) => SETS[name].forEach((src) => {
      if (warmed.has(src)) return;
      warmed.add(src);
      const img = new Image();
      img.decoding = 'async';
      img.src = src;
    }));
  }
  warm(['sleep', 'yawn', 'stand', 'walk']);
  window.addEventListener('load', () => warm(Object.keys(SETS)));

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];

  // Same cumulative rounding as the app, so a walk out and back lands on
  // exactly the pixel it started from.
  function distributeSteps(total, steps) {
    const deltas = [];
    let prev = 0;
    for (let i = 1; i <= steps; i += 1) {
      const acc = Math.round((total * i) / steps);
      deltas.push(acc - prev);
      prev = acc;
    }
    return deltas;
  }

  // Starting a new playback cancels whatever was running. Resolves true if
  // it was interrupted.
  class Flipbook {
    constructor(img) {
      this.img = img;
      this.token = null;
    }

    async play(name, {
      frames = null, fps = 10, times = 1, breakIf = () => false, onFrame = () => {},
    } = {}) {
      const list = frames || SETS[name];
      const token = {};
      this.token = token;
      const frameMs = 1000 / fps;
      for (let rep = 0; times === Infinity || rep < times; rep += 1) {
        for (let i = 0; i < list.length; i += 1) {
          if (this.token !== token) return true;
          if (breakIf()) return true;
          this.img.src = list[i];
          onFrame(i, rep);
          // eslint-disable-next-line no-await-in-loop
          await wait(frameMs);
        }
      }
      return false;
    }
  }

  // ---- Where the mouse is ----
  // Like the app's main process polling the global cursor: "being petted"
  // means the pointer is literally inside the dog's box right now. Tracking
  // the position ourselves (instead of mouseenter/leave) keeps it correct
  // when the dog walks out from under a cursor that isn't moving.
  let pointer = null;
  window.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') pointer = { x: e.clientX, y: e.clientY };
  }, { passive: true });
  document.documentElement.addEventListener('mouseleave', () => { pointer = null; });

  const dogEl = document.getElementById('dog');
  const dogFlip = dogEl.querySelector('.flip');
  const dogBook = new Flipbook(dogEl.querySelector('img'));
  const hintEl = document.getElementById('hint');

  let scale = 1;
  let x = 0; // left edge, px from the window's left
  let lift = 0; // px above the bottom of the window (0 = on the floor)
  let touchPetUntil = 0;
  let dragging = null;

  const viewW = () => document.documentElement.clientWidth;
  const viewH = () => window.innerHeight;
  const dogW = () => dogEl.offsetWidth;
  const dogH = () => dogEl.offsetHeight;

  function isPetting() {
    if (performance.now() < touchPetUntil) return true;
    if (!pointer) return false;
    const r = dogEl.getBoundingClientRect();
    return pointer.x >= r.left && pointer.x <= r.right
      && pointer.y >= r.top && pointer.y <= r.bottom;
  }

  // Slide the "pet me" bubble sideways just enough to stay in the window.
  function nudgeHint() {
    if (dogEl.classList.contains('petted') || dogEl.classList.contains('awake')) return;
    const w = hintEl.offsetWidth;
    const pad = 8;
    const center = x + dogW() / 2;
    let n = 0;
    if (center + w / 2 > viewW() - pad) n = viewW() - pad - (center + w / 2);
    if (center - w / 2 + n < pad) n = pad - (center - w / 2);
    hintEl.style.setProperty('--nudge', `${Math.round(n)}px`);
  }

  function place() {
    dogEl.style.transform = `translate(${x}px, ${-lift}px)`;
    nudgeHint();
  }

  const setFlip = (on) => dogFlip.classList.toggle('flipped', on); // artwork faces left
  // The "pet me" bubble only makes sense over a sleeping dog.
  function setAwake(on) {
    dogEl.classList.toggle('awake', on);
    if (!on) nudgeHint();
  }

  function markPetted() {
    if (dogEl.classList.contains('petted')) return;
    dogEl.classList.add('petted');
    dogEl.setAttribute('aria-label', '撫でられて喜んでいる犬のビスケット');
  }

  // Life-size on a desktop browser (the app's own 173x200 box), smaller on
  // a phone.
  function fit(initial) {
    scale = clamp(viewW() / 1000, 0.55, 1);
    document.documentElement.style.setProperty('--s', scale.toFixed(3));
    requestAnimationFrame(() => {
      // Bottom-right corner, 40px in from the edge -- where the app starts.
      if (initial) x = viewW() - dogW() - 40 * scale;
      x = clamp(x, 0, viewW() - dogW());
      lift = clamp(lift, 0, Math.max(0, viewH() - dogH()));
      place();
      dogEl.classList.add('placed');
    });
  }
  fit(true);
  window.addEventListener('resize', () => fit(false));
  window.addEventListener('scroll', () => {
    document.body.classList.toggle('scrolled', window.scrollY > 120);
  }, { passive: true });

  // ---- dragging (and tap-to-pet on touch screens) ----
  dogEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    try { dogEl.setPointerCapture(e.pointerId); } catch (err) { /* not an active pointer */ }
    dragging = {
      id: e.pointerId, type: e.pointerType, sx: e.clientX, sy: e.clientY, ox: x, olift: lift, moved: false,
    };
    e.preventDefault();
  });
  dogEl.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragging.id) return;
    const dx = e.clientX - dragging.sx;
    const dy = e.clientY - dragging.sy;
    if (!dragging.moved && Math.hypot(dx, dy) < 5) return;
    dragging.moved = true;
    dogEl.classList.add('dragging');
    x = clamp(dragging.ox + dx, 0, viewW() - dogW());
    lift = clamp(dragging.olift - dy, 0, Math.max(0, viewH() - dogH()));
    place();
  });
  function endDrag(e) {
    if (!dragging || e.pointerId !== dragging.id) return;
    if (dragging.moved) {
      if (lift < 4) { lift = 0; place(); }
    } else if (dragging.type !== 'mouse') {
      // No hover on a phone: a tap counts as a few seconds of petting,
      // and each further tap tops it up.
      touchPetUntil = performance.now() + 6000;
    }
    dogEl.classList.remove('dragging');
    dragging = null;
  }
  dogEl.addEventListener('pointerup', endDrag);
  dogEl.addEventListener('pointercancel', endDrag);

  // ---- 0.2.0 のかわいさ（アプリの effects.js を移植） ----
  // ビスケットの箱の上に重ねる層。左右反転(.flip)の外に置くので、文字は裏返らない。
  const fxEl = document.createElement('div');
  fxEl.className = 'bfx';
  fxEl.setAttribute('aria-hidden', 'true');
  dogEl.appendChild(fxEl);
  const sayEl = document.createElement('div');
  sayEl.className = 'bfx-say';
  sayEl.setAttribute('aria-live', 'polite');
  dogEl.appendChild(sayEl);

  function spawn(cls, text, style) {
    const el = document.createElement('span');
    el.className = `bfx-item ${cls}`;
    el.textContent = text;
    Object.assign(el.style, style);
    fxEl.appendChild(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 9000);
  }

  function timeOfDay() {
    const h = new Date().getHours();
    if (h >= 5 && h < 10) return 'morning';
    if (h >= 10 && h < 17) return 'day';
    if (h >= 17 && h < 22) return 'evening';
    return 'night';
  }
  const LINES = {
    morning: ['おはよう！', 'ふぁ〜…おはよ', 'きょうもよろしくね', 'お散歩行こっ'],
    day: ['わん！', 'あそぼ！', 'なでて〜', 'えへへ', 'もっとなでて！', 'おやつちょーだい', 'お散歩行こっ'],
    evening: ['おかえり！', 'おつかれさま', 'おなかすいた…', 'きょうもがんばったね', 'おやつちょーだい', 'お散歩行こっ'],
    night: ['ねむい…', 'まだおきてるの？', 'そろそろねよ？', 'むにゃ…'],
  };
  const ANYTIME = ['わふっ', 'すき！', 'しっぽ、ふってるよ'];
  const DREAMS = ['むにゃ…', '…ビスケット…', 'すぴー', 'ゆめで、おさんぽ…'];

  let sayTimer = null;
  function say(text, ms = 2600) {
    sayEl.textContent = text;
    sayEl.classList.add('show');
    clearTimeout(sayTimer);
    sayTimer = setTimeout(() => sayEl.classList.remove('show'), ms);
  }
  // マンガの効果音のような文字（ゴロン・くるっ など）
  function popWord(text, pos = {}) {
    const [l0, l1] = pos.left || [4, 12];
    const [t0, t1] = pos.top || [30, 38];
    spawn('bfx-word', text, { left: `${rand(l0, l1)}%`, top: `${rand(t0, t1)}%` });
  }
  function sparkle(n = 4) {
    for (let i = 0; i < n; i += 1) {
      setTimeout(() => spawn('bfx-spark', '✦', { left: `${rand(12, 82)}%`, top: `${rand(34, 70)}%` }), i * 180);
    }
  }
  // 季節：冬は雪、春は桜、それ以外はシャボン玉
  function seasonal() {
    const m = new Date().getMonth() + 1;
    const sway = `${rand(-22, 22).toFixed(0)}px`;
    if (m === 12 || m <= 2) {
      spawn('bfx-fall bfx-snow', '●', { left: `${rand(4, 92)}%`, '--sway': sway });
    } else if (m === 3 || m === 4) {
      spawn('bfx-fall bfx-sakura', '', { left: `${rand(4, 92)}%`, '--sway': sway });
    } else {
      const size = rand(10, 22) * scale;
      spawn('bfx-soap', '', {
        left: `${rand(8, 84)}%`, top: `${rand(62, 82)}%`,
        width: `${size.toFixed(0)}px`, height: `${size.toFixed(0)}px`, '--sway': sway,
      });
    }
  }

  // 0.1秒ごとに様子を見て、寝ていればZzzと寝言、撫でられていればひとこと
  let asleep = false;
  let wasPetting = false;
  let nextZ = 0;
  let nextLine = 0;
  let nextDream = performance.now() + rand(30000, 60000);
  let nextSeason = performance.now() + 2500;
  setInterval(() => {
    if (document.hidden) return;
    const now = performance.now();
    const pet = isPetting();
    if (pet && !wasPetting) {
      say(pick(LINES[timeOfDay()]));
      nextLine = now + rand(9000, 16000);
    }
    if (!pet && wasPetting) sayEl.classList.remove('show');
    wasPetting = pet;
    if (pet) {
      if (now >= nextLine) {
        say(Math.random() < 0.75 ? pick(LINES[timeOfDay()]) : pick(ANYTIME));
        nextLine = now + rand(9000, 16000);
      }
    } else if (asleep) {
      if (now >= nextZ) {
        spawn('bfx-z', pick(['z', 'Z', 'z']), { left: `${rand(22, 32)}%`, top: `${rand(50, 56)}%` });
        nextZ = now + rand(1500, 2200);
      }
      if (now >= nextDream) { say(pick(DREAMS), 2200); nextDream = now + rand(45000, 90000); }
    }
    if (now >= nextSeason) {
      seasonal();
      nextSeason = now + (pet ? rand(1800, 2800) : rand(4500, 7000));
    }
  }, 100);

  // Little hearts while it's being petted.
  setInterval(() => {
    if (!isPetting() || document.hidden) return;
    const heart = document.createElement('span');
    heart.className = 'heart';
    heart.textContent = '♥';
    heart.style.left = `${rand(28, 62)}%`;
    heart.addEventListener('animationend', () => heart.remove());
    dogEl.appendChild(heart);
  }, 750);

  // ---- walking ----
  // Moves `dist` px sideways over whole walk cycles.
  async function walkBy(dist, { breakIf = () => false, pxPerFrame = 4.4 } = {}) {
    const steps = Math.max(8, Math.round(Math.abs(dist) / (pxPerFrame * scale)));
    const deltas = distributeSteps(dist, steps);
    const frames = [];
    while (frames.length < steps) frames.push(...SETS.walk);
    frames.length = steps;
    let i = 0;
    setFlip(dist > 0);
    return dogBook.play(null, {
      frames,
      fps: 12,
      breakIf,
      onFrame: () => {
        x = clamp(x + (deltas[i] || 0), 0, viewW() - dogW());
        i += 1;
        place();
      },
    });
  }

  // ---- petting reactions (ported from renderer.js) ----
  const notPetted = () => !isPetting();

  const wakeUpAndStretch = () => dogBook.play('yawn', { fps: 8, times: 2, breakIf: notPetted });

  // Out, turn around, and back to exactly where it started. Like the app,
  // no breakIf on the legs: the walk carries the dog out from under the
  // cursor, which would otherwise read as "petting stopped" and cut the
  // stroll short halfway.
  async function doWalk() {
    let distance = rand(100, 200) * scale;
    let goingRight = Math.random() < 0.5;
    const margin = 12;
    const roomRight = viewW() - margin - (x + dogW());
    const roomLeft = x - margin;
    if (roomRight >= distance && roomLeft >= distance) {
      // Room either way -- keep the coin flip.
    } else if (roomRight >= distance) {
      goingRight = true;
    } else if (roomLeft >= distance) {
      goingRight = false;
    } else {
      goingRight = roomRight >= roomLeft;
      distance = Math.max(30 * scale, Math.min(distance, goingRight ? roomRight : roomLeft));
    }
    const d = Math.round(distance) * (goingRight ? 1 : -1);
    const pace = Math.abs(d) / (SETS.walk.length * 2) / scale; // two walk cycles per leg
    await walkBy(d, { pxPerFrame: pace });
    await dogBook.play('spin', { fps: 10 });
    await walkBy(-d, { pxPerFrame: pace });
    setFlip(false);
  }

  const doSniff = () => dogBook.play('sniff', { fps: 10, times: 2, breakIf: notPetted });
  const doPaw = () => { popWord('ぱふっ'); return dogBook.play('paw', { fps: 10, times: 2, breakIf: notPetted }); };
  const doSpin = () => { popWord('くるっ', { left: [30, 42], top: [20, 28] }); return dogBook.play('spin', { fps: 10, times: 2, breakIf: notPetted }); };
  const doStandIdle = () => dogBook.play('stand', { fps: 6, times: 2, breakIf: notPetted });
  const doSmile = () => dogBook.play('smile', { fps: 8, times: 2, breakIf: notPetted });
  const doLick = () => dogBook.play('lick', { fps: 10, breakIf: notPetted });
  const doRun = () => { popWord('タタタッ', { left: [46, 50], top: [70, 74] }); return dogBook.play('run', { fps: 14, times: 2, breakIf: notPetted }); };
  const doRoll = () => { popWord('ゴロン'); return dogBook.play('roll', { fps: 10, times: 2, breakIf: notPetted }); };

  // 止め絵のポーズ7つ。1枚の絵に、CSS で揺れ・跳ね・傾きなどの動きを付ける
  const POSES = ['goron', 'kashige', 'ureshii', 'fuse', 'dakko', 'furifuri', 'osumashi'];
  const poseSrc = (n) => `poses/${n}.webp`;
  window.addEventListener('load', () => POSES.forEach((n) => { const i = new Image(); i.src = poseSrc(n); }));
  const dogImg = dogEl.querySelector('img');
  async function doPose(name, motion, ms, onStart) {
    setFlip(false);
    dogImg.classList.add(`m-${motion}`);
    if (onStart) onStart();
    const frames = Array(Math.max(1, Math.round(ms / 100))).fill(poseSrc(name));
    await dogBook.play(null, { frames, fps: 10, breakIf: notPetted });
    dogImg.classList.remove(`m-${motion}`);
  }
  const doGoronPose = () => doPose('goron', 'rock', 3200, () => popWord('ゴロン'));
  const doKashige = () => doPose('kashige', 'tilt', 3400, () => {
    popWord('？', { left: [62, 70], top: [22, 28] });
    if (Math.random() < 0.5) say('なあに？');
  });
  const doUreshii = () => doPose('ureshii', 'hop', 3000, () => popWord('ぴょん', { left: [58, 64], top: [26, 32] }));
  const doFuse = () => doPose('fuse', 'breathe', 3600, () => popWord('ぺたん', { left: [6, 14], top: [48, 54] }));
  const doDakko = () => doPose('dakko', 'sway', 3400, () => say('だっこして〜'));
  const doFurifuri = () => doPose('furifuri', 'wiggle', 3000, () => popWord('ふりふり', { left: [40, 46], top: [30, 36] }));
  const doOsumashi = () => doPose('osumashi', 'proud', 3200, () => { popWord('キリッ', { left: [52, 58], top: [24, 30] }); sparkle(4); });
  const doBow = () => dogBook.play('bow', { fps: 10, breakIf: notPetted });

  const randomReactions = [
    doWalk, doSniff, doPaw, doSpin, doStandIdle, doSmile, wakeUpAndStretch,
    doLick, doRun, doRoll, doBow,
    doGoronPose, doKashige, doUreshii, doFuse, doDakko, doFurifuri, doOsumashi,
  ];

  async function petSession() {
    markPetted();
    setAwake(true);
    await wakeUpAndStretch();
    if (!isPetting()) return;
    await doWalk();
    if (!isPetting()) return;
    await doSniff();
    while (isPetting()) {
      // eslint-disable-next-line no-await-in-loop
      await pick(randomReactions)();
      if (!isPetting()) break;
      // eslint-disable-next-line no-await-in-loop
      await wait(200);
    }
  }

  // ---- left alone ----
  // The app naps with an occasional yawn or paw-lick. The site adds a
  // wander across the window, and makes the first one come early so
  // there's something to see before anyone touches it.
  const IDLE_AVG_MS = 16000;
  let nextIdleAt = performance.now() + 6500;
  let idleCount = 0;

  async function wander() {
    setAwake(true);
    if (await dogBook.play('yawn', { fps: 8, breakIf: isPetting })) return;
    if (await dogBook.play('stand', { fps: 6, breakIf: isPetting })) return;
    const maxX = viewW() - dogW();
    const reach = 520 * scale;
    let tx = clamp(x + rand(-reach, reach), 0, maxX);
    if (Math.abs(tx - x) < 80 * scale) tx = clamp(x + (x > maxX / 2 ? -1 : 1) * 200 * scale, 0, maxX);
    if (await walkBy(tx - x, { breakIf: isPetting })) return;
    await dogBook.play('sniff', { fps: 10, breakIf: isPetting });
  }

  function idleGesture() {
    const first = idleCount === 0;
    idleCount += 1;
    if (first || Math.random() < 0.5) return wander();
    return Math.random() < 0.5
      ? dogBook.play('yawn', { fps: 8, breakIf: isPetting })
      : dogBook.play('lick', { fps: 10, breakIf: isPetting });
  }

  // On page load it's already curled up (that's the frame in the HTML), so
  // the first nap skips the lying-down animation.
  async function goToSleep(alreadyAsleep) {
    setFlip(false);
    if (!alreadyAsleep && await dogBook.play('sleep', { fps: 10, breakIf: isPetting })) return;
    setAwake(false);
    const breathing = SETS.sleep.slice(-6);
    while (!isPetting()) {
      asleep = true;
      // eslint-disable-next-line no-await-in-loop
      await dogBook.play(null, {
        frames: breathing,
        fps: 4,
        times: Infinity,
        breakIf: () => isPetting() || performance.now() >= nextIdleAt,
      });
      asleep = false;
      if (isPetting()) return;
      // eslint-disable-next-line no-await-in-loop
      await idleGesture();
      nextIdleAt = performance.now() + IDLE_AVG_MS * rand(0.5, 1.5);
      if (isPetting()) return;
      setFlip(false);
      // eslint-disable-next-line no-await-in-loop
      await dogBook.play('sleep', { fps: 10, breakIf: isPetting });
      if (isPetting()) return;
      setAwake(false);
    }
  }

  (async function mainLoop() {
    let first = true;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // eslint-disable-next-line no-await-in-loop
      await goToSleep(first);
      first = false;
      // eslint-disable-next-line no-await-in-loop
      await petSession();
      // eslint-disable-next-line no-await-in-loop
      await wait(200);
    }
  })();
})();
