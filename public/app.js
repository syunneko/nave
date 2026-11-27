const $ = (id) => document.getElementById(id);

let candidates = [];
let bestId = "";
let selectedId = "";
let originCoords = null;
let speechScript = "";
let isSpeaking = false;
let autoSpeak = false;
let handsFreeEnabled = false;
let recognition = null;
let isListening = false;
let currentMode = "voice"; // "voice" | "input"
let idleExprTimer = null;
let talkExprTimer = null;
let cachedCuteVoice = null;

let searchSettings = {
  includeFlight: true,
  preference: "shortest",
};

const MODE_BADGE = {
  flight: '<span class="px-2 py-0.5 text-xs font-bold rounded bg-indigo-50 text-indigo-800 border border-indigo-200">✈️ 飛行機</span>',
  train: '<span class="px-2 py-0.5 text-xs font-bold rounded bg-sky-50 text-sky-800 border border-sky-200">🚃 電車</span>',
  bus: '<span class="px-2 py-0.5 text-xs font-bold rounded bg-amber-50 text-amber-800 border border-amber-200">🚌 バス</span>',
  walk: '<span class="px-2 py-0.5 text-xs font-bold rounded bg-slate-100 text-slate-700 border border-slate-200">🚶 徒歩</span>',
};

// かわいい系・女性寄りの日本語音声を優先選択
function pickCuteJapaneseVoice() {
  if (!("speechSynthesis" in window)) return null;
  if (cachedCuteVoice) return cachedCuteVoice;

  const voices = speechSynthesis.getVoices() || [];
  const jaVoices = voices.filter((v) => /ja(-|_)?JP/i.test(v.lang));
  if (!jaVoices.length) return null;

  const preferredKeywords = [
    /kyoko/i,
    /haruka/i,
    /nanami/i,
    /sayaka/i,
    /mizuki/i,
    /ayumi/i,
    /google\s*日本語/i,
    /female/i,
    /girl/i,
  ];
  const avoidedKeywords = [/otoya/i, /ichiro/i, /keita/i, /male/i];

  for (const pat of preferredKeywords) {
    const matched = jaVoices.find((v) => pat.test(v.name));
    if (matched) {
      cachedCuteVoice = matched;
      return matched;
    }
  }

  const nonMale = jaVoices.find((v) => !avoidedKeywords.some((pat) => pat.test(v.name)));
  cachedCuteVoice = nonMale || jaVoices[0];
  return cachedCuteVoice;
}

if ("speechSynthesis" in window) {
  speechSynthesis.onvoiceschanged = () => {
    cachedCuteVoice = null;
    pickCuteJapaneseVoice();
  };
}

// 読み上げ用に語尾や句読点をかわいく整える
function prettifySpeechText(rawText) {
  return String(rawText || "")
    .replace(/向かうよ！/g, "行ってみようねっ！")
    .replace(/見つかったよ！/g, "見つけたよ〜！")
    .replace(/調べているよ！/g, "調べてみるね〜！")
    .replace(/。/g, "、")
    .replace(/！+/g, "っ！")
    .trim();
}

// スプライトシート画像のパス解決（4列×4行）
function resolveCharSpriteImage() {
  const candidatesSrc = [
    "./DEMO-stand.jpeg",
    "./DEMO-stand.jpg",
    "./DEMO-stand.png",
  ];

  const tryNext = (index) => {
    if (index >= candidatesSrc.length) return;
    const src = candidatesSrc[index];
    const probe = new Image();
    probe.onload = () => {
      document.documentElement.style.setProperty("--char-sprite-url", `url("${src}")`);
    };
    probe.onerror = () => tryNext(index + 1);
    probe.src = src;
  };

  tryNext(0);
}

// 4列 x 4行のスプライトシートの指定コマ（col: 0..3, row: 0..3）を適用
function setStandFrame(el, col, row) {
  if (!el) return;
  const xPct = (col / 3) * 100;
  const yPct = (row / 3) * 100;
  el.style.backgroundPosition = `${xPct}% ${yPct}%`;
}

function stopExprLoops() {
  clearInterval(idleExprTimer);
  clearInterval(talkExprTimer);
  idleExprTimer = null;
  talkExprTimer = null;
}

// 待機中のコマ送りアニメーション（立ち → 少し動き → 手を挙げる → ニコッと挨拶）
function startIdleAnimation() {
  stopExprLoops();
  const standSprite = $("standSprite");
  const replySprite = $("replyStandSprite");
  const frames = [
    [0, 0],
    [1, 0],
    [3, 0],
    [0, 1],
  ];
  let idx = 0;

  const applyCurrent = () => {
    const [col, row] = frames[idx % frames.length];
    setStandFrame(standSprite, col, row);
    setStandFrame(replySprite, col, row);
  };

  applyCurrent();
  idleExprTimer = setInterval(() => {
    idx += 1;
    applyCurrent();
  }, 900);
}

// 音声モード画面 / 文字入力モード画面 の切り替え
function switchScreen(mode) {
  currentMode = mode;
  const isVoice = mode === "voice";

  $("voiceScreen").classList.toggle("hidden", !isVoice);
  $("inputScreen").classList.toggle("hidden", isVoice);

  $("tabVoiceBtn").className = isVoice
    ? "py-2 rounded-xl text-xs sm:text-sm font-extrabold bg-white text-indigo-700 shadow-xs transition"
    : "py-2 rounded-xl text-xs sm:text-sm font-bold text-slate-600 hover:text-slate-900 transition";

  $("tabInputBtn").className = !isVoice
    ? "py-2 rounded-xl text-xs sm:text-sm font-extrabold bg-white text-sky-700 shadow-xs transition"
    : "py-2 rounded-xl text-xs sm:text-sm font-bold text-slate-600 hover:text-slate-900 transition";

  if (!isVoice && isListening && recognition) {
    syncHandsFree(false);
    recognition.stop();
  }
}

$("tabVoiceBtn").onclick = () => switchScreen("voice");
$("tabInputBtn").onclick = () => switchScreen("input");

// キャラクターのポーズ・アニメーション・状態バッジ・吹き出しを更新
function setCharacterState(state, bubbleText) {
  const avatar = $("avatarWrap");
  const standSprite = $("standSprite");
  const replyAvatar = $("replyAvatarWrap");
  const replySprite = $("replyStandSprite");
  const badge = $("charStateBadge");

  stopExprLoops();
  avatar.classList.remove("char-idle", "char-listening", "char-speaking");
  if (replyAvatar) replyAvatar.classList.remove("char-idle", "char-listening", "char-speaking");

  if (state === "listening") {
    avatar.classList.add("char-listening");
    const listenFrames = [
      [2, 1],
      [3, 1],
    ];
    let idx = 0;
    const applyListen = () => {
      const [col, row] = listenFrames[idx % listenFrames.length];
      setStandFrame(standSprite, col, row);
    };
    applyListen();
    talkExprTimer = setInterval(() => {
      idx += 1;
      applyListen();
    }, 450);
    badge.textContent = "👂 聞き取り中";
    badge.className = "text-[10px] font-bold px-2.5 py-1 rounded-full bg-indigo-100 text-indigo-700";
  } else if (state === "speaking") {
    avatar.classList.add("char-speaking");
    if (replyAvatar) replyAvatar.classList.add("char-speaking");
    const talkFrames = [
      [0, 1],
      [1, 1],
      [2, 1],
      [2, 3],
    ];
    let idx = 0;
    const applyTalk = () => {
      const [col, row] = talkFrames[idx % talkFrames.length];
      setStandFrame(standSprite, col, row);
      setStandFrame(replySprite, col, row);
    };
    applyTalk();
    talkExprTimer = setInterval(() => {
      idx += 1;
      applyTalk();
    }, 280);
    badge.textContent = "💬 お話し中";
    badge.className = "text-[10px] font-bold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700";
  } else if (state === "thinking") {
    avatar.classList.add("char-idle");
    setStandFrame(standSprite, 2, 2);
    badge.textContent = "🔍 検索中";
    badge.className = "text-[10px] font-bold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800";
  } else if (state === "error") {
    avatar.classList.add("char-idle");
    setStandFrame(standSprite, 0, 2);
    badge.textContent = "⚠️ エラー";
    badge.className = "text-[10px] font-bold px-2.5 py-1 rounded-full bg-rose-100 text-rose-700";
  } else {
    avatar.classList.add("char-idle");
    if (replyAvatar) replyAvatar.classList.add("char-idle");
    startIdleAnimation();
    badge.textContent = "待機中";
    badge.className = "text-[10px] font-bold px-2.5 py-1 rounded-full bg-sky-100 text-sky-700";
  }

  if (bubbleText) {
    $("charBubble").textContent = bubbleText;
  }
}

function updateSettingsSummary() {
  const flightLabel = searchSettings.includeFlight ? "✈️ 使う" : "🚫 使わない";
  const prefLabel = searchSettings.preference === "shortest" ? "⚡ 一番早い" : "💴 一番安い";
  const text = `${flightLabel} ／ ${prefLabel}`;
  $("settingsSummaryVoice").textContent = text;
  $("settingsSummaryInput").textContent = text;
}

function syncHandsFree(enabled) {
  handsFreeEnabled = Boolean(enabled);
  $("handsFreeToggle").checked = handsFreeEnabled;
  $("modalHandsFree").checked = handsFreeEnabled;
}

$("handsFreeToggle").onchange = (e) => syncHandsFree(e.target.checked);
$("modalHandsFree").onchange = (e) => syncHandsFree(e.target.checked);

function openSettingsModal() {
  document.querySelector(`input[name="modalFlightOption"][value="${searchSettings.includeFlight ? "yes" : "no"}"]`).checked = true;
  document.querySelector(`input[name="modalPreference"][value="${searchSettings.preference}"]`).checked = true;
  $("modalHandsFree").checked = handsFreeEnabled;
  $("settingsModal").classList.remove("hidden");
}

function closeSettingsModal() {
  $("settingsModal").classList.add("hidden");
}

$("openSettingsBtn").onclick = openSettingsModal;
$("openSettingsInlineBtn").onclick = openSettingsModal;
$("closeSettingsBtn").onclick = closeSettingsModal;

$("saveSettingsBtn").onclick = () => {
  searchSettings.includeFlight = document.querySelector('input[name="modalFlightOption"]:checked').value === "yes";
  searchSettings.preference = document.querySelector('input[name="modalPreference"]:checked').value;
  syncHandsFree($("modalHandsFree").checked);
  updateSettingsSummary();
  closeSettingsModal();
  setCharacterState("idle", "設定を更新したよ〜！いつでも話しかけてねっ！");
};

resolveCharSpriteImage();
updateSettingsSummary();
setCharacterState("idle", "こんにちは〜！行きたい場所を話しかけてねっ！");

function sayShortPhrase(phrase, continueListeningAfter = false) {
  if (!("speechSynthesis" in window) || !phrase) return;
  speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(prettifySpeechText(phrase));
  const cuteVoice = pickCuteJapaneseVoice();
  if (cuteVoice) utterance.voice = cuteVoice;

  utterance.lang = "ja-JP";
  utterance.rate = 1.14;
  utterance.pitch = 1.52;
  utterance.volume = 1.0;

  utterance.onstart = () => {
    isSpeaking = true;
    $("speakBtn").textContent = "⏹️ 停止";
    $("speakingIndicator").classList.replace("hidden", "flex");
    setCharacterState("speaking");
  };
  utterance.onend = utterance.onerror = () => {
    stopSpeech();
    if (continueListeningAfter && handsFreeEnabled && currentMode === "voice") {
      setTimeout(() => startVoice(), 350);
    }
  };
  speechSynthesis.speak(utterance);
}

function stopSpeech() {
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  isSpeaking = false;
  $("speakBtn").textContent = "🔊 読み上げ";
  $("speakingIndicator").classList.replace("flex", "hidden");
  if (!isListening) setCharacterState("idle");
}

function speakGuide() {
  if (!speechScript) return;
  sayShortPhrase(speechScript, handsFreeEnabled);
}

$("speakBtn").onclick = () => (isSpeaking ? stopSpeech() : speakGuide());

async function reverseGeocode(lat, lng) {
  const fetchJson = async (url) => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 3500);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };

  const [osm, gsi] = await Promise.all([
    fetchJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=ja&addressdetails=1&zoom=18`),
    fetchJson(`https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=${lat}&lon=${lng}`),
  ]);

  const a = osm?.address || {};
  const osmAddr = `${a.state || ""}${a.city || a.ward || a.town || a.village || ""}${a.city_district || ""}${a.suburb || ""}${a.quarter || ""}${a.neighbourhood || ""}${a.road || ""}${a.house_number || ""}`.trim();
  const gsiTown = gsi?.results?.lv01Nm || "";

  if (gsiTown && (!osmAddr || /[都道府県市区郡]$/.test(osmAddr))) {
    return `${a.state || ""}${gsiTown}`;
  }
  return osmAddr || (gsiTown ? `${a.state || ""}${gsiTown}` : "");
}

function fetchGpsOrigin() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(false);
    const st = $("gpsStatus");
    $("gpsBtn").disabled = true;
    $("gpsBtn").textContent = "📡 取得中...";
    st.textContent = "現在地と住所を取得中...";
    st.className = "text-xs text-slate-600 mt-1";

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = +pos.coords.latitude.toFixed(5);
        const lng = +pos.coords.longitude.toFixed(5);
        originCoords = [lat, lng];
        const addr = await reverseGeocode(lat, lng);
        $("origin").value = addr || `現在地 (${lat}, ${lng})`;
        st.textContent = `${addr ? "住所取得完了" : "座標取得完了"}（誤差 約${Math.round(pos.coords.accuracy)}m）`;
        st.className = "text-xs text-emerald-700 font-bold mt-1";
        $("gpsBtn").disabled = false;
        $("gpsBtn").textContent = "📍 現在地を使う";
        resolve(true);
      },
      () => {
        st.textContent = "現在地を取得できませんでした。位置情報許可を確認してください。";
        st.className = "text-xs text-rose-600 font-medium mt-1";
        $("gpsBtn").disabled = false;
        $("gpsBtn").textContent = "📍 現在地を使う";
        resolve(false);
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  });
}

$("gpsBtn").onclick = fetchGpsOrigin;
$("origin").oninput = () => {
  originCoords = null;
  $("gpsStatus").classList.add("hidden");
};
$("swapBtn").onclick = () => {
  [$("origin").value, $("destination").value] = [$("destination").value, $("origin").value];
  originCoords = null;
  $("gpsStatus").classList.add("hidden");
};

function parseVoice(text) {
  const s = text.replace(/[？?！!。、]/g, " ").trim();
  let useGps = /(今いるところ|いまいるところ|現在地|ここから|今いる場所)/.test(s);
  let from = "";
  let to = "";

  const m = s.match(/(.+?)から\s*(.+?)(?:まで|へ|に|にいく|に行く|に行きたい|への|の最短|の最安|のルート|ルート|経路|行き方|$)/);
  if (m) {
    if (/(今いるところ|いまいるところ|現在地|ここ|今いる場所)/.test(m[1])) useGps = true;
    else from = m[1].trim();
    to = m[2].trim();
  } else {
    const m2 = s.match(/(.+?)(?:まで|へ|に|にいく|に行く|に行きたい|への|の最短|の最安|のルート|ルート|経路|行き方)/);
    if (m2) to = m2[1].replace(/^(今いるところ|いまいるところ|現在地|ここ)\s*/, "").trim();
  }

  if (/(安い|安く|最安|節約|一番安い)/.test(s)) searchSettings.preference = "cheapest";
  else if (/(最短|早い|早く|速い|速く|一番早い)/.test(s)) searchSettings.preference = "shortest";

  if (/(飛行機なし|飛行機を使わない|飛行機以外|新幹線|電車だけ|バスだけ)/.test(s)) searchSettings.includeFlight = false;
  else if (/(飛行機|空路)/.test(s)) searchSettings.includeFlight = true;

  updateSettingsSummary();
  return { useGps, from, to };
}

function setListening(active) {
  isListening = active;
  $("voiceSearchBtn").classList.toggle("mic-listening", active);
  $("voiceSearchBtn").textContent = active ? "⏹️ 聞き取りを止める" : "🎙️ ボタンを押して話しかける";

  if (active) {
    setCharacterState("listening", "うんうんっ、どこに行きたいか教えてね〜！");
    $("voiceBox").classList.remove("hidden");
    $("voiceStatus").textContent = "🎙️ 話しかけてください...";
    $("voiceText").textContent = "";
  } else if (!isSpeaking) {
    setCharacterState("idle");
  }
}

function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    $("voiceBox").classList.remove("hidden");
    $("voiceStatus").textContent = "未対応ブラウザです";
    $("voiceText").textContent = "Chrome や Safari をご利用ください。";
    setCharacterState("error", "ごめんね、このブラウザだと音声認識が使えないみたい。");
    return;
  }
  if (isListening && recognition) {
    syncHandsFree(false);
    return recognition.stop();
  }
  stopSpeech();

  recognition = new SR();
  recognition.lang = "ja-JP";
  recognition.interimResults = true;
  let finalStr = "";

  recognition.onstart = () => setListening(true);
  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalStr += t;
      else interim += t;
    }
    $("voiceText").textContent = finalStr || interim;
  };
  recognition.onerror = () => {
    setListening(false);
    $("voiceStatus").textContent = "聞き取れませんでした。もう一度話しかけてください。";
    setCharacterState("error", "うまく聞き取れなかったよ〜。もう一回話しかけてねっ！");
  };
  recognition.onend = async () => {
    setListening(false);
    const spoken = (finalStr || $("voiceText").textContent).trim();
    if (!spoken) return;
    $("voiceStatus").textContent = "ナビロボがルートを調べているよ...";
    setCharacterState("thinking", `「${spoken}」だねっ！ちょっと待っててね〜！`);
    const p = parseVoice(spoken);
    if (p.to) $("destination").value = p.to;
    if (p.useGps) await fetchGpsOrigin();
    else if (p.from) {
      $("origin").value = p.from;
      originCoords = null;
    }
    $("userNote").value = spoken;
    autoSpeak = true;
    $("searchForm").requestSubmit();
  };
  recognition.start();
}

$("voiceSearchBtn").onclick = startVoice;

function renderAgentReply(origin, destination, preference, shouldAutoSpeak) {
  const best = candidates.find((c) => c.routeId === bestId) || candidates[0];
  const prefText = preference === "shortest" ? "一番早い" : "一番安い";
  const note = $("userNote").value.trim();

  $("userQueryBubble").textContent = note ? `「${note}」` : `${origin} から ${destination} まで（${prefText}）`;

  if (!best) {
    const msg = "ごめんね、その条件に合うルートが見つからなかったよ〜。別の場所を教えてねっ！";
    $("aiReplyLead").textContent = msg;
    $("aiReplyHighlights").innerHTML = "";
    speechScript = msg;
    setCharacterState("error", msg);
    if (shouldAutoSpeak) sayShortPhrase(speechScript, handsFreeEnabled);
    return;
  }

  const leadMsg = `${origin}から${destination}までは、ルート${best.routeId}（約${best.durationMinutes}分・${best.fareYen}円）が${prefText}よ！`;
  $("aiReplyLead").textContent = leadMsg;
  setCharacterState("idle", `見つけたよ〜！約${best.durationMinutes}分・${best.fareYen}円で行けるよっ！`);

  $("aiReplyHighlights").innerHTML = best.legs
    .map((leg, idx) => {
      const tag = idx === 0 ? "乗車" : idx === best.legs.length - 1 ? "到着" : "乗換";
      return `
        <div class="bg-white border border-slate-200 rounded-xl px-3 py-2 text-xs sm:text-sm text-slate-800 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1">
          <div>
            <span class="font-bold text-sky-700 mr-1">[${tag}]</span>
            <span class="font-bold text-slate-900">${leg.lineName}</span>
            <span class="text-slate-600">：${leg.boardAt} → ${leg.alightAt}</span>
          </div>
          <span class="text-xs font-semibold text-slate-500 shrink-0">約${leg.durationMinutes}分</span>
        </div>
      `;
    })
    .join("");

  const steps = best.legs
    .map((l) => `${l.lineName}で${l.boardAt}から${l.alightAt}まで約${l.durationMinutes}分`)
    .join("。次は");
  speechScript = `${origin}から${destination}までは、ルート${best.routeId}、約${best.durationMinutes}分、${best.fareYen}円が${prefText}よ！${steps}で向かうよ！`;

  if (shouldAutoSpeak || (handsFreeEnabled && currentMode === "voice")) {
    sayShortPhrase(speechScript, handsFreeEnabled && currentMode === "voice");
  }
}

function renderCards() {
  $("routeCards").innerHTML = candidates
    .map((r) => {
      const isBest = r.routeId === bestId;
      const isSel = r.routeId === selectedId;
      const legs = r.legs
        .map(
          (l) => `
          <div class="relative pl-4 pb-3 last:pb-0 border-l-2 ${isSel ? "border-sky-400" : "border-slate-200"}">
            <span class="absolute -left-[7px] top-1.5 w-3 h-3 rounded-full border-2 border-white ${isSel ? "bg-sky-500" : "bg-slate-400"}"></span>
            <div class="flex flex-wrap items-center gap-1.5 mb-1">
              ${MODE_BADGE[l.mode] || MODE_BADGE.walk}
              <span class="text-sm font-bold text-slate-900">${l.lineName}</span>
              <span class="text-xs text-slate-500">(${l.durationMinutes}分)</span>
            </div>
            <div class="bg-slate-50 border border-slate-200 rounded-xl p-2.5 text-xs sm:text-sm space-y-1.5">
              <div><span class="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-900 font-bold text-[11px] mr-1.5">乗車</span>${l.boardAt}</div>
              <div><span class="px-1.5 py-0.5 rounded bg-rose-100 text-rose-900 font-bold text-[11px] mr-1.5">下車</span>${l.alightAt}</div>
              ${l.note ? `<p class="text-xs text-slate-600">💡 ${l.note}</p>` : ""}
            </div>
          </div>`
        )
        .join("");

      return `
        <div onclick="selectRoute('${r.routeId}')" class="cursor-pointer rounded-3xl p-4 sm:p-5 bg-white border-2 transition ${isSel ? "border-sky-500 shadow-md" : "border-slate-200 hover:border-slate-300 shadow-sm"}">
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-3 pb-2.5 border-b border-slate-100">
            <div class="flex flex-wrap items-center gap-2">
              <span class="w-7 h-7 rounded-xl text-xs font-extrabold flex items-center justify-center ${isBest ? "bg-sky-500 text-white" : "bg-slate-100 text-slate-700"}">${r.routeId}</span>
              <span class="font-bold text-base text-slate-900">${r.summary}</span>
              ${isBest ? '<span class="text-xs font-bold px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200">おすすめ</span>' : ""}
            </div>
            <div class="flex items-center gap-4 text-base">
              <span class="font-extrabold text-slate-900">${r.durationMinutes}<span class="text-xs font-normal text-slate-500">分</span></span>
              <span class="font-extrabold text-emerald-600">¥${r.fareYen}</span>
              <span class="text-xs font-semibold text-slate-600">乗換 ${r.transfers}回</span>
            </div>
          </div>
          <div class="ml-1">${legs}</div>
        </div>`;
    })
    .join("");
}

window.selectRoute = (id) => {
  selectedId = id;
  renderCards();
};

$("searchForm").onsubmit = async (e) => {
  e.preventDefault();
  stopSpeech();
  const shouldSpeak = autoSpeak;
  autoSpeak = false;

  const origin = $("origin").value.trim();
  const destination = $("destination").value.trim();
  const { includeFlight, preference } = searchSettings;
  const userNote = $("userNote").value.trim();

  setCharacterState("thinking", `${origin}から${destination}までのルートを調べてみるね〜！`);
  $("emptyState").classList.add("hidden");
  $("errorState").classList.add("hidden");
  $("resultContainer").classList.add("hidden");
  $("loadingState").classList.remove("hidden");
  $("submitBtn").disabled = true;

  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ origin, destination, includeFlight, preference, userNote, originCoords }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "検索に失敗しました");

    candidates = data.candidates;
    bestId = data.bestRouteId;
    selectedId = (candidates.find((c) => c.routeId === bestId) || candidates[0])?.routeId || "";

    renderAgentReply(origin, destination, preference, shouldSpeak);
    renderCards();

    $("loadingState").classList.add("hidden");
    $("resultContainer").classList.remove("hidden");
    if (window.innerWidth < 1024) $("resultsSection").scrollIntoView({ behavior: "smooth" });
  } catch (err) {
    $("loadingState").classList.add("hidden");
    $("errorState").textContent = "エラー: " + err.message;
    $("errorState").classList.remove("hidden");
    setCharacterState("error", "ごめんね、検索でエラーが起きちゃった〜。もう一回試してみてね！");
    if (handsFreeEnabled && currentMode === "voice") {
      sayShortPhrase("ごめんね、エラーが起きちゃった〜。もう一回話しかけてね！", true);
    }
  } finally {
    $("submitBtn").disabled = false;
  }
};