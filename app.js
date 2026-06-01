// ── Config ────────────────────────────────────────────────
var API = 'https://script.google.com/macros/s/AKfycbxR-rqmbCxk2Gg15i9tVq69L9Fgx5Swq237t3ok_7xbS1AHEQeeH96rz6jvPnmvUr4g/exec';

var partCount = 0;
var _oorData  = [];
var _scanData = [];
var _activeLocation = 'all';
var _activeShip     = 'all';
var _scanTargetId   = null;
var _scannerRunning = false;

// ── API calls ─────────────────────────────────────────────

function apiFetch(action, payload) {
  if (payload) {
    return fetch(API, {
      method: 'POST',
      body: JSON.stringify({ action: action, payload: payload })
    }).then(function(r) { return r.json(); });
  }
  return fetch(API + '?action=' + action)
    .then(function(r) { return r.json(); });
}

// ── Tab routing ───────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('page-' + tab).classList.add('active');
  if (tab === 'scan')    loadOrders();
  if (tab === 'oor')     loadOOR();
  if (tab === 'package') loadPackage();
}

// ── Scanner ───────────────────────────────────────────────

function openScanner(targetInputId) {
  _scanTargetId = targetInputId;

  var labelMap = {
    'orderNumber': 'Order number',
    'pn':  'Part number',
    'lot': 'Lot number'
  };
  var labelKey = targetInputId.startsWith('pn-')  ? 'pn'  :
                 targetInputId.startsWith('lot-') ? 'lot' : targetInputId;

  document.getElementById('scannerFieldLabel').textContent =
    'Scanning: ' + (labelMap[labelKey] || targetInputId);
  document.getElementById('scannerStatus').textContent = 'Starting camera…';
  document.getElementById('scannerStatus').className = 'scanner-status';
  document.getElementById('scannerOverlay').classList.add('active');

  Quagga.init({
    inputStream: {
      name: 'Live',
      type: 'LiveStream',
      target: document.getElementById('scannerVideo'),
      constraints: {
        facingMode: 'environment',
        width:  { ideal: 1280 },
        height: { ideal: 720 }
      }
    },
    decoder: {
      readers: [
        'code_128_reader',
        'ean_reader',
        'ean_8_reader',
        'code_39_reader',
        'upc_reader',
        'upc_e_reader',
        'i2of5_reader'
      ]
    },
    locate: true
  }, function(err) {
    if (err) {
      document.getElementById('scannerStatus').textContent = 'Camera error: ' + err.message;
      document.getElementById('scannerStatus').className = 'scanner-status error';
      return;
    }
    Quagga.start();
    _scannerRunning = true;
    document.getElementById('scannerStatus').textContent = 'Point camera at barcode…';
  });

  Quagga.onDetected(function(result) {
    var code = result.codeResult.code;
    if (!code) return;

    document.getElementById('scannerStatus').textContent = 'Got it: ' + code;
    document.getElementById('scannerStatus').className = 'scanner-status success';

    var input = document.getElementById(_scanTargetId);
    if (input) {
      input.value = code;
      input.dispatchEvent(new Event('input'));
    }

    showToast('Scanned: ' + code, 'success');
    setTimeout(closeScanner, 800);
  });
}

function closeScanner() {
  if (_scannerRunning) {
    Quagga.stop();
    _scannerRunning = false;
  }
  Quagga.offDetected();
  document.getElementById('scannerOverlay').classList.remove('active');
  _scanTargetId = null;
}

// ── Scan Orders ───────────────────────────────────────────

function loadOrders() {
  document.getElementById('orderList').innerHTML =
    '<div class="empty-state"><p>Loading...</p></div>';
  apiFetch('getScanOrders')
    .then(function(data) {
      _scanData = data || [];
      filterScanOrders();
    })
    .catch(function() { showToast('Error loading orders', 'error'); });
}

function filterScanOrders() {
  var q = document.getElementById('scanSearch')
    ? document.getElementById('scanSearch').value.toLowerCase().trim() : '';
  var filtered = _scanData.filter(function(o) {
    return !q || String(o.orderNumber).toLowerCase().indexOf(q) !== -1;
  });
  renderOrders(filtered);
}

function renderOrders(orders) {
  var list = document.getElementById('orderList');
  if (!orders || !orders.length) {
    list.innerHTML =
      '<div class="empty-state"><div class="empty-icon">📋</div>' +
      '<p>No orders found.</p></div>';
    return;
  }
  list.innerHTML = orders.map(function(o) {
    var date = o.timestamp
      ? new Date(o.timestamp).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })
      : '—';
    var count = o.parts ? o.parts.length : 0;
    return '<div class="order-card">' +
      '<div class="order-icon">📋</div>' +
      '<div class="order-info">' +
        '<div class="order-num">' + o.orderNumber + '</div>' +
        '<div class="order-meta">' + date + ' &nbsp;·&nbsp; ' + count + ' part' + (count !== 1 ? 's' : '') + '</div>' +
      '</div>' +
      '<span class="badge badge-pending">Pending</span>' +
    '</div>';
  }).join('');
}

// ── OOR ───────────────────────────────────────────────────

function loadOOR() {
  document.getElementById('oorList').innerHTML =
    '<div class="empty-state"><p>Loading...</p></div>';
  apiFetch('getOOROrders')
    .then(function(data) {
      if (data && data.error) { showToast('Error: ' + data.error, 'error'); return; }
      _oorData = data || [];
      buildLocationChips();
      renderOOR();
    })
    .catch(function() { showToast('Error loading OOR orders', 'error'); });
}

function buildLocationChips() {
  var fixed = ['MCMAUR', 'MCMATL', 'MCMELM', 'MCMROB', 'MCMSSAN'];
  var locs  = ['all'].concat(fixed);
  var html = locs.map(function(loc) {
    var label  = loc === 'all' ? 'All' : loc;
    var active = loc === _activeLocation ? ' active' : '';
    return '<button class="chip' + active + '" onclick="setLocFilter(\'' + loc + '\')">' + label + '</button>';
  }).join('');
  document.getElementById('locationChips').innerHTML = html;
}

function setLocFilter(loc) {
  _activeLocation = loc;
  buildLocationChips();
  renderOOR();
}

function setShipFilter(type) {
  _activeShip = type;
  document.querySelectorAll('#chip-all, #chip-collect, #chip-prepaid').forEach(function(c) {
    c.classList.remove('active');
  });
  document.getElementById('chip-' + type).classList.add('active');
  renderOOR();
}

function renderOOR() {
  var q = document.getElementById('oorSearch')
    ? document.getElementById('oorSearch').value.toLowerCase().trim() : '';
  var filtered = _oorData.filter(function(o) {
    var locMatch    = _activeLocation === 'all' || o.location === _activeLocation;
    var shipMatch   = _activeShip === 'all' ||
      (_activeShip === 'prepaid' &&  o.isPrepaid) ||
      (_activeShip === 'collect' && !o.isPrepaid);
    var searchMatch = !q ||
      String(o.orderNo).toLowerCase().indexOf(q) !== -1 ||
      String(o.po || '').toLowerCase().indexOf(q) !== -1;
    return locMatch && shipMatch && searchMatch;
  });

  var list = document.getElementById('oorList');
  if (!filtered.length) {
    var locLabel = _activeLocation === 'all' ? '' : ' for ' + _activeLocation;
    list.innerHTML =
      '<div class="empty-state"><div class="empty-icon">📦</div>' +
      '<p>No current orders' + locLabel + '.</p></div>';
    return;
  }

  list.innerHTML = filtered.map(function(o, idx) {
    var pd = o.promiseDate
      ? new Date(o.promiseDate).toLocaleDateString('en-US', { month:'short', day:'numeric' })
      : '—';
    var shipBadge = o.isPrepaid
      ? '<span class="badge badge-prepaid">Prepaid</span>'
      : '<span class="badge badge-collect">Collect</span>';
    var locBadge  = '<span class="badge badge-loc">' + (o.location || '—') + '</span>';
    var itemCount = o.items ? o.items.length : 0;
    var items = (o.items || []).map(function(item) {
      return '<div class="oor-item">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="oor-item-code">' + (item.itemCode || '—') + '</div>' +
          '<div class="oor-item-desc">' + (item.description || '') + '</div>' +
        '</div>' +
        '<div class="oor-item-qty">' + (item.qtyOrdered || 0) + ' ' + (item.uom || '') + '</div>' +
      '</div>';
    }).join('');

    return '<div class="oor-card" id="oor-' + idx + '">' +
      '<div class="oor-card-header" onclick="toggleOOR(' + idx + ')">' +
        '<div class="oor-order-icon">📦</div>' +
        '<div class="oor-order-info">' +
          '<div class="oor-order-num">Order #' + o.orderNo + '</div>' +
          '<div class="oor-order-meta">Promise: ' + pd + ' &nbsp;·&nbsp; ' + itemCount + ' item' + (itemCount !== 1 ? 's' : '') + ' &nbsp;·&nbsp; PO: ' + (o.po || '—') + '</div>' +
        '</div>' +
        '<div class="oor-badges">' + locBadge + shipBadge + '</div>' +
        '<span class="oor-chevron">▶</span>' +
      '</div>' +
      '<div class="oor-items">' + items + '</div>' +
    '</div>';
  }).join('');
}

function toggleOOR(idx) {
  var card = document.getElementById('oor-' + idx);
  if (card) card.classList.toggle('open');
}

// ── Package Orders ────────────────────────────────────────

function loadPackage() { filterPackageOrders(); }
function filterPackageOrders() { /* placeholder */ }

// ── New order form ────────────────────────────────────────

function showNewOrder() {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('page-new-order').classList.add('active');
  document.getElementById('orderNumber').value = '';
  document.getElementById('partsContainer').innerHTML = '';
  partCount = 0;
  addPart();
  document.getElementById('orderNumber').focus();
}

function exitForm() {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('tab-scan').classList.add('active');
  document.getElementById('page-scan').classList.add('active');
  loadOrders();
}

// ── Part management ───────────────────────────────────────

function addPart() {
  partCount++;
  var id = partCount;
  var card = document.createElement('div');
  card.className = 'part-card';
  card.id = 'part-' + id;
  card.innerHTML =
    '<div class="part-card-header">' +
      '<span class="part-badge">Part ' + id + '</span>' +
      (id > 1
        ? '<button class="remove-btn" onclick="removePart(' + id + ')" aria-label="Remove part ' + id + '">✕</button>'
        : '<span></span>') +
    '</div>' +
    '<div class="part-field"><label for="pn-' + id + '">Part number</label>' +
      '<div class="input-scan">' +
        '<input type="text" id="pn-' + id + '" placeholder="e.g. 91251A307" autocomplete="off"/>' +
        '<button class="scan-btn" title="Scan part number" onclick="openScanner(\'pn-' + id + '\')">&#9641;</button>' +
      '</div></div>' +
    '<div class="part-field"><label for="lot-' + id + '">Lot number</label>' +
      '<div class="input-scan">' +
        '<input type="text" id="lot-' + id + '" placeholder="e.g. LOT-2024A" autocomplete="off"/>' +
        '<button class="scan-btn" title="Scan lot number" onclick="openScanner(\'lot-' + id + '\')">&#9641;</button>' +
      '</div></div>' +
    '<div class="part-field"><label for="qty-' + id + '">Quantity</label>' +
      '<input class="qty-input" type="number" id="qty-' + id + '" placeholder="0" min="1"/>' +
    '</div>';
  document.getElementById('partsContainer').appendChild(card);
  if (id > 1) card.querySelector('input').focus();
  renumberParts();
}

function removePart(id) {
  var el = document.getElementById('part-' + id);
  if (el) el.remove();
  renumberParts();
}

function renumberParts() {
  document.querySelectorAll('.part-card').forEach(function(card, idx) {
    var badge = card.querySelector('.part-badge');
    if (badge) badge.textContent = 'Part ' + (idx + 1);
  });
}

// ── Save order ────────────────────────────────────────────

function saveOrder() {
  var orderNum = document.getElementById('orderNumber').value.trim();
  if (!orderNum) {
    showToast('Please enter an order number', 'error');
    document.getElementById('orderNumber').focus();
    return;
  }
  var cards = document.querySelectorAll('.part-card');
  var parts = [];
  var valid = true;
  cards.forEach(function(card, idx) {
    if (!valid) return;
    var pn  = card.querySelector('[id^="pn-"]').value.trim();
    var lot = card.querySelector('[id^="lot-"]').value.trim();
    var qty = card.querySelector('[id^="qty-"]').value.trim();
    if (!pn || !lot || !qty) {
      showToast('Part ' + (idx + 1) + ' is incomplete', 'error');
      valid = false; return;
    }
    parts.push({ partNumber: pn, lotNumber: lot, quantity: parseInt(qty) });
  });
  if (!valid) return;

  var saveBtn = document.getElementById('saveBtn');
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  apiFetch('saveScanOrder', { orderNumber: orderNum, parts: parts })
    .then(function(res) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save order';
      if (res.success) {
        showToast('Order ' + orderNum + ' saved', 'success');
        setTimeout(exitForm, 900);
      } else {
        showToast('Error: ' + res.error, 'error');
      }
    })
    .catch(function() {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save order';
      showToast('Error saving order', 'error');
    });
}

// ── Toast ─────────────────────────────────────────────────

function showToast(msg, type) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + (type || 'success');
  setTimeout(function() { t.classList.add('show'); }, 10);
  setTimeout(function() { t.classList.remove('show'); }, 3200);
}

// ── Init ──────────────────────────────────────────────────

loadOrders();
