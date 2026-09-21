const sprite = document.getElementById('sprite');
const flipWrap = document.getElementById('flipWrap');
const stage = document.getElementById('stage');

// ---- Manual window dragging ----
// Replaces -webkit-app-region: drag (see style.css for why): on mousedown we
// snapshot the window's current position and the cursor's screen position,
// then on every mousemove we tell the main process to move the window by
// the same delta the cursor has moved. This keeps full control over the
// cursor's CSS appearance (hand/grab) while dragging still works the same
// as before from the user's point of view.
let dragState = null;

if (stage) {
  stage.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // left click only
    if (!window.dogAPI || !window.dogAPI.getWindowBoundsSync) return;
    const bounds = window.dogAPI.getWindowBoundsSync();
    dragState = {
      startMouseX: e.screenX,
      startMouseY: e.screenY,
      startWinX: bounds.x,
      startWinY: bounds.y,
    };
    stage.classList.add('dragging');
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragState) return;
    const dx = e.screenX - dragState.startMouseX;
    const dy = e.screenY - dragState.startMouseY;
    window.dogAPI.moveWindowTo(dragState.startWinX + dx, dragState.startWinY + dy);
  });

  window.addEventListener('mouseup', () => {
    if (!dragState) return;
    dragState = null;
    stage.classList.remove('dragging');
  });
}

// Real multi-frame animations, extracted from AI-generated video clips based
// on the original 7-pose illustration set (background removed, cropped to a
// stable per-action frame). Each pose is a short flipbook.
function frameList(action, count) {
  const frames = [];
  for (let i = 1; i <= count; i++) {
    frames.push(`assets/anim/${action}/${action}_${String(i).padStart(2, '0')}.png`);
  }
  return frames;
}

const FRAME_SETS = {
  stand: frameList('stand', 5),
  walk: frameList('walk', 16),
  sniff: frameList('sniff', 21),
  yawn: frameList('yawn', 6),
  paw: frameList('paw', 20),
  smile: frameList('smile', 8),
  spin: frameList('spin', 14),
  sleep: frameList('sleep', 19),
  // Added from a second reference video: running with a bone, licking a
  // paw, rolling on its back, and an excited little bow/prance.
  lick: frameList('lick', 30),
  run: frameList('run', 25),
  roll: frameList('roll', 16),
  bow: frameList('bow', 28),
};

// Warm the browser cache so the first playback of each animation doesn't
// stutter while frames load in.
function preloadAll() {
  Object.values(FRAME_SETS).flat().forEach((src) => {
    const img = new Image();
    img.src = src;
  });
}
preloadAll();

function setFlip(shouldFlip) {
  flipWrap.classList.toggle('flip', shouldFlip);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Kept up to date by the main process, which watches the global cursor
// position: true whenever the OS pointer is literally over the dog's
// window. That's the entire signal for "being petted" -- there's no wider
// proximity radius anymore, so the cursor can move freely elsewhere on
// screen without interrupting anything.
let petting = false;
// 呼吸しながら寝ているあいだだけ true（effects.js が Zzz を出すのに使う）
let asleep = false;
if (window.dogAPI && window.dogAPI.onCursorStatus) {
  window.dogAPI.onCursorStatus((data) => {
    petting = data.over;
  });
}

// Only one playback "owns" the sprite at a time; starting a new one
// invalidates whatever was running before it.
let playToken = null;

// Steps through `frames` at `fps`, for `times` full passes (Infinity to
// loop forever). Stops early if `breakIf()` becomes true, or if another
// playFrames() call takes over first. `onFrame(i, rep)` fires right after
// each frame is shown (used by doWalk to shift the window a little on
// every frame). Returns true if it was interrupted.
async function playFrames(frames, { fps = 10, times = 1, breakIf = () => false, onFrame = () => {} } = {}) {
  const token = {};
  playToken = token;
  const frameMs = 1000 / fps;
  const infinite = times === Infinity;
  for (let rep = 0; infinite || rep < times; rep++) {
    for (let i = 0; i < frames.length; i++) {
      if (playToken !== token) return true;
      if (breakIf()) return true;
      sprite.src = frames[i];
      onFrame(i, rep);
      // eslint-disable-next-line no-await-in-loop
      await wait(frameMs);
    }
  }
  return false;
}

// Splits `total` (a signed pixel amount) into `steps` integer deltas that
// sum to exactly Math.round(total) -- cumulative rounding, so per-frame
// window-move calls (which each round independently on the main-process
// side) never drift the final position off by a pixel or two.
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

// ---- Petting-centric behavior ----
// The dog is asleep by default. Resting the cursor on it (the whole
// window doubles as "the dog" since it's mostly just the sprite) wakes it
// up for a little yawn-and-stretch, a walk, a sniff, and then a stream of
// random happy reactions for as long as the cursor stays put. Moving the
// cursor away at any point sends it back to sleep.

// Roughly how often (on average) the sleeping dog takes a little break to
// do a small idle gesture on its own, unrelated to petting. Randomized
// between half and 1.5x this so it doesn't feel metronomic.
const IDLE_YAWN_AVG_MS = 20000;

// The little gestures it can do mid-nap, picked at random each time. Both
// stop early if petting starts, handing straight off to the normal
// wake-for-petting flow.
const idleSleepGestures = [
  () => playFrames(FRAME_SETS.yawn, { fps: 8, times: 1, breakIf: () => petting }),
  () => playFrames(FRAME_SETS.lick, { fps: 10, times: 1, breakIf: () => petting }),
];

async function goToSleep() {
  setFlip(false);
  const interrupted = await playFrames(FRAME_SETS.sleep, {
    fps: 10,
    times: 1,
    breakIf: () => petting,
  });
  if (interrupted) return;

  const breathingFrames = FRAME_SETS.sleep.slice(-6);

  // Stay asleep, breathing gently, until the cursor comes to pet it. Every
  // so often, at a random interval, it takes a short break to sit up and
  // do a little gesture (yawn/stretch, or lick a paw), then settles back
  // down and keeps napping. This is independent of petting -- if the
  // cursor happens to land during the gesture, breakIf() below catches it
  // and hands straight off to the normal wake-for-petting flow.
  while (!petting) {
    // 夜は眠りが深く、仕草の間隔が長くなる（napFactor は effects.js）
    const nightly = typeof napFactor === 'function' ? napFactor() : 1;
    const napDeadline = Date.now() + IDLE_YAWN_AVG_MS * nightly * (0.5 + Math.random());
    asleep = true;
    // eslint-disable-next-line no-await-in-loop
    await playFrames(breathingFrames, {
      fps: 4,
      times: Infinity,
      breakIf: () => petting || Date.now() >= napDeadline,
    });
    asleep = false;
    if (petting) return;

    const gesture = idleSleepGestures[Math.floor(Math.random() * idleSleepGestures.length)];
    // eslint-disable-next-line no-await-in-loop
    await gesture();
    if (petting) return;

    // Settle back down to sleep before continuing to nap.
    // eslint-disable-next-line no-await-in-loop
    await playFrames(FRAME_SETS.sleep, { fps: 10, times: 1, breakIf: () => petting });
    if (petting) return;
  }
}

async function wakeUpAndStretch() {
  await playFrames(FRAME_SETS.yawn, { fps: 8, times: 2, breakIf: () => !petting });
}

// A real little stroll: walk a short distance across the screen, turn
// around in place, then walk back to exactly where it started. The default
// artwork faces left, so heading right means mirroring it.
//
// Deliberately no breakIf() during any of the three legs: moving the
// window necessarily carries it out from under the literal cursor
// position, which would otherwise look like "petting stopped" and cut the
// walk short partway through the yard. Once started, the whole round trip
// (out -> turn -> back) always finishes, and "is petting still happening"
// is only re-checked once the dog is back home (by the caller, after this
// resolves).
async function doWalk() {
  const walkFrameCount = FRAME_SETS.walk.length;
  const repsPerLeg = 2;
  const stepsPerLeg = walkFrameCount * repsPerLeg;

  let distance = 100 + Math.random() * 100; // 100-200px, one-way
  let goingRight = Math.random() < 0.5;

  if (window.dogAPI && window.dogAPI.getWindowBoundsSync && window.dogAPI.getScreenInfo) {
    try {
      const bounds = window.dogAPI.getWindowBoundsSync();
      // eslint-disable-next-line no-await-in-loop
      const info = await window.dogAPI.getScreenInfo();
      const margin = 20; // keep a little breathing room from the screen edge
      const roomRight = info.screenW - margin - (bounds.x + bounds.width);
      const roomLeft = bounds.x - margin;

      if (roomRight >= distance && roomLeft >= distance) {
        // Plenty of room either way -- direction stays random.
      } else if (roomRight >= distance) {
        goingRight = true;
      } else if (roomLeft >= distance) {
        goingRight = false;
      } else {
        // Not enough room in either direction for the full distance --
        // pick whichever side has more space and shrink the walk to fit,
        // so it still moves a little instead of not moving at all.
        goingRight = roomRight >= roomLeft;
        distance = Math.max(30, Math.min(distance, goingRight ? roomRight : roomLeft));
      }
    } catch (err) {
      // If anything about the bounds/screen-info lookup fails, fall back
      // to the plain random guess above rather than not walking at all.
    }
  }

  const sign = goingRight ? 1 : -1;
  const outDeltas = distributeSteps(Math.round(distance) * sign, stepsPerLeg);
  const backDeltas = distributeSteps(-Math.round(distance) * sign, stepsPerLeg);

  setFlip(goingRight);
  let i = 0;
  await playFrames(FRAME_SETS.walk, {
    fps: 12,
    times: repsPerLeg,
    onFrame: () => {
      if (window.dogAPI && window.dogAPI.moveWindowBy) window.dogAPI.moveWindowBy(outDeltas[i] || 0);
      i += 1;
    },
  });

  // Turn around to face home before heading back.
  await playFrames(FRAME_SETS.spin, { fps: 10, times: 1 });
  setFlip(!goingRight);

  i = 0;
  await playFrames(FRAME_SETS.walk, {
    fps: 12,
    times: repsPerLeg,
    onFrame: () => {
      if (window.dogAPI && window.dogAPI.moveWindowBy) window.dogAPI.moveWindowBy(backDeltas[i] || 0);
      i += 1;
    },
  });
  setFlip(false);
}

async function doSniff() {
  await playFrames(FRAME_SETS.sniff, { fps: 10, times: 2, breakIf: () => !petting });
}

async function doPaw() {
  await playFrames(FRAME_SETS.paw, {
    fps: 10,
    times: 2,
    breakIf: () => !petting,
    // 上げた手のそばに「ぱふっ」
    onFrame: (i, rep) => {
      if (i === 0 && rep === 0 && typeof popWord === 'function') popWord('ぱふっ');
    },
  });
}

async function doSpin() {
  await playFrames(FRAME_SETS.spin, {
    fps: 10,
    times: 2,
    breakIf: () => !petting,
    // 頭の上あたりに「くるっ」
    onFrame: (i, rep) => {
      if (i === 0 && rep === 0 && typeof popWord === 'function') popWord('くるっ', { left: [30, 42], top: [20, 28] });
    },
  });
}

async function doStandIdle() {
  await playFrames(FRAME_SETS.stand, { fps: 6, times: 2, breakIf: () => !petting });
}

async function doSmile() {
  await playFrames(FRAME_SETS.smile, { fps: 8, times: 2, breakIf: () => !petting });
}

async function doLick() {
  // Already a long 30-frame clip on its own, so one pass is plenty.
  await playFrames(FRAME_SETS.lick, { fps: 10, times: 1, breakIf: () => !petting });
}

async function doRun() {
  // Runs in place like doWalkInPlace -- the window deliberately doesn't
  // move so the dog doesn't dash out from under the cursor mid-pet.
  await playFrames(FRAME_SETS.run, {
    fps: 14,
    times: 2,
    breakIf: () => !petting,
    // 走っている後ろの足もとに「タタタッ」
    onFrame: (i, rep) => {
      if (i === 0 && rep === 0 && typeof popWord === 'function') popWord('タタタッ', { left: [46, 50], top: [70, 74] });
    },
  });
}

async function doRoll() {
  await playFrames(FRAME_SETS.roll, {
    fps: 10,
    times: 2,
    breakIf: () => !petting,
    // 仰向けになった最初のコマで「ゴロン」（popWord は effects.js）
    onFrame: (i, rep) => {
      if (i === 0 && rep === 0 && typeof popWord === 'function') popWord('ゴロン');
    },
  });
}

async function doBow() {
  // Already a long 28-frame clip (crouch + sparkly prance), so one pass is
  // plenty -- looping it would snap awkwardly from the joyful ending back
  // to the crouch start.
  await playFrames(FRAME_SETS.bow, { fps: 10, times: 1, breakIf: () => !petting });
}

// ---- 止め絵のポーズ（2026-09 追加） ----
// 1ポーズ1枚の絵に、揺れ・跳ね・傾きなどの動きを CSS で付けて見せる。
// 絵は assets/poses/ にあり、全部同じ大きさの画布に下そろえで置いてある。
const POSES = {
  goron: 'assets/poses/goron.png',
  kashige: 'assets/poses/kashige.png',
  ureshii: 'assets/poses/ureshii.png',
  fuse: 'assets/poses/fuse.png',
  dakko: 'assets/poses/dakko.png',
  furifuri: 'assets/poses/furifuri.png',
  osumashi: 'assets/poses/osumashi.png',
};
Object.values(POSES).forEach((src) => { const img = new Image(); img.src = src; });

// motion は style.css の .m-◯◯ に対応。ms のあいだ、撫でている限り続ける
async function doPose(name, motion, ms, onStart) {
  setFlip(false);
  const cls = `m-${motion}`;
  sprite.classList.add(cls);
  if (onStart) onStart();
  const frames = Array(Math.max(1, Math.round(ms / 100))).fill(POSES[name]);
  await playFrames(frames, { fps: 10, times: 1, breakIf: () => !petting });
  sprite.classList.remove(cls);
}
const fxWord = (w, pos) => { if (typeof popWord === 'function') popWord(w, pos); };
const fxSay = (t) => { if (typeof say === 'function') say(t); };

const doGoronPose = () => doPose('goron', 'rock', 3200, () => fxWord('ゴロン'));
const doKashige = () => doPose('kashige', 'tilt', 3400, () => {
  fxWord('？', { left: [62, 70], top: [22, 28] });
  if (Math.random() < 0.5) fxSay('なあに？');
});
const doUreshii = () => doPose('ureshii', 'hop', 3000, () => fxWord('ぴょん', { left: [58, 66], top: [26, 32] }));
const doFuse = () => doPose('fuse', 'breathe', 3600, () => fxWord('ぺたん', { left: [6, 14], top: [48, 54] }));
const doDakko = () => doPose('dakko', 'sway', 3400, () => fxSay('だっこして〜'));
const doFurifuri = () => doPose('furifuri', 'wiggle', 3000, () => fxWord('ふりふり', { left: [40, 46], top: [30, 36] }));
const doOsumashi = () => doPose('osumashi', 'proud', 3200, () => {
  fxWord('キリッ', { left: [52, 58], top: [24, 30] });
  if (typeof sparkle === 'function') sparkle(4);
});

// The grab-bag of reactions once the intro (wake -> walk -> sniff) is
// done. Picked at random for as long as petting continues.
const randomReactions = [
  doWalk, doSniff, doPaw, doSpin, doStandIdle, doSmile, wakeUpAndStretch,
  doLick, doRun, doRoll, doBow,
  // 止め絵のポーズ
  doGoronPose, doKashige, doUreshii, doFuse, doDakko, doFurifuri, doOsumashi,
];

function pickRandomReaction() {
  return randomReactions[Math.floor(Math.random() * randomReactions.length)];
}

async function petSession() {
  await wakeUpAndStretch();
  if (!petting) return;
  await doWalk();
  if (!petting) return;
  await doSniff();
  while (petting) {
    const reaction = pickRandomReaction();
    // eslint-disable-next-line no-await-in-loop
    await reaction();
    if (!petting) break;
    // eslint-disable-next-line no-await-in-loop
    await wait(200);
  }
}

async function mainLoop() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    await goToSleep();
    // eslint-disable-next-line no-await-in-loop
    await petSession();
    // eslint-disable-next-line no-await-in-loop
    await wait(200);
  }
}

mainLoop();
