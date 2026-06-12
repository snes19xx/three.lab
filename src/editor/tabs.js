// Sidebar tab switching. Each .tab toggles the matching #tab-<name> panel.
export function initTabs() {
  const tabs = [...document.querySelectorAll(".tabbar .tab")];
  const panels = [...document.querySelectorAll(".tab-panel")];

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const name = tab.dataset.tab;
      tabs.forEach((t) => t.classList.toggle("active", t === tab));
      panels.forEach((p) => p.classList.toggle("active", p.id === "tab-" + name));
    });
  });
}
