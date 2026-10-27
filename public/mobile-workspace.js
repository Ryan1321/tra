// Mobile navigation changes visibility only: the same forms, drafts and print
// controls stay mounted. Desktop and printed documents use the full layout.
const phone = matchMedia('(max-width: 640px)');
const $ = selector => document.querySelector(selector);
const kind = document.body.dataset.page;
const configurations = {
  stickers: {
    tabs: [['products', 'Products'], ['label', 'Label'], ['batch', 'Batch'], ['settings', 'Settings']],
    sections: {
      '#catalog-panel': 'products', '#label-editor': 'label', '.preview-panel': 'label',
      '#batch-panel': 'batch', '.label-stock-panel': 'label batch settings',
      '.printer-panel': 'settings', '#setup-panel': 'settings', '.recent-section': 'settings',
    },
  },
  tra: {
    tabs: [['add', 'Add items'], ['details', 'Details'], ['print', 'Print'], ['saved', 'Saved']],
    sections: {
      '[aria-labelledby="item-heading"]': 'add', '[aria-labelledby="items-heading"]': 'details',
      '[aria-labelledby="details-heading"]': 'details', '[aria-labelledby="saved-heading"]': 'saved',
      '#document-preview': 'print',
    },
  },
  waybill: {
    tabs: [['first', 'Waybill 1'], ['second', 'Waybill 2'], ['print', 'Print']],
    sections: {
      '[aria-labelledby="waybill-one-heading"]': 'first', '[aria-labelledby="waybill-two-heading"]': 'second',
      '[aria-label="Waybill draft"]': 'first second', '#document-preview': 'print',
    },
  },
};
const config = configurations[kind];
let active = config?.tabs[0][0];
const sections = [], buttons = new Map();
let bar;

function select(section, { scroll = false } = {}) {
  if (!buttons.has(section)) return;
  active = section;
  for (const [name, button] of buttons) button.setAttribute('aria-pressed', String(name === active));
  for (const element of sections) element.dataset.mobileHidden = String(!element.dataset.mobileSections.split(' ').includes(active));
  if (phone.matches) {
    try { sessionStorage.setItem(`labeldesk.mobile.${kind}`, active); } catch {}
    if (active === 'saved') $('#saved-receipts-panel').open = true;
    if (scroll) bar.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
}

export function revealMobileSection(id) {
  if (!phone.matches) return;
  const target = document.getElementById(id);
  const section = target?.closest('[data-mobile-sections]');
  if (section && !section.dataset.mobileSections.split(' ').includes(active)) select(section.dataset.mobileSections.split(' ')[0], { scroll: true });
}

export function setMobileItemEntry(editing) {
  if (kind !== 'tra') return;
  document.body.dataset.mobileItemEntry = String(editing);
  const pending = ['#item-description', '#item-barcode', '#item-price'].some(selector => $(selector)?.value) || $('#item-quantity')?.value !== '1';
  if ($('#mobile-resume-item')) $('#mobile-resume-item').hidden = editing || !pending;
}

if (config) {
  for (const [selector, names] of Object.entries(config.sections)) {
    const element = $(selector);
    element.dataset.mobileSections = names;
    if (!element.id) element.id = `mobile-${kind}-${sections.length}`;
    sections.push(element);
  }
  bar = document.createElement('nav');
  bar.className = 'mobile-task-nav mobile-only screen-only';
  bar.setAttribute('aria-label', 'Current workspace');
  for (const [name, label] of config.tabs) {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label; button.dataset.mobileTab = name;
    button.setAttribute('aria-controls', sections.filter(e => e.dataset.mobileSections.split(' ').includes(name)).map(e => e.id).join(' '));
    button.addEventListener('click', () => select(name, { scroll: true }));
    buttons.set(name, button); bar.append(button);
  }
  $('#draft-sync').before(bar);
  const help = document.createElement('button');
  help.type = 'button'; help.className = 'mobile-only mobile-tips screen-only';
  help.textContent = 'Tips'; help.setAttribute('aria-pressed', 'false');
  help.addEventListener('click', () => {
    const show = document.body.dataset.mobileTips !== 'true';
    document.body.dataset.mobileTips = String(show); help.setAttribute('aria-pressed', String(show));
  });
  $('.site-header, .tra-header').append(help);

  // Only explanatory copy is optional. Errors, print results, recovery actions,
  // pairing prompts and sync conflicts remain visible in their workspace.
  const guidance = [
    '.catalog-intro', '#price-hint', '#barcode-hint', '.print-options .field-hint', '#batch-help',
    '#label-stock-note', '.pair-template-key', '#receipt-number-hint', '#item-limit',
    '.panel > p.hint:not([id])', '.print-controls > p.hint:not([id])', '.receipt-browser-print > .hint',
    '#saved-receipts-panel > p.hint:not([id])', '#tra-scanner > p.hint:not([id])', '#tra-scanner-hint',
  ];
  document.querySelectorAll(guidance.join(',')).forEach(element => element.classList.add('mobile-guidance'));

  // Existing in-page links also work when the destination lives in another view.
  document.addEventListener('click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (link) revealMobileSection(link.getAttribute('href').slice(1));
  }, true);
  document.addEventListener('invalid', event => revealMobileSection(event.target.id), true);
  window.addEventListener('hashchange', () => revealMobileSection(location.hash.slice(1)));

  if (kind !== 'stickers') {
    const toggle = document.createElement('button');
    toggle.type = 'button'; toggle.className = 'mobile-only mobile-preview-toggle secondary-button screen-only';
    toggle.textContent = 'Show paper preview'; toggle.setAttribute('aria-expanded', 'false');
    $('.paper-stage').id = 'mobile-paper-preview'; toggle.setAttribute('aria-controls', 'mobile-paper-preview');
    $('.preview-toolbar').append(toggle);
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.textContent = expanded ? 'Hide paper preview' : 'Show paper preview';
      document.body.dataset.mobilePreview = String(expanded);
    });
  }
  if (kind === 'stickers') {
    const update = () => { const count = $('#batch-items').children.length; buttons.get('batch').textContent = count ? `Batch (${count})` : 'Batch'; };
    new MutationObserver(update).observe($('#batch-items'), { childList: true }); update();
  }
  if (kind === 'tra') {
    const back = document.createElement('button');
    back.type = 'button'; back.className = 'mobile-only mobile-item-back text-button'; back.textContent = '← Search / scan';
    back.addEventListener('click', () => { setMobileItemEntry(false); bar.scrollIntoView({ block: 'start', behavior: 'instant' }); });
    $('#item-form').prepend(back);
    const resume = document.createElement('button');
    resume.id = 'mobile-resume-item'; resume.type = 'button'; resume.className = 'mobile-only secondary-button';
    resume.textContent = 'Continue current item'; resume.hidden = true;
    resume.addEventListener('click', () => setMobileItemEntry(true));
    $('#tra-catalog').prepend(resume);
    const review = document.createElement('button');
    review.type = 'button'; review.className = 'mobile-only mobile-review-items secondary-button';
    review.addEventListener('click', () => { select('details', { scroll: true }); $('#receipt-items').scrollIntoView({ block: 'start', behavior: 'instant' }); });
    $('[aria-labelledby="item-heading"] .panel-heading').after(review);
    const update = () => { review.textContent = `Review ${$('#receipt-items').children.length} items · ${$('#receipt-total').textContent}`; };
    new MutationObserver(update).observe($('#receipt-items'), { childList: true });
    new MutationObserver(update).observe($('#receipt-total'), { childList: true, characterData: true, subtree: true }); update();
    setMobileItemEntry(false);
  }
  try {
    const saved = sessionStorage.getItem(`labeldesk.mobile.${kind}`);
    if (buttons.has(saved)) active = saved;
    if (kind === 'stickers') {
      if (localStorage.getItem('labeldesk.pendingPrint')) active = 'label';
      if (localStorage.getItem('labeldesk.pendingBatch')) active = 'batch';
    } else if (localStorage.getItem(`labeldesk.${kind}.print.pending.v1`)) active = 'print';
  } catch {}
  select(active);
  if (location.hash) revealMobileSection(location.hash.slice(1));
  phone.addEventListener('change', () => {
    if (phone.matches) revealMobileSection(document.activeElement?.id);
    select(active);
  });
  document.body.classList.add('mobile-workspace-ready');
}
