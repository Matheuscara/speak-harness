// Links, downloads, navigation and disclosure panels work without JavaScript.
const preview = document.querySelector("#preview");
const previewImage = document.querySelector("#preview-image");
const previewTitle = document.querySelector("#preview-title");

if (preview && typeof preview.showModal === "function") {
  for (const link of document.querySelectorAll("[data-preview]")) {
    link.addEventListener("click", (event) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      previewImage.src = link.href;
      previewImage.alt = link.querySelector("img").alt;
      previewTitle.textContent = link.dataset.preview;
      preview.showModal();
    });
  }
  preview
    .querySelector(".preview-close")
    .addEventListener("click", () => preview.close());
  preview.addEventListener("click", (event) => {
    const box = preview.getBoundingClientRect();
    if (
      event.target === preview &&
      (event.clientX < box.left ||
        event.clientX > box.right ||
        event.clientY < box.top ||
        event.clientY > box.bottom)
    )
      preview.close();
  });
}
