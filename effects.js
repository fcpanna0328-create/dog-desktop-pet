// ---- かわいさのエフェクト（ハート・Zzz・ひとこと・季節） ----
// 絵のコマを増やさずに、ビスケットのまわりに重ねて出すだけの演出。
// 動きの本体(renderer.js)は触らず、そちらの状態(petting / asleep)を
// 0.1秒ごとに見て、それに合わせて出す。メニューバーから丸ごと切れる。

const fxLayer = document.getElementById('fx');
const bubbleEl = document.getElementById('bubble');
let fxEnabled = true;

if (window.dogAPI && window.dogAPI.getSettings) {
  window.dogAPI.getSettings().then((s) => { fxEnabled = !s || s.effects !== false; }).catch(() => {});
}
if (window.dogAPI && window.dogAPI.onSettings) {
  window.dogAPI.onSettings((s) => {
    fxEnabled = !s || s.effects !== false;
    if (!fxEnabled) { fxLayer.innerHTML = ''; hideBubble(); }
  });
}

// ---- 時間帯 ----
function timeOfDay(d = new Date()) {
  const h = d.getHours();
  if (h >= 5 && h < 10) return 'morning';
  if (h >= 10 && h < 17) return 'day';
  if (h >= 17 && h < 22) return 'evening';
  return 'night';
}
// 夜は眠りが深い（寝ているあいだの仕草が少なくなる）。renderer.js が使う
function napFactor() {
  return timeOfDay() === 'night' ? 2.2 : 1;
}

const LINES = {
  morning: ['おはよう！', 'ふぁ〜…おはよ', 'きょうもよろしくね', 'お散歩行こっ'],
  day: ['わん！', 'あそぼ！', 'なでて〜', 'えへへ', 'もっとなでて！', 'おやつちょーだい', 'お散歩行こっ'],
  evening: ['おかえり！', 'おつかれさま', 'おなかすいた…', 'きょうもがんばったね', 'おやつちょーだい', 'お散歩行こっ'],
  night: ['ねむい…', 'まだおきてるの？', 'そろそろねよ？', 'むにゃ…'],
};
const ANYTIME = ['わふっ', 'すき！', 'しっぽ、ふってるよ'];
const DREAMS = ['むにゃ…', '…ビスケット…', 'すぴー', 'ゆめで、おさんぽ…'];

function pick(list) { return list[Math.floor(Math.random() * list.length)]; }

// ---- ひとこと吹き出し ----
let bubbleTimer = null;
function say(text, ms = 2600) {
  if (!fxEnabled || !bubbleEl) return;
  bubbleEl.textContent = text;
  bubbleEl.classList.add('show');
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(hideBubble, ms);
}
function hideBubble() {
  if (bubbleEl) bubbleEl.classList.remove('show');
}

// ---- 浮かぶもの（ハート・Z・季節） ----
function spawn(cls, text, style) {
  const el = document.createElement('span');
  el.className = `fx ${cls}`;
  el.textContent = text;
  Object.assign(el.style, style);
  fxLayer.appendChild(el);
  el.addEventListener('animationend', () => el.remove(), { once: true });
  // 念のため、アニメーションが止まっても残らないようにする
  setTimeout(() => el.remove(), 9000);
  return el;
}
const rand = (a, b) => a + Math.random() * (b - a);

function heart() {
  spawn('heart', pick(['❤', '♥', '💗']), {
    left: `${rand(28, 70)}%`,
    top: `${rand(34, 52)}%`,
    fontSize: `${rand(13, 20).toFixed(0)}px`,
    '--sway': `${rand(-14, 14).toFixed(0)}px`,
  });
}
function zzz() {
  // 寝ているときは頭が左側にあるので、頭の上あたりから出す
  spawn('zzz', pick(['z', 'Z', 'z']), {
    left: `${rand(22, 32)}%`,
    top: `${rand(50, 56)}%`,
    fontSize: `${rand(15, 20).toFixed(0)}px`,
  });
}

// 季節：冬は雪、春は桜、それ以外はシャボン玉
function season(d = new Date()) {
  const m = d.getMonth() + 1;
  if (m === 12 || m <= 2) return 'snow';
  if (m === 3 || m === 4) return 'sakura';
  return 'soap';
}
function seasonal() {
  const s = season();
  if (!s) return;
  const common = { left: `${rand(4, 92)}%`, '--sway': `${rand(-26, 26).toFixed(0)}px`, animationDuration: `${rand(5.5, 8).toFixed(1)}s` };
  if (s === 'snow') spawn('flake snow', '●', { ...common, fontSize: `${rand(4, 7).toFixed(0)}px` });
  if (s === 'sakura') spawn('flake sakura', '', { ...common });
  if (s === 'soap') {
    // シャボン玉は下から、ふわふわ揺れながら昇って、最後にぱちんと消える
    const size = rand(10, 22);
    spawn('soap', '', {
      left: `${rand(8, 84)}%`,
      top: `${rand(62, 82)}%`,
      width: `${size.toFixed(0)}px`,
      height: `${size.toFixed(0)}px`,
      '--sway': `${rand(-22, 22).toFixed(0)}px`,
      animationDuration: `${rand(4.8, 7).toFixed(1)}s`,
    });
  }
}

// ---- 見張り（0.1秒ごと） ----
let wasPetting = false;
let nextHeart = 0;
let nextZ = 0;
let nextLine = 0;
let nextDream = Date.now() + rand(40000, 70000);
let nextSeason = Date.now() + 3000;

setInterval(() => {
  if (!fxEnabled) return;
  let isPetting = false;
  let isAsleep = false;
  try { isPetting = petting; isAsleep = asleep; } catch (e) { return; }
  const now = Date.now();

  if (isPetting && !wasPetting) {
    // 撫ではじめ：時間帯のあいさつ
    say(pick(LINES[timeOfDay()]));
    nextLine = now + rand(10000, 18000);
    nextHeart = now + 300;
  }
  if (!isPetting && wasPetting) hideBubble();
  wasPetting = isPetting;

  if (isPetting) {
    if (now >= nextHeart) { heart(); nextHeart = now + rand(550, 900); }
    if (now >= nextLine) {
      say(Math.random() < 0.75 ? pick(LINES[timeOfDay()]) : pick(ANYTIME));
      nextLine = now + rand(10000, 18000);
    }
  } else if (isAsleep) {
    if (now >= nextZ) { zzz(); nextZ = now + rand(1500, 2200); }
    if (now >= nextDream) { say(pick(DREAMS), 2200); nextDream = now + rand(60000, 120000); }
  }

  // 季節のものは静かに、ときどきだけ（撫でているあいだは少し多め）
  if (now >= nextSeason) {
    seasonal();
    nextSeason = now + (isPetting ? rand(1200, 2000) : rand(4500, 7000));
  }
}, 100);
