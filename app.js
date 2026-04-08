const API_URL =
  window.CDMS_CONFIG?.APPS_SCRIPT_WEB_APP_URL ||
  window.APP_CONFIG?.APPS_SCRIPT_WEB_APP_URL ||
  "";

if (!API_URL) {
  alert("Google Sheets Web App URL is missing. Open config.js and set APPS_SCRIPT_WEB_APP_URL first.");
}

const APP = {
  cache: {
    drugs: [],
    prescriptions: [],
    transactions: []
  },
  ui: {
    activeTab: 'prescriptionsTab',
    expandedPrescriptionIds: new Set(),
    expandedTransactionIds: new Set()
  }
};

const JORDAN_TZ = 'Asia/Amman';
const q = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

async function apiRequest(action, payload = {}) {
  const res = await fetch(API_URL, {
    method: 'POST',
    body: JSON.stringify({ action, ...payload })
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Google Sheets API Error');
  return data;
}

function jordanDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: JORDAN_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date);
  const obj = {};
  for (const part of parts) if (part.type !== 'literal') obj[part.type] = part.value;
  return obj;
}

function jordanNowIso() {
  const p = jordanDateParts();
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function formatJordanDateTime(value, withSeconds = false) {
  if (!value) return '-';
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    return s.replace('T', ' ').slice(0, withSeconds ? 19 : 16);
  }
  const date = new Date(s);
  if (Number.isNaN(date.getTime())) return s.replace('T', ' ').slice(0, withSeconds ? 19 : 16);
  const p = jordanDateParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${withSeconds ? `:${p.second}` : ''}`;
}

function showToast(message, error = false) {
  const toast = document.createElement('div');
  toast.className = `toast${error ? ' error' : ''}`;
  toast.textContent = message;
  q('toastHost').appendChild(toast);
  setTimeout(() => toast.remove(), 3200);
}

function todayKey() {
  return jordanNowIso().slice(0, 10);
}

function statusBadge(status) {
  const text = String(status || 'Registered');
  const key = text.toLowerCase();
  return `<span class="badge ${esc(key)}">${esc(text)}</span>`;
}

function typePill(type) {
  return `<span class="type-pill">${esc(type || '-')}</span>`;
}

function drugById(id) {
  return APP.cache.drugs.find(row => String(row.id) === String(id));
}

function drugLabelFromAny(row = {}) {
  const drug = drugById(row.drugId);
  const name = row.drugName || row.tradeName || drug?.tradeName || '';
  const strength = row.strength || drug?.strength || '';
  return `${name} ${strength}`.trim() || '-';
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean).map(v => String(v).trim()))].sort((a, b) => a.localeCompare(b));
}

function bindTabs() {
  document.querySelectorAll('[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      APP.ui.activeTab = btn.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('active', el === btn));
      document.querySelectorAll('.tab-panel').forEach(panel => panel.classList.toggle('active', panel.id === btn.dataset.tab));
    });
  });
}

function fillSelect(selectId, items, placeholder) {
  const el = q(selectId);
  if (!el) return;
  el.innerHTML = `<option value="">${esc(placeholder)}</option>` + items.map(item => `<option value="${esc(item.value)}">${esc(item.label)}</option>`).join('');
}

function initFilters() {
  const pharmacies = uniqueValues([
    ...APP.cache.prescriptions.map(r => r.pharmacy),
    ...APP.cache.transactions.map(r => r.pharmacy)
  ]);
  const drugs = uniqueValues(APP.cache.drugs.map(d => `${d.tradeName || ''} ${d.strength || ''}`.trim()));
  const txTypes = uniqueValues(APP.cache.transactions.map(r => r.type));

  fillSelect('rxPharmacy', pharmacies.map(v => ({ value: v, label: v })), 'All Pharmacies');
  fillSelect('txPharmacy', pharmacies.map(v => ({ value: v, label: v })), 'All Pharmacies');
  fillSelect('rxDrug', APP.cache.drugs.map(d => ({ value: d.id, label: `${d.tradeName || ''} ${d.strength || ''}`.trim() })), 'All Drugs');
  fillSelect('txDrug', drugs.map(v => ({ value: v, label: v })), 'All Drugs');
  const txTypeEl = q('txType');
  txTypeEl.innerHTML = `<option value="">All Types</option>` + txTypes.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
}

function rxLoadAllowed() {
  return !!(
    q('rxFileNumber').value.trim() ||
    q('rxPharmacy').value ||
    (q('rxFromDate').value && q('rxToDate').value)
  );
}

function txLoadAllowed() {
  return !!(
    q('txSearch').value.trim() ||
    q('txPharmacy').value ||
    q('txType').value ||
    q('txDrug').value ||
    (q('txFromDate').value && q('txToDate').value)
  );
}

function matchesDateRange(dateTime, from, to) {
  const day = formatJordanDateTime(dateTime).slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

function getFilteredPrescriptions() {
  if (!rxLoadAllowed()) return [];
  const search = q('rxSearch').value.trim().toLowerCase();
  const fileNumber = q('rxFileNumber').value.trim().toLowerCase();
  const pharmacy = q('rxPharmacy').value;
  const from = q('rxFromDate').value;
  const to = q('rxToDate').value;
  const status = q('rxStatus').value;
  const drugId = q('rxDrug').value;

  return APP.cache.prescriptions.filter(row => {
    const drug = drugById(row.drugId);
    const hay = `${row.patientName || ''} ${row.fileNumber || ''} ${row.doctorName || ''} ${row.pharmacistName || ''} ${row.prescriptionType || ''} ${row.status || ''} ${row.auditNote || ''} ${row.returnNote || ''} ${drug?.tradeName || ''} ${drug?.strength || ''} ${drug?.scientificName || ''}`.toLowerCase();
    if (search && !hay.includes(search)) return false;
    if (fileNumber && !String(row.fileNumber || '').toLowerCase().includes(fileNumber)) return false;
    if (pharmacy && String(row.pharmacy || '') !== pharmacy) return false;
    if (status && String(row.status || '') !== status) return false;
    if (drugId && String(row.drugId || '') !== drugId) return false;
    if ((from || to) && !matchesDateRange(row.dateTime, from, to)) return false;
    return true;
  }).sort((a, b) => String(b.dateTime || '').localeCompare(String(a.dateTime || '')));
}

function getRelatedTimelineRows(rx) {
  return APP.cache.transactions.filter(tx => {
    const sameDrug = String(tx.drugId || '') === String(rx.drugId || '') || drugLabelFromAny(tx) === drugLabelFromAny(rx);
    const sameFile = String(tx.fileNumber || '') === String(rx.fileNumber || '');
    const samePatient = String(tx.patientName || '').trim().toLowerCase() === String(rx.patientName || '').trim().toLowerCase();
    return sameDrug && (sameFile || samePatient);
  }).sort((a, b) => String(a.dateTime || '').localeCompare(String(b.dateTime || '')));
}

function buildTimelineHtml(rx) {
  const rows = getRelatedTimelineRows(rx);
  const relevant = rows.filter(row => ['Edit Prescription', 'Return', 'Delete Prescription', 'Register'].includes(String(row.type || '')));
  if (!relevant.length) {
    return `<div class="timeline-item"><div class="timeline-head"><strong>No timeline details found</strong><span class="timeline-meta">No related edit / return / delete records were matched.</span></div></div>`;
  }
  return relevant.map(row => {
    const oldValues = row.oldValues || {};
    const newValues = row.newValues || {};
    const diffRows = [];
    if (row.type === 'Edit Prescription') {
      const map = [
        ['Patient', oldValues.patientName, newValues.patientName],
        ['File Number', oldValues.fileNumber, newValues.fileNumber],
        ['Doctor', oldValues.doctorName, newValues.doctorName],
        ['Boxes', oldValues.qtyBoxes, newValues.qtyBoxes],
        ['Units', oldValues.qtyUnits, newValues.qtyUnits]
      ].filter(item => String(item[1] ?? '') !== String(item[2] ?? ''));
      if (!map.length) diffRows.push('<div class="timeline-meta">Edit recorded with no field diff available.</div>');
      else diffRows.push(...map.map(item => `<div class="detail-card"><span>${esc(item[0])}</span><strong>${esc(item[1] ?? '-')} → ${esc(item[2] ?? '-')}</strong></div>`));
    }
    if (row.type === 'Return') {
      diffRows.push(`<div class="detail-card"><span>Returned Quantity</span><strong>${Number(row.qtyBoxes || 0)} box(es) + ${Number(row.qtyUnits || 0)} unit(s)</strong></div>`);
    }
    if (row.type === 'Delete Prescription') {
      diffRows.push(`<div class="detail-card"><span>Deleted Quantity</span><strong>${Number(row.qtyBoxes || 0)} box(es) + ${Number(row.qtyUnits || 0)} unit(s)</strong></div>`);
    }
    if (row.type === 'Register') {
      diffRows.push(`<div class="detail-card"><span>Registered Quantity</span><strong>${Number(row.qtyBoxes || 0)} box(es) + ${Number(row.qtyUnits || 0)} unit(s)</strong></div>`);
    }
    return `
      <div class="timeline-item">
        <div class="timeline-head">
          <strong>${esc(row.type || 'Transaction')}</strong>
          <span class="timeline-meta">${esc(formatJordanDateTime(row.dateTime || row.registeredDateTime || row.returnDateTime || row.deletedDateTime || row.editedDateTime, true))}</span>
        </div>
        <div class="timeline-meta">By: ${esc(row.performedBy || row.pharmacistName || row.editedBy || row.returnBy || row.deletedBy || '-')}</div>
        <div class="timeline-grid" style="margin-top:12px">${diffRows.join('')}</div>
      </div>`;
  }).join('');
}

function renderPrescriptions() {
  const rows = getFilteredPrescriptions();
  q('rxResultsCaption').textContent = rxLoadAllowed()
    ? `${rows.length} prescription(s) found.`
    : 'Choose patient/file/pharmacy and date range to load prescriptions.';

  if (!rxLoadAllowed()) {
    q('prescriptionsTbody').innerHTML = `<tr><td colspan="10" class="empty-state">No data shown until you select file number or pharmacy or full date range.</td></tr>`;
    return;
  }

  if (!rows.length) {
    q('prescriptionsTbody').innerHTML = `<tr><td colspan="10" class="empty-state">No prescriptions found for the selected filters.</td></tr>`;
    return;
  }

  q('prescriptionsTbody').innerHTML = rows.map((row, index) => {
    const id = row.id || `rx_${index}`;
    const expanded = APP.ui.expandedPrescriptionIds.has(id);
    const drug = drugById(row.drugId);
    return `
      <tr>
        <td><button class="expand-btn" data-rx-expand="${esc(id)}">${expanded ? '−' : '+'}</button></td>
        <td>
          <div><strong>${esc(row.fileNumber || '-')}</strong></div>
          <div class="subline">${esc(row.patientName || '-')}</div>
        </td>
        <td>${esc(formatJordanDateTime(row.dateTime, true))}</td>
        <td>${esc(`${drug?.tradeName || ''} ${drug?.strength || ''}`.trim() || '-')}</td>
        <td>${esc(row.doctorName || '-')}</td>
        <td>${esc(row.pharmacistName || '-')}</td>
        <td>${Number(row.qtyBoxes || 0)}</td>
        <td>${Number(row.qtyUnits || 0)}</td>
        <td>${statusBadge(row.status || 'Registered')}</td>
        <td>
          <div>${typePill(row.prescriptionType || 'Prescription')}</div>
          <div class="subline">${esc(row.auditBy || '-')} ${row.auditDateTime ? `· ${esc(formatJordanDateTime(row.auditDateTime))}` : ''}</div>
        </td>
      </tr>
      ${expanded ? `
      <tr class="expand-row">
        <td colspan="10">
          <div class="details-grid">
            <div class="detail-card"><span>Status</span><strong>${esc(row.status || '-')}</strong></div>
            <div class="detail-card"><span>Prescription Type</span><strong>${esc(row.prescriptionType || '-')}</strong></div>
            <div class="detail-card"><span>Audit Details</span><strong>${esc([row.auditBy, row.auditDateTime ? formatJordanDateTime(row.auditDateTime, true) : '', row.auditNote].filter(Boolean).join(' · ') || '-')}</strong></div>
            <div class="detail-card"><span>Return Details</span><strong>${esc([row.returnBy, row.returnDateTime ? formatJordanDateTime(row.returnDateTime, true) : '', row.returnNote].filter(Boolean).join(' · ') || '-')}</strong></div>
            <div class="detail-card full"><span>Timeline</span><strong><div class="timeline-shell">${buildTimelineHtml(row)}</div></strong></div>
          </div>
        </td>
      </tr>` : ''}`;
  }).join('');

  document.querySelectorAll('[data-rx-expand]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.rxExpand;
      if (APP.ui.expandedPrescriptionIds.has(id)) APP.ui.expandedPrescriptionIds.delete(id);
      else APP.ui.expandedPrescriptionIds.add(id);
      renderPrescriptions();
    };
  });
}

function getFilteredTransactions() {
  if (!txLoadAllowed()) return [];
  const search = q('txSearch').value.trim().toLowerCase();
  const pharmacy = q('txPharmacy').value;
  const type = q('txType').value;
  const drug = q('txDrug').value;
  const from = q('txFromDate').value;
  const to = q('txToDate').value;

  return APP.cache.transactions.filter(row => {
    const label = drugLabelFromAny(row);
    const hay = `${row.type || ''} ${label} ${row.pharmacy || ''} ${row.performedBy || ''} ${row.patientName || ''} ${row.fileNumber || ''} ${row.note || ''} ${row.receiverPharmacist || ''} ${row.receivedBy || ''} ${row.invoiceNumber || ''} ${row.invoiceDate || ''}`.toLowerCase();
    if (search && !hay.includes(search)) return false;
    if (pharmacy && String(row.pharmacy || '') !== pharmacy) return false;
    if (type && String(row.type || '') !== type) return false;
    if (drug && label !== drug) return false;
    if ((from || to) && !matchesDateRange(row.dateTime || row.registeredDateTime || row.returnDateTime || row.deletedDateTime || row.editedDateTime, from, to)) return false;
    return true;
  }).sort((a, b) => String(b.dateTime || '').localeCompare(String(a.dateTime || '')));
}

function transactionDetailCards(row) {
  const cards = [
    ['Movement Type', row.type || '-'],
    ['Drug', drugLabelFromAny(row)],
    ['Pharmacy', row.pharmacy || '-'],
    ['Performed By', row.performedBy || row.pharmacistName || '-'],
    ['Patient Name', row.patientName || '-'],
    ['File Number', row.fileNumber || '-'],
    ['Doctor', row.doctorName || '-'],
    ['Boxes', Number(row.qtyBoxes || 0)],
    ['Units', Number(row.qtyUnits || 0)],
    ['Note', row.note || '-'],
    ['Invoice Number', row.invoiceNumber || '-'],
    ['Invoice Date', row.invoiceDate || '-'],
    ['Receiver Pharmacist', row.receiverPharmacist || row.receivedBy || '-'],
    ['Origin / Destination', [row.fromPharmacy, row.toPharmacy].filter(Boolean).join(' → ') || '-']
  ];

  if (row.type === 'Edit Prescription') {
    const oldValues = row.oldValues || {};
    const newValues = row.newValues || {};
    cards.push(['Before Edit', `Patient: ${oldValues.patientName || '-'} | File: ${oldValues.fileNumber || '-'} | Doctor: ${oldValues.doctorName || '-'} | Boxes: ${oldValues.qtyBoxes ?? '-'} | Units: ${oldValues.qtyUnits ?? '-'}`]);
    cards.push(['After Edit', `Patient: ${newValues.patientName || '-'} | File: ${newValues.fileNumber || '-'} | Doctor: ${newValues.doctorName || '-'} | Boxes: ${newValues.qtyBoxes ?? '-'} | Units: ${newValues.qtyUnits ?? '-'}`]);
  }

  return cards.map(item => `<div class="detail-card"><span>${esc(item[0])}</span><strong>${esc(item[1])}</strong></div>`).join('');
}

function renderTransactions() {
  const rows = getFilteredTransactions();
  q('txResultsCaption').textContent = txLoadAllowed()
    ? `${rows.length} transaction(s) found.`
    : 'Choose filters to load transactions.';

  if (!txLoadAllowed()) {
    q('transactionsTbody').innerHTML = `<tr><td colspan="9" class="empty-state">No data shown until you select transaction filters.</td></tr>`;
    return;
  }

  if (!rows.length) {
    q('transactionsTbody').innerHTML = `<tr><td colspan="9" class="empty-state">No transactions found for the selected filters.</td></tr>`;
    return;
  }

  q('transactionsTbody').innerHTML = rows.map((row, index) => {
    const id = row.id || `tx_${index}`;
    const expanded = APP.ui.expandedTransactionIds.has(id);
    return `
      <tr>
        <td><button class="expand-btn" data-tx-expand="${esc(id)}">${expanded ? '−' : '+'}</button></td>
        <td>${esc(formatJordanDateTime(row.dateTime || row.registeredDateTime || row.returnDateTime || row.deletedDateTime || row.editedDateTime, true))}</td>
        <td>${typePill(row.type || '-')}</td>
        <td>${esc(drugLabelFromAny(row))}</td>
        <td>${esc(row.performedBy || row.pharmacistName || row.editedBy || row.deletedBy || row.returnBy || '-')}</td>
        <td>${esc(row.pharmacy || [row.fromPharmacy, row.toPharmacy].filter(Boolean).join(' → ') || '-')}</td>
        <td>${Number(row.qtyBoxes || 0)}</td>
        <td>${Number(row.qtyUnits || row.dispensedUnits || 0)}</td>
        <td><button class="print-mini-btn" data-print-tx="${esc(id)}">Print</button></td>
      </tr>
      ${expanded ? `
      <tr class="expand-row">
        <td colspan="9">
          <div class="details-grid">${transactionDetailCards(row)}</div>
        </td>
      </tr>` : ''}`;
  }).join('');

  document.querySelectorAll('[data-tx-expand]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.txExpand;
      if (APP.ui.expandedTransactionIds.has(id)) APP.ui.expandedTransactionIds.delete(id);
      else APP.ui.expandedTransactionIds.add(id);
      renderTransactions();
    };
  });

  document.querySelectorAll('[data-print-tx]').forEach(btn => {
    btn.onclick = () => {
      const row = rows.find(item => String(item.id || '') === String(btn.dataset.printTx));
      if (row) printSingleTransaction(row);
    };
  });
}

function buildPrintShell(title, subtitle, body) {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>${esc(title)}</title>
<style>
body{font-family:Inter,Arial,sans-serif;padding:28px;color:#21364e}
.print-head{margin-bottom:20px;border-bottom:2px solid #d9e3ee;padding-bottom:14px}
.print-head h1{margin:0;font-size:22px;color:#173a66}
.print-head .sub{margin-top:8px;color:#60758e;font-size:13px;font-weight:700}
.section{margin-top:16px}
.section-title{font-size:18px;font-weight:800;color:#173a66;margin-bottom:10px}
table{width:100%;border-collapse:collapse;margin-top:8px}
th,td{border:1px solid #d7dfeb;padding:10px 12px;text-align:left;font-size:12px;vertical-align:top}
th{background:#edf3fa}
.meta-row td{background:#f9fbfe;font-weight:700}
.summary-table{margin-top:16px}
.page-break{page-break-before:always}
.signature-row{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:18px}
.sign-box{border:1px solid #d7dfeb;border-radius:12px;padding:14px 16px;min-height:78px}
.sign-box span{display:block;color:#60758e;font-size:12px;font-weight:700}
.sign-box strong{display:block;margin-top:10px}
</style></head><body>
<div class="print-head"><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div></div>
${body}
<script>window.onload=()=>window.print();</script>
</body></html>`;
}

function printPrescriptions() {
  const rows = getFilteredPrescriptions();
  if (!rows.length) return showToast('No filtered prescriptions to print.', true);
  const from = q('rxFromDate').value || '-';
  const to = q('rxToDate').value || '-';
  const pharmacy = q('rxPharmacy').value || 'All Pharmacies';
  const groups = APP.cache.drugs
    .map(drug => ({ drug, rows: rows.filter(row => String(row.drugId) === String(drug.id)) }))
    .filter(group => group.rows.length);

  const body = groups.map((group, index) => {
    const totalRegistered = group.rows.filter(row => String(row.status || '').toLowerCase() !== 'returned').length;
    const totalReturned = group.rows.filter(row => String(row.status || '').toLowerCase() === 'returned').length;
    const totalAll = group.rows.length;
    const totalUnitsPerBox = Math.max(1, Number(group.drug.unitsPerBox || 1));
    const totalDispensedUnits = group.rows.reduce((sum, row) => sum + Number(row.qtyBoxes || 0) * totalUnitsPerBox + Number(row.qtyUnits || 0), 0);
    const totalBoxes = Math.floor(totalDispensedUnits / totalUnitsPerBox);
    const remainingUnits = totalDispensedUnits % totalUnitsPerBox;

    return `
      <div class="section ${index ? 'page-break' : ''}">
        <div class="section-title">${esc(`${group.drug.tradeName || ''} ${group.drug.strength || ''}`.trim())}</div>
        <div class="sub"><strong>Pharmacy:</strong> ${esc(pharmacy)} &nbsp; | &nbsp; <strong>Date:</strong> ${esc(from)} to ${esc(to)} &nbsp; | &nbsp; <strong>Drug:</strong> ${esc(`${group.drug.tradeName || ''} ${group.drug.strength || ''}`.trim())}</div>
        <table>
          <thead><tr><th>Date & Time</th><th>Patient</th><th>File Number</th><th>Doctor</th><th>Pharmacist</th><th>Boxes</th><th>Units</th><th>Status</th></tr></thead>
          <tbody>
            ${group.rows.map(row => `
              <tr>
                <td>${esc(formatJordanDateTime(row.dateTime, true))}</td>
                <td>${esc(row.patientName || '-')}</td>
                <td>${esc(row.fileNumber || '-')}</td>
                <td>${esc(row.doctorName || '-')}</td>
                <td>${esc(row.pharmacistName || '-')}</td>
                <td>${Number(row.qtyBoxes || 0)}</td>
                <td>${Number(row.qtyUnits || 0)}</td>
                <td>${esc(row.status || '-')}</td>
              </tr>
              <tr class="meta-row"><td colspan="8"><strong>Prescription Type:</strong> ${esc(row.prescriptionType || '-')} &nbsp; | &nbsp; <strong>Audit:</strong> ${esc([row.auditBy, row.auditDateTime ? formatJordanDateTime(row.auditDateTime, true) : '', row.auditNote].filter(Boolean).join(' · ') || '-')}</td></tr>
            `).join('')}
          </tbody>
        </table>
        <table class="summary-table">
          <thead><tr><th>Total Registered</th><th>Total Returned</th><th>Total Prescriptions</th></tr></thead>
          <tbody><tr><td>${totalRegistered}</td><td>${totalReturned}</td><td>${totalAll}</td></tr></tbody>
        </table>
        <table class="summary-table">
          <thead><tr><th>Total Dispensed Quantity</th></tr></thead>
          <tbody><tr><td>${totalBoxes} box(es) + ${remainingUnits} unit(s)</td></tr></tbody>
        </table>
      </div>`;
  }).join('');

  const win = window.open('', '_blank');
  win.document.write(buildPrintShell('Prescriptions Report', `${pharmacy} · ${from} to ${to}`, body));
  win.document.close();
}

function buildSingleTransactionSection(row) {
  const t = String(row.type || 'Transaction');
  if (t === 'Register' || t === 'Dispense') {
    return `
      <div class="section-title">Register / Dispense</div>
      <table><thead><tr><th>Patient Name</th><th>File Number</th><th>Pharmacy</th><th>Doctor</th><th>Dispensed Quantity</th></tr></thead>
      <tbody>
        <tr><td>${esc(row.patientName || '-')}</td><td>${esc(row.fileNumber || '-')}</td><td>${esc(row.pharmacy || '-')}</td><td>${esc(row.doctorName || '-')}</td><td>${Number(row.qtyBoxes || 0)} box(es) + ${Number(row.qtyUnits || 0)} unit(s)</td></tr>
        <tr class="meta-row"><td colspan="5"><strong>Pharmacist:</strong> ${esc(row.registeredBy || row.pharmacistName || row.performedBy || '-')} &nbsp; | &nbsp; <strong>Date & Time:</strong> ${esc(formatJordanDateTime(row.registeredDateTime || row.dateTime, true))}</td></tr>
      </tbody></table>`;
  }
  if (t === 'Edit Prescription') {
    const oldValues = row.oldValues || {};
    const newValues = row.newValues || {};
    return `
      <div class="section-title">Edit Prescription</div>
      <table><thead><tr><th>Stage</th><th>Patient Name</th><th>File Number</th><th>Pharmacy</th><th>Doctor</th><th>Quantity</th></tr></thead>
      <tbody>
        <tr><td>Before Edit</td><td>${esc(oldValues.patientName || row.patientName || '-')}</td><td>${esc(oldValues.fileNumber || row.fileNumber || '-')}</td><td>${esc(row.pharmacy || '-')}</td><td>${esc(oldValues.doctorName || row.doctorName || '-')}</td><td>${esc(`${oldValues.qtyBoxes ?? 0} box(es) + ${oldValues.qtyUnits ?? 0} unit(s)`)}</td></tr>
        <tr><td>After Edit</td><td>${esc(newValues.patientName || row.patientName || '-')}</td><td>${esc(newValues.fileNumber || row.fileNumber || '-')}</td><td>${esc(row.pharmacy || '-')}</td><td>${esc(newValues.doctorName || row.doctorName || '-')}</td><td>${esc(`${newValues.qtyBoxes ?? 0} box(es) + ${newValues.qtyUnits ?? 0} unit(s)`)}</td></tr>
        <tr class="meta-row"><td colspan="6"><strong>Edited by:</strong> ${esc(row.editedBy || row.performedBy || '-')} &nbsp; | &nbsp; <strong>Date & Time:</strong> ${esc(formatJordanDateTime(row.editedDateTime || row.dateTime, true))}</td></tr>
      </tbody></table>`;
  }
  if (t === 'Delete Prescription') {
    return `
      <div class="section-title">Delete Prescription</div>
      <table><thead><tr><th>Patient Name</th><th>File Number</th><th>Pharmacy</th><th>Doctor</th><th>Deleted Quantity</th></tr></thead>
      <tbody>
        <tr><td>${esc(row.patientName || '-')}</td><td>${esc(row.fileNumber || '-')}</td><td>${esc(row.pharmacy || '-')}</td><td>${esc(row.doctorName || '-')}</td><td>${Number(row.qtyBoxes || 0)} box(es) + ${Number(row.qtyUnits || 0)} unit(s)</td></tr>
        <tr class="meta-row"><td colspan="5"><strong>Deleted by:</strong> ${esc(row.deletedBy || row.performedBy || '-')} &nbsp; | &nbsp; <strong>Date & Time:</strong> ${esc(formatJordanDateTime(row.deletedDateTime || row.dateTime, true))}</td></tr>
      </tbody></table>`;
  }
  if (t === 'Return') {
    return `
      <div class="section-title">Return Prescription</div>
      <table><thead><tr><th>Patient Name</th><th>File Number</th><th>Pharmacy</th><th>Doctor</th><th>Returned Quantity</th></tr></thead>
      <tbody>
        <tr><td>${esc(row.patientName || '-')}</td><td>${esc(row.fileNumber || '-')}</td><td>${esc(row.pharmacy || '-')}</td><td>${esc(row.doctorName || '-')}</td><td>${Number(row.qtyBoxes || 0)} box(es) + ${Number(row.qtyUnits || 0)} unit(s)</td></tr>
        <tr class="meta-row"><td colspan="5"><strong>Returned by:</strong> ${esc(row.returnBy || row.performedBy || '-')} &nbsp; | &nbsp; <strong>Date & Time:</strong> ${esc(formatJordanDateTime(row.returnDateTime || row.dateTime, true))}</td></tr>
      </tbody></table>`;
  }
  if (t === 'Receive Shipment') {
    return `
      <div class="section-title">Receive Shipment</div>
      <table><thead><tr><th>Date & Time</th><th>Pharmacy</th><th>Drug</th><th>Received Quantity</th><th>Invoice No.</th><th>Invoice Date</th></tr></thead>
      <tbody>
        <tr><td>${esc(formatJordanDateTime(row.dateTime, true))}</td><td>${esc(row.pharmacy || '-')}</td><td>${esc(drugLabelFromAny(row))}</td><td>${Number(row.qtyBoxes || 0)} box(es) + ${Number(row.qtyUnits || 0)} unit(s)</td><td>${esc(row.invoiceNumber || '-')}</td><td>${esc(row.invoiceDate || '-')}</td></tr>
      </tbody></table>`;
  }
  if (t === 'Transfer') {
    return `
      <div class="section-title">Transfer</div>
      <table><thead><tr><th>Date & Time</th><th>Drug</th><th>From</th><th>To</th><th>Transferred Quantity</th><th>Receiver Pharmacist</th></tr></thead>
      <tbody>
        <tr><td>${esc(formatJordanDateTime(row.dateTime, true))}</td><td>${esc(drugLabelFromAny(row))}</td><td>${esc(row.fromPharmacy || row.pharmacy || '-')}</td><td>${esc(row.toPharmacy || '-')}</td><td>${Number(row.qtyBoxes || 0)} box(es) + ${Number(row.qtyUnits || 0)} unit(s)</td><td>${esc(row.receiverPharmacist || '-')}</td></tr>
      </tbody></table>
      <div class="signature-row"><div class="sign-box"><span>Pharmacist Signature</span><strong>${esc(row.performedBy || '-')}</strong></div><div class="sign-box"><span>Pharmacist Signature</span><strong>${esc(row.receiverPharmacist || '-')}</strong></div></div>`;
  }
  return `
    <div class="section-title">${esc(t)}</div>
    <table><thead><tr><th>Date & Time</th><th>Movement</th><th>Drug</th><th>Performed By</th><th>Pharmacy</th><th>Note</th></tr></thead>
    <tbody><tr><td>${esc(formatJordanDateTime(row.dateTime, true))}</td><td>${esc(t)}</td><td>${esc(drugLabelFromAny(row))}</td><td>${esc(row.performedBy || '-')}</td><td>${esc(row.pharmacy || '-')}</td><td>${esc(row.note || '-')}</td></tr></tbody></table>`;
}

function printSingleTransaction(row) {
  const title = `${row.type || 'Transaction'} Report`;
  const subtitle = `${drugLabelFromAny(row)} · ${formatJordanDateTime(row.dateTime || row.registeredDateTime || row.returnDateTime || row.deletedDateTime || row.editedDateTime, true)}`;
  const win = window.open('', '_blank');
  win.document.write(buildPrintShell(title, subtitle, buildSingleTransactionSection(row)));
  win.document.close();
}

function printTransactions() {
  const rows = getFilteredTransactions();
  if (!rows.length) return showToast('No filtered transactions to print.', true);
  const body = rows.map((row, index) => `<div class="section ${index ? 'page-break' : ''}">${buildSingleTransactionSection(row)}</div>`).join('');
  const subtitle = `${q('txPharmacy').value || 'All Pharmacies'} · ${q('txFromDate').value || '-'} to ${q('txToDate').value || '-'}`;
  const win = window.open('', '_blank');
  win.document.write(buildPrintShell('Transactions Report', subtitle, body));
  win.document.close();
}

async function loadData() {
  const [drugs, prescriptions, transactions] = await Promise.all([
    apiRequest('listDocs', { table: 'drugs' }),
    apiRequest('listDocs', { table: 'prescriptions' }),
    apiRequest('listDocs', { table: 'transactions' })
  ]);
  APP.cache.drugs = (drugs.data || []).filter(row => row.active !== false).sort((a, b) => `${a.tradeName || ''} ${a.strength || ''}`.localeCompare(`${b.tradeName || ''} ${b.strength || ''}`));
  APP.cache.prescriptions = (prescriptions.data || []).sort((a, b) => String(b.dateTime || '').localeCompare(String(a.dateTime || '')));
  APP.cache.transactions = (transactions.data || []).sort((a, b) => String(b.dateTime || '').localeCompare(String(a.dateTime || '')));
}

function bindFilters() {
  [
    'rxSearch','rxFileNumber','rxPharmacy','rxFromDate','rxToDate','rxStatus','rxDrug'
  ].forEach(id => q(id).addEventListener('input', renderPrescriptions));
  [
    'txSearch','txPharmacy','txType','txDrug','txFromDate','txToDate'
  ].forEach(id => q(id).addEventListener('input', renderTransactions));

  q('prescriptionsClearBtn').onclick = () => {
    ['rxSearch','rxFileNumber','rxPharmacy','rxFromDate','rxToDate','rxStatus','rxDrug'].forEach(id => q(id).value = '');
    APP.ui.expandedPrescriptionIds.clear();
    renderPrescriptions();
  };
  q('transactionsClearBtn').onclick = () => {
    ['txSearch','txPharmacy','txType','txDrug','txFromDate','txToDate'].forEach(id => q(id).value = '');
    APP.ui.expandedTransactionIds.clear();
    renderTransactions();
  };
  q('printPrescriptionsBtn').onclick = printPrescriptions;
  q('printTransactionsBtn').onclick = printTransactions;
}

function tickJordanTime() {
  q('liveJordanTime').textContent = `Jordan Time · ${formatJordanDateTime(jordanNowIso(), true)}`;
}

async function init() {
  try {
    tickJordanTime();
    setInterval(tickJordanTime, 1000);
    bindTabs();
    await loadData();
    initFilters();
    bindFilters();
    renderPrescriptions();
    renderTransactions();
    showToast('Audit prescriptions page loaded successfully.');
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Failed to load old database data.', true);
  }
}

init();
