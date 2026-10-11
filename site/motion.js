// GSAP 3.13 + ScrollTrigger; native scrolling, no loading gate or autoplay audio.
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const motionButton = document.querySelector(".motion-toggle");
let motionPaused = false;
let motionContext;
let introPlayed = false;

function configureMotion() {
  motionContext?.revert();
  document.querySelector(".entrance").style.display = "none";
  const enabled = !reduceMotion.matches && !motionPaused;
  motionButton.textContent = enabled ? "Pause motion" : "Motion off";
  motionButton.setAttribute("aria-pressed", String(!enabled));
  document.documentElement.dataset.motion = enabled ? "on" : "off";
  document.dispatchEvent(
    new CustomEvent("speakh-motion", { detail: { enabled } }),
  );
  if (!enabled || !window.gsap || !window.ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);
  motionContext = gsap.context(() => {
    const entry = gsap.timeline();
    // A short opening gesture, not a fake progress loader. Deep links skip it.
    if (!introPlayed && !location.hash) {
      entry
        .set(".entrance", { display: "grid" })
        .from(".entrance-brand img", {
          scale: 0.35,
          rotation: -30,
          opacity: 0,
          duration: 0.55,
          ease: "back.out(1.5)",
        })
        .from(
          ".entrance-brand span, .entrance-brand strong",
          { y: 30, opacity: 0, stagger: 0.12, duration: 0.45 },
          0.2,
        )
        .from(".entrance-line", { scaleX: 0, duration: 0.65 }, 0.35)
        .to(
          ".entrance",
          {
            clipPath: "inset(0 0 100% 0)",
            duration: 0.7,
            ease: "power3.inOut",
          },
          1.1,
        )
        .set(".entrance", { display: "none" });
    }
    const offset = !introPlayed && !location.hash ? 1.25 : 0;
    introPlayed = true;
    if (!location.hash) {
      entry
        .from(
          ".headline-line",
          {
            y: 65,
            rotationX: -35,
            opacity: 0,
            duration: 0.9,
            stagger: 0.14,
            ease: "power3.out",
          },
          offset,
        )
        .from(
          ".hero-copy .eyebrow, .hero-lead, .hero-description, .hero-actions, .hero-note",
          { y: 20, opacity: 0, stagger: 0.09, duration: 0.6 },
          offset + 0.2,
        )
        .from(
          ".hero-product",
          {
            x: 70,
            rotationY: -18,
            rotationZ: 5,
            opacity: 0,
            duration: 1.1,
            ease: "power3.out",
          },
          offset + 0.1,
        );
    }
    const orbit = gsap.to(".signal-orbit", {
      rotation: 360,
      duration: 55,
      repeat: -1,
      ease: "none",
      paused: true,
    });
    const waves = gsap.to(".wave i", {
      scaleY: 0.3,
      duration: 0.55,
      stagger: { each: 0.08, repeat: -1, yoyo: true },
      ease: "sine.inOut",
      paused: true,
    });
    const heroObserver = new IntersectionObserver(([item]) => {
      const play = item.isIntersecting && !document.hidden;
      orbit.paused(!play);
      waves.paused(!play);
    });
    heroObserver.observe(document.querySelector(".hero"));
    const visibility = () => {
      const visible =
        !document.hidden &&
        document.querySelector(".hero").getBoundingClientRect().bottom > 0;
      orbit.paused(!visible);
      waves.paused(!visible);
    };
    document.addEventListener("visibilitychange", visibility);
    for (const selector of [
      ".feature-card",
      ".download-card",
      ".section-heading",
      ".language-copy",
      ".settings-preview",
      ".proof-strip",
    ]) {
      gsap.utils.toArray(selector).forEach((node) =>
        gsap.from(node, {
          y: 38,
          opacity: 0,
          duration: 0.8,
          ease: "power2.out",
          scrollTrigger: { trigger: node, start: "top 92%", once: true },
        }),
      );
    }
    gsap.from(".bar", {
      scaleX: 0,
      transformOrigin: "left",
      duration: 1.15,
      stagger: 0.16,
      ease: "power3.out",
      scrollTrigger: { trigger: ".chart", start: "top 85%", once: true },
    });
    const targets = [
      ...document.querySelectorAll(".feature-card, .product-window"),
    ];
    const handlers = [];
    if (matchMedia("(hover: hover) and (pointer: fine)").matches) {
      targets.forEach((node) => {
        const move = (event) => {
          const rect = node.getBoundingClientRect();
          const x = (event.clientX - rect.left) / rect.width;
          const y = (event.clientY - rect.top) / rect.height;
          node.style.setProperty("--mx", `${x * 100}%`);
          node.style.setProperty("--my", `${y * 100}%`);
          gsap.to(node, {
            rotationY: (x - 0.5) * 7,
            rotationX: (0.5 - y) * 7,
            transformPerspective: 1000,
            duration: 0.4,
            overwrite: "auto",
          });
        };
        const leave = () =>
          gsap.to(node, {
            rotationX: 0,
            rotationY: 0,
            duration: 0.6,
            overwrite: "auto",
          });
        node.addEventListener("pointermove", move);
        node.addEventListener("pointerleave", leave);
        handlers.push(() => {
          node.removeEventListener("pointermove", move);
          node.removeEventListener("pointerleave", leave);
          gsap.killTweensOf(node);
          gsap.set(node, { clearProps: "transform" });
        });
      });
    }
    return () => {
      heroObserver.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      handlers.forEach((fn) => fn());
    };
  });
}
if (window.gsap && window.ScrollTrigger) {
  motionButton.hidden = false;
  motionButton.addEventListener("click", () => {
    motionPaused = !motionPaused;
    configureMotion();
  });
  reduceMotion.addEventListener("change", configureMotion);
  configureMotion();
  window.addEventListener("load", () => ScrollTrigger.refresh(), {
    once: true,
  });
}
