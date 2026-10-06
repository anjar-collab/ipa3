/* Controls the opening story, synthesized narration, ambient piano, and transition. */
(function(){
  'use strict';

  const screen = document.getElementById('introScreen');
  if(!screen) return;

  const lineEls = Array.from(screen.querySelectorAll('[data-intro-line]'));
  const story = document.getElementById('introStory');
  const status = document.getElementById('introStatus');
  const startButton = document.getElementById('introStart');
  const pauseButton = document.getElementById('introPause');
  const resumeButton = document.getElementById('introResume');
  const speedButton = document.getElementById('introSpeed');
  const voiceSelect = document.getElementById('introVoice');
  const enterButton = document.getElementById('introEnter');
  const replayButton = document.getElementById('introReplay');
  const skipButton = document.getElementById('introSkip');
  const musicButton = document.getElementById('introMusic');
  const volumeSlider = document.getElementById('introVolume');
  const menuToggle = document.getElementById('introMenuToggle');
  const menu = document.getElementById('introMenu');
  const cursor = document.getElementById('introCursor');
  const music = new Audio('music/Maroon_5,_Wiz_Khalifa_%E2%80%93_Payphone__Lyrics_(128k).m4a');
  music.loop = true;
  music.preload = 'auto';
  music.volume = 0.2;
  music.load();
  function splitSentences(text){
    const parts=[];
    let start=0;
    for(let i=0;i<text.length;i++){
      if(!/[.!?]/.test(text.charAt(i))) continue;
      let end=i+1;
      while(end<text.length && /["'”’]/.test(text.charAt(end))) end++;
      if(end<text.length && !/\s/.test(text.charAt(end))) continue;
      while(end<text.length && /\s/.test(text.charAt(end))) end++;
      parts.push(text.slice(start,end));
      start=end;
      i=end-1;
    }
    if(start<text.length) parts.push(text.slice(start));
    return parts;
  }
  const lines = lineEls.map(function(element){
    const text = element.textContent;
    element.textContent = '';
    const sentences = splitSentences(text).map(function(sentence){
      const output = document.createElement('span');
      output.className = 'intro-sentence';
      element.appendChild(output);
      return { text:sentence, characters:Array.from(sentence), output:output };
    });
    return { element:element, sentences:sentences, characters:Array.from(text), text:text };
  });
  const fullText = lines.map(function(line){ return line.text; }).join('\n\n');
  const totalCharacters = lines.reduce(function(total,line){ return total + line.characters.length; },0);
  const preloadCharacterLimit = Math.ceil(totalCharacters*0.18);
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let phase = 'ready';
  let typedCharacters = 0;
  let timer = 0;
  let controller = null;
  let narration = null;
  let narrationUrl = '';
  let browserUtterance = null;
  let browserNarration = false;
  let browserBoundaryStart = 0;
  let browserBoundaryEnd = 0;
  let browserBoundaryTime = 0;
  let browserPauseTime = 0;
  let browserCharacterMs = 85;
  let browserLastBoundaryPosition = 0;
  let browserLastBoundaryTime = 0;
  let narrationEnded = false;
  let isPaused = false;
  let fastPlayback = false;
  let musicPlaying = false;
  let autoplayBlocked = false;
  let syncStartCharacter = 0;
  let syncStartTime = 0;
  let typingFast = false;
  let musicRetryHandler = null;
  let musicRequested = false;
  let musicPlayPromise = null;
  let musicAttempt = 0;
  let particlesFrame = 0;
  let particles = [];
  let clockTimer = 0;

  const dateOptions = { weekday:'long', year:'numeric', month:'long', day:'numeric' };
  function updateClock(){
    const now = new Date();
    document.getElementById('introTime').textContent = new Intl.DateTimeFormat('id-ID',{
      hour:'2-digit',minute:'2-digit',hour12:false
    }).format(now);
    document.getElementById('introDate').textContent = new Intl.DateTimeFormat('id-ID',dateOptions).format(now);
  }
  updateClock();
  clockTimer = window.setInterval(updateClock,1000);

  const logo = document.getElementById('introLogo');
  const mainLogo = document.getElementById('heroLogoImg');
  if(mainLogo && mainLogo.src) logo.src = mainLogo.src;
  const backdrop = document.getElementById('introBackdrop');
  const schoolBackground = document.querySelector('.hero-bg');
  if(backdrop && schoolBackground){
    const backgroundImage = window.getComputedStyle(schoolBackground).backgroundImage;
    if(backgroundImage && backgroundImage !== 'none') backdrop.style.backgroundImage = backgroundImage;
  }

  function setStatus(message){ status.textContent = message; }

  function renderText(position){
    let offset = 0;
    let activeSentence = null;
    lines.forEach(function(line){
      let lineCount = Math.max(0,Math.min(line.characters.length,position-offset));
      let sentenceOffset = 0;
      line.sentences.forEach(function(sentence){
        const count = Math.max(0,Math.min(sentence.characters.length,lineCount-sentenceOffset));
        sentence.output.textContent = sentence.characters.slice(0,count).join('');
        const active = count < sentence.characters.length && lineCount >= sentenceOffset;
        sentence.output.classList.toggle('is-active',active);
        if(active) activeSentence = sentence;
        sentenceOffset += sentence.characters.length;
      });
      line.element.classList.toggle('is-speaking',lineCount < line.characters.length && position >= offset);
      offset += line.characters.length;
    });
    typedCharacters = Math.max(0,Math.min(totalCharacters,position));
    cursor.remove();
    if(activeSentence && typedCharacters < totalCharacters) activeSentence.output.appendChild(cursor);
    if(story && activeSentence) story.scrollTop = story.scrollHeight;
  }

  function browserTextPosition(characterIndex){
    return Array.from(fullText.slice(0,characterIndex).replace(/\n/g,'')).length;
  }

  function setDuck(isDucked){
    const base = Number(volumeSlider.value)/100*0.85;
    music.volume = Math.max(0,Math.min(1,base*(isDucked ? 0.5 : 1)));
  }

  function startTypingTimer(){
    window.clearInterval(timer);
    timer = window.setInterval(function(){
      if(isPaused || phase === 'done' || phase === 'exited') return;
      if(narration && !narrationEnded){
        if(narration.paused || !Number.isFinite(narration.duration) ||
           narration.duration <= syncStartTime) return;
        const duration = narration.duration-syncStartTime;
        const elapsed = Math.max(0,narration.currentTime-syncStartTime);
        const progress = Math.min(1,elapsed/duration);
        const target = Math.floor(syncStartCharacter+(totalCharacters-syncStartCharacter)*progress);
        renderText(Math.max(typedCharacters,Math.min(target,typedCharacters+1)));
      }else if(browserNarration && !narrationEnded){
        if(browserBoundaryEnd > browserBoundaryStart){
          const spokenLength = browserBoundaryEnd-browserBoundaryStart;
          const duration = spokenLength*browserCharacterMs;
          const progress = Math.min(1,(performance.now()-browserBoundaryTime)/duration);
          const characterIndex = browserBoundaryStart+Math.floor(spokenLength*progress);
          renderText(Math.max(typedCharacters,Math.min(totalCharacters,browserTextPosition(characterIndex))));
        }
      }else if(phase === 'loading'){
        if(typedCharacters < preloadCharacterLimit){
          renderText(Math.min(preloadCharacterLimit,typedCharacters+1));
        }
      }else{
        renderText(Math.min(totalCharacters,typedCharacters+1));
        if(typedCharacters >= totalCharacters && (!narration || narrationEnded) &&
           (!browserNarration || narrationEnded)) finishNarration();
      }
    },reducedMotion ? 45 : 20);
  }

  function finishNarration(){
    if(phase === 'done' || phase === 'exited') return;
    if(narration && !narrationEnded) return;
    if(typedCharacters < totalCharacters) return;
    window.clearInterval(timer);
    timer = 0;
    phase = 'done';
    isPaused = false;
    renderText(totalCharacters);
    setDuck(false);
    cursor.remove();
    document.querySelectorAll('.intro-line').forEach(function(line){ line.classList.remove('is-speaking'); });
    pauseButton.disabled = true;
    resumeButton.disabled = true;
    speedButton.disabled = true;
    startButton.disabled = true;
    startButton.hidden = true;
    voiceSelect.disabled = true;
    enterButton.hidden = false;
    replayButton.hidden = false;
    setStatus('Kenangan telah kembali. Selamat datang di rumah.');
  }

  function releaseNarrationAudio(){
    const activeBrowserUtterance = browserUtterance;
    browserNarration = false;
    browserUtterance = null;
    if(activeBrowserUtterance && window.speechSynthesis){
      window.speechSynthesis.cancel();
    }
    browserBoundaryStart = 0;
    browserBoundaryEnd = 0;
    browserBoundaryTime = 0;
    browserPauseTime = 0;
    browserLastBoundaryPosition = 0;
    browserLastBoundaryTime = 0;
    if(narration){
      narration.pause();
      narration.removeAttribute('src');
      narration.load();
      narration = null;
    }
    if(narrationUrl){
      URL.revokeObjectURL(narrationUrl);
      narrationUrl = '';
    }
    narrationEnded = false;
  }

  function showAudioError(error){
    if(phase === 'exited' || phase === 'done') return;
    if(controller) controller.abort();
    releaseNarrationAudio();
    autoplayBlocked = false;
    window.clearInterval(timer);
    timer = 0;
    phase = 'ready';
    isPaused = false;
    renderText(0);
    pauseButton.disabled = true;
    resumeButton.disabled = true;
    speedButton.disabled = true;
    voiceSelect.disabled = false;
    startButton.textContent = '🔊 Coba Lagi Suara OpenAI';
    startButton.hidden = false;
    startButton.disabled = false;
    setDuck(false);
    console.error('Suara OpenAI gagal diputar:',error);
    setStatus('Suara OpenAI gagal: ' + error.message + ' Periksa API key dan koneksi server, lalu coba lagi.');
  }

  function startBrowserNarration(error){
    if(phase === 'exited' || phase === 'done') return;
    const synth = window.speechSynthesis;
    if(!synth || typeof window.SpeechSynthesisUtterance !== 'function'){
      showAudioError(error);
      return;
    }
    if(controller) controller.abort();
    releaseNarrationAudio();
    const utterance = new window.SpeechSynthesisUtterance(fullText);
    utterance.lang = 'id-ID';
    utterance.rate = fastPlayback ? 1.2 : 1;
    const availableVoices = synth.getVoices();
    const indonesianVoice = availableVoices.find(function(voice){
      return voice.lang.toLowerCase().startsWith('id');
    });
    if(indonesianVoice) utterance.voice = indonesianVoice;
    browserNarration = true;
    browserUtterance = utterance;
    narrationEnded = false;
    autoplayBlocked = false;
    browserCharacterMs = fastPlayback ? 70 : 85;
    phase = 'playing';
    isPaused = false;
    startButton.hidden = true;
    startButton.disabled = true;
    pauseButton.disabled = false;
    resumeButton.disabled = true;
    speedButton.disabled = false;
    voiceSelect.disabled = true;
    renderText(0);
    setDuck(true);
    setStatus('Suara OpenAI gagal. Melanjutkan dengan suara browser…');
    utterance.onboundary = function(event){
      if(browserUtterance !== utterance || !Number.isFinite(event.charIndex)) return;
      const now = performance.now();
      const position = browserTextPosition(event.charIndex);
      if(browserLastBoundaryTime && now > browserLastBoundaryTime){
        const characterDelta = position-browserLastBoundaryPosition;
        const measuredMs = (now-browserLastBoundaryTime)/Math.max(1,characterDelta);
        if(characterDelta > 0 && measuredMs >= 35 && measuredMs <= 160){
          browserCharacterMs = browserCharacterMs*0.4+measuredMs*0.6;
        }
      }
      browserBoundaryStart = event.charIndex;
      const boundaryLength = Number.isFinite(event.charLength) && event.charLength > 0
        ? event.charLength : 0;
      if(boundaryLength){
        browserBoundaryEnd = Math.min(fullText.length,event.charIndex+boundaryLength);
      }else{
        browserBoundaryEnd = event.charIndex;
        while(browserBoundaryEnd < fullText.length && !/\s/.test(fullText.charAt(browserBoundaryEnd))){
          browserBoundaryEnd++;
        }
      }
      browserBoundaryTime = now;
      browserLastBoundaryPosition = position;
      browserLastBoundaryTime = now;
      renderText(Math.max(typedCharacters,Math.min(totalCharacters,position)));
    };
    utterance.onend = function(){
      if(browserUtterance !== utterance) return;
      narrationEnded = true;
      renderText(totalCharacters);
      finishNarration();
    };
    utterance.onerror = function(event){
      if(browserUtterance !== utterance) return;
      showAudioError(new Error(event.error || 'Suara browser tidak dapat diputar.'));
    };
    try{
      synth.speak(utterance);
      startTypingTimer();
    }catch(speechError){
      showAudioError(speechError);
    }
  }

  function clearNarration(){
    autoplayBlocked = false;
    releaseNarrationAudio();
  }

  async function beginNarration(){
    if(phase !== 'ready') return;
    phase = 'loading';
    startButton.hidden = true;
    startButton.disabled = true;
    voiceSelect.disabled = true;
    setStatus('Menyiapkan narasi suara…');
    pauseButton.disabled = false;
    resumeButton.disabled = true;
    speedButton.disabled = false;
    startTypingTimer();
    setMusicPlaying(true);
    controller = new AbortController();
    try{
      const response = await fetch('/api/intro-tts',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ text:fullText, voice:voiceSelect.value }),
        signal:controller.signal
      });
      if(!response.ok){
        let message = 'Layanan suara tidak tersedia (' + response.status + ').';
        const contentType = response.headers.get('content-type') || '';
        if(contentType.includes('application/json')){
          const details = await response.json();
          if(details && details.error) message = details.error;
        }
        throw new Error(message);
      }
      const contentType = response.headers.get('content-type') || '';
      if(!contentType.toLowerCase().startsWith('audio/')){
        throw new Error('Layanan OpenAI tidak mengirimkan berkas audio.');
      }
      const audioBlob = await response.blob();
      if(!audioBlob.size) throw new Error('Layanan suara mengirimkan audio kosong.');
      narrationUrl = URL.createObjectURL(audioBlob);
      narration = new Audio(narrationUrl);
      narration.preload = 'auto';
      narration.volume = 0.95;
      narrationEnded = false;
      narration.addEventListener('ended',function(){
        narrationEnded = true;
        finishNarration();
      },{once:true});
      const openAiAudio = narration;
      narration.addEventListener('error',function(){
        if(narration === openAiAudio && phase !== 'exited' && phase !== 'done'){
          startBrowserNarration(new Error('Berkas suara tidak dapat dibaca.'));
        }
      });
      syncStartCharacter = 0;
      syncStartTime = 0;
      try{
        await narration.play();
      }catch(error){
        if(error.name === 'AbortError' && (phase === 'exited' || !narration)) return;
        if(error.name !== 'NotAllowedError'){
          startBrowserNarration(error);
          return;
        }
        autoplayBlocked = true;
        phase = 'playing';
        isPaused = true;
        renderText(0);
        startButton.hidden = false;
        startButton.disabled = false;
        startButton.textContent = '🔊 Aktifkan Suara AI';
        setDuck(false);
        setStatus('Pemutaran otomatis diblokir. Tekan Aktifkan Suara AI untuk memutar audio OpenAI.');
        return;
      }
      phase = 'playing';
      autoplayBlocked = false;
      renderText(0);
      setDuck(true);
      pauseButton.disabled = false;
      resumeButton.disabled = true;
      speedButton.disabled = false;
      setStatus('Mendengarkan kenangan…');
      startTypingTimer();
    }catch(error){
      if(error.name === 'AbortError') return;
      startBrowserNarration(error);
    }
  }

  async function activateNarration(){
    if(!autoplayBlocked || !narration) return;
    try{
      narration.currentTime = 0;
      syncStartCharacter = 0;
      syncStartTime = 0;
      await narration.play();
    }catch(error){
      if(error.name !== 'NotAllowedError'){
        startBrowserNarration(error);
        return;
      }
      setStatus('Suara OpenAI tidak dapat diputar: ' + error.message);
      return;
    }
    autoplayBlocked = false;
    startButton.hidden = true;
    isPaused = false;
    renderText(0);
    setDuck(true);
    pauseButton.disabled = false;
    resumeButton.disabled = true;
    setStatus('Mendengarkan kenangan…');
    startTypingTimer();
  }

  function pauseNarration(){
    if(phase !== 'playing' && phase !== 'loading') return;
    isPaused = true;
    if(narration) narration.pause();
    if(browserNarration){
      browserPauseTime = performance.now();
      window.speechSynthesis.pause();
    }
    pauseButton.disabled = true;
    resumeButton.disabled = false;
    setDuck(false);
    setStatus('Narasi dijeda. Tekan Lanjutkan untuk meneruskan.');
  }

  async function resumeNarration(){
    if((phase !== 'playing' && phase !== 'loading') || !isPaused) return;
    if(narration){
      try{
        await narration.play();
      }catch(error){
        if(error.name !== 'NotAllowedError'){
          startBrowserNarration(error);
          return;
        }
        setStatus('Audio tidak dapat dilanjutkan: ' + error.message);
        return;
      }
    }
    if(browserNarration){
      if(browserPauseTime) browserBoundaryTime += performance.now()-browserPauseTime;
      browserPauseTime = 0;
      window.speechSynthesis.resume();
    }
    isPaused = false;
    pauseButton.disabled = false;
    resumeButton.disabled = true;
    setDuck(!!narration || browserNarration);
    setStatus(browserNarration ? 'Mendengarkan kenangan dengan suara browser…' :
      narration ? 'Mendengarkan kenangan…' : 'Narasi teks sedang diputar tanpa suara.');
  }

  function setPlaybackSpeed(){
    fastPlayback = !fastPlayback;
    typingFast = fastPlayback;
    if(narration) narration.playbackRate = fastPlayback ? 1.2 : 1;
    if(browserUtterance){
      browserUtterance.rate = fastPlayback ? 1.2 : 1;
      browserCharacterMs = fastPlayback ? 70 : 85;
    }
    speedButton.textContent = fastPlayback ? '⏩ Kecepatan normal' : '⏩ Percepat';
    setStatus(fastPlayback ? 'Narasi dipercepat 1,2×.' : 'Kecepatan narasi kembali normal.');
  }

  function removeMusicRetry(){
    if(!musicRetryHandler) return;
    document.removeEventListener('pointerdown',musicRetryHandler);
    document.removeEventListener('keydown',musicRetryHandler);
    musicRetryHandler = null;
  }

  function installMusicRetry(){
    if(musicRetryHandler) return;
    musicRetryHandler = function(event){
      if(event.target === musicButton) return;
      if(musicRequested) setMusicPlaying(true);
    };
    document.addEventListener('pointerdown',musicRetryHandler);
    document.addEventListener('keydown',musicRetryHandler);
  }

  async function setMusicPlaying(shouldPlay){
    if(!shouldPlay){
      musicRequested = false;
      musicAttempt++;
      musicPlayPromise = null;
      removeMusicRetry();
      musicPlaying = false;
      music.pause();
      musicButton.textContent = '♫ Putar Musik';
      musicButton.setAttribute('aria-pressed','false');
      return;
    }
    musicRequested = true;
    if(musicPlaying && !music.paused) return;
    if(musicPlayPromise) return musicPlayPromise;

    const attempt = ++musicAttempt;
    const playAttempt = (async function(){
      updateMusicVolume();
      try{
        await music.play();
      }catch(error){
        if(attempt !== musicAttempt || !musicRequested) return;
        if(error.name === 'NotAllowedError'){
          setStatus('Browser menunggu interaksi untuk memutar musik. Musik akan aktif setelah interaksi pertama.');
          installMusicRetry();
        }else{
          console.error('Musik intro gagal diputar:',error);
          setStatus('Musik gagal diputar. Periksa berkas musik dan koneksi hosting.');
        }
        return;
      }
      if(!musicRequested){
        music.pause();
        return;
      }
      musicPlaying = true;
      removeMusicRetry();
      musicButton.textContent = '♫ Jeda Musik';
      musicButton.setAttribute('aria-pressed','true');
    })();
    musicPlayPromise = playAttempt;
    try{
      await playAttempt;
    }finally{
      if(musicPlayPromise === playAttempt) musicPlayPromise = null;
    }
  }

  function updateMusicVolume(){
    const browserSpeaking = browserNarration && window.speechSynthesis && !window.speechSynthesis.paused;
    setDuck(!!((narration && !narration.paused || browserSpeaking) && !isPaused));
  }

  function exitIntro(){
    if(phase === 'exited') return;
    phase = 'exited';
    if(controller) controller.abort();
    window.clearInterval(timer);
    window.clearInterval(clockTimer);
    clearNarration();
    setMusicPlaying(false);
    window.cancelAnimationFrame(particlesFrame);
    screen.classList.add('is-exiting');
    window.setTimeout(function(){
      screen.remove();
      document.body.classList.remove('intro-lock');
      pageChildren.forEach(function(child){ child.inert = false; });
      window.scrollTo(0,0);
    },reducedMotion ? 0 : 880);
  }

  function replay(){
    if(controller) controller.abort();
    window.clearInterval(timer);
    clearNarration();
    lines.forEach(function(line){ line.element.classList.remove('is-speaking'); });
    lines.forEach(function(line){
      line.sentences.forEach(function(sentence){
        sentence.output.classList.remove('is-active');
        sentence.output.textContent = '';
        line.element.appendChild(sentence.output);
      });
    });
    renderText(0);
    phase = 'ready';
    isPaused = false;
    fastPlayback = false;
    startButton.hidden = true;
    startButton.disabled = true;
    pauseButton.disabled = true;
    resumeButton.disabled = true;
    speedButton.disabled = true;
    speedButton.textContent = '⏩ Percepat';
    voiceSelect.disabled = false;
    enterButton.hidden = true;
    replayButton.hidden = true;
    setDuck(false);
    setStatus('Menyiapkan ulang narasi…');
    beginNarration();
  }

  startButton.addEventListener('click',function(){
    if(autoplayBlocked) activateNarration();
    else beginNarration();
  });
  pauseButton.addEventListener('click',pauseNarration);
  resumeButton.addEventListener('click',resumeNarration);
  speedButton.addEventListener('click',setPlaybackSpeed);
  enterButton.addEventListener('click',exitIntro);
  skipButton.addEventListener('click',exitIntro);
  replayButton.addEventListener('click',replay);
  musicButton.addEventListener('click',function(){ setMusicPlaying(!musicPlaying); });
  volumeSlider.addEventListener('input',updateMusicVolume);
  menuToggle.addEventListener('click',function(){
    const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded',String(!isOpen));
    menuToggle.setAttribute('aria-label',isOpen ? 'Buka pengaturan intro' : 'Tutup pengaturan intro');
    menu.hidden = isOpen;
  });
  document.addEventListener('click',function(event){
    if(!menu.hidden && !menu.contains(event.target) && !menuToggle.contains(event.target)){
      menu.hidden = true;
      menuToggle.setAttribute('aria-expanded','false');
      menuToggle.setAttribute('aria-label','Buka pengaturan intro');
    }
  });
  document.addEventListener('keydown',function(event){
    if(event.key === 'Escape' && !menu.hidden){
      menu.hidden = true;
      menuToggle.setAttribute('aria-expanded','false');
      menuToggle.setAttribute('aria-label','Buka pengaturan intro');
      menuToggle.focus();
    }
  });
  document.body.classList.add('intro-lock');
  const pageChildren = Array.from(document.body.children).filter(function(child){ return child !== screen; });
  pageChildren.forEach(function(child){ child.inert = true; });

  const canvas = document.getElementById('introParticles');
  const drawing = canvas.getContext('2d');
  function resizeParticles(){
    const ratio = Math.min(window.devicePixelRatio || 1,1.5);
    canvas.width = Math.round(window.innerWidth*ratio);
    canvas.height = Math.round(window.innerHeight*ratio);
    canvas.style.width = window.innerWidth+'px';
    canvas.style.height = window.innerHeight+'px';
    drawing.setTransform(ratio,0,0,ratio,0,0);
    const count = window.innerWidth < 700 ? 22 : 42;
    particles = Array.from({length:count},function(){
      return {
        x:Math.random()*window.innerWidth,
        y:Math.random()*window.innerHeight,
        radius:Math.random()*1.45+.35,
        speed:Math.random()*.26+.07,
        phase:Math.random()*Math.PI*2,
        drift:(Math.random()-.5)*.22
      };
    });
  }
  function drawParticles(){
    if(phase === 'exited' || document.hidden) return;
    const width=window.innerWidth,height=window.innerHeight;
    drawing.clearRect(0,0,width,height);
    particles.forEach(function(point){
      point.y-=point.speed;
      point.x+=point.drift;
      point.phase+=.018;
      if(point.y < -4){point.y=height+4;point.x=Math.random()*width;}
      if(point.x < -4) point.x=width+4;
      if(point.x > width+4) point.x=-4;
      const alpha=.2+(Math.sin(point.phase)+1)*.27;
      drawing.beginPath();
      drawing.arc(point.x,point.y,point.radius,0,Math.PI*2);
      drawing.fillStyle='rgba(248,224,168,'+alpha+')';
      drawing.fill();
    });
    particlesFrame=window.requestAnimationFrame(drawParticles);
  }
  resizeParticles();
  if(!reducedMotion) drawParticles();
  window.addEventListener('resize',resizeParticles,{passive:true});
  document.addEventListener('visibilitychange',function(){
    if(document.hidden) window.cancelAnimationFrame(particlesFrame);
    else if(!reducedMotion && phase !== 'exited') drawParticles();
  });
  if(!reducedMotion){
    window.addEventListener('pointermove',function(event){
      const x=(event.clientX/window.innerWidth-.5)*-9;
      const y=(event.clientY/window.innerHeight-.5)*-7;
      backdrop.style.backgroundPosition='calc(50% + '+x+'px) calc(50% + '+y+'px)';
    },{passive:true});
  }
  renderText(totalCharacters);
  beginNarration();
})();
