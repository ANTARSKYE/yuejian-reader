export function initializeAccessibility(analysisConfirmModal) {
  document.querySelectorAll("button").forEach((button) => {
    if (!button.hasAttribute("type")) button.type = "button";
  });
  const labels = {
    catalogQuery: "搜索在线书库",
    customSourceName: "电子书网站名称",
    customSourceUrl: "电子书网站地址",
    bulkQuoteText: "批量导入名言",
  };
  Object.entries(labels).forEach(([id, label]) =>
    document.getElementById(id)?.setAttribute("aria-label", label),
  );

  let lastTrigger = null;
  document.addEventListener(
    "click",
    (event) => {
      if (event.target.closest("button,a,label")) lastTrigger = event.target;
    },
    true,
  );

  document.querySelectorAll('[role="dialog"]').forEach((dialog, index) => {
    const heading = dialog.querySelector("h2");
    if (heading && !heading.id) heading.id = `dialogTitle${index}`;
    if (heading && !dialog.getAttribute("aria-labelledby"))
      dialog.setAttribute("aria-labelledby", heading.id);
    dialog.setAttribute("aria-hidden", dialog.classList.contains("open") ? "false" : "true");
    new MutationObserver(() => {
      const open = dialog.classList.contains("open");
      dialog.setAttribute("aria-hidden", open ? "false" : "true");
      if (open && !dialog.contains(document.activeElement)) {
        dialog
          .querySelector('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href]')
          ?.focus();
      } else if (!open && lastTrigger instanceof HTMLElement) {
        lastTrigger.focus();
      }
    }).observe(dialog, { attributes: true, attributeFilter: ["class"] });
  });

  document.addEventListener("keydown", (event) => {
    const dialogs = [...document.querySelectorAll('[role="dialog"].open')];
    const dialog = dialogs.at(-1);
    if (!dialog) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (dialog === analysisConfirmModal)
        document.getElementById("cancelAnalysisConfirm").click();
      else dialog.classList.remove("open");
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]):not([hidden]),input:not([disabled]):not([hidden]),select:not([disabled]),textarea:not([disabled]),a[href]')].filter(
      (element) => element.offsetParent !== null,
    );
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
}
