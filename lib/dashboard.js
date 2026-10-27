const activeStatuses = new Set(['preparing', 'submitting']);
const attentionStatuses = new Set(['unknown', 'failed']);
const routes = { sticker: '/', receipt: '/tra', waybill: '/waybill' };

function dateKey(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Read the service's current records, without querying a driver or resending jobs.
export function buildDashboard({ stickers, receipts, waybills, batches, config, printBusy, documentBusy, now = new Date() }) {
  const today = dateKey(now);
  const entries = [
    ...stickers.map(job => ({ kind: 'sticker', job })),
    ...receipts.map(job => ({ kind: 'receipt', job })),
    ...waybills.map(job => ({ kind: 'waybill', job })),
  ];
  const sentToday = entries.filter(({ job }) => job.status === 'submitted' && dateKey(job.createdAt) === today);
  const quantity = kind => sentToday.filter(entry => kind === 'sticker' ? entry.kind === kind && entry.job.labelsPerCopy === 2 : entry.kind !== 'sticker')
    .reduce((sum, { job }) => sum + (Number.isInteger(job.copies) && job.copies > 0 ? job.copies : 0), 0);
  const activity = entries.filter(({ job }) => dateKey(job.createdAt))
    .sort((a, b) => new Date(b.job.createdAt) - new Date(a.job.createdAt)).slice(0, 8)
    .map(({ kind, job }) => ({
      id: job.id, kind, href: routes[kind], status: job.status, copies: job.copies, labelsPerCopy: job.labelsPerCopy,
      createdAt: job.createdAt,
      title: kind === 'sticker' ? (job.fields?.productName || 'Sticker pair')
        : kind === 'receipt' ? (job.receiptNumber ? `Receipt #${job.receiptNumber}` : 'Trust Receipt')
          : `Waybill${job.waybillNumbers?.filter(Boolean).length ? ' ' + job.waybillNumbers.filter(Boolean).map(value => '#' + value).join(' / ') : ''}`,
    }));
  return {
    updatedAt: now.toISOString(), date: today, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    today: { stickerPairs: quantity('sticker'), documentSheets: quantity('document'), submissions: sentToday.length },
    activeJobs: entries.filter(({ job }) => activeStatuses.has(job.status)).length,
    activeBatches: batches.filter(batch => ['validating', 'printing'].includes(batch.status)).length,
    attentionToday: entries.filter(({ job }) => attentionStatuses.has(job.status) && dateKey(job.createdAt) === today).length,
    printers: {
      stickers: { name: config.selectedPrinter || null, busy: printBusy },
      documents: { name: config.receiptPrinter || null, busy: documentBusy },
    },
    activity,
  };
}
