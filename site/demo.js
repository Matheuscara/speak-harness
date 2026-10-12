// The terminal is illustrative. These clips were synthesized by the real local engine.
// No API call, microphone access, model inference or audio autoplay happens on this page.
(() => {
  const root = document.querySelector("#tour");
  const audio = root.querySelector("#demo-audio");
  const play = root.querySelector("#demo-play");
  const replay = root.querySelector("#demo-replay");
  const position = root.querySelector("#demo-position");
  const time = root.querySelector("#demo-time");
  const status = root.querySelector("#demo-audio-status");
  const speed = root.querySelector("#demo-speed");
  const langButtons = [...root.querySelectorAll("[data-demo-lang]")];
  const flowButton = root.querySelector(".demo-replay-flow");
  const stages = [...root.querySelectorAll("[data-demo-stage]")];
  const wave = root.querySelector("#demo-wave");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  // Sample paths are relative to the site root, where this script lives, so /pt/ shares them.
  const siteRoot = new URL(".", document.currentScript.src);
  const text = document.documentElement.lang.startsWith("pt")
    ? {
        hear: "Ouça a voz real",
        playLabel: (label) => `Tocar a amostra ${label}`,
        ready: "Áudio real gerado previamente. Aperte o play para ouvir.",
        loading: "Carregando a amostra de voz…",
        playFailed:
          "Não foi possível tocar esta amostra. Aperte o play de novo ou abra o arquivo de áudio abaixo.",
        pause: "Pausar a voz",
        pauseLabel: "Pausar a amostra de voz",
        playing: (label) => `Tocando ${label}.`,
        resume: "Continuar a voz",
        resumeLabel: "Continuar a amostra de voz",
        paused: "Pausado. Continue quando quiser.",
        again: "Ouvir de novo",
        againLabel: "Tocar a amostra de novo",
        ended:
          "Essa foi a voz real. Experimente o outro idioma ou baixe o app.",
        buffering: "Carregando a amostra de voz…",
        loadFailed:
          "Não foi possível carregar o áudio. Use os links diretos das amostras abaixo ou tente de novo.",
        unavailable:
          "Use o player de áudio acima ou os links diretos das amostras abaixo. A prévia interativa não está disponível.",
        of: (current, total) => `${current} de ${total}`,
      }
    : {
        hear: "Hear the real voice",
        playLabel: (label) => `Play ${label} sample`,
        ready: "Real pre-generated audio. Press Play to listen.",
        loading: "Loading the voice sample…",
        playFailed:
          "Could not play this sample. Try Play again or open the audio file below.",
        pause: "Pause voice",
        pauseLabel: "Pause voice sample",
        playing: (label) => `Playing ${label}.`,
        resume: "Resume voice",
        resumeLabel: "Resume voice sample",
        paused: "Paused. Continue whenever you are ready.",
        again: "Listen again",
        againLabel: "Replay voice sample",
        ended:
          "That was the real voice. Try the other language, or get the app.",
        buffering: "Buffering the voice sample…",
        loadFailed:
          "Audio could not load. Use the direct sample links below, or try again.",
        unavailable:
          "Use the audio player above or the direct sample links below. The interactive preview is unavailable.",
        of: (current, total) => `${current} of ${total}`,
      };
  let clips;
  let sample;
  let flow;
  let frame;
  let version = 0;
  let started = false;
  const motionAllowed = () =>
    !reduced.matches && document.documentElement.dataset.motion !== "off";
  const clock = (value) =>
    `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}`;
  function setPlay(label, icon, ariaLabel) {
    play.innerHTML = `${label} <span aria-hidden="true">${icon}</span>`;
    play.setAttribute("aria-label", ariaLabel);
  }
  function stage(index) {
    stages.forEach((node, i) =>
      i === index
        ? node.setAttribute("aria-current", "step")
        : node.removeAttribute("aria-current"),
    );
  }
  function ready() {
    flow?.kill();
    if (window.gsap) {
      gsap.set(".agent-reply, #demo-transcript, .demo-waveform", {
        clearProps: "opacity,transform,clipPath",
      });
      gsap.set(".connector-signal", { clearProps: "strokeDashoffset" });
      gsap.set(".transfer-packet", { opacity: 0 });
    }
    stage(2);
  }
  function handoff() {
    started = true;
    ready();
    stage(0);
    if (!window.gsap || !motionAllowed()) {
      stage(2);
      return;
    }
    flow = gsap.timeline({ onComplete: () => stage(2) });
    flow
      .fromTo(
        ".agent-reply",
        { clipPath: "inset(0 0 100% 0)", opacity: 0.2 },
        {
          clipPath: "inset(0 0 0% 0)",
          opacity: 1,
          duration: 1.15,
          ease: "power2.out",
        },
      )
      .fromTo(
        ".connector-signal",
        { strokeDashoffset: 106 },
        { strokeDashoffset: 0, duration: 0.65, onStart: () => stage(1) },
        0.95,
      )
      .fromTo(
        ".transfer-packet",
        { left: "0%", opacity: 0 },
        { left: "75%", opacity: 1, duration: 0.8, ease: "power1.inOut" },
        1,
      )
      .to(".transfer-packet", { opacity: 0, duration: 0.2 }, 1.8)
      .fromTo(
        "#demo-transcript",
        { opacity: 0.16, y: 14 },
        { opacity: 1, y: 0, duration: 0.65, clearProps: "opacity,transform" },
        1.6,
      )
      .fromTo(
        ".demo-waveform",
        { opacity: 0.15, scaleY: 0.15 },
        {
          opacity: 1,
          scaleY: 1,
          duration: 0.65,
          ease: "back.out(1.2)",
          clearProps: "opacity,transform",
        },
        1.8,
      );
  }
  function drawWave() {
    const ns = "http://www.w3.org/2000/svg";
    wave.replaceChildren();
    for (const className of ["wave-base", "wave-played"]) {
      const group = document.createElementNS(ns, "g");
      group.setAttribute("class", className);
      sample.peaks.forEach((peak, index) => {
        const rect = document.createElementNS(ns, "rect");
        const height = Math.max(3, peak * 54);
        for (const [key, value] of Object.entries({
          x: index * 6,
          y: (60 - height) / 2,
          width: 3.5,
          height,
          rx: 1.5,
        }))
          rect.setAttribute(key, String(value));
        group.append(rect);
      });
      wave.append(group);
    }
  }
  function progress() {
    const duration =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : sample.duration;
    const ratio = Math.min(1, Math.max(0, audio.currentTime / duration));
    position.value = String(ratio * 100);
    position.setAttribute(
      "aria-valuetext",
      text.of(clock(audio.currentTime), clock(duration)),
    );
    time.textContent = `${clock(audio.currentTime)} / ${clock(duration)}`;
    wave.style.setProperty("--wave-remaining", `${(1 - ratio) * 100}%`);
  }
  function stopFrames() {
    if (frame) cancelAnimationFrame(frame);
    frame = undefined;
  }
  function tick() {
    progress();
    if (!audio.paused && !audio.ended && motionAllowed())
      frame = requestAnimationFrame(tick);
  }
  function select(id) {
    version++;
    audio.pause();
    stopFrames();
    sample = clips.find((clip) => clip.id === id);
    audio.src = new URL(sample.src, siteRoot).href;
    audio.setAttribute("aria-label", sample.label);
    audio.playbackRate = Number(speed.value);
    root.querySelector("#demo-prompt").textContent = sample.prompt;
    root.querySelector("#demo-heading").textContent = sample.heading;
    root.querySelector("#demo-raw").textContent = sample.sentences
      .join("\n\n")
      .replace(
        id === "en" ? "server" : "servidor",
        id === "en" ? "**server**" : "**servidor**",
      );
    root.querySelector("#demo-transcript").textContent = sample.text;
    root.querySelector("#demo-transcript").lang = sample.lang;
    root.querySelector(".agent-terminal").lang = sample.lang;
    root.querySelector("#demo-voice").textContent = sample.label;
    langButtons.forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.demoLang === id),
      ),
    );
    setPlay(text.hear, "▶", text.playLabel(sample.label));
    status.textContent = text.ready;
    drawWave();
    progress();
    if (started) handoff();
  }
  async function listen(restart = false) {
    ready();
    const requestVersion = version;
    if (restart || audio.ended) audio.currentTime = 0;
    if (!restart && !audio.paused) {
      audio.pause();
      return;
    }
    status.textContent = text.loading;
    try {
      await audio.play();
    } catch (error) {
      if (requestVersion !== version || error.name === "AbortError") return;
      status.textContent = text.playFailed;
    }
  }
  async function init() {
    const response = await fetch(new URL("audio/samples.json", siteRoot));
    if (!response.ok) throw new Error("Sample metadata unavailable");
    clips = await response.json();
    const initial = langButtons.find(
      (button) => button.getAttribute("aria-pressed") === "true",
    );
    select(initial?.dataset.demoLang ?? "en");
    root.classList.add("demo-ready");
    root.querySelector(".demo-player").hidden = false;
    langButtons.forEach((button) => {
      button.disabled = false;
      button.addEventListener("click", () => select(button.dataset.demoLang));
    });
    flowButton.disabled = false;
    flowButton.addEventListener("click", () => {
      audio.pause();
      handoff();
    });
    play.addEventListener("click", () => void listen());
    replay.addEventListener("click", () => void listen(true));
    speed.addEventListener("change", () => {
      audio.playbackRate = Number(speed.value);
    });
    position.addEventListener("input", () => {
      if (Number.isFinite(audio.duration)) {
        audio.currentTime = (Number(position.value) / 100) * audio.duration;
        progress();
      }
    });
    audio.addEventListener("playing", () => {
      setPlay(text.pause, "Ⅱ", text.pauseLabel);
      status.textContent = text.playing(sample.label);
      stopFrames();
      tick();
    });
    audio.addEventListener("pause", () => {
      stopFrames();
      setPlay(text.resume, "▶", text.resumeLabel);
      status.textContent = text.paused;
    });
    audio.addEventListener("ended", () => {
      stopFrames();
      progress();
      setPlay(text.again, "↺", text.againLabel);
      status.textContent = text.ended;
    });
    audio.addEventListener("timeupdate", progress);
    audio.addEventListener("loadedmetadata", progress);
    audio.addEventListener("waiting", () => {
      if (!audio.paused) status.textContent = text.buffering;
    });
    audio.addEventListener("error", () => {
      stopFrames();
      status.textContent = text.loadFailed;
    });
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !started) {
          handoff();
        }
        if (!entry.isIntersecting && !audio.paused) audio.pause();
      },
      { threshold: 0 },
    );
    observer.observe(root);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) audio.pause();
    });
    document.addEventListener("speakh-motion", (event) => {
      if (!event.detail.enabled) {
        ready();
        stopFrames();
      } else if (!audio.paused) {
        stopFrames();
        tick();
      }
    });
    reduced.addEventListener("change", () => {
      if (reduced.matches) {
        ready();
        stopFrames();
      }
    });
  }
  init().catch(() => {
    status.textContent = text.unavailable;
  });
})();
