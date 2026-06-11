// ── Config ────────────────────────────────────────────────
var API = 'https://artek-proxy.parkwall12.workers.dev';
var DRIVE_SCRIPT = 'https://script.google.com/macros/s/AKfycbyA8mFEQ8zbRbWtZ2Z-WR-p0wC741pANpiMIMmlRGGsl2mXR-mgSyMEVLax8ZuHpoxP2Q/exec';

var _oorData         = [];
var _scanData        = [];
var _packageData     = [];
var _scanTargetId    = null;
var _partScanIdx     = null;
var _partScanCode    = null;
var _codeReader      = null;
var _oorItemCache    = {};
var _currentPickData = null;
var _currentPkgData  = null;
var _pkgBoxes        = [];
var _sessionPicks    = [];
var _pkgReturnTab    = null;

// ── Fetch ─────────────────────────────────────────────────

function apiFetch(action, payload) {
  var url = API + '?action=' + encodeURIComponent(action);
  if (payload) url += '&payload=' + encodeURIComponent(JSON.stringify(payload));
  return fetch(url).then(function(r) { return r.json(); });
}

function apiFetchPost(body) {
  return fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r) { return r.json(); });
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
      playGoodBeep(); showToast('✓ Part matched!', 'success');
      if (qtyInput) setTimeout(function() { qtyInput.focus(); }, 100);
    } else {
      status.textContent = '✗ No match — expected: ' + expectedMiddle + ' · got: ' + scannedMiddle;
      status.className = 'pick-status no-match';
      playBadBeep(); showToast('✗ Wrong part!', 'error');
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
    return '<div class="order-card" onclick="openOrderDetail(\'' + o.orderNumber + '\')">' +
      '<div class="order-icon">📋</div>' +
      '<div class="order-info">' +
        '<div class="order-num">Order #' + o.orderNumber + '</div>' +
        '<div class="order-meta">' + date + (o.location ? ' &nbsp;·&nbsp; ' + o.location : '') + '</div>' +
        (o.po ? '<div class="order-meta">PO: ' + o.po + '</div>' : '') +
      '</div>' + badge +
    '</div>';
  }).join('');
}

// ── Order detail (read-only view) ─────────────────────────

function openOrderDetail(orderNo) {
  _pkgReturnTab = document.querySelector('.tab-btn.active') ? document.querySelector('.tab-btn.active').id.replace('tab-','') : 'scan';
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('page-order-detail').classList.add('active');
  document.getElementById('detailContent').innerHTML = '<p style="color:#94a3b8;text-align:center;padding:40px">Loading…</p>';

  Promise.all([
    apiFetch('getPackageOrder', { orderNo: String(orderNo) }),
    apiFetch('getBoxPhotos',    { orderNo: String(orderNo) })
  ]).then(function(results) {
    var data   = results[0];
    var photos = results[1];
    if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
    renderOrderDetail(data, Array.isArray(photos) ? photos : []);
  }).catch(function() { showToast('Error loading order', 'error'); });
}

function renderOrderDetail(data, photos) {
  var h     = data.header;
  var items = data.items || [];
  var boxes = data.boxes || {};
  photos    = photos || [];

  var photoLookup = {};
  photos.forEach(function(p) { photoLookup[p.boxIdx + '|' + p.partCode] = p.photoData || p.thumbnailUrl; });

  var statusBadge = h.status === 'Complete'  ? '<span class="badge badge-complete">Complete</span>'  :
                    h.status === 'Packaging'  ? '<span class="badge badge-inprog">Packaging</span>'   :
                    '<span class="badge badge-ready">Picked</span>';

  var bodyHtml = '';

  if (items.length === 0) {
    bodyHtml = '<p style="color:#94a3b8;font-size:.85rem;padding:8px 0">No items found.</p>';
  } else {
    items.forEach(function(item) {
      var itemBoxes = boxes[item.itemCode] || [];

      var photoHtml = '';
      itemBoxes.forEach(function(box) {
        var url = photoLookup[box.boxIndex + '|' + item.itemCode];
        if (url) photoHtml += '<img src="' + url + '" class="detail-photo"/>';
      });

      var boxHtml = '';
      if (itemBoxes.length > 0) {
        boxHtml = '<div class="detail-item-boxes">';
        itemBoxes.forEach(function(box) {
          boxHtml += '<div class="detail-item-row">' +
            '<span>Box ' + box.boxIndex + ' of ' + box.totalBoxes + '</span>' +
            '<strong>' + box.qtyInBox + ' ' + (item.uom||'ft') + ' · ' + box.weight + ' lbs</strong>' +
          '</div>';
        });
        boxHtml += '</div>';
      }

      bodyHtml += '<div class="detail-part-entry">' +
        '<div class="detail-item-code">' + item.itemCode + '</div>' +
        (item.description ? '<div class="detail-item-desc">' + item.description + '</div>' : '') +
        '<div class="detail-item-row"><span>Lot #</span><strong>' + (item.lotNumber || '—') + '</strong></div>' +
        '<div class="detail-item-row"><span>Pieces pulled</span><strong>' + item.qtyPulled + ' ' + (item.uom||'') + '</strong></div>' +
        boxHtml +
        (photoHtml ? '<div class="detail-photos">' + photoHtml + '</div>' : '') +
      '</div>';
    });
  }

  var actionHtml = h.status !== 'Complete'
    ? '<button class="btn-save" style="width:100%;margin-top:12px" onclick="openPackageOrder(\'' + h.orderNumber + '\')">Open in Packaging →</button>'
    : '<button class="reprint-btn" style="margin-top:12px" onclick="reprintPDF(\'' + h.orderNumber + '\')">🖨 Print tags</button>';

  document.getElementById('detailContent').innerHTML =
    '<div class="pick-order-header">' +
      '<div class="pick-order-num">Order #' + h.orderNumber + ' &nbsp;' + statusBadge + '</div>' +
      '<div class="pick-order-meta">' +
        '<span class="pick-order-po">PO: ' + (h.po||'—') + '</span>' +
        ' &nbsp;·&nbsp; ' + (h.location||'—') +
      '</div>' +
    '</div>' +
    '<div class="detail-box-section">' + bodyHtml + '</div>' +
    actionHtml;
}

function exitOrderDetail() {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  var returnTab = _pkgReturnTab || 'scan';
  document.getElementById('tab-' + returnTab).classList.add('active');
  document.getElementById('page-' + returnTab).classList.add('active');
  if (returnTab === 'scan')     loadOrders();
  else if (returnTab === 'oor') loadOOR();
  else                          loadPackageOrders();
  _pkgReturnTab = null;
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
        '<div class="session-pick-meta">' + (p.location||'') + (p.po ? ' &nbsp;·&nbsp; PO: ' + p.po : '') + ' &nbsp;·&nbsp; ' + p.itemCount + ' item' + (p.itemCount !== 1 ? 's' : '') + '</div>' +
      '</div>' +
      '<span class="badge badge-ok">Picked</span>' +
    '</div>';
  }).join('');
}

function lookupOrder() {
  var num = document.getElementById('orderNumber').value.trim();
  if (!num) { document.getElementById('lookupError').textContent = 'Please enter an order number.'; document.getElementById('lookupError').style.display = 'block'; return; }
  document.getElementById('lookupError').style.display = 'none';
  var btn = document.getElementById('lookupBtn');
  btn.disabled = true; btn.textContent = 'Looking up…';
  apiFetch('getFullOOROrder', { orderNo: num })
    .then(function(data) {
      btn.disabled = false; btn.textContent = 'Look up order';
      if (data && data.error) { document.getElementById('lookupError').textContent = data.error; document.getElementById('lookupError').style.display = 'block'; return; }
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
        '<input type="text" id="pick-scan-' + idx + '" placeholder="Scan or type part #" autocomplete="off" onchange="verifyPartScan(' + idx + ',\'' + safeCode + '\',this.value)"/>' +
        '<button class="scan-btn" onclick="openPartScanner(' + idx + ',\'' + safeCode + '\')">&#9641;</button>' +
      '</div>' +
      '<div class="pick-status" id="pick-status-' + idx + '"></div>' +
      '<div class="pick-label">Lot number</div>' +
      '<div class="pick-scan-row">' +
        '<input type="text" id="pick-lot-' + idx + '" placeholder="Scan or type lot #" autocomplete="off"/>' +
        '<button class="scan-btn" onclick="openScanner(\'pick-lot-' + idx + '\')">&#9641;</button>' +
        '<button class="autofill-btn" id="autofill-btn-' + idx + '" onclick="autofillLot(' + idx + ')" title="Autofill lot number">⟳</button>' +
      '</div>' +
      '<div class="pick-qty-row">' +
        '<label>Pieces pulled</label>' +
        '<input type="number" id="pick-qty-' + idx + '" placeholder="0" min="0"/>' +
      '</div>' +
    '</div>';
  }).join('');
}

function autofillLot(idx) {
  if (!_currentPickData) return;
  var items = _currentPickData.items || [];
  var item  = items[idx];
  if (!item) return;
  var btn = document.getElementById('autofill-btn-' + idx);
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  apiFetch('getLotNumber', { partCode: extractPartCode(item.itemCode) })
    .then(function(res) {
      if (btn) { btn.disabled = false; btn.textContent = '⟳'; }
      if (res && res.lotNumber) {
        var input = document.getElementById('pick-lot-' + idx);
        if (input) input.value = res.lotNumber;
        showToast('Lot # filled: ' + res.lotNumber, 'success');
      } else if (res && res.error) {
        showToast('Lot error: ' + res.error, 'error');
      } else {
        showToast('No lot number found for this part', 'error');
      }
    })
    .catch(function() {
      if (btn) { btn.disabled = false; btn.textContent = '⟳'; }
      showToast('Error looking up lot number', 'error');
    });
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
    orderNumber: String(h.orderNo), po: h.po||'', location: h.location||'',
    items: items.map(function(item, idx) {
      var expectedCode = extractPartCode(item.itemCode);
      var scannedCode  = (document.getElementById('pick-scan-' + idx)||{}).value || '';
      var lotNumber    = (document.getElementById('pick-lot-'  + idx)||{}).value || '';
      var qtyPulled    = parseFloat((document.getElementById('pick-qty-' + idx)||{}).value || 0);
      var match        = extractMiddleCode(scannedCode) === extractMiddleCode(expectedCode);
      return { expectedCode:expectedCode, description:item.description||'', uom:item.uom||'', lotNumber:lotNumber, qtyRequired:item.qtyOrdered, qtyPulled:qtyPulled, match:match };
    })
  };
  btn.disabled = true; btn.textContent = 'Saving…';
  apiFetch('saveScanOrder', payload)
    .then(function(res) {
      btn.disabled = false; btn.textContent = 'Save pick';
      if (res && res.success) {
        _sessionPicks.unshift({ orderNumber:String(h.orderNo), po:h.po||'', location:h.location||'', itemCount:items.length });
        showToast('Order #' + h.orderNo + ' picked — ready to package', 'success');
        document.getElementById('phase-pick').style.display   = 'none';
        document.getElementById('phase-lookup').style.display = 'block';
        document.getElementById('orderNumber').value = '';
        document.getElementById('lookupError').style.display  = 'none';
        _currentPickData = null;
        renderSessionPicks();
        setTimeout(function() { document.getElementById('orderNumber').focus(); }, 100);
      } else { showToast('Error: ' + ((res && res.error) || 'Unknown error'), 'error'); }
    })
    .catch(function(err) { btn.disabled = false; btn.textContent = 'Save pick'; showToast('Error: ' + (err.message||'check connection'), 'error'); });
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
    var badge = o.status === 'Packaging' ? '<span class="badge badge-inprog">In progress</span>' : '<span class="badge badge-ready">Ready</span>';
    return '<div class="order-card" onclick="openPackageOrder(\'' + o.orderNumber + '\')">' +
      '<div class="order-icon">📦</div>' +
      '<div class="order-info">' +
        '<div class="order-num">Order #' + o.orderNumber + '</div>' +
        '<div class="order-meta">' + (o.location||'—') + (o.po ? ' &nbsp;·&nbsp; PO: ' + o.po : '') + '</div>' +
      '</div>' + badge +
    '</div>';
  }).join('');
}

// ── Package order detail (edit mode) ──────────────────────

function openPackageOrder(orderNo) {
  _pkgReturnTab = document.querySelector('.tab-btn.active') ? document.querySelector('.tab-btn.active').id.replace('tab-','') : 'package';
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('page-package-detail').classList.add('active');
  _pkgBoxes = [];
  document.getElementById('pkgOrderHeader').innerHTML = '<div class="pick-order-header"><p style="color:#94a3b8">Loading…</p></div>';
  document.getElementById('pkgItemsList').innerHTML = '';

  apiFetch('getPackageOrder', { orderNo: String(orderNo) })
    .then(function(data) {
      if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
      _currentPkgData = data;

      var byBox = {};
      Object.keys(data.boxes || {}).forEach(function(itemCode) {
        (data.boxes[itemCode] || []).forEach(function(box) {
          if (!byBox[box.boxIndex]) byBox[box.boxIndex] = [];
          byBox[box.boxIndex].push({ itemCode:itemCode, qty:box.qtyInBox||0, weight:box.weight||0, photoUrl:null });
        });
      });
      var boxIdxs = Object.keys(byBox).map(Number).sort(function(a,b) { return a-b; });

      if (boxIdxs.length > 0) {
        _pkgBoxes = boxIdxs.map(function(bIdx) { return { parts: byBox[bIdx] }; });
      } else {
        _pkgBoxes = [{ parts: [{ itemCode:'', qty:0, weight:0, photoUrl:null }] }];
      }

      renderPackageDetail(data);
    })
    .catch(function(err) {
      console.error('openPackageOrder error:', err);
      showToast('Error loading order', 'error');
    });
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
  document.getElementById('pkgItemsList').innerHTML = '<div id="boxesList"></div>';
  renderAllBoxes();
}

function renderAllBoxes() {
  var container = document.getElementById('boxesList');
  if (!container || !_currentPkgData) return;
  var items = _currentPkgData.items || [];
  container.innerHTML = _pkgBoxes.map(function(box, bIdx) {
    return renderBoxSection(box, bIdx, items, bIdx === _pkgBoxes.length - 1);
  }).join('');
}

function renderBoxSection(box, bIdx, items, isLast) {
  var partsHtml = box.parts.map(function(part, pIdx) {
    return renderPartEntry(bIdx, pIdx, part, items, box.parts.length > 1);
  }).join('');
  return '<div class="box-section" id="box-section-' + bIdx + '">' +
    '<div class="box-section-header">' +
      '<span class="box-section-title">Box ' + (bIdx + 1) + '</span>' +
      (bIdx > 0 ? '<button class="delete-box-btn" onclick="deleteBox(' + bIdx + ')">✕ Remove box</button>' : '') +
    '</div>' +
    '<div id="box-' + bIdx + '-parts">' + partsHtml + '</div>' +
    '<div class="box-action-row">' +
      '<button class="add-part-to-box-btn" onclick="addPartToBox(' + bIdx + ')">+ Add part to box</button>' +
      (isLast ? '<button class="add-new-box-btn" onclick="addNewBox()">+ Add box</button>' : '') +
    '</div>' +
  '</div>';
}

function renderPartEntry(bIdx, pIdx, part, items, canRemove) {
  var optionsHtml = '<option value="">Select part…</option>' +
    items.map(function(item) {
      var sel = part.itemCode === item.itemCode ? ' selected' : '';
      return '<option value="' + item.itemCode + '"' + sel + '>' + item.itemCode + (item.description ? ' — ' + item.description : '') + '</option>';
    }).join('');
  return '<div class="box-part-entry">' +
    '<div class="part-select-row">' +
      '<select class="part-select" onchange="updatePartField(' + bIdx + ',' + pIdx + ',\'itemCode\',this.value)">' + optionsHtml + '</select>' +
      (canRemove ? '<button class="remove-btn" onclick="removePartFromBox(' + bIdx + ',' + pIdx + ')">✕</button>' : '') +
    '</div>' +
    '<div class="part-field-row">' +
      '<div class="pkg-field"><label>Qty pulled (feet)</label>' +
        '<input type="number" value="' + (part.qty||'') + '" placeholder="0" oninput="updatePartField(' + bIdx + ',' + pIdx + ',\'qty\',this.value)"/>' +
      '</div>' +
      '<div class="pkg-field"><label>Weight (lbs)</label>' +
        '<input type="number" value="' + (part.weight||'') + '" placeholder="0" oninput="updatePartField(' + bIdx + ',' + pIdx + ',\'weight\',this.value)"/>' +
      '</div>' +
    '</div>' +
    '<div class="pkg-photo-field">' +
      '<input type="file" accept="image/*" capture="environment" id="photo-input-' + bIdx + '-' + pIdx + '" style="display:none" onchange="handleBoxPhotoNew(' + bIdx + ',' + pIdx + ',this)"/>' +
      '<button class="photo-btn" onclick="document.getElementById(\'photo-input-' + bIdx + '-' + pIdx + '\').click()">📷 Take photo</button>' +
      '<div class="photo-preview" id="photo-' + bIdx + '-' + pIdx + '">' + (part.photoUrl ? '<img src="' + part.photoUrl + '"/>' : '') + '</div>' +
    '</div>' +
  '</div>';
}

function updatePartField(bIdx, pIdx, field, value) {
  if (!_pkgBoxes[bIdx] || !_pkgBoxes[bIdx].parts[pIdx]) return;
  _pkgBoxes[bIdx].parts[pIdx][field] = (field === 'qty' || field === 'weight') ? (parseFloat(value) || 0) : value;
}

function addPartToBox(bIdx) {
  if (!_pkgBoxes[bIdx]) return;
  _pkgBoxes[bIdx].parts.push({ itemCode:'', qty:0, weight:0, photoUrl:null });
  renderAllBoxes();
}

function removePartFromBox(bIdx, pIdx) {
  if (!_pkgBoxes[bIdx] || _pkgBoxes[bIdx].parts.length <= 1) return;
  _pkgBoxes[bIdx].parts.splice(pIdx, 1);
  renderAllBoxes();
}

function addNewBox() {
  _pkgBoxes.push({ parts: [{ itemCode:'', qty:0, weight:0, photoUrl:null }] });
  renderAllBoxes();
  setTimeout(function() {
    var lastBox = document.getElementById('box-section-' + (_pkgBoxes.length - 1));
    if (lastBox) lastBox.scrollIntoView({ behavior:'smooth' });
  }, 100);
}

function deleteBox(bIdx) {
  if (bIdx === 0 || !_pkgBoxes[bIdx]) return;
  _pkgBoxes.splice(bIdx, 1);
  renderAllBoxes();
}

function compressPhoto(dataUrl, callback) {
  var img = new Image();
  img.onload = function() {
    var maxDim = 640;
    var w = img.width, h = img.height;
    if (w > h && w > maxDim) { h = h * (maxDim / w); w = maxDim; }
    else if (h > maxDim)     { w = w * (maxDim / h); h = maxDim; }
    var canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    callback(canvas.toDataURL('image/jpeg', 0.5));
  };
  img.src = dataUrl;
}

function handleBoxPhotoNew(bIdx, pIdx, input) {
  if (!input.files || !input.files[0]) return;
  var reader = new FileReader();
  reader.onload = function(e) {
    compressPhoto(e.target.result, function(compressed) {
      if (!_pkgBoxes[bIdx] || !_pkgBoxes[bIdx].parts[pIdx]) return;
      _pkgBoxes[bIdx].parts[pIdx].photoUrl = compressed;
      var preview = document.getElementById('photo-' + bIdx + '-' + pIdx);
      if (preview) preview.innerHTML = '<img src="' + compressed + '"/>';
    });
  };
  reader.readAsDataURL(input.files[0]);
}

function collectPackagePayload(complete) {
  if (!_currentPkgData) return null;
  var h = _currentPkgData.header;
  var totalBoxes = _pkgBoxes.length;
  var boxes = [];
  _pkgBoxes.forEach(function(box, bIdx) {
    box.parts.forEach(function(part) {
      if (part.itemCode) {
        boxes.push({ itemCode:part.itemCode, boxIndex:bIdx+1, totalBoxes:totalBoxes, qtyInBox:parseFloat(part.qty)||0, weight:parseFloat(part.weight)||0 });
      }
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
      if (res.success) {
        showToast('Saved!', 'success');
        setTimeout(exitPackageDetail, 900);
      } else {
        showToast('Error: ' + (res.error||''), 'error');
      }
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
      btn.disabled = false; btn.textContent = '✓ Complete order';
      if (res.success) {
        var pdfBase64 = generatePDFBase64();
        var photos    = collectPhotos();
        var h         = _currentPkgData.header;
        var date      = new Date().toISOString().split('T')[0];

        fetch(DRIVE_SCRIPT, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({
            orderNo: h.orderNumber,
            location: h.location || 'MCM',
            completionDate: date,
            pdfBase64: pdfBase64,
            photos: photos
          })
        });

        showToast('Order complete — saving to Drive…', 'success');
        setTimeout(exitPackageDetail, 900);
      } else {
        showToast('Error: ' + (res.error||''), 'error');
      }
    })
    .catch(function() { btn.disabled = false; btn.textContent = '✓ Complete order'; showToast('Error', 'error'); });
}

function exitPackageDetail() {
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  var returnTab = _pkgReturnTab || 'package';
  document.getElementById('tab-' + returnTab).classList.add('active');
  document.getElementById('page-' + returnTab).classList.add('active');
  if (returnTab === 'scan')    loadOrders();
  else                         loadPackageOrders();
  _pkgReturnTab = null;
}

// ── PDF Generation ────────────────────────────────────────

function renderPDFTag(doc, data) {
  doc.setTextColor(0, 0, 0);
  var x = 8; var y = 18; var gap = 14;
  doc.setFont(undefined, 'bold'); doc.setFontSize(13);
  doc.text('McMaster-Carr', x, y); y += 10;
  doc.text(String(data.location || '—'), x, y); y += gap;
  doc.setFont(undefined, 'normal'); doc.setFontSize(11);
  doc.text('P.O. # ' + String(data.po || '—'), x, y); y += gap;
  doc.text('LOT # ' + String(data.lotNumber || '—'), x, y); y += gap;
  doc.text('Part #:', x, y); y += 9;
  doc.setFont(undefined, 'bold'); doc.setFontSize(9);
  doc.text(String(data.partCode || '—'), x, y); y += gap;
  doc.setFont(undefined, 'normal'); doc.setFontSize(11);
  doc.text('QTY: ' + String(data.qty || 0) + ' ' + String(data.uom || 'Feet'), x, y); y += gap;
  doc.text('Pkg: ' + data.boxIndex + ' of ' + data.totalBoxes, x, y);
}

function generatePDFBase64() {
  var jsPDFLib = window.jspdf ? window.jspdf.jsPDF : (window.jsPDF || null);
  if (!jsPDFLib || !_currentPkgData) return null;
  var h        = _currentPkgData.header;
  var items    = _currentPkgData.items || [];
  var itemInfo = {};
  items.forEach(function(item) { itemInfo[item.itemCode] = item; });
  var doc        = null;
  var totalBoxes = _pkgBoxes.length;
  _pkgBoxes.forEach(function(box, bIdx) {
    box.parts.forEach(function(part) {
      if (!part.itemCode) return;
      var info = itemInfo[part.itemCode] || {};
      if (!doc) { doc = new jsPDFLib({ orientation:'portrait', unit:'mm', format:[101.6, 152.4] }); }
      else       { doc.addPage([101.6, 152.4], 'portrait'); }
      renderPDFTag(doc, {
        location:   h.location || '—',
        po:         h.po || '—',
        lotNumber:  info.lotNumber || '—',
        partCode:   part.itemCode,
        qty:        part.qty || 0,
        uom:        info.uom || 'Feet',
        boxIndex:   bIdx + 1,
        totalBoxes: totalBoxes
      });
    });
  });
  if (!doc) return null;
  return doc.output('datauristring').split(',')[1];
}

function collectPhotos() {
  var photos = [];
  _pkgBoxes.forEach(function(box, bIdx) {
    box.parts.forEach(function(part) {
      if (part.photoUrl && part.photoUrl.indexOf('base64,') !== -1) {
        var base64 = part.photoUrl.split('base64,')[1];
        var ext    = part.photoUrl.indexOf('image/png') !== -1 ? 'png' : 'jpg';
        photos.push({ boxIdx:bIdx+1, partCode:part.itemCode||'part', qty:part.qty||0, base64:base64, ext:ext });
      }
    });
  });
  return photos;
}

function reprintPDF(orderNo) {
  apiFetch('getPackageOrder', { orderNo: String(orderNo) })
    .then(function(data) {
      if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
      var hdr   = data.header;
      var items = data.items  || [];
      var boxes = data.boxes  || {};
      var itemInfo = {};
      items.forEach(function(item) { itemInfo[item.itemCode] = item; });
      var jsPDFLib = window.jspdf ? window.jspdf.jsPDF : (window.jsPDF || null);
      if (!jsPDFLib) { showToast('PDF library not loaded', 'error'); return; }
      var allEntries = [];
      Object.keys(boxes).forEach(function(itemCode) {
        (boxes[itemCode] || []).forEach(function(box) {
          allEntries.push({ itemCode:itemCode, boxIndex:box.boxIndex, totalBoxes:box.totalBoxes, qtyInBox:box.qtyInBox });
        });
      });
      allEntries.sort(function(a,b) { return a.boxIndex - b.boxIndex; });
      if (allEntries.length === 0) {
        items.forEach(function(item) {
          allEntries.push({ itemCode:item.itemCode, boxIndex:1, totalBoxes:1, qtyInBox:item.qtyPulled||0 });
        });
      }
      if (allEntries.length === 0) { showToast('No data for this order', 'error'); return; }
      var doc = null;
      allEntries.forEach(function(entry) {
        var info = itemInfo[entry.itemCode] || {};
        if (!doc) { doc = new jsPDFLib({ orientation:'portrait', unit:'mm', format:[101.6, 152.4] }); }
        else       { doc.addPage([101.6, 152.4], 'portrait'); }
        renderPDFTag(doc, {
          location:   hdr.location || '—',
          po:         hdr.po || '—',
          lotNumber:  info.lotNumber || '—',
          partCode:   entry.itemCode,
          qty:        entry.qtyInBox,
          uom:        info.uom || 'Feet',
          boxIndex:   entry.boxIndex,
          totalBoxes: entry.totalBoxes
        });
      });
      if (doc) { doc.save('ArTek_Order_' + orderNo + '_tags.pdf'); showToast('PDF tags ready!', 'success'); }
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
    return !q || String(o.orderNo).toLowerCase().indexOf(q) !== -1 || String(o.location||'').toLowerCase().indexOf(q) !== -1;
  });
  var list = document.getElementById('oorList');
  if (!filtered.length) { list.innerHTML = '<div class="empty-state"><div class="empty-icon">📦</div><p>No orders found.</p></div>'; return; }
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
    apiFetch('getPackageOrder', { orderNo: String(orderNo) })
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
      '<div style="flex:1;min-width:0"><div class="oor-item-code">' + (item.itemCode||'—') + '</div><div class="oor-item-desc">' + (item.description||'') + '</div></div>' +
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
            }).join('') + '</div>'
        : '';
      return '<div class="oor-item">' +
        '<div style="flex:1;min-width:0"><div class="oor-item-code">' + code + '</div>' +
          (item.lotNumber ? '<div class="oor-item-desc">Lot: ' + item.lotNumber + '</div>' : '') +
          boxHtml +
        '</div>' +
        '<div class="oor-item-qty">' + (item.qtyRequired||item.qtyPulled||0) + ' ' + (item.uom||'') + '</div>' +
      '</div>';
    }).join('') +
    '<div class="oor-action-row">' +
      '<button class="oor-action-btn" onclick="reprintPDF(\'' + (header.orderNumber||'') + '\')">🖨 Print tags</button>' +
      '<button class="oor-action-btn oor-action-btn-view" onclick="viewOrderFromOOR(\'' + (header.orderNumber||'') + '\')">📋 View order</button>' +
    '</div>';
}

function viewOrderFromOOR(orderNo) {
  _pkgReturnTab = 'oor';
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('active'); });
  document.getElementById('page-order-detail').classList.add('active');
  document.getElementById('detailContent').innerHTML = '<p style="color:#94a3b8;text-align:center;padding:40px">Loading…</p>';
  Promise.all([
    apiFetch('getPackageOrder', { orderNo: String(orderNo) }),
    apiFetch('getBoxPhotos',    { orderNo: String(orderNo) })
  ]).then(function(results) {
    var data   = results[0];
    var photos = results[1];
    if (data.error) { showToast('Error: ' + data.error, 'error'); return; }
    renderOrderDetail(data, Array.isArray(photos) ? photos : []);
  }).catch(function() { showToast('Error loading order', 'error'); });
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
