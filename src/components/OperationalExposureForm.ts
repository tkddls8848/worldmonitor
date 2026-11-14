import { t, getCurrentLanguageTag } from '@/services/i18n';
import type { OperationalInput, OperationalSnapshot } from '@/types/operational-balance';
import { calculateOperationalBalance, importOperationalWorksheet, MAX_OPERATIONAL_DELIVERIES, MAX_OPERATIONAL_JSON_BYTES, operationalExample } from '@/utils/operational-balance';
import { h } from '@/utils/dom-utils';

interface OperationalDraft extends Omit<OperationalInput, 'startingStock' | 'dailyDemand' | 'horizonDays' | 'deliveries' | 'alternativeDeliveries'> {
  startingStock: number | null;
  dailyDemand: number | null;
  horizonDays: number | null;
  deliveries: { date: string; quantity: number | null; unit: string; costUsd: number | null }[];
  alternativeDeliveries: OperationalDraft['deliveries'];
}

export interface OperationalWorksheetSession {
  draft?: OperationalDraft;
}

function worksheetError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : '';
  const errors: Record<string, string> = {
    'Expected a worksheet object.': 'objectError',
    'Use a valid date from 1900 through 9998.': 'dateError',
    'Enter an operation name of 1-100 characters.': 'operationError',
    'Enter one quantity unit of 1-24 characters.': 'unitError',
    'Horizon must be 1-90 whole days.': 'horizonError',
    'Input basis must be example or user.': 'basisError',
    'Use at most 30 deliveries per list.': 'deliveryLimit',
    'Delivery dates must be inside the selected horizon.': 'deliveryDateError',
    'Worksheet JSON must be no larger than 64 KiB.': 'fileLimit',
    'Unsupported worksheet format.': 'formatError',
  };
  if (errors[message]) return t(`components.operationalWorksheet.${errors[message]}`);
  // Local validation failures are already translated before being thrown.
  if ([t('components.operationalWorksheet.fileLimit'), t('components.operationalWorksheet.inputsChanged')].includes(message)) return message;
  if (getCurrentLanguageTag().startsWith('ko')) {
    if (message.endsWith('is required.')) return t('components.operationalWorksheet.requiredError');
    if (message.includes('must be between 0 and 1 million')) return t('components.operationalWorksheet.numberError');
    if (message.startsWith('Every delivery must use')) return t('components.operationalWorksheet.mixedUnitError');
    return t('components.operationalWorksheet.invalidError');
  }
  return message || t('components.operationalWorksheet.invalidError');
}

export function renderOperationalWorksheet(snapshot: OperationalSnapshot): HTMLElement {
  const { input, baseline, alternative } = snapshot;
  const gap = (day: number | null) => day === null ? t('components.operationalWorksheet.noGap') : t('components.operationalWorksheet.day', { day });
  const root = h('section', { className: 'operational-result', 'aria-label': t('components.operationalWorksheet.balanceAria'), lang: getCurrentLanguageTag() },
    h('div', { className: 'operational-result-heading' }, h('h3', {}, t('components.operationalWorksheet.balanceTitle')), h('span', {}, t('components.operationalWorksheet.horizon', { days: input.horizonDays, unit: input.unit }))),
    h('p', { className: 'operational-operation' }, input.operation),
    h('div', { className: 'operational-summary' },
      h('p', { className: 'operational-scenario' }, h('span', {}, t('components.operationalWorksheet.baselineGap')), h('strong', {}, `${gap(baseline.firstGapDay)}. `)),
      h('p', { className: 'operational-scenario operational-scenario-alt' }, h('span', {}, t('components.operationalWorksheet.alternativeGap')), h('strong', {}, `${gap(alternative.firstGapDay)}. `)),
      h('p', { className: 'operational-unmet' }, t('components.operationalWorksheet.unmet', { baseline: baseline.totalUnmetDemand, alternative: alternative.totalUnmetDemand, unit: input.unit }),
        h('span', {}, t('components.operationalWorksheet.avoided', { quantity: snapshot.avoidedUnmetDemand, unit: input.unit })))),
    h('p', { className: 'operational-cost' }, snapshot.additionalDeliveryCostUsd === null ? t('components.operationalWorksheet.costUnknown') : t('components.operationalWorksheet.cost', { cost: snapshot.additionalDeliveryCostUsd })),
  );
  const assumptions = h('details', { className: 'operational-method' }, h('summary', {}, t('components.operationalWorksheet.assumptions')),
    h('p', {}, input.basis === 'example' ? t('components.operationalWorksheet.exampleBasis') : t('components.operationalWorksheet.userBasis')),
    h('p', {}, t('components.operationalWorksheet.inputs', { unit: input.unit, stock: input.startingStock, date: input.startDate, days: input.horizonDays })),
    h('p', {}, t('components.operationalWorksheet.stockMethod')),
    h('p', {}, t('components.operationalWorksheet.alternativeMethod')));
  for (const [label, rows] of [[t('components.operationalWorksheet.baselineDeliveries'), input.deliveries], [t('components.operationalWorksheet.additionalDeliveries'), input.alternativeDeliveries]] as const) {
    assumptions.append(h('h4', {}, label), h('ul', {}, ...(rows.length ? rows.map(row => h('li', {}, t('components.operationalWorksheet.delivery', { date: row.date, quantity: row.quantity, unit: row.unit, cost: row.costUsd === null ? t('components.operationalWorksheet.unknown') : `${row.costUsd} USD` }))) : [h('li', {}, t('components.operationalWorksheet.none'))])));
  }
  const table = h('table', {}, h('caption', {}, t('components.operationalWorksheet.caption', { unit: input.unit })),
    h('thead', {}, h('tr', {}, ...[t('components.operationalWorksheet.dayDate'), t('components.operationalWorksheet.baselineArrivals'), t('components.operationalWorksheet.baselineDemand'), t('components.operationalWorksheet.baselineStock'), t('components.operationalWorksheet.baselineUnmet'), t('components.operationalWorksheet.alternativeArrivals'), t('components.operationalWorksheet.alternativeDemand'), t('components.operationalWorksheet.alternativeStock'), t('components.operationalWorksheet.alternativeUnmet')].map(label => h('th', { scope: 'col' }, label)))));
  table.append(h('tbody', {}, ...baseline.days.map((day, index) => {
    const alt = alternative.days[index]!;
    return h('tr', { 'data-day': day.day }, h('th', { scope: 'row' }, `${day.day} / ${day.date}`), ...[day.arrivals, day.demand, day.closingStock, day.unmetDemand, alt.arrivals, alt.demand, alt.closingStock, alt.unmetDemand].map(value => h('td', {}, String(value))));
  })));
  root.append(h('div', { className: 'operational-table', tabindex: 0, role: 'region', 'aria-label': t('components.operationalWorksheet.scrollAria') }, table),
    h('p', { className: 'operational-note' }, t('components.operationalWorksheet.note')), assumptions);
  return root;
}

export function createOperationalExposureForm(onChange: (snapshot: OperationalSnapshot | null) => void, session: OperationalWorksheetSession = {}, signal?: AbortSignal): HTMLElement {
  const root = h('section', { className: 'operational-worksheet', 'aria-label': t('components.operationalWorksheet.worksheetAria'), lang: getCurrentLanguageTag() });
  const fields = h('div', { className: 'operational-fields' });
  const editor = h('div', { className: 'operational-editor' });
  const actions = h('div', { className: 'operational-actions' });
  const alternativeFields = h('div', { className: 'operational-fields operational-alternative-fields' });
  const baselineRows = h('div');
  const alternativeRows = h('div');
  const result = h('div');
  const error = h('p', { className: 'operational-error', 'aria-live': 'polite' });
  const importStatus = h('p', { className: 'operational-import-status', 'aria-live': 'polite' });
  let basis: OperationalInput['basis'] = 'example';
  let snapshot: OperationalSnapshot | null = null;
  let revision = 0;
  let importGeneration = 0;
  const setNumber = (field: HTMLInputElement, value: number | null) => {
    field.value = value === null || Number.isNaN(value) ? '' : String(value);
    field.setCustomValidity(Number.isNaN(value) ? t('components.operationalWorksheet.validNumber') : '');
  };
  const input = (label: string, type: string, parent: HTMLElement, value = '') => {
    const field = h('input', { type, value, 'aria-label': label, ...(type === 'number' ? { min: 0, max: 1e6, step: 'any' } : {}) }) as HTMLInputElement;
    if (type === 'number') setNumber(field, value === '' ? null : Number(value));
    parent.append(h('label', {}, h('span', {}, label), field));
    return field;
  };
  const operation = input(t('components.operationalWorksheet.operation'), 'text', fields);
  operation.maxLength = 100;
  const unit = input(t('components.operationalWorksheet.unit'), 'text', fields);
  unit.maxLength = 24;
  const start = input(t('components.operationalWorksheet.startDate'), 'date', fields);
  const horizon = input(t('components.operationalWorksheet.horizonDays'), 'number', fields);
  horizon.max = '90'; horizon.min = '1'; horizon.step = '1';
  const stock = input(t('components.operationalWorksheet.startingStock'), 'number', fields);
  const demand = input(t('components.operationalWorksheet.dailyDemand'), 'number', fields);
  const alternativeDemand = input(t('components.operationalWorksheet.alternativeDailyDemand'), 'number', alternativeFields);
  const numeric = (field: HTMLInputElement) => field.validity.badInput || field.validity.customError ? NaN : field.value === '' ? null : Number(field.value);
  const rows = (parent: HTMLElement) => Array.from(parent.children).map(row => {
    const [date, quantity, cost] = Array.from(row.querySelectorAll('input'));
    return { date: date!.value, quantity: numeric(quantity!), unit: unit.value.trim(), costUsd: numeric(cost!) };
  });
  const exportButton = h('button', { type: 'button', className: 'cdp-action-btn cdp-export-primary' }, t('components.operationalWorksheet.exportJson')) as HTMLButtonElement;
  const update = () => {
    revision++;
    session.draft = { operation: operation.value, basis, unit: unit.value, startDate: start.value, horizonDays: numeric(horizon), startingStock: numeric(stock), dailyDemand: numeric(demand), alternativeDailyDemand: numeric(alternativeDemand), deliveries: rows(baselineRows), alternativeDeliveries: rows(alternativeRows) };
    try {
      snapshot = calculateOperationalBalance(session.draft);
      result.replaceChildren(renderOperationalWorksheet(snapshot)); error.textContent = ''; exportButton.disabled = false;
    } catch (cause) {
      snapshot = null; result.replaceChildren(); error.textContent = t('components.operationalWorksheet.invalidWorksheet', { reason: worksheetError(cause) }); exportButton.disabled = true;
    }
    onChange(snapshot);
  };
  const addRow = (parent: HTMLElement, label: string, row?: OperationalDraft['deliveries'][number]) => {
    if (parent.children.length >= MAX_OPERATIONAL_DELIVERIES) { importStatus.textContent = t('components.operationalWorksheet.deliveryLimit'); return; }
    const group = h('div', { className: 'operational-delivery' });
    input(t('components.operationalWorksheet.date', { label }), 'date', group, row?.date ?? start.value);
    input(t('components.operationalWorksheet.quantity', { label }), 'number', group, row?.quantity == null ? '' : String(row.quantity));
    input(t('components.operationalWorksheet.deliveryCost', { label }), 'number', group, row?.costUsd == null ? '' : String(row.costUsd));
    const remove = h('button', { type: 'button', className: 'cdp-action-btn', 'aria-label': t('components.operationalWorksheet.remove', { label: label.toLowerCase() }) }, t('components.operationalWorksheet.removeButton'));
    remove.addEventListener('click', () => { group.remove(); basis = 'user'; update(); });
    group.append(remove); parent.append(group);
  };
  const populate = (data: OperationalDraft) => {
    basis = data.basis; operation.value = data.operation; unit.value = data.unit; start.value = data.startDate;
    setNumber(horizon, data.horizonDays);
    setNumber(stock, data.startingStock);
    setNumber(demand, data.dailyDemand);
    setNumber(alternativeDemand, data.alternativeDailyDemand);
    baselineRows.replaceChildren(); alternativeRows.replaceChildren();
    data.deliveries.forEach(row => addRow(baselineRows, t('components.operationalWorksheet.baselineDelivery'), row));
    data.alternativeDeliveries.forEach(row => addRow(alternativeRows, t('components.operationalWorksheet.alternativeDelivery'), row));
    update();
  };
  for (const [parent, label] of [[baselineRows, t('components.operationalWorksheet.baselineDelivery')], [alternativeRows, t('components.operationalWorksheet.alternativeDelivery')]] as const) {
    const add = h('button', { type: 'button', className: 'cdp-action-btn' }, t('components.operationalWorksheet.add', { label: label.toLowerCase() }));
    add.addEventListener('click', () => { addRow(parent, label); basis = 'user'; update(); });
    const section = h('section', { className: 'operational-input-section' },
      h('div', { className: 'operational-section-heading' }, h('h3', {}, label === t('components.operationalWorksheet.baselineDelivery') ? t('components.operationalWorksheet.baselineDeliveries') : t('components.operationalWorksheet.alternativePlan')), add));
    if (parent === alternativeRows) section.append(alternativeFields);
    section.append(parent);
    editor.append(section);
  }
  editor.prepend(h('section', { className: 'operational-input-section' }, h('h3', {}, t('components.operationalWorksheet.operationInputs')), fields));
  root.append(h('header', { className: 'operational-header' },
    h('p', { className: 'operational-eyebrow' }, t('components.operationalWorksheet.localWorksheet')),
    h('h2', { className: 'cdp-card-title' }, t('components.operationalWorksheet.title')),
    h('p', { className: 'cdp-section-description' }, t('components.operationalWorksheet.description'))));
  root.addEventListener('input', event => {
    if (event.target instanceof HTMLInputElement && event.target.type !== 'file') { event.target.setCustomValidity(''); basis = 'user'; update(); }
  });
  const file = input(t('components.operationalWorksheet.importJson'), 'file', actions);
  file.accept = '.json,application/json';
  file.addEventListener('change', async () => {
    const selected = file.files?.[0];
    if (!selected) return;
    const current = revision;
    const generation = ++importGeneration;
    try {
      if (selected.size > MAX_OPERATIONAL_JSON_BYTES) throw new Error(t('components.operationalWorksheet.fileLimit'));
      const imported = importOperationalWorksheet(await selected.text());
      if (signal?.aborted || generation !== importGeneration) return;
      if (current !== revision) throw new Error(t('components.operationalWorksheet.inputsChanged'));
      populate(imported.input); importStatus.textContent = t('components.operationalWorksheet.imported');
    } catch (cause) {
      importStatus.textContent = t('components.operationalWorksheet.importRejected', { reason: worksheetError(cause) });
    } finally { if (generation === importGeneration) file.value = ''; }
  });
  exportButton.addEventListener('click', () => {
    if (!snapshot) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }));
    h('a', { href: url, download: 'operational-worksheet.json' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  });
  actions.append(exportButton);
  root.append(actions, importStatus,
    h('details', { className: 'operational-method operational-input-help' }, h('summary', {}, t('components.operationalWorksheet.helpTitle')),
      h('p', {}, t('components.operationalWorksheet.help'))),
    h('div', { className: 'operational-workspace' }, editor, h('div', { className: 'operational-results' }, error, result)));
  const example = operationalExample();
  if (getCurrentLanguageTag().startsWith('ko')) {
    example.operation = t('components.operationalWorksheet.exampleOperation');
    example.unit = t('components.operationalWorksheet.exampleUnit');
    example.deliveries.forEach(row => { row.unit = example.unit; });
  }
  populate(session.draft ?? example);
  return root;
}
