/* Token Radar — the board, the detail view and the comps, from window.RADAR.
 * No network: every number comes from the data script the program wrote.
 * The pricing story lives here in plain words so the page states its own
 * model: a size curve fitted on the live-token comps, tested blind, with a
 * band from the test's median miss and farm plans costed at the band's
 * low end. See the Method section at the foot of the page. */
(function () {
  'use strict';
  var R = window.RADAR;
  var M = R.model;
  var rows = R.rows;
  var comps = R.comps;

  var $ = function (id) { return document.getElementById(id); };
  var view = $('view');
  var state = { tab: 'board', q: '', cat: '', chain: '', verdict: '', sort: 'implied' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function money(n) {
    if (n == null) return '—';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(n % 1e9 === 0 ? 0 : 2).replace(/\.00$/, '') + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return (n < 0 ? '−$' : '$') + Math.abs(Math.round(n));
  }
  function signedMoney(n) {
    if (n == null) return '—';
    return (n < 0 ? '−' : '+') + money(Math.abs(n)).slice(0);
  }
  function pct(v) {
    if (v == null) return '—';
    var cls = v > 0 ? 'up' : v < 0 ? 'down' : '';
    return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + v.toFixed(2) + '%</span>';
  }
  function ageText(d) {
    if (d == null) return '—';
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    return d + 'd';
  }
  function chainsOf(r) { return r.chains.slice(0, 2).join(', '); }

  /* ---- header ------------------------------------------------ */
  $('snapLine').textContent = 'Snapshot ' + R.as_of + ' · DefiLlama protocol index · ' + M.version;
  $('headline').textContent = rows.length + ' pre-token protocols, ranked by implied value';
  $('lede').textContent = 'Every protocol in the snapshot that records no token, priced off the ' +
    M.comps + ' tokens that already trade. The watchlist is the floor — ' +
    R.watchlist_size + ' protocols — and the board carries ' +
    (rows.length - R.watchlist_size) + ' more below it.';
  var maxImplied = rows.length ? rows[0].implied_value_usd : 1;
  $('stats').innerHTML =
    '<div><dt>Watchlist covered</dt><dd>' + R.watchlist_size + ' / ' + R.watchlist_size + '</dd></div>' +
    '<div><dt>Blind-test median miss</dt><dd>&times;' + M.blind.medianMultiple.toFixed(2) + '</dd></div>' +
    '<div><dt>Farm · Thin · Skip</dt><dd>' + R.verdicts.farm + ' · ' + R.verdicts.thin + ' · ' + R.verdicts.skip + '</dd></div>';
  $('methodNumbers').textContent =
    'Fitted on ' + M.comps + ' comps: log10(market cap) = ' + M.intercept + ' + ' + M.slope +
    ' × log10(TVL), R² = ' + M.r_squared + '. Blind test — curve fitted on ' + M.blind.trainN +
    ' protocols listed before ' + M.blind.cut + ', priced ' + M.blind.testN + ' listed after it: median miss ×' +
    M.blind.medianMultiple + ', ' + Math.round(M.blind.withinTwoX * 100) + '% within 2×; five-fold cross-validation median miss ×' +
    M.blind.cvMedianMultiple + '. Band: every implied value ÷× ' + M.band_multiple +
    '. Farm plans: ' + Math.round(M.airdrop_share * 100) + '% of the low-end value to the airdrop, farmers hold ' +
    Math.round(M.farmer_tvl_share * 100) + '% of TVL, $' + M.gas_budget_usd + ' of gas; farm at $' +
    M.farm_min_net_usd + ' net or more, thin at $' + M.thin_min_net_usd + ' or more.';

  /* ---- controls ---------------------------------------------- */
  var cats = [], chains = [];
  rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort(); chains.sort();
  cats.forEach(function (c) { $('cat').appendChild(new Option(c, c)); });
  chains.forEach(function (c) { $('chain').appendChild(new Option(c, c)); });

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.verdict && r.verdict !== state.verdict) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (q && (r.name + ' ' + (r.category || '') + ' ' + r.chains.join(' ')).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    var sorters = {
      implied: function (a, b) { return a.rank - b.rank; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d == null ? -1e9 : b.change_7d) - (a.change_7d == null ? -1e9 : a.change_7d); },
      net: function (a, b) { return b.net_usd - a.net_usd; },
      age: function (a, b) { return (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days); }
    };
    return list.sort(sorters[state.sort] || sorters.implied);
  }

  function boardTable(list, title) {
    if (!list.length) return '<div class="panel"><div class="empty">No protocols match these filters.</div></div>';
    var html = '<div class="panel"><h2>' + esc(title) + '</h2><table><thead><tr>' +
      '<th>Rank</th><th>Protocol</th><th class="num">TVL</th><th class="num">7d</th><th class="num">Age</th>' +
      '<th class="num">Implied value</th><th class="num">Band</th><th class="num">Net</th><th>Verdict</th>' +
      '</tr></thead><tbody>';
    list.forEach(function (r) {
      var w = Math.max(4, Math.round((r.implied_value_usd / maxImplied) * 100));
      html += '<tr data-slug="' + esc(r.slug) + '"><td>' + r.rank + '</td>' +
        '<td class="name"><b>' + esc(r.name) + '</b><span>' + esc(r.category || 'Uncategorised') +
        ' on ' + esc(chainsOf(r)) + '</span></td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td><td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + ageText(r.age_days) + '</td>' +
        '<td class="num"><span class="bar"><i style="width:' + w + '%"></i></span>' + money(r.implied_value_usd) + '</td>' +
        '<td class="num">' + money(r.implied_low_usd) + '–' + money(r.implied_high_usd) + '</td>' +
        '<td class="num">' + signedMoney(r.net_usd) + '</td>' +
        '<td><span class="badge ' + r.verdict + '">' + r.verdict + '</span></td></tr>';
    });
    return html + '</tbody></table></div>';
  }

  function renderBoard() {
    var list = filtered();
    var title = state.tab === 'farm'
      ? 'Pre-token protocols, strongest net value first — farm, thin or skip, each plan netted to the dollar'
      : 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.';
    $('rowCount').textContent = list.length + ' rows shown';
    view.innerHTML = boardTable(list, title);
  }

  function renderComps() {
    $('rowCount').textContent = comps.length + ' live-token comps';
    var html = '<div class="panel"><h2>The ' + comps.length +
      ' live-token comps the curve is fitted on — market value against the fitted value, richest first. ' +
      'These already trade, so the board shows the market\u2019s own value for them, never a model\u2019s.</h2>' +
      '<table><thead><tr><th>Protocol</th><th class="num">TVL</th><th class="num">Market cap</th>' +
      '<th class="num">Fitted value</th><th class="num">Actual ÷ fitted</th></tr></thead><tbody>';
    comps.forEach(function (c) {
      html += '<tr><td class="name"><b>' + esc(c.name) + '</b><span>' + esc(c.category || 'Uncategorised') +
        ' on ' + esc(chainsOf(c)) + '</span></td>' +
        '<td class="num">' + money(c.tvl_usd) + '</td><td class="num">' + money(c.mcap_usd) + '</td>' +
        '<td class="num">' + money(c.fitted_usd) + '</td><td class="num">' + c.multiple.toFixed(2) + '×</td></tr>';
    });
    view.innerHTML = html + '</tbody></table></div>';
  }

  function renderDetail(slug) {
    var r = null;
    rows.forEach(function (x) { if (x.slug === slug) r = x; });
    if (!r) { location.hash = '#/'; return; }
    document.body.classList.add('detail-mode');
    $('rowCount').textContent = '';
    var chainList = r.chains.length > 3 ? r.chains.slice(0, 3).join(', ') + ' +' + (r.chains.length - 3) + ' more' : r.chains.join(', ');
    var steps = r.farm_steps.map(function (s) {
      var cut = s.indexOf(' Cost: ');
      var head = cut > 0 ? s.slice(0, cut) : s;
      var tail = cut > 0 ? s.slice(cut + 1) : '';
      return '<li><b>' + esc(head) + '</b><span>' + esc(tail) + '</span></li>';
    }).join('');
    view.innerHTML = '<article class="detail"><a class="back" href="#/">← Back to the board</a>' +
      '<h2>' + esc(r.name) + '</h2>' +
      '<p class="sub">Rank ' + r.rank + ' of ' + rows.length + ' · ' + esc(r.category || 'Uncategorised') +
      ' on ' + esc(chainList) + ' · records no token</p>' +
      '<dl class="kv">' +
      '<div><dt>Implied value</dt><dd>' + money(r.implied_value_usd) + '<small>band ' + money(r.implied_low_usd) + ' – ' + money(r.implied_high_usd) + '</small></dd></div>' +
      '<div><dt>TVL</dt><dd>' + money(r.tvl_usd) + '<small>7-day ' + (r.change_7d == null ? 'unreported' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(2) + '%') + '</small></dd></div>' +
      '<div><dt>Age with no token</dt><dd>' + ageText(r.age_days) + '<small>' + (r.age_days == null ? 'listed date unreported' : 'since first tracked') + '</small></dd></div>' +
      '<div><dt>Farm verdict</dt><dd><span class="badge ' + r.verdict + '">' + r.verdict + '</span><small>net ' + signedMoney(r.net_usd) + '</small></dd></div>' +
      '</dl>' +
      '<p class="math">Curve value <b>' + money(r.curve_value_usd) + '</b> × growth <b>' + r.growth_multiplier.toFixed(2) +
      '</b> × maturity <b>' + r.maturity_multiplier.toFixed(2) + '</b> = implied <b>' + money(r.implied_value_usd) +
      '</b>. The band is the blind test&rsquo;s median miss, ×' + M.band_multiple + ', up and down.</p>' +
      '<p class="econ">Farm economics, costed at the band&rsquo;s low end: capital <strong>' + money(r.farm_capital_usd) +
      '</strong> · expected gross <strong>' + money(r.expected_gross_usd) + '</strong> · gas <strong>' + money(r.farm_cost_usd) +
      '</strong> · net <strong>' + signedMoney(r.net_usd) + '</strong> → <span class="badge ' + r.verdict + '">' + r.verdict + '</span></p>' +
      '<ol class="steps">' + steps + '</ol>' +
      '<p class="note">The gross assumes ' + Math.round(M.airdrop_share * 100) + '% of the low-end value goes to the airdrop and ' +
      'farmers hold ' + Math.round(M.farmer_tvl_share * 100) + '% of TVL. If farmers held 5% of TVL, the gross would fall by 60%.</p>' +
      '</article>';
  }

  /* ---- routing ------------------------------------------------- */
  function route() {
    var hash = location.hash || '#/';
    document.body.classList.remove('detail-mode');
    var m = hash.match(/^#\/protocol\/([\w-]+)/);
    if (m) { setTab('board'); renderDetail(m[1]); return; }
    if (hash.indexOf('#/comps') === 0) { setTab('comps'); renderComps(); return; }
    if (hash.indexOf('#/farm') === 0) { setTab('farm'); renderBoard(); return; }
    var q = hash.match(/verdict=(farm|thin|skip)/);
    if (q) { state.verdict = q[1]; $('verdict').value = q[1]; }
    setTab('board');
    renderBoard();
  }

  function setTab(tab) {
    state.tab = tab;
    if (tab === 'farm' && state.sort === 'implied') { state.sort = 'net'; $('sort').value = 'net'; }
    document.querySelectorAll('#tabs button').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-tab') === tab);
    });
    document.body.classList.toggle('comps-mode', tab === 'comps');
  }

  /* ---- events -------------------------------------------------- */
  document.querySelectorAll('#tabs button').forEach(function (b) {
    b.addEventListener('click', function () {
      var tab = b.getAttribute('data-tab');
      location.hash = tab === 'board' ? '#/' : '#/' + tab;
    });
  });
  $('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
  $('cat').addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
  $('chain').addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
  $('verdict').addEventListener('change', function (e) { state.verdict = e.target.value; renderBoard(); });
  $('sort').addEventListener('change', function (e) { state.sort = e.target.value; renderBoard(); });
  view.addEventListener('click', function (e) {
    var tr = e.target.closest('tr[data-slug]');
    if (tr) location.hash = '#/protocol/' + tr.getAttribute('data-slug');
  });
  window.addEventListener('hashchange', route);
  route();
})();
