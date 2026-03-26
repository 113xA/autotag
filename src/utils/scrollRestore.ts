/**
 * Optional main scroll container (`.app-body`). When set, scroll read/write use it
 * instead of the window so WebView/document focus cannot fight the review list.
 */
let appScrollContainer: HTMLElement | null = null;

export function bindAppScrollContainer(el: HTMLElement | null): void {
  appScrollContainer = el;
}

function readScrollTop(): number {
  if (appScrollContainer) {
    return appScrollContainer.scrollTop;
  }
  return (
    window.scrollY ||
    window.pageYOffset ||
    document.documentElement.scrollTop ||
    document.body.scrollTop ||
    0
  );
}

/** Read vertical scroll position for the active scrollport. */
export function readDocumentScrollY(): number {
  return readScrollTop();
}

/** Single scroll write — skip if already aligned (avoids repaint flicker). */
export function writeDocumentScrollY(y: number): void {
  if (appScrollContainer) {
    const cur = appScrollContainer.scrollTop;
    if (Math.abs(cur - y) < 0.5) return;
    appScrollContainer.scrollTop = y;
    return;
  }
  const cur = readScrollTop();
  if (Math.abs(cur - y) < 0.5) return;
  window.scrollTo({ top: y, left: 0, behavior: "auto" });
}

/**
 * Move keyboard focus back into the review card when focus falls on body/header.
 */
export function refocusReviewAnchor(anchor: HTMLElement | null): void {
  if (!anchor) return;
  const ae = document.activeElement;
  if (ae && anchor.contains(ae)) return;
  if (
    ae instanceof HTMLInputElement ||
    ae instanceof HTMLTextAreaElement ||
    ae instanceof HTMLSelectElement
  ) {
    return;
  }
  if (ae?.closest(".options-modal")) return;
  if (ae?.closest(".options-backdrop")) return;
  if (ae?.closest(".loading-overlay")) return;
  anchor.focus({ preventScroll: true });
}

/**
 * After Accept/Skip: refocus once, then correct scroll only if it drifted (WebView).
 */
export function scheduleScrollAndReviewFocusRestore(
  y: number,
  getAnchor: () => HTMLElement | null,
): void {
  requestAnimationFrame(() => {
    refocusReviewAnchor(getAnchor());
    const cur = readScrollTop();
    if (Math.abs(cur - y) > 2) {
      writeDocumentScrollY(y);
    }
  });
}
