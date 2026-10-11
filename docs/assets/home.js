// Static, precomputed playback. No tools or agents run in the visitor's browser.
(async () => {
  const demo = document.querySelector('#terminal-demo');
  if (!demo) return;
  let data;
  try {
    const response = await fetch(document.body.dataset.demoUrl);
    if (!response.ok) return;
    data = await response.json();
  } catch { return; } // The server-rendered example and walkthrough remain usable.

  const command = document.querySelector('#demo-command');
  const output = document.querySelector('#demo-output');
  const screen = document.querySelector('.terminal-screen');
  const play = document.querySelector('#demo-play');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let language = 0;
  let stage = 0;
  let playing = !motion.matches;
  let visible = true;
  let elapsed = 0;
  let last = 0;
  let timer = null;
  let rendered = -1;
  const durations = [8500, 6500, 6500, 6500, 9500, 8000];

  function currentFrame() { return data.variants[language].frames[stage]; }

  function draw(complete = false) {
    const frame = currentFrame();
    // The first frame types code; the remaining frames type the shell command,
    // then reveal captured output. Explicit step selection reveals everything.
    const typingDuration = stage === 0 ? 4000 : Math.min(2000, frame.command.length * 18);
    const fraction = complete ? 1 : Math.min(1, elapsed / typingDuration);
    const text = stage === 0 ? frame.text : frame.command;
    const length = Math.floor(text.length * fraction);
    if (length === rendered) return;
    rendered = length;
    command.textContent = stage === 0 ? frame.command : frame.command.slice(0, length);
    output.textContent = stage === 0 ? frame.text.slice(0, length) : fraction === 1 ? frame.text : '';
    if (stage === 0 && fraction < 1) screen.scrollTop = screen.scrollHeight;
  }

  function controls() {
    play.textContent = playing ? 'Pause' : 'Play';
    play.setAttribute('aria-label', playing ? 'Pause playback' : 'Play playback');
    demo.classList.toggle('is-playing', playing && visible && !document.hidden);
  }

  function select(nextLanguage, nextStage, complete = false) {
    language = nextLanguage;
    stage = nextStage;
    elapsed = 0;
    rendered = -1;
    const variant = data.variants[language];
    const frame = currentFrame();
    screen.dataset.kind = frame.kind;
    document.querySelector('#terminal-path').textContent = `~/ops / ${language === 3 ? 'src/main.rs' : 'scripts/' + variant.file}`;
    document.querySelector('#demo-stage').textContent = frame.title;
    document.querySelector('#demo-counter').textContent = `${String(stage + 1).padStart(2, '0')} / 06`;
    document.querySelector('#demo-caption').textContent = frame.caption;
    for (const button of demo.querySelectorAll('[data-language]')) button.setAttribute('aria-pressed', String(Number(button.dataset.language) === language));
    for (const button of demo.querySelectorAll('[data-stage]')) button.setAttribute('aria-pressed', String(Number(button.dataset.stage) === stage));
    document.querySelector('#install-language').textContent = `${variant.name.toUpperCase()} / INSTALL`;
    document.querySelector('#install-command').textContent = variant.install;
    const guide = document.querySelector('#install-guide');
    guide.href = guide.dataset.base + (variant.id === 'typescript' ? 'javascript' : variant.id) + '.html';
    guide.textContent = `Read the ${variant.name} guide →`;
    document.querySelector('#copy-status').textContent = '';
    draw(complete);
    if (complete) elapsed = stage === 0 ? 4000 : 2000;
    screen.scrollTop = 0;
    controls();
  }

  function stopTimer() {
    clearTimeout(timer);
    timer = null;
    last = 0;
    controls();
  }

  function tick() {
    timer = null;
    if (!playing || !visible || document.hidden) { last = 0; controls(); return; }
    const now = performance.now();
    if (last) elapsed += Math.min(now - last, 250);
    last = now;
    if (elapsed >= durations[stage]) {
      const nextStage = (stage + 1) % 6;
      select(nextStage === 0 ? (language + 1) % data.variants.length : language, nextStage);
    }
    draw();
    timer = setTimeout(tick, 40);
  }

  function schedule() {
    stopTimer();
    if (playing && visible && !document.hidden) timer = setTimeout(tick, 40);
  }

  play.addEventListener('click', () => {
    playing = !playing;
    if (!playing) {
      rendered = -1;
      draw(true);
      elapsed = Math.max(elapsed, stage === 0 ? 4000 : 2000);
    }
    schedule();
  });
  demo.querySelectorAll('[data-language]').forEach(button => button.addEventListener('click', () => {
    // Manual selection pauses on the complete example for reading/copying.
    playing = false;
    select(Number(button.dataset.language), 0, true);
    schedule();
  }));
  demo.querySelectorAll('[data-stage]').forEach(button => button.addEventListener('click', () => {
    playing = false;
    select(language, Number(button.dataset.stage), true);
    schedule();
  }));
  document.querySelector('#demo-replay').addEventListener('click', () => {
    playing = true;
    select(language, 0);
    schedule();
  });
  motion.addEventListener('change', () => {
    if (motion.matches) { playing = false; rendered = -1; draw(true); schedule(); }
  });
  document.addEventListener('visibilitychange', schedule);
  if ('IntersectionObserver' in window) new IntersectionObserver(entries => {
    visible = entries[0].isIntersecting;
    schedule();
  }, { threshold: 0.1 }).observe(demo);

  const copy = document.querySelector('#copy-install');
  if (navigator.clipboard?.writeText) {
    copy.hidden = false;
    copy.addEventListener('click', async () => {
      const status = document.querySelector('#copy-status');
      try {
        await navigator.clipboard.writeText(data.variants[language].install);
        status.textContent = 'Copied to clipboard.';
      } catch { status.textContent = 'Select the command text to copy it.'; }
    });
  }
  document.querySelector('.demo-controls').hidden = false;
  document.querySelector('.language-picker').hidden = false;
  select(0, 0, !playing);
  schedule();
})();
