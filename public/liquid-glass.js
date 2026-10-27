// Presentation only. Native clicks, scrolling, form values and print actions
// remain owned by each tool. No network requests or continuous animation loop.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const printMedia = matchMedia('print');
const phone = matchMedia('(max-width: 640px)');
const canMove = () => Boolean(Element.prototype.animate) && !reduceMotion.matches && !printMedia.matches && !document.hidden;
const controls = '.primary-button, .secondary-button, .icon-button, .dashboard-refresh, .dashboard-tool, .studio-nav a, .mobile-task-nav button, .mobile-tips, .quantity-control button';
let pressed = null;
function release() { pressed?.classList.remove('liquid-pressed'); pressed = null; }
document.addEventListener('pointerdown', event => {
  release();
  if (!canMove() || !event.isPrimary || event.button !== 0) return;
  const target = event.target.closest?.(controls);
  if (!target || target.matches(':disabled, [aria-disabled="true"]')) return;
  pressed = target; target.classList.add('liquid-pressed');
}, { passive: true });
for (const type of ['pointerup', 'pointercancel', 'blur']) window.addEventListener(type, release, { passive: true });
document.addEventListener('scroll', release, { passive: true, capture: true });

const reveals = new Set();
function reveal(elements) {
  if (!canMove()) return;
  elements.filter(element => element.getClientRects().length).slice(0, 5).forEach((element, index) => {
    const animation = element.animate([
      { opacity: .5, translate: '0 5px' }, { opacity: 1, translate: '0 0' },
    ], { duration: 230, delay: index * 18, easing: 'cubic-bezier(.2,.8,.2,1)' });
    reveals.add(animation);
    animation.onfinish = animation.oncancel = () => reveals.delete(animation);
  });
}
document.addEventListener('toggle', event => {
  const details = event.target;
  if (details.open && details.matches('.dashboard-disclosure, .setup-panel, .saved-receipts-panel, .receipt-print-history, #item-details')) {
    reveal([...details.children].filter(element => element.tagName !== 'SUMMARY'));
  }
}, true);

const tabBars = new Map();
function enhanceTabs(bar) {
  if (tabBars.has(bar) || !Element.prototype.animate) return;
  const indicator = document.createElement('span');
  indicator.className = 'liquid-tab-indicator screen-only'; indicator.setAttribute('aria-hidden', 'true');
  bar.prepend(indicator);
  let animation = null, lastButton = null, lastBounds = '';
  function position(animate = false) {
    const selected = bar.querySelector('button[aria-pressed="true"]');
    if (!selected || !bar.getClientRects().length || printMedia.matches) return;
    const outer = bar.getBoundingClientRect(), rect = selected.getBoundingClientRect();
    const target = { transform: `translate(${rect.left - outer.left - bar.clientLeft}px, ${rect.top - outer.top - bar.clientTop}px)`, width: `${rect.width}px`, height: `${rect.height}px` };
    const bounds = JSON.stringify(target);
    if (bounds === lastBounds && selected === lastButton) return;
    const current = getComputedStyle(indicator);
    const from = lastButton ? { transform: current.transform, width: current.width, height: current.height } : target;
    animation?.cancel();
    animation = indicator.animate([from, target], { duration: animate && canMove() && lastButton ? 340 : 0, easing: 'cubic-bezier(.2,.9,.2,1.08)', fill: 'forwards' });
    bar.classList.add('liquid-tabs-ready');
    if (animate && selected !== lastButton && lastButton && phone.matches) {
      reveal([...document.querySelectorAll('[data-mobile-hidden="false"]')]);
    }
    lastButton = selected; lastBounds = bounds;
  }
  const observer = new MutationObserver(() => position(true));
  observer.observe(bar, { subtree: true, attributes: true, attributeFilter: ['aria-pressed'] });
  const resize = new ResizeObserver(() => position()); resize.observe(bar);
  tabBars.set(bar, { position, settle: () => { animation?.finish(); } });
  position();
}
document.querySelectorAll('.mobile-task-nav').forEach(enhanceTabs);
// Workspace tabs are sometimes created after this module has loaded.
if (!tabBars.size && ['stickers', 'tra', 'waybill'].includes(document.body.dataset.page)) {
  const discovery = new MutationObserver(records => {
    for (const record of records) for (const node of record.addedNodes) {
      if (!(node instanceof Element)) continue;
      if (node.matches('.mobile-task-nav')) enhanceTabs(node);
      node.querySelectorAll('.mobile-task-nav').forEach(enhanceTabs);
    }
    if (tabBars.size) discovery.disconnect();
  });
  discovery.observe(document.body, { childList: true, subtree: true });
}
function settle() {
  release();
  for (const animation of reveals) animation.cancel();
  reveals.clear();
  for (const bar of tabBars.values()) bar.settle();
}
reduceMotion.addEventListener('change', settle);
printMedia.addEventListener('change', settle);
window.addEventListener('beforeprint', settle);
window.addEventListener('pagehide', settle);
document.addEventListener('visibilitychange', () => { if (document.hidden) settle(); });
