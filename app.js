// ── Config ────────────────────────────────────────────────
var API = 'https://script.google.com/macros/s/AKfycbzAtTHWoapyH00uvH2eqz55u__9XSnA-oibjgX5BIEDbR01iffHxWeIFsH3IOBGpMbD/exec';

var partCount        = 0;
var _oorData         = [];
var _scanData        = [];
var _activeLocation  = 'all';
var _activeShip      = 'all';
var _scanTargetId    = null;
var _partScanIdx     = null;
var _partScanCode    = null;
var _codeReader      = null;
var _oorItemCache    = {};
var _currentPickData = null;

// ── JSONP ─────────────────────────────────────────────────

function apiFetch(action, payload) {
  return new Promise(function(resolve, reject) {
    var cbName = 'cb_' + Math.random().toString(36).substr(2, 9);
    var script = document.createElement('script');
    var url = API + '?action=' + encodeURIComponent(action) + '&callback=' + cbName;
    if (payload) url += '&payload=' + encodeURIComponent(JSON.stringify(payload));

    var timeout = setTimeout(function() {
      cleanup(); reject(new Error('Request timed out'));
    }, 15000);

    window[cbName] = function(data) { cleanup(); resolve(data); };

    function cleanup() {
      clearTimeout(timeout);
      delete window[cbName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    script.onerror = function() { cleanup(); reject(new Error('Script load error')); };
    script.src = url;
    document.head.appendChild(script);
  });
}

// ── Sound ─────────────────────────────────────────────────

function playGoodBeep() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1100].forEach(function(freq, i) {
      var osc  = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      var t = ctx.currentTime + i * 0.14;
      gain.gain.setValueAtTime(0.35, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
      osc.start(t);
      osc.stop(t + 0.12);
    });
  } catch(e) {}
}

function playBadBeep() {
  try {
    var ctx  = new (window.AudioContext || window.webkitAudioContext)();
    var osc  = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(320, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.5);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } catch(e) {}
}

// ── Part code extraction ──────────────────────────────────

function extractPartCode(itemCode) {
  // itemCode looks like "FBMCM-282VNL000-60   Flat Bar..."
  // Extract just the code before the double spaces
  var trimmed = (itemCode || '').trim();
  var parts   = trimmed.split(/\s{2,}/);
  return parts[0].trim();
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

// ── Scanner (ZXing) ───────────────────────────────────────

function openScanner(targetInputId) {
  _scanTargetId = targetInputId;
  _partScanIdx  = null;
  _partScanCode = null;
  _startScanner('Scanning: ' + (targetInputId === 'orderNumber' ? 'Order number' : targetInputId));
}

function openPartScanner(idx, expectedCode) {
  _partScanIdx  = idx;
  _partScanCode = expectedCode;
  _scanTargetId = null;
  _startScanner('Scanning: Part ' + (idx + 1));
}

function _startScanner(label) {
  document.getElementById('scannerFieldLabel').textContent = label;
  document.getElementById('scannerStatus').textContent = 'Starting camera…';
  document.getElementById('scannerStatus').className = 'scanner-status';
  document.getElementById('scannerOverlay').classList.add('active');

  if (_codeReader) {
    try { _codeReader.reset(); } catch(e) {}
    _codeReader = null;
  }

  setTimeout(function() {
    try {
      _codeReader = new ZXing.BrowserMultiFormatReader();
      _codeReader.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' } } },
        document.getElementById('scannerVideo'),
        function(result, err) {
          if (result) {
            var code = result.getText();
            document.getElementById('scannerStatus').textContent = 'Got it: ' + code;
            document.getElementById('scannerStatus').className = 'scanner-status success';

            if (_partScanIdx !== null) {
              // Part verification scan
              setTimeout(function() {
                closeScanner();
                verifyPartScan(_partScanIdx, _partScanCode, code);
              }, 600);
            } else if (_scanTargetId) {
              // Regular field fill
              var input = document.getElementById(_scanTargetId);
              if (input) {
                input.value = code;
                input.dispatchEvent(new Event('input'));
              }
              showToast('Scanned: ' + code, 'success');
              setTimeout(function() {
                closeScanner();
                // Auto-lookup if order number was scanned
                if (_scanTargetId === 'orderNumber') {
                  setTimeout(lookupOrder, 300);
                }
              }, 600);
            }
          }
          if (err && !(err instanceof ZXing.NotFoundException)) {
            console.warn('Scanner error:', err);
          }
        }
      );
      document.getElementById('scannerStatus').textContent = 'Point camera at barcode…';
    } catch(e) {
      document.getElementById('scannerStatus').textContent = 'Camera error: ' + e.message;
      document.getElementById('scannerStatus').className = 'scanner-status error';
    }
  }, 300);
}

function closeScanner() {
  if (_codeReader) {
    try { _codeReader.reset(); } catch(e) {}
    _codeReader = null;
  }
  document.getElementById('scannerOverlay').classList.remove('active');
  _scanTargetId = null;
}

// ── Part verification ─────────────────────────────────────

function verifyPartScan(idx, expectedCode, scannedCode) {
  var cleanExpected = extractPartCode(expectedCode).toUpperCase();
  var cleanScanned  = scannedCode.trim().toUpperCase();
  var isMatch       = cleanExpected === cleanScanned;

  var card    = document.getElementById('pick-card-' + idx);
  var input   = document.getElementById('pick-scan-' + idx);
  var status  = document.getElementById('pick-status-' + idx);
  var qtyInput = document.getElementById('pick-qty-' + idx);

  if (input) {
    input.value = scannedCode;
    input.className = isMatch ? 'input-match' : 'input-no-match';
  }

  if (card) {
    card.classList.remove('match', 'no-match');
    card.classList.add(isMatch ? 'match' : 'no-match');
  }

  if (status) {
    if (isMatch) {
      status.textContent = '✓ Match — part verified';
      status.className = 'pick-status match';
      playGoodBeep();
      showToast('✓ Part matched!', 'success');
      if (qtyInput) setTimeout(function() { qtyInput.focus(); }, 100);
    } else {
      status.textContent = '✗ No match — expected: ' + extractPartCode(expectedCode);
      status.className = 'pick-status no-match';
      playBadBeep();
      showToast('✗ Wrong part scanned', 'error');
    }
  }
}

// ── Scan Orders list ──────────────────────────────────────

function loadOrders() {
  document.getElementById('orderList').innerHTML =
    '<div class="empty-state"><p>Loading...</p></div>';
  apiFetch('getScanOrders')
    .then(function(data) {
      _scanData = Array.isArray(data) ? data : [];
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
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>No orders yet. Tap + to start a pick.</p></div>';
    return;
  }
  list.innerHTML = orders.map(function(o) {
    var date  = o.timestamp ? new Date(o.timestamp).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—';
    var count = o.items ? o.items.length : 0;
    var badge = o.allMatch
      ? '<span class="badge badge-ok">All verified</span>'
      : '<span class="badge badge-warn">Mismatches</span>';
    return '<div class="order-card">' +
      '<div class="order-icon">📋</div>' +
      '<div class="order-info">' +
        '<div class="order-num">Order #' + o.orderNumber + '</div>' +
        '<div class="order-meta">' + date + (o.po ? ' &nbsp;·&nbsp; PO: ' + o.po : '') + ' &nbsp;·&nbsp; ' + count + ' item' + (count !== 1 ? 's' : '') + '</div>' +
      '</div>' +
      badge +
    '</div>';
  }).join('');
}

// ── New order lookup ──────────────────────────────────────

function showNewOrder() {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('page-new-order').classList.add('active');
  document.getElementById('phase-lookup').style.display = 'block';
  document.getElementById('phase-pick').style.display   = 'none';
  document.getElementById('orderNumber').value = '';
  document.getElementById('lookupError').style.display = 'none';
  _currentPickData = null;
  setTimeout(function() { document.getElementById('orderNumber').focus(); }, 100);
}

function lookupOrder() {
  var num = document.getElementById('orderNumber').value.trim();
  if (!num) {
    document.getElementById('lookupError').textContent = 'Please enter an order number.';
    document.getElementById('lookupError').style.display = 'block';
    return;
  }

  document.getElementById('lookupError').style.display = 'none';
  var btn = document.getElementById('lookupBtn');
  btn.disabled = true;
  btn.textContent = 'Looking up…';

  apiFetch('getFullOOROrder', { orderNo: num })
    .then(function(data) {
      btn.disabled = false;
      btn.textContent = 'Look up order';

      if (data && data.error) {
        document.getElementById('lookupError').textContent = data.error;
        document.getElementById('lookupError').style.display = 'block';
        return;
      }

      _currentPickData = data;
      showPickPhase(data);
    })
    .catch(function() {
      btn.disabled = false;
      btn.textContent = 'Look up order';
      document.getElementById('lookupError').textContent = 'Error looking up order. Check your connection.';
      document.getElementById('lookupError').style.display = 'block';
    });
}

function showPickPhase(data) {
  document.getElementById('phase-lookup').style.display = 'none';
  document.getElementById('phase-pick').style.display   = 'block';

  var h  = data.header;
  var pd = h.promiseDate ? new Date(h.promiseDate).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—';

  document.getElementById('pickOrderHeader').innerHTML =
    '<div class="pick-order-num">Order #' + h.orderNo + '</div>' +
    '<div class="pick-order-meta">' +
      '<span class="pick-order-po">PO: ' + (h.po || '—') + '</span>' +
      '&nbsp;&nbsp;·&nbsp;&nbsp;' + (h.location || '—') +
      '&nbsp;&nbsp;·&nbsp;&nbsp;' + (h.isPrepaid ? 'Prepaid' : 'Collect') +
      '&nbsp;&nbsp;·&nbsp;&nbsp;Promise: ' + pd +
    '</div>';

  document.getElementById('pickItemsList').innerHTML = (data.items || []).map(function(item, idx) {
    var code = extractPartCode(item.itemCode);
    return '<div class="pick-item-card" id="pick-card-' + idx + '">' +
      '<div class="pick-item-top">' +
        '<div class="pick-item-code">' + code + '</div>' +
        '<div class="pick-item-desc">' + (item.description || '') + '</div>' +
        '<span class="pick-item-req">Required: ' + item.qtyOrdered + ' ' + item.uom + '</span>' +
      '</div>' +

      '<div class="pick-scan-row">' +
        '<input type="text" id="pick-scan-' + idx + '" placeholder="Scan or type part #" autocomplete="off"' +
          ' onchange="verifyPartScan(' + idx + ', \'' + code.replace(/'/g, "\\'") + '\', this.value)"/>' +
        '<button class="scan-btn" title="Scan part" onclick="openPartScanner(' + idx + ', \'' + code.replace(/'/g, "\\'") + '\')">' +
          '&#9641;' +
        '</button>' +
      '</div>' +

      '<div class="pick-status" id="pick-status-' + idx + '"></div>' +

      '<div class="pick-qty-row">' +
        '<label>Qty pulled (' + item.uom + ')</label>' +
        '<input type="number" id="pick-qty-' + idx + '" placeholder="0" min="0"/>' +
      '</div>' +
    '</div>';
  }).join('');
}

function backToLookup() {
  document.getElementById('phase-lookup').style.display = 'block';
  document.getElementById('phase-pick').style.display   = 'none';
  document.getElementById('lookupError').style.display  = 'none';
}

function savePick() {
  if (!_currentPickData) return;
  var h     = _currentPickData.header;
  var items = _currentPickData.items || [];
  var saveBtn = document.getElementById('savePickBtn');

  var payload = {
    orderNumber: String(h.orderNo),
    po:          h.po || '',
    items:       items.map(function(item, idx) {
      var expectedCode = extractPartCode(item.itemCode);
      var scannedCode  = (document.getElementById('pick-scan-' + idx) || {}).value || '';
      var qtyPulled    = parseFloat((document.getElementById('pick-qty-' + idx) || {}).value || 0);
      var match        = scannedCode.trim().toUpperCase() === expectedCode.toUpperCase();
      return {
        expectedCode: expectedCode,
        scannedCode:  scannedCode,
        qtyRequired:  item.qtyOrdered,
        qtyPulled:    qtyPulled,
        match:        match
      };
    })
  };

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  apiFetch('saveScanOrder', payload)
    .then(function(res) {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save pick';
      if (res.success) {
        showToast('Pick saved for order #' + h.orderNo, 'success');
        setTimeout(exitForm, 900);
      } else {
        showToast('Error: ' + (res.error || 'Unknown error'), 'error');
      }
    })
    .catch(function() {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save pick';
      showToast('Error saving pick', 'error');
    });
}

function exitForm() {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('tab-scan').classList.add('active');
  document.getElementById('page-scan').classList.add('active');
  loadOrders();
}

// ── OOR ───────────────────────────────────────────────────

function loadOOR() {
  _oorItemCache = {};
  document.getElementById('oorList').innerHTML =
    '<div class="empty-state"><p>Loading...</p></div>';
  apiFetch('getOOROrderHeaders')
    .then(function(data) {
      if (data && data.error) { showToast('Error: ' + data.error, 'error'); return; }
      _oorData = Array.isArray(data) ? data : [];
      buildLocationChips();
      renderOOR();
    })
    .catch(function() { showToast('Error loading OOR orders', 'error'); });
}

function buildLocationChips() {
  var fixed = ['MCMAUR', 'MCMATL', 'MCMELM', 'MCMROB', 'MCMSAN', 'MCMFWO'];
  var locs  = ['all'].concat(fixed);
  var html  = locs.map(function(loc) {
    var active = loc === _activeLocation ? ' active' : '';
    return '<button class="chip' + active + '" onclick="setLocFilter(\'' + loc + '\')">' + (loc === 'all' ? 'All' : loc) + '</button>';
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
  document.querySelectorAll('#chip-all, #chip-collect, #chip-prepaid').forEach(function(c) { c.classList.remove('active'); });
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
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📦</div><p>No current orders' + locLabel + '.</p></div>';
    return;
  }

  list.innerHTML = filtered.map(function(o, idx) {
    var pd        = o.promiseDate ? new Date(o.promiseDate).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '—';
    var shipBadge = o.isPrepaid ? '<span class="badge badge-prepaid">Prepaid</span>' : '<span class="badge badge-collect">Collect</span>';
    var locBadge  = '<span class="badge badge-loc">' + (o.location || '—') + '</span>';

    return '<div class="oor-card" id="oor-' + idx + '">' +
      '<div class="oor-card-header" onclick="toggleOOR(' + idx + ', \'' + o.orderNo + '\')">' +
        '<div class="oor-order-icon">📦</div>' +
        '<div class="oor-order-info">' +
          '<div class="oor-order-num">Order #' + o.orderNo + '</div>' +
          '<div class="oor-order-meta">Promise: ' + pd + ' &nbsp;·&nbsp; ' + o.itemCount + ' item' + (o.itemCount !== 1 ? 's' : '') + ' &nbsp;·&nbsp; PO: ' + (o.po || '—') + '</div>' +
        '</div>' +
        '<div class="oor-badges">' + locBadge + shipBadge + '</div>' +
        '<span class="oor-chevron">▶</span>' +
      '</div>' +
      '<div class="oor-items" id="oor-items-' + idx + '"><div class="oor-item-loading">Loading items…</div></div>' +
    '</div>';
  }).join('');
}

function toggleOOR(idx, orderNo) {
  var card     = document.getElementById('oor-' + idx);
  var itemsDiv = document.getElementById('oor-items-' + idx);
  if (!card) return;
  var isOpen = card.classList.contains('open');
  if (isOpen) { card.classList.remove('open'); return; }
  card.classList.add('open');
  if (_oorItemCache[orderNo]) { renderOORItems(itemsDiv, _oorItemCache[orderNo]); return; }
  itemsDiv.innerHTML = '<div class="oor-item-loading">Loading items…</div>';
  apiFetch('getOOROrderItems', { orderNo: String(orderNo) })
    .then(function(items) {
      if (!Array.isArray(items)) items = [];
      _oorItemCache[orderNo] = items;
      renderOORItems(itemsDiv, items);
    })
    .catch(function() { itemsDiv.innerHTML = '<div class="oor-item-loading">Error loading items.</div>'; });
}

function renderOORItems(container, items) {
  if (!items.length) { container.innerHTML = '<div class="oor-item-loading">No items found.</div>'; return; }
  container.innerHTML = items.map(function(item) {
    return '<div class="oor-item">' +
      '<div style="flex:1;min-width:0">' +
        '<div class="oor-item-code">' + (item.itemCode || '—') + '</div>' +
        '<div class="oor-item-desc">' + (item.description || '') + '</div>' +
      '</div>' +
      '<div class="oor-item-qty">' + (item.qtyOrdered || 0) + ' ' + (item.uom || '') + '</div>' +
    '</div>';
  }).join('');
}

// ── Package Orders ────────────────────────────────────────

function loadPackage() { filterPackageOrders(); }
function filterPackageOrders() {}

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
