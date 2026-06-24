(function(){
  "use strict";

  // ============================================================
  // IndexedDB persistence layer
  // ============================================================
  const DB_NAME = 'noobat-bazi-db';
  const DB_VERSION = 1;
  const STORE_NAME = 'settings';
  const SETTINGS_KEY = 'main';

  let dbPromise = null;

  function openDB(){
    if(dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if(!('indexedDB' in window)){
        reject(new Error('IndexedDB not supported'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if(!db.objectStoreNames.contains(STORE_NAME)){
          db.createObjectStore(STORE_NAME);
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror = (e) => reject(e.target.error);
    });
    return dbPromise;
  }

  async function idbGet(key){
    try{
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }catch(e){
      return undefined;
    }
  }

  async function idbSet(key, value){
    try{
      const db = await openDB();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const req = store.put(value, key);
        req.onsuccess = () => resolve(true);
        req.onerror = () => reject(req.error);
      });
    }catch(e){
      return false;
    }
  }

  // Fallback chain: try IndexedDB; if it fails entirely, fall back to localStorage
  // (still better than nothing on very old/locked-down browsers).
  function loadFromLocalStorageFallback(){
    try{
      const raw = localStorage.getItem('noobat-bazi-settings-v1');
      return raw ? JSON.parse(raw) : null;
    }catch(e){ return null; }
  }

  function saveToLocalStorageFallback(data){
    try{
      localStorage.setItem('noobat-bazi-settings-v1', JSON.stringify(data));
    }catch(e){ /* ignore */ }
  }

  // ============================================================
  // App state
  // ============================================================
  let mode = 'single';
  let durationMin = 20;
  let totalRounds = 8;

  let singleCount = 2;
  let players = ['', ''];

  let g1Count = 2, g2Count = 2;
  let g1Names = ['', ''];
  let g2Names = ['', ''];
  let g1Label = 'گروه ۱', g2Label = 'گروه ۲';

  let currentRound = 1;
  let currentTurnIdx = 0;
  let secondsLeft = 0;
  let totalSeconds = 0;
  let timerHandle = null;
  let isPaused = false;
  let warnedThisRound = false;
  let audioCtx = null;
  let wakeLock = null;

  let customAudioURL = null;
  let customAudioEl = null;
  let customAudioData = null; // base64 data URL, persisted

  const RING_CIRC = 2 * Math.PI * 98;

  function currentSettingsSnapshot(){
    return {
      mode, durationMin, totalRounds,
      singleCount, players,
      g1Count, g2Count, g1Names, g2Names, g1Label, g2Label,
      customAudioData
    };
  }

  let saveTimer = null;
  function saveSettings(){
    const data = currentSettingsSnapshot();
    saveToLocalStorageFallback(data); // fast synchronous fallback copy
    // debounce the heavier IDB write slightly in case of rapid typing
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      idbSet(SETTINGS_KEY, data);
    }, 150);
  }

  // ============================================================
  // Elements
  // ============================================================
  const setupScreen = document.getElementById('setupScreen');
  const playScreen = document.getElementById('playScreen');
  const endScreen = document.getElementById('endScreen');
  const banner = document.getElementById('banner');

  const modeSingleBtn = document.getElementById('modeSingleBtn');
  const modeGroupBtn = document.getElementById('modeGroupBtn');
  const singleModeCard = document.getElementById('singleModeCard');
  const groupModeCard = document.getElementById('groupModeCard');

  const durationPills = document.getElementById('durationPills');
  const roundsPills = document.getElementById('roundsPills');

  const countMinus = document.getElementById('countMinus');
  const countPlus = document.getElementById('countPlus');
  const countDisplay = document.getElementById('countDisplay');
  const playersScroll = document.getElementById('playersScroll');

  const g1CountMinus = document.getElementById('g1CountMinus');
  const g1CountPlus = document.getElementById('g1CountPlus');
  const g1CountDisplay = document.getElementById('g1CountDisplay');
  const g1PlayersScroll = document.getElementById('g1PlayersScroll');
  const g1NameInput = document.getElementById('group1NameInput');

  const g2CountMinus = document.getElementById('g2CountMinus');
  const g2CountPlus = document.getElementById('g2CountPlus');
  const g2CountDisplay = document.getElementById('g2CountDisplay');
  const g2PlayersScroll = document.getElementById('g2PlayersScroll');
  const g2NameInput = document.getElementById('group2NameInput');

  const uploadBtn = document.getElementById('uploadBtn');
  const clearAudioBtn = document.getElementById('clearAudioBtn');
  const audioFileInput = document.getElementById('audioFileInput');
  const testAudioBtn = document.getElementById('testAudioBtn');

  const startBtn = document.getElementById('startBtn');

  const roundInfo = document.getElementById('roundInfo');
  const turnLabel = document.getElementById('turnLabel');
  const playerName = document.getElementById('playerName');
  const timeLeft = document.getElementById('timeLeft');
  const groupMembers = document.getElementById('groupMembers');
  const nextUp = document.getElementById('nextUp');
  const ringProgress = document.getElementById('ringProgress');
  const pauseBtn = document.getElementById('pauseBtn');
  const skipBtn = document.getElementById('skipBtn');
  const stopBtn = document.getElementById('stopBtn');
  const restartBtn = document.getElementById('restartBtn');

  const bannerIcon = document.getElementById('bannerIcon');
  const bannerEyebrow = document.getElementById('bannerEyebrow');
  const bannerTitle = document.getElementById('bannerTitle');
  const bannerSub = document.getElementById('bannerSub');
  const bannerBtn = document.getElementById('bannerBtn');

  ringProgress.setAttribute('stroke-dasharray', RING_CIRC.toFixed(2));

  const ORDINALS = ["اول","دوم","سوم","چهارم","پنجم","ششم","هفتم","هشتم","نهم","دهم",
    "یازدهم","دوازدهم","سیزدهم","چهاردهم","پانزدهم","شانزدهم","هفدهم","هجدهم","نوزدهم","بیستم"];

  function ordinal(n){
    return ORDINALS[n-1] || (n + "ام");
  }

  function toFarsiDigits(str){
    const map = {'0':'۰','1':'۱','2':'۲','3':'۳','4':'۴','5':'۵','6':'۶','7':'۷','8':'۸','9':'۹'};
    return String(str).replace(/[0-9]/g, d => map[d]);
  }

  // ============================================================
  // Mode toggle
  // ============================================================
  function setMode(m){
    mode = m;
    modeSingleBtn.classList.toggle('active', m === 'single');
    modeGroupBtn.classList.toggle('active', m === 'group');
    singleModeCard.classList.toggle('hidden', m !== 'single');
    groupModeCard.classList.toggle('hidden', m !== 'group');
    validateStart();
    saveSettings();
  }
  modeSingleBtn.addEventListener('click', () => setMode('single'));
  modeGroupBtn.addEventListener('click', () => setMode('group'));

  // ============================================================
  // Pills
  // ============================================================
  function wirePillGroup(container, onPick){
    container.querySelectorAll('.pill').forEach(btn => {
      const val = parseInt(btn.dataset.val, 10);
      btn.addEventListener('click', () => {
        container.querySelectorAll('.pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        onPick(val);
        saveSettings();
      });
    });
  }
  function syncPillsUI(container, currentVal){
    container.querySelectorAll('.pill').forEach(btn => {
      const val = parseInt(btn.dataset.val, 10);
      btn.classList.toggle('active', val === currentVal);
    });
  }
  wirePillGroup(durationPills, v => durationMin = v);
  wirePillGroup(roundsPills, v => totalRounds = v);

  // ============================================================
  // Generic player-name-list renderer (used 3x)
  // ============================================================
  function renderNameList(container, namesArr, count, placeholder){
    while(namesArr.length < count) namesArr.push('');
    while(namesArr.length > count) namesArr.pop();

    container.innerHTML = '';
    for(let i = 0; i < count; i++){
      const chip = document.createElement('div');
      chip.className = 'player-chip';

      const num = document.createElement('div');
      num.className = 'player-num';
      num.textContent = toFarsiDigits(i+1);

      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = placeholder + ' ' + toFarsiDigits(i+1);
      input.value = namesArr[i];
      input.addEventListener('input', e => { namesArr[i] = e.target.value; validateStart(); saveSettings(); });

      chip.appendChild(num);
      chip.appendChild(input);
      container.appendChild(chip);
    }
  }

  function renderSinglePlayers(){
    renderNameList(playersScroll, players, singleCount, 'بازیکن');
  }
  function renderG1(){
    renderNameList(g1PlayersScroll, g1Names, g1Count, 'عضو');
  }
  function renderG2(){
    renderNameList(g2PlayersScroll, g2Names, g2Count, 'عضو');
  }

  // ============================================================
  // Count steppers
  // ============================================================
  function wireCounter(minusBtn, plusBtn, display, getCount, setCount, rerender, min, max){
    minusBtn.addEventListener('click', () => {
      let c = getCount();
      if(c > min){ c--; setCount(c); display.textContent = toFarsiDigits(c); rerender(); validateStart(); saveSettings(); }
    });
    plusBtn.addEventListener('click', () => {
      let c = getCount();
      if(c < max){ c++; setCount(c); display.textContent = toFarsiDigits(c); rerender(); validateStart(); saveSettings(); }
    });
  }

  wireCounter(countMinus, countPlus, countDisplay,
    () => singleCount, v => singleCount = v, renderSinglePlayers, 2, 12);

  wireCounter(g1CountMinus, g1CountPlus, g1CountDisplay,
    () => g1Count, v => g1Count = v, renderG1, 1, 10);

  wireCounter(g2CountMinus, g2CountPlus, g2CountDisplay,
    () => g2Count, v => g2Count = v, renderG2, 1, 10);

  g1NameInput.addEventListener('input', e => { g1Label = e.target.value; saveSettings(); });
  g2NameInput.addEventListener('input', e => { g2Label = e.target.value; saveSettings(); });

  function validateStart(){
    if(mode === 'single'){
      const filled = players.filter(p => p.trim().length > 0);
      startBtn.disabled = filled.length < 2;
    } else {
      const f1 = g1Names.filter(p => p.trim().length > 0);
      const f2 = g2Names.filter(p => p.trim().length > 0);
      startBtn.disabled = (f1.length < 1 || f2.length < 1);
    }
  }

  // ============================================================
  // Audio upload (persisted as base64 in IndexedDB)
  // ============================================================
  function setAudioFromDataURL(dataURL, displayName){
    customAudioData = dataURL;
    customAudioEl = new Audio(dataURL);
    customAudioEl.preload = 'auto';
    uploadBtn.textContent = '✓ ' + (displayName || 'فایل صوتی ذخیره‌شده');
    uploadBtn.classList.add('has-file');
    clearAudioBtn.classList.remove('hidden');
  }

  uploadBtn.addEventListener('click', () => audioFileInput.click());

  audioFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setAudioFromDataURL(reader.result, file.name);
      saveSettings();
    };
    reader.onerror = () => {
      if(customAudioURL) URL.revokeObjectURL(customAudioURL);
      customAudioURL = URL.createObjectURL(file);
      customAudioEl = new Audio(customAudioURL);
      uploadBtn.textContent = '✓ ' + file.name;
      uploadBtn.classList.add('has-file');
      clearAudioBtn.classList.remove('hidden');
    };
    reader.readAsDataURL(file);
  });

  clearAudioBtn.addEventListener('click', () => {
    if(customAudioURL) URL.revokeObjectURL(customAudioURL);
    customAudioURL = null;
    customAudioEl = null;
    customAudioData = null;
    audioFileInput.value = '';
    uploadBtn.textContent = '+ آپلود فایل صوتی «نوبت نفر بعدی شده»';
    uploadBtn.classList.remove('has-file');
    clearAudioBtn.classList.add('hidden');
    saveSettings();
  });

  testAudioBtn.addEventListener('click', () => {
    ensureAudio();
    if(customAudioEl){
      try{ customAudioEl.currentTime = 0; customAudioEl.play(); }catch(e){}
    } else {
      playTurnChangeSound();
    }
  });

  // ============================================================
  // Audio (beep fallback via WebAudio)
  // ============================================================
  function ensureAudio(){
    if(!audioCtx){
      try{ audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }catch(e){}
    }
    if(audioCtx && audioCtx.state === 'suspended'){
      audioCtx.resume();
    }
  }

  function beep(freq, durationMs, delayMs, volume){
    if(!audioCtx) return;
    const t0 = audioCtx.currentTime + (delayMs/1000);
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(volume || 0.4, t0 + 0.02);
    gain.gain.linearRampToValueAtTime(0, t0 + durationMs/1000);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(t0);
    osc.stop(t0 + durationMs/1000 + 0.05);
  }

  function playWarningSound(){
    ensureAudio();
    beep(880, 180, 0);
    beep(880, 180, 250);
  }

  function playTurnChangeSound(){
    ensureAudio();
    if(customAudioEl){
      try{ customAudioEl.currentTime = 0; customAudioEl.play(); return; }catch(e){}
    }
    beep(660, 150, 0);
    beep(880, 150, 180);
    beep(1100, 220, 360);
  }

  function playEndSound(){
    ensureAudio();
    beep(1100, 200, 0);
    beep(880, 200, 250);
    beep(660, 200, 500);
    beep(440, 400, 750);
  }

  function vibrate(pattern){
    if(navigator.vibrate){
      try{ navigator.vibrate(pattern); }catch(e){}
    }
  }

  // ============================================================
  // Wake lock
  // ============================================================
  async function requestWakeLock(){
    try{
      if('wakeLock' in navigator){
        wakeLock = await navigator.wakeLock.request('screen');
      }
    }catch(e){}
  }
  function releaseWakeLock(){
    if(wakeLock){ wakeLock.release().catch(()=>{}); wakeLock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if(document.visibilityState === 'visible' && timerHandle){
      requestWakeLock();
    }
  });

  // ============================================================
  // Game flow helpers
  // ============================================================
  function showScreen(scr){
    [setupScreen, playScreen, endScreen].forEach(s => s.classList.add('hidden'));
    scr.classList.remove('hidden');
  }

  let livePlayers = [];
  let liveG1Names = [];
  let liveG2Names = [];

  function slotAt(idx){
    if(mode === 'single'){
      const i = idx % livePlayers.length;
      const name = livePlayers[i] || ('بازیکن ' + toFarsiDigits(i+1));
      return { label: name, members: null, ordinalText: 'نوبت نفر ' + ordinal(i+1) };
    } else {
      const i = idx % 2;
      if(i === 0){
        const label = (g1Label.trim() || 'گروه ۱');
        return { label, members: liveG1Names, ordinalText: 'نوبت ' + label };
      } else {
        const label = (g2Label.trim() || 'گروه ۲');
        return { label, members: liveG2Names, ordinalText: 'نوبت ' + label };
      }
    }
  }

  function slotCount(){
    return mode === 'single' ? livePlayers.length : 2;
  }

  function formatTime(s){
    const m = Math.floor(s/60);
    const sec = s%60;
    return toFarsiDigits(String(m).padStart(2,'0')) + ':' + toFarsiDigits(String(sec).padStart(2,'0'));
  }

  function updateRingAndTime(){
    const frac = secondsLeft / totalSeconds;
    const offset = RING_CIRC * (1 - frac);
    ringProgress.setAttribute('stroke-dashoffset', offset.toFixed(2));
    timeLeft.textContent = formatTime(secondsLeft);

    const isWarnZone = secondsLeft <= 60;
    ringProgress.classList.toggle('warn', isWarnZone);
    timeLeft.classList.toggle('warn', isWarnZone);
  }

  function startRound(){
    totalSeconds = durationMin * 60;
    secondsLeft = totalSeconds;
    warnedThisRound = false;

    const slot = slotAt(currentTurnIdx);
    const nextSlot = slotAt(currentTurnIdx + 1);

    roundInfo.textContent = 'دور ' + toFarsiDigits(currentRound) + ' از ' + toFarsiDigits(totalRounds);
    turnLabel.textContent = slot.ordinalText;
    playerName.textContent = slot.label;

    if(slot.members && slot.members.length){
      groupMembers.textContent = 'اعضا: ' + slot.members.join('، ');
      groupMembers.classList.remove('hidden');
    } else {
      groupMembers.classList.add('hidden');
    }

    nextUp.innerHTML = 'بعدی: <b>' + nextSlot.label + '</b>';
    updateRingAndTime();

    showScreen(playScreen);
    runTicker();
  }

  function runTicker(){
    clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      if(isPaused) return;
      secondsLeft--;

      if(secondsLeft === 60 && !warnedThisRound){
        warnedThisRound = true;
        triggerOneMinuteWarning();
      }

      if(secondsLeft <= 0){
        clearInterval(timerHandle);
        triggerTurnChange();
        return;
      }
      updateRingAndTime();
    }, 1000);
  }

  function triggerOneMinuteWarning(){
    playWarningSound();
    vibrate([200,100,200]);
    const slot = slotAt(currentTurnIdx);
    const nextSlot = slotAt(currentTurnIdx + 1);
    bannerIcon.textContent = '⏳';
    bannerEyebrow.textContent = 'یک دقیقه مونده';
    bannerTitle.className = 'banner-title gold';
    bannerTitle.textContent = slot.label + ' آماده باش!';
    bannerSub.textContent = 'یک دقیقه دیگه نوبت ' + nextSlot.label + ' می‌شه';
    bannerBtn.textContent = 'باشه، فهمیدم';
    bannerBtn.onclick = hideBanner;
    showBanner();
    updateRingAndTime();
  }

  function triggerTurnChange(){
    playTurnChangeSound();
    vibrate([300,150,300,150,300]);

    const finishedSlot = slotAt(currentTurnIdx);
    const isLastRound = currentRound >= totalRounds;

    if(isLastRound){
      bannerIcon.textContent = '🏁';
      bannerEyebrow.textContent = 'پایان دور آخر';
      bannerTitle.className = 'banner-title coral';
      bannerTitle.textContent = 'نوبت ' + finishedSlot.label + ' تمام شد';
      bannerSub.textContent = 'این آخرین نوبت بود — نوبت نفر بعدی شده';
      bannerBtn.textContent = 'پایان بازی';
      bannerBtn.onclick = () => { hideBanner(); finishGame(); };
    } else {
      currentRound++;
      currentTurnIdx = (currentTurnIdx + 1) % slotCount();
      const newSlot = slotAt(currentTurnIdx);
      bannerIcon.textContent = '🎮';
      bannerEyebrow.textContent = 'تغییر نوبت';
      bannerTitle.className = 'banner-title gold';
      bannerTitle.textContent = 'نوبت نفر بعدی شده: ' + newSlot.label;
      bannerSub.textContent = 'دسته رو بده به ' + newSlot.label;
      bannerBtn.textContent = 'شروع نوبت';
      bannerBtn.onclick = () => { hideBanner(); startRound(); };
    }
    showBanner();
  }

  function showBanner(){ banner.classList.remove('hidden'); }
  function hideBanner(){ banner.classList.add('hidden'); }
  bannerBtn.onclick = hideBanner;

  function finishGame(){
    clearInterval(timerHandle);
    timerHandle = null;
    playEndSound();
    vibrate([400,200,400,200,400,200,400]);
    releaseWakeLock();
    showScreen(endScreen);
  }

  // ============================================================
  // Controls
  // ============================================================
  pauseBtn.addEventListener('click', () => {
    isPaused = !isPaused;
    pauseBtn.textContent = isPaused ? '▶ ادامه' : '⏸ توقف';
  });

  skipBtn.addEventListener('click', () => {
    clearInterval(timerHandle);
    secondsLeft = 0;
    triggerTurnChange();
  });

  stopBtn.addEventListener('click', () => {
    clearInterval(timerHandle);
    timerHandle = null;
    releaseWakeLock();
    showScreen(setupScreen);
  });

  restartBtn.addEventListener('click', () => {
    showScreen(setupScreen);
  });

  startBtn.addEventListener('click', () => {
    ensureAudio();
    requestWakeLock();
    saveSettings();

    if(mode === 'single'){
      livePlayers = players.map(p => p.trim()).filter(p => p.length > 0);
      if(livePlayers.length < 2) return;
    } else {
      liveG1Names = g1Names.map(p => p.trim()).filter(p => p.length > 0);
      liveG2Names = g2Names.map(p => p.trim()).filter(p => p.length > 0);
      if(liveG1Names.length < 1 || liveG2Names.length < 1) return;
    }

    currentRound = 1;
    currentTurnIdx = 0;
    isPaused = false;
    pauseBtn.textContent = '⏸ توقف';
    startRound();
  });

  // ============================================================
  // Boot: load saved settings (async, from IndexedDB), then render UI
  // ============================================================
  async function boot(){
    let saved = await idbGet(SETTINGS_KEY);
    if(!saved){
      // migrate from old localStorage-only version if present
      saved = loadFromLocalStorageFallback();
      if(saved) idbSet(SETTINGS_KEY, saved);
    }

    if(saved){
      mode = saved.mode || mode;
      durationMin = saved.durationMin || durationMin;
      totalRounds = saved.totalRounds || totalRounds;
      singleCount = saved.singleCount || singleCount;
      players = (saved.players && saved.players.length) ? saved.players.slice() : players;
      g1Count = saved.g1Count || g1Count;
      g2Count = saved.g2Count || g2Count;
      g1Names = (saved.g1Names && saved.g1Names.length) ? saved.g1Names.slice() : g1Names;
      g2Names = (saved.g2Names && saved.g2Names.length) ? saved.g2Names.slice() : g2Names;
      g1Label = saved.g1Label || g1Label;
      g2Label = saved.g2Label || g2Label;
      customAudioData = saved.customAudioData || null;
    }

    // Restore UI to match loaded state
    modeSingleBtn.classList.toggle('active', mode === 'single');
    modeGroupBtn.classList.toggle('active', mode === 'group');
    singleModeCard.classList.toggle('hidden', mode !== 'single');
    groupModeCard.classList.toggle('hidden', mode !== 'group');

    syncPillsUI(durationPills, durationMin);
    syncPillsUI(roundsPills, totalRounds);

    countDisplay.textContent = toFarsiDigits(singleCount);
    g1CountDisplay.textContent = toFarsiDigits(g1Count);
    g2CountDisplay.textContent = toFarsiDigits(g2Count);
    g1NameInput.value = g1Label;
    g2NameInput.value = g2Label;

    renderSinglePlayers();
    renderG1();
    renderG2();
    validateStart();

    if(customAudioData){
      setAudioFromDataURL(customAudioData, 'فایل صوتی ذخیره‌شده');
    }
  }

  boot();

})();
