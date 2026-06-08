// ── Config ────────────────────────────────────────────────
var API = 'https://artek-proxy.parkwall12.workers.dev';

var partCount        = 0;
var _oorData         = [];
var _scanData        = [];
var _packageData     = [];
var _activeLocation  = 'all';
var _activeShip      = 'all';
var _scanTargetId    = null;
var _partScanIdx     = null;
var _partScanCode    = null;
var _codeReader      = null;
var _oorItemCache    = {};
var _currentPickData = null;
var _currentPkgData  = null;
var _pkgBoxes        = {};
var _sessionPicks    = [];

// ── JSONP ─────────────────────────────────────────────────

function apiFetch(action, payload) {
  var url = API + '?action=' + encodeURIComponent(action);
  if (payload) url += '&payload=' + encodeURIComponent(JSON.stringify(payload));
  return fetch(url).then(function(r) { return r.json(); });
}

// ── Sound ─────────────────────────────────────────────────

function playGoodBeep() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1100].forEach(function(freq, i) {
      var osc = ctx.createOscillator(); var gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.value = freq;
      var t = ctx.currentTime + i * 0.15;
      gain.gain.setValueAtTime(0.35, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
      osc.start(t); osc.stop(t + 0.13);
    });
  } catch(e) {}
}

function playBadBeep() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator(); var gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(300, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(80, ctx.currentTime + 0.5);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.5);
  } catch(e) {}
}

// ── Code helpers ──────────────────────────────────────────

function extractPartCode(itemCode) {
  return (itemCode || '').trim().split(/\s{2,}/)[0].trim();
}

function extractMiddleCode(code) {
  var parts = (code || '').trim().split('-');
  return parts.length >= 2 ? parts[1].trim().toUpperCase() : (code || '').trim().toUpperCase();
}

// ── Tab routing ───────────────────────────────────────────

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(function(b) { b.classList.remove('active'); });
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('tab-' + tab).classList.add('active');
  document.getElementById('page-' + tab).classList.add('active');
  if (tab === 'scan')    loadOrders();
  if (tab === 'oor')     loadOOR();
  if (tab === 'package') loadPackageOrders();
}

// ── Scanner ───────────────────────────────────────────────

function openScanner(targetInputId) {
  _scanTargetId = targetInputId;
  _partScanIdx  = null;
  _partScanCode = null;
  var label = targetInputId === 'orderNumber' ? 'Order number' :
              targetInputId.startsWith('pick-lot-') ? 'Lot number' : 'Part number';
  _startScanner('Scanning: ' + label);
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

  if (_codeReader) { try { _codeReader.reset(); } catch(e) {} _codeReader = null; }

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
              setTimeout(function() { closeScanner(); verifyPartScan(_partScanIdx, _partScanCode, code); }, 500);
            } else if (_scanTargetId) {
              var input = document.getElementById(_scanTargetId);
              if (input) { input.value = code; input.dispatchEvent(new Event('input')); }
              showToast('Scanned: ' + code, 'success');
              setTimeout(function() {
                closeScanner();
                if (_scanTargetId === 'orderNumber') setTimeout(lookupOrder, 300);
              }, 500);
            }
          }
          if (err && !(err instanceof ZXing.NotFoundException)) console.warn(err);
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
  if (_codeReader) { try { _codeReader.reset(); } catch(e) {} _codeReader = null; }
  document.getElementById('scannerOverlay').classList.remove('active');
  _scanTargetId = null;
}

// ── Part verification ─────────────────────────────────────

function verifyPartScan(idx, expectedCode, scannedCode) {
  var expectedMiddle = extractMiddleCode(expectedCode);
  var scannedMiddle  = extractMiddleCode(scannedCode);
  var isMatch        = expectedMiddle === scannedMiddle;

  var card     = document.getElementById('pick-card-' + idx);
  var input    = document.getElementById('pick-scan-' + idx);
  var status   = document.getElementById('pick-status-' + idx);
  var qtyInput = document.getElementById('pick-qty-' + idx);

  if (input)  { input.value = scannedCode; input.className = isMatch ? 'input-match' : 'input-no-match'; }
  if (card)   { card.classList.remove('match','no-match'); card.classList.add(isMatch ? 'match' : 'no-match'); }
  if (status) {
    if (isMatch) {
      status.textContent = '✓ Match — ' + expectedMiddle + ' verified';
      status.className = 'pick-status match';
      playGoodBeep();
      showToast('✓ Part matched!', 'success');
      if (qtyInput) setTimeout(function() { qtyInput.focus(); }, 100);
    } else {
      status.textContent = '✗ No match — expected: ' + expectedMiddle + ' · got: ' + scannedMiddle;
      status.className = 'pick-status no-match';
      playBadBeep();
      showToast('✗ Wrong part!', 'error');
    }
  }
}

// ── Scan Orders list ──────────────────────────────────────

function loadOrders() {
  document.getElementById('orderList').innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
  apiFetch('getScanOrders')
    .then(function(data) { _scanData = Array.isArray(data) ? data : []; filterScanOrders(); })
    .catch(function() { showToast('Error loading orders', 'error'); });
}

function filterScanOrders() {
  var q = document.getElementById('scanSearch') ? document.getElementById('scanSearch').value.toLowerCase().trim() : '';
  renderOrders(_scanData.filter(function(o) { return !q || String(o.orderNumber).toLowerCase().indexOf(q) !== -1; }));
}

function renderOrders(orders) {
  var list = document.getElementById('orderList');
  if (!orders || !orders.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📋</div><p>No orders yet. Tap + to start a pick.</p></div>';
    return;
  }
  list.innerHTML = orders.map(function(o) {
    var date  = o.timestamp ? new Date(o.timestamp).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : '—';
    var badge = o.status === 'Complete'  ? '<span class="badge badge-complete">Complete</span>'  :
                o.status === 'Packaging' ? '<span class="badge badge-inprog">Packaging</span>'   :
                '<span class="badge badge-ready">Picked</span>';
    return '<div class="order-card">' +
      '<div class="order-icon">📋</div>' +
      '<div class="order-info">' +
        '<div class="order-num">Order #' + o.orderNumber + '</div>' +
        '<div class="order-meta">' + date + (o.location ? ' &nbsp;·&nbsp; ' + o.location : '') + (o.po ? ' &nbsp;·&nbsp; PO: ' + o.po : '') + '</div>' +
      '</div>' + badge +
    '</div>';
  }).join('');
}

// ── Order lookup ──────────────────────────────────────────

function showNewOrder() {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('page-new-order').classList.add('active');
  document.getElementById('phase-lookup').style.display = 'block';
  document.getElementById('phase-pick').style.display   = 'none';
  document.getElementById('orderNumber').value = '';
  document.getElementById('lookupError').style.display  = 'none';
  _currentPickData = null;
  renderSessionPicks();
  setTimeout(function() { document.getElementById('orderNumber').focus(); }, 100);
}

function renderSessionPicks() {
  var wrap = document.getElementById('sessionPicksWrap');
  var list = document.getElementById('sessionPicksList');
  if (!_sessionPicks.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  list.innerHTML = _sessionPicks.map(function(p) {
    return '<div class="session-pick-card">' +
      '<div class="session-pick-icon">✓</div>' +
      '<div class="session-pick-info">' +
        '<div class="session-pick-num">Order #' + p.orderNumber + '</div>' +
        '<div class="session-pick-meta">' +
          (p.location || '') +
          (p.po ? ' &nbsp;·&nbsp; PO: ' + p.po : '') +
          ' &nbsp;·&nbsp; ' + p.itemCount + ' item' + (p.itemCount !== 1 ? 's' : '') +
        '</div>' +
      '</div>' +
      '<span class="badge badge-ok">Picked</span>' +
    '</div>';
  }).join('');
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
  btn.disabled = true; btn.textContent = 'Looking up…';

  apiFetch('getFullOOROrder', { orderNo: num })
    .then(function(data) {
      btn.disabled = false; btn.textContent = 'Look up order';
      if (data && data.error) {
        document.getElementById('lookupError').textContent = data.error;
        document.getElementById('lookupError').style.display = 'block';
        return;
      }
      _currentPickData = data;
      showPickPhase(data);
    })
    .catch(function() {
      btn.disabled = false; btn.textContent = 'Look up order';
      document.getElementById('lookupError').textContent = 'Error looking up order. Check connection.';
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
      '<span class="pick-order-po">PO: ' + (h.po||'—') + '</span>' +
      ' &nbsp;·&nbsp; ' + (h.location||'—') +
      ' &nbsp;·&nbsp; ' + (h.isPrepaid ? 'Prepaid' : 'Collect') +
      ' &nbsp;·&nbsp; Promise: ' + pd +
    '</div>';

  document.getElementById('pickItemsList').innerHTML = (data.items||[]).map(function(item, idx) {
    var code     = extractPartCode(item.itemCode);
    var safeCode = code.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return '<div class="pick-item-card" id="pick-card-' + idx + '">' +
      '<div class="pick-item-top">' +
        '<div class="pick-item-code">' + code + '</div>' +
        '<div class="pick-item-desc">' + (item.description||'') + '</div>' +
        '<span class="pick-item-req">Required: ' + item.qtyOrdered + ' ' + item.uom + '</span>' +
      '</div>' +

      '<div class="pick-label">Part number</div>' +
      '<div class="pick-scan-row">' +
        '<input type="text" id="pick-scan-' + idx + '" placeholder="Scan or type part #" autocomplete="off"' +
          ' onchange="verifyPartScan(' + idx + ',\'' + safeCode + '\',this.value)"/>' +
        '<button class="scan-btn" onclick="openPartScanner(' + idx + ',\'' + safeCode + '\')">&#9641;</button>' +
      '</div>' +
      '<div class="pick-status" id="pick-status-' + idx + '"></div>' +

      '<div class="pick-label">Lot number</div>' +
      '<div class="pick-scan-row">' +
        '<input type="text" id="pick-lot-' + idx + '" placeholder="Scan or type lot #" autocomplete="off"/>' +
        '<button class="scan-btn" onclick="openScanner(\'pick-lot-' + idx + '\')">&#9641;</button>' +
      '</div>' +

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
  document.getElementById('orderNumber').value = '';
  setTimeout(function() { document.getElementById('orderNumber').focus(); }, 100);
}

function savePick() {
  if (!_currentPickData) return;
  var h     = _currentPickData.header;
  var items = _currentPickData.items || [];
  var btn   = document.getElementById('savePickBtn');

  var payload = {
    orderNumber: String(h.orderNo),
    po:          h.po       || '',
    location:    h.location || '',
    items: items.map(function(item, idx) {
      var expectedCode = extractPartCode(item.itemCode);
      var scannedCode  = (document.getElementById('pick-scan-' + idx)||{}).value || '';
      var lotNumber    = (document.getElementById('pick-lot-'  + idx)||{}).value || '';
      var qtyPulled    = parseFloat((document.getElementById('pick-qty-' + idx)||{}).value || 0);
      var match        = extractMiddleCode(scannedCode) === extractMiddleCode(expectedCode);
      return {
        expectedCode: expectedCode,
        description:  item.description || '',
        uom:          item.uom || '',
        lotNumber:    lotNumber,
        qtyRequired:  item.qtyOrdered,
        qtyPulled:    qtyPulled,
        match:        match
      };
    })
  };

  btn.disabled = true; btn.textContent = 'Saving…';

  apiFetch('saveScanOrder', payload)
    .then(function(res) {
      btn.disabled = false; btn.textContent = 'Save pick';
      if (res && res.success) {
        _sessionPicks.unshift({
          orderNumber: String(h.orderNo),
          po:          h.po       || '',
          location:    h.location || '',
          itemCount:   items.length
        });
        showToast('Order #' + h.orderNo + ' picked — ready to package', 'success');
        document.getElementById('phase-pick').style.display   = 'none';
        document.getElementById('phase-lookup').style.display = 'block';
        document.getElementById('orderNumber').value = '';
        document.getElementById('lookupError').style.display  = 'none';
        _currentPickData = null;
        renderSessionPicks();
        setTimeout(function() { document.getElementById('orderNumber').focus(); }, 100);
      } else {
        showToast('Error: ' + ((res && res.error) || 'Unknown error'), 'error');
      }
    })
    .catch(function(err) {
      btn.disabled = false; btn.textContent = 'Save pick';
      showToast('Error: ' + (err.message || 'check connection'), 'error');
    });
}

function exitForm() {
  _sessionPicks = [];
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('tab-scan').classList.add('active');
  document.getElementById('page-scan').classList.add('active');
  loadOrders();
}

// ── Package Orders list ───────────────────────────────────

function loadPackage() { loadPackageOrders(); }

function loadPackageOrders() {
  document.getElementById('packageList').innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
  apiFetch('getPackageOrders')
    .then(function(data) { _packageData = Array.isArray(data) ? data : []; filterPackageOrders(); })
    .catch(function() { showToast('Error loading package orders', 'error'); });
}

function filterPackageOrders() {
  var q = document.getElementById('packageSearch') ? document.getElementById('packageSearch').value.toLowerCase().trim() : '';
  renderPackageList(_packageData.filter(function(o) { return !q || String(o.orderNumber).toLowerCase().indexOf(q) !== -1; }));
}

function renderPackageList(orders) {
  var list = document.getElementById('packageList');
  if (!orders || !orders.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📦</div><p>No orders ready for packaging.<br>Complete a scan first.</p></div>';
    return;
  }
  list.innerHTML = orders.map(function(o) {
    var badge = o.status === 'Packaging'
      ? '<span class="badge badge-inprog">In progress</span>'
      : '<span class="badge badge-ready">Ready</span>';
    return '<div class="order-card" onclick="openPackageOrder(\'' + o.orderNumber + '\')">' +
      '<div class="order-icon">📦</div>' +
      '<div class="order-info">' +
        '<div class="order-num">Order #' + o.orderNumber + '</div>' +
        '<div class="order-meta">' + (o.location||'—') + (o.po ? ' &nbsp;·&nbsp; PO: ' + o.po : '') + '</div>' +
      '</div>' + badge +
    '</div>';
  }).join('');
}

// ── Package order detail ──────────────────────────────────

function openPackageOrder(orderNo) {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('page-package-detail').classList.add('active');
  _pkgBoxes = {};

  document.getElementById('pkgOrderHeader').innerHTML =
    '<div class="pick-order-header"><p style="color:#94a3b8">Loading…</p></div>';
  document.getElementById('pkgItemsList').innerHTML = '';

  apiFetch('getPackageOrder', { orderNo: String(orderNo) })
    .then(function(data) {
      if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
      _currentPkgData = data;

      (data.items||[]).forEach(function(item, idx) {
        var savedBoxes = data.boxes && data.boxes[item.itemCode];
        _pkgBoxes[idx] = savedBoxes && savedBoxes.length
          ? savedBoxes.map(function(b) { return { qty:b.qtyInBox||0, weight:b.weight||0, photoUrl:null }; })
          : [{ qty:item.qtyPulled||0, weight:0, photoUrl:null }];
      });

      renderPackageDetail(data);
    })
    .catch(function() { showToast('Error loading order', 'error'); });
}

function renderPackageDetail(data) {
  var h = data.header;
  document.getElementById('pkgOrderHeader').innerHTML =
    '<div class="pick-order-header">' +
      '<div class="pick-order-num">Order #' + h.orderNumber + '</div>' +
      '<div class="pick-order-meta">' +
        '<span class="pick-order-po">PO: ' + (h.po||'—') + '</span>' +
        ' &nbsp;·&nbsp; ' + (h.location||'—') +
        ' &nbsp;·&nbsp; Status: ' + h.status +
      '</div>' +
    '</div>';

  document.getElementById('pkgItemsList').innerHTML = (data.items||[]).map(function(item, idx) {
    return '<div class="pkg-item-card">' +
      '<div class="pkg-item-header">' +
        '<div class="pick-item-code">' + item.itemCode + '</div>' +
        '<div class="pkg-item-meta">' +
          'Lot: <strong>' + (item.lotNumber||'—') + '</strong>' +
          ' &nbsp;·&nbsp; Pulled: <strong>' + item.qtyPulled + ' ' + item.uom + '</strong>' +
          ' &nbsp;·&nbsp; Required: <strong>' + item.qtyRequired + ' ' + item.uom + '</strong>' +
        '</div>' +
      '</div>' +
      '<div id="boxes-' + idx + '"></div>' +
      '<button class="add-box-btn" onclick="addBox(' + idx + ')">+ Add another box</button>' +
    '</div>';
  }).join('');

  (data.items||[]).forEach(function(item, idx) { renderItemBoxes(idx); });
}

function renderItemBoxes(itemIdx) {
  var boxes     = _pkgBoxes[itemIdx] || [{}];
  var container = document.getElementById('boxes-' + itemIdx);
  if (!container) return;

  container.innerHTML = boxes.map(function(box, bIdx) {
    return '<div class="box-card" id="box-' + itemIdx + '-' + bIdx + '">' +
      '<div class="box-header">' +
        '<span class="box-label">Box ' + (bIdx+1) + ' of ' + boxes.length + '</span>' +
        (boxes.length > 1 ? '<button class="remove-btn" onclick="removeBox(' + itemIdx + ',' + bIdx + ')">✕</button>' : '') +
      '</div>' +
      '<div class="box-fields">' +
        '<div class="box-field"><label>Qty in box</label>' +
          '<input type="number" value="' + (box.qty||'') + '" placeholder="0" oninput="updateBoxField(' + itemIdx + ',' + bIdx + ',\'qty\',this.value)"/>' +
        '</div>' +
        '<div class="box-field"><label>Weight (lbs)</label>' +
          '<input type="number" value="' + (box.weight||'') + '" placeholder="0" oninput="updateBoxField(' + itemIdx + ',' + bIdx + ',\'weight\',this.value)"/>' +
        '</div>' +
        '<div class="box-field full"><label>Photo (optional)</label>' +
          '<input type="file" accept="image/*" capture="environment" onchange="handleBoxPhoto(' + itemIdx + ',' + bIdx + ',this)"/>' +
          '<div class="photo-preview" id="photo-preview-' + itemIdx + '-' + bIdx + '">' +
            (box.photoUrl ? '<img src="' + box.photoUrl + '"/>' : '') +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}

function addBox(itemIdx) {
  if (!_pkgBoxes[itemIdx]) _pkgBoxes[itemIdx] = [];
  _pkgBoxes[itemIdx].push({ qty:0, weight:0, photoUrl:null });
  renderItemBoxes(itemIdx);
}

function removeBox(itemIdx, boxIdx) {
  if (!_pkgBoxes[itemIdx] || _pkgBoxes[itemIdx].length <= 1) return;
  _pkgBoxes[itemIdx].splice(boxIdx, 1);
  renderItemBoxes(itemIdx);
}

function updateBoxField(itemIdx, boxIdx, field, value) {
  if (!_pkgBoxes[itemIdx] || !_pkgBoxes[itemIdx][boxIdx]) return;
  _pkgBoxes[itemIdx][boxIdx][field] = parseFloat(value) || 0;
}

function handleBoxPhoto(itemIdx, boxIdx, input) {
  if (!input.files || !input.files[0]) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    if (!_pkgBoxes[itemIdx]) _pkgBoxes[itemIdx] = [];
    if (!_pkgBoxes[itemIdx][boxIdx]) _pkgBoxes[itemIdx][boxIdx] = {};
    _pkgBoxes[itemIdx][boxIdx].photoUrl = e.target.result;
    var preview = document.getElementById('photo-preview-' + itemIdx + '-' + boxIdx);
    if (preview) preview.innerHTML = '<img src="' + e.target.result + '"/>';
  };
  reader.readAsDataURL(input.files[0]);
}

function syncBoxesFromDOM() {
  if (!_currentPkgData) return;
  (_currentPkgData.items||[]).forEach(function(item, idx) {
    var boxes = _pkgBoxes[idx] || [];
    boxes.forEach(function(box, bIdx) {
      var el = document.getElementById('box-' + idx + '-' + bIdx);
      if (!el) return;
      var nums = el.querySelectorAll('input[type="number"]');
      if (nums[0]) _pkgBoxes[idx][bIdx].qty    = parseFloat(nums[0].value || 0);
      if (nums[1]) _pkgBoxes[idx][bIdx].weight  = parseFloat(nums[1].value || 0);
    });
  });
}

function collectPackagePayload(complete) {
  if (!_currentPkgData) return null;
  syncBoxesFromDOM();
  var h     = _currentPkgData.header;
  var items = _currentPkgData.items || [];
  var boxes = [];

  items.forEach(function(item, idx) {
    var itemBoxes  = _pkgBoxes[idx] || [{}];
    var totalBoxes = itemBoxes.length;
    itemBoxes.forEach(function(box, bIdx) {
      boxes.push({ itemCode:item.itemCode, boxIndex:bIdx+1, totalBoxes:totalBoxes, qtyInBox:box.qty||0, weight:box.weight||0 });
    });
  });

  return { orderNumber:h.orderNumber, boxes:boxes, complete:complete };
}

function savePackageDraft() {
  var payload = collectPackagePayload(false);
  if (!payload) return;
  var btn = document.getElementById('savePkgBtn');
  btn.disabled = true; btn.textContent = 'Saving…';

  apiFetch('savePackageData', payload)
    .then(function(res) {
      btn.disabled = false; btn.textContent = 'Save for later';
      if (res.success) showToast('Saved!', 'success');
      else showToast('Error: ' + (res.error||''), 'error');
    })
    .catch(function() { btn.disabled = false; btn.textContent = 'Save for later'; showToast('Error saving', 'error'); });
}

function completeOrder() {
  var payload = collectPackagePayload(true);
  if (!payload) return;
  var btn = document.getElementById('completePkgBtn');
  btn.disabled = true; btn.textContent = 'Completing…';

  apiFetch('savePackageData', payload)
    .then(function(res) {
      btn.disabled = false; btn.textContent = '✓ Complete order & generate tags';
      if (res.success) {
        showToast('Order complete! Generating tags…', 'success');
        setTimeout(function() { generatePDFTags(); }, 400);
        setTimeout(exitPackageDetail, 1800);
      } else {
        showToast('Error: ' + (res.error||''), 'error');
      }
    })
    .catch(function() { btn.disabled = false; btn.textContent = '✓ Complete order & generate tags'; showToast('Error', 'error'); });
}

function exitPackageDetail() {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('tab-package').classList.add('active');
  document.getElementById('page-package').classList.add('active');
  loadPackageOrders();
}

// ── PDF Generation ────────────────────────────────────────

function renderPDFTag(doc, data, photoUrl) {
  doc.setFillColor(26, 42, 74);
  doc.rect(0, 0, 100, 13, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(10);
  doc.setFont(undefined, 'bold');
  doc.text('ArTek WMS', 50, 9, { align:'center' });

  doc.setTextColor(30, 41, 59);
  var y = 20;
  var fields = [
    ['Location', String(data.location || '—')],
    ['PO',       String(data.po       || '—')],
    ['Part #',   String(data.partCode || '—')],
    ['Lot #',    String(data.lotNumber|| '—')],
    ['Qty',      String(data.qty) + ' ' + String(data.uom||'')],
    ['Weight',   String(data.weight)  + ' lbs'],
    ['Package',  'Box ' + data.boxIndex + ' of ' + data.totalBoxes]
  ];

  fields.forEach(function(f) {
    doc.setFont(undefined, 'bold');   doc.setFontSize(7.5); doc.text(f[0] + ':', 7, y);
    doc.setFont(undefined, 'normal'); doc.setFontSize(8);   doc.text(f[1], 32, y);
    y += 6.5;
  });

  if (photoUrl) {
    try { doc.addImage(photoUrl, 'JPEG', 64, 15, 30, 48); } catch(ex) {}
  }

  doc.setDrawColor(180, 180, 180);
  doc.setLineWidth(0.4);
  doc.rect(2, 14, 96, 53);
}

function generatePDFTags() {
  if (!_currentPkgData) return;
  var h     = _currentPkgData.header;
  var items = _currentPkgData.items || [];
  var doc   = null;

  try {
    var jsPDFLib = window.jspdf ? window.jspdf.jsPDF : (window.jsPDF || null);
    if (!jsPDFLib) { showToast('PDF library not loaded', 'error'); return; }

    items.forEach(function(item, idx) {
      var itemBoxes = _pkgBoxes[idx] || [{ qty:item.qtyPulled||0, weight:0, photoUrl:null }];
      itemBoxes.forEach(function(box, bIdx) {
        if (!doc) {
          doc = new jsPDFLib({ orientation:'landscape', unit:'mm', format:[100, 70] });
        } else {
          doc.addPage([100, 70], 'landscape');
        }
        renderPDFTag(doc, {
          location:   h.location    || '—',
          po:         h.po          || '—',
          partCode:   item.itemCode,
          lotNumber:  item.lotNumber || '—',
          qty:        box.qty        || 0,
          uom:        item.uom       || '',
          weight:     box.weight     || 0,
          boxIndex:   bIdx + 1,
          totalBoxes: itemBoxes.length
        }, box.photoUrl || null);
      });
    });

    if (doc) { doc.save('ArTek_Order_' + h.orderNumber + '_tags.pdf'); showToast('PDF tags downloaded!', 'success'); }
  } catch(e) { showToast('PDF error: ' + e.message, 'error'); }
}

function reprintPDF(orderNo) {
  apiFetch('getCompletedOrderDetails', { orderNo: String(orderNo) })
    .then(function(data) {
      if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
      var hdr   = data.header;
      var items = data.items  || [];
      var boxes = data.boxes  || {};

      try {
        var jsPDFLib = window.jspdf ? window.jspdf.jsPDF : (window.jsPDF || null);
        if (!jsPDFLib) { showToast('PDF library not loaded', 'error'); return; }
        var doc = null;

        items.forEach(function(item) {
          var code      = item.itemCode;
          var itemBoxes = boxes[code] || [{ boxIndex:1, totalBoxes:1, qtyInBox:item.qtyPulled||0, weight:0 }];
          itemBoxes.forEach(function(box) {
            if (!doc) {
              doc = new jsPDFLib({ orientation:'landscape', unit:'mm', format:[100, 70] });
            } else {
              doc.addPage([100, 70], 'landscape');
            }
            renderPDFTag(doc, {
              location:   hdr.location   || '—',
              po:         hdr.po         || '—',
              partCode:   code,
              lotNumber:  item.lotNumber || '—',
              qty:        box.qtyInBox   || 0,
              uom:        item.uom       || '',
              weight:     box.weight     || 0,
              boxIndex:   box.boxIndex,
              totalBoxes: box.totalBoxes
            }, null);
          });
        });

        if (doc) { doc.save('ArTek_Order_' + orderNo + '_tags.pdf'); showToast('PDF reprinted!', 'success'); }
      } catch(e) { showToast('PDF error: ' + e.message, 'error'); }
    })
    .catch(function() { showToast('Error loading order', 'error'); });
}

// ── OOR ───────────────────────────────────────────────────

function loadOOR() {
  _oorItemCache = {};
  document.getElementById('oorList').innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
  apiFetch('getOOROrderHeaders')
    .then(function(data) {
      if (data && data.error) { showToast('Error: ' + data.error, 'error'); return; }
      _oorData = Array.isArray(data) ? data : [];
      renderOOR();
    })
    .catch(function() { showToast('Error loading OOR', 'error'); });
}

function renderOOR() {
  var q = document.getElementById('oorSearch') ? document.getElementById('oorSearch').value.toLowerCase().trim() : '';
  var filtered = _oorData.filter(function(o) {
    return !q ||
      String(o.orderNo).toLowerCase().indexOf(q) !== -1 ||
      String(o.location||'').toLowerCase().indexOf(q) !== -1;
  });

  var list = document.getElementById('oorList');
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state"><div class="empty-icon">📦</div><p>No orders found.</p></div>';
    return;
  }

  list.innerHTML = filtered.map(function(o, idx) {
    var locBadge = '<span class="badge badge-loc">' + (o.location||'—') + '</span>';
    var wmsBadge = o.wmsStatus === 'Complete' ? '<span class="badge badge-done">✓ Done</span>' :
                   (o.wmsStatus === 'Packaging' || o.wmsStatus === 'Picked') ? '<span class="badge badge-inprog">In WMS</span>' : '';

    return '<div class="oor-card" id="oor-' + idx + '">' +
      '<div class="oor-card-header" onclick="toggleOOR(' + idx + ',\'' + o.orderNo + '\',\'' + (o.wmsStatus||'') + '\')">' +
        '<div class="oor-order-icon">📦</div>' +
        '<div class="oor-order-info">' +
          '<div class="oor-order-num">Order #' + o.orderNo + '</div>' +
          '<div class="oor-order-meta">' + o.itemCount + ' item' + (o.itemCount !== 1 ? 's' : '') + '</div>' +
        '</div>' +
        '<div class="oor-badges">' + locBadge + wmsBadge + '</div>' +
        '<span class="oor-chevron">▶</span>' +
      '</div>' +
      '<div class="oor-items" id="oor-items-' + idx + '"><div class="oor-item-loading">Loading…</div></div>' +
    '</div>';
  }).join('');
}

function toggleOOR(idx, orderNo, wmsStatus) {
  var card     = document.getElementById('oor-' + idx);
  var itemsDiv = document.getElementById('oor-items-' + idx);
  if (!card) return;
  if (card.classList.contains('open')) { card.classList.remove('open'); return; }
  card.classList.add('open');

  if (_oorItemCache[orderNo]) {
    if (_oorItemCache[orderNo].items) renderOORItemsWithBoxes(itemsDiv, _oorItemCache[orderNo]);
    else renderOORItems(itemsDiv, _oorItemCache[orderNo]);
    return;
  }

  itemsDiv.innerHTML = '<div class="oor-item-loading">Loading…</div>';

  if (wmsStatus === 'Complete') {
    apiFetch('getCompletedOrderDetails', { orderNo: String(orderNo) })
      .then(function(data) {
        if (data.error) { itemsDiv.innerHTML = '<div class="oor-item-loading">' + data.error + '</div>'; return; }
        _oorItemCache[orderNo] = data;
        renderOORItemsWithBoxes(itemsDiv, data);
      })
      .catch(function() { itemsDiv.innerHTML = '<div class="oor-item-loading">Error loading.</div>'; });
  } else {
    apiFetch('getOOROrderItems', { orderNo: String(orderNo) })
      .then(function(items) {
        if (!Array.isArray(items)) items = [];
        _oorItemCache[orderNo] = items;
        renderOORItems(itemsDiv, items);
      })
      .catch(function() { itemsDiv.innerHTML = '<div class="oor-item-loading">Error loading.</div>'; });
  }
}

function renderOORItems(container, items) {
  if (!items || !items.length) { container.innerHTML = '<div class="oor-item-loading">No items found.</div>'; return; }
  container.innerHTML = items.map(function(item) {
    return '<div class="oor-item">' +
      '<div style="flex:1;min-width:0">' +
        '<div class="oor-item-code">' + (item.itemCode||'—') + '</div>' +
        '<div class="oor-item-desc">' + (item.description||'') + '</div>' +
      '</div>' +
      '<div class="oor-item-qty">' + (item.qtyOrdered||0) + ' ' + (item.uom||'') + '</div>' +
    '</div>';
  }).join('');
}

function renderOORItemsWithBoxes(container, data) {
  var items  = data.items  || [];
  var boxes  = data.boxes  || {};
  var header = data.header || {};
  if (!items.length) { container.innerHTML = '<div class="oor-item-loading">No items.</div>'; return; }

  container.innerHTML = '<div class="oor-complete-note">✓ Order packaged and complete</div>' +
    items.map(function(item) {
      var code      = item.itemCode || '—';
      var itemBoxes = boxes[code]   || [];
      var boxHtml   = itemBoxes.length
        ? '<div class="oor-item-boxes">' +
            itemBoxes.map(function(b) {
              return '<span class="box-tag">Box ' + b.boxIndex + '/' + b.totalBoxes + ': ' + b.qtyInBox + ' ' + (item.uom||'') + ' · ' + b.weight + ' lbs</span>';
            }).join('') +
          '</div>'
        : '';
      return '<div class="oor-item">' +
        '<div style="flex:1;min-width:0">' +
          '<div class="oor-item-code">' + code + '</div>' +
          (item.lotNumber ? '<div class="oor-item-desc">Lot: ' + item.lotNumber + '</div>' : '') +
          boxHtml +
        '</div>' +
        '<div class="oor-item-qty">' + (item.qtyRequired||item.qtyPulled||0) + ' ' + (item.uom||'') + '</div>' +
      '</div>';
    }).join('') +
    '<div style="padding:10px 16px">' +
      '<button class="reprint-btn" onclick="reprintPDF(\'' + (header.orderNumber||'') + '\')">🖨 Reprint PDF tags</button>' +
    '</div>';
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
