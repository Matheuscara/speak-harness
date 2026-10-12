// Plays the film muted when visible; sound is opt-in. Reduced motion: never autoplays.
(() => {
  const video = document.querySelector(".film-video");
  const sound = document.querySelector(".film-sound");
  if (!video) return;
  const reduce = matchMedia("(prefers-reduced-motion: reduce)");
  video.removeAttribute("controls");
  sound.hidden = false;
  sound.addEventListener("click", () => {
    video.muted = !video.muted;
    sound.setAttribute("aria-pressed", String(!video.muted));
    sound.textContent = video.muted ? "Sound on" : "Sound off";
    if (!video.muted) video.play().catch(() => {});
  });
  new IntersectionObserver(
    ([entry]) => {
      if (entry.isIntersecting && (!reduce.matches || !video.muted))
        video.play().catch(() => {});
      else if (!entry.isIntersecting) video.pause();
    },
    { threshold: 0.35 },
  ).observe(video);
  if (reduce.matches) video.setAttribute("controls", "");
})();
