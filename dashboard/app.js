// Token Radar's console dashboard.
//
// It reads window.RADAR — the dataset main.ts writes beside dashboard/ as
// data.js — and renders the ranked board, a filterable table, a per-protocol
// detail drawer with the model's own inputs and the protocol's farm plan. No
// network: every byte it shows is already in data.js. The page also recomputes
// each row from the snapshot figures and checks the number board.json carries,
// so the page's arithmetic and the board's data are visibly the same.
//
// Press "/" anywhere on the page to jump to the search box.
(() => {
  'use strict';

  const DATA = window.RADAR;
  if (!DATA) return;

  const mount = document.getElementById('board');

  // What the reader is looking at right now: the search text, the filters, the
  // active tab, the sort, and the protocol whose detail drawer is open.
  const view = {
    q: '',
    category: 'all',
    chain: 'all',
    wl: false,
    tab: 'pre-token',
    sort: 'implied',
    dir: -1,
    selected: null,
  };

  /* ---------------------------------------------------------------- */
  /* Formatting                                                        */
  /* ---------------------------------------------------------------- */

  /** A dollar amount, shortened: $588.40M, $1.2M, $850K, $42. */
  function money(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    const abs = Math.abs(n);
    if (abs >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (abs >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + Math.round(n);
  }

  /** A seven-day change with a sign: +3.42%, -1.08%, n/a. */
  function pct(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }

  /** An age in days, shortened: 2.4y, 90d, unknown. */
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  /** A market multiple: 0.246x. */
  function multLabel(n) {
    return n.toFixed(3) + 'x';
  }

  /* ---------------------------------------------------------------- */
  /* The model, recomputed in the page                                 */
  /* ---------------------------------------------------------------- */

  // The same arithmetic board.json carries, so the page can check a row
  // against the board. `multiple` is the row's own market multiple; the chain
  // factor follows from its chain count.
  function recompute(row) {
    const model = DATA.model;
    const growth = Math.min(
      model.growth_cap,
      Math.max(model.growth_floor, row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d),
    );
    const growthMult = 1 + (growth / 100) * model.growth_weight;
    const age = row.age_days === null || row.age_days === undefined ? model.unknown_age_days : row.age_days;
    const maturity =
      model.maturity_floor +
      (Math.min(Math.max(age, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
    const chainMult =
      1 + model.chain_step * (Math.min(Math.max((row.chains || []).length, 1), model.chain_max) - 1);
    return Math.max(1, Math.round(row.tvl_usd * row.multiple * growthMult * maturity * chainMult));
  }

  /* ---------------------------------------------------------------- */
  /* A small DOM builder                                               */
  /* ---------------------------------------------------------------- */

  // h('div', { className: 'panel', id: 'x' }, child, 'text', [more]) builds a
  // node. Props: className, text, html set content; onClick/onInput/... add
  // listeners; anything else becomes an attribute. Null, undefined and false
  // children are skipped; arrays are flattened.
  function h(tag, props, ...kids) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;
        if (key === 'className') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'html') node.innerHTML = value;
        else if (key.startsWith('on') && typeof value === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), value);
        } else node.setAttribute(key, value);
      }
    }
    for (const kid of kids.flat(9)) {
      if (kid === null || kid === undefined || kid === false) continue;
      node.append(kid && kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return node;
  }

  /* ---------------------------------------------------------------- */
  /* The farm plan, derived the same way board.json derives it         */
  /* ---------------------------------------------------------------- */

  // Category, chains, TVL and age decide the action, the capital, the hold
  // and every cost and time. No name is special-cased.
  function primaryChain(p) {
    return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain';
  }

  function stakeFor(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }

  function holdFor(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }

  // The category actions, as a rule table: the first rule whose keywords
  // appear in the category wins, and the default at the end is a plain
  // deposit. The order is the priority.
  const ACTION_RULES = [
    {
      keys: ['lend', 'cdp', 'collateral'],
      write: (name, amount, chain) => `Supply $${amount} of USDC to ${name} on ${chain} and keep the position open.`,
    },
    {
      keys: ['dex', 'yield', 'leveraged farm'],
      write: (name, amount, chain) => `Provide $${amount} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`,
    },
    {
      keys: ['basis'],
      write: (name, amount, chain) => `Deposit $${amount} of USDC into ${name}'s basis vault on ${chain} and keep the shares.`,
    },
    {
      keys: ['bridge'],
      write: (name, amount, chain) => `Bridge $${amount} of USDC to ${chain} through ${name} and use the bridged funds in its app.`,
    },
    {
      keys: ['staking', 'restak'],
      write: (name, amount, chain) => `Stake $${amount} of the chain's staking asset through ${name} and keep the receipt.`,
    },
    {
      keys: ['perpetual', 'derivative'],
      write: (name, amount, chain) => `Deposit $${amount} of USDC as margin on ${name} and open one small hedge.`,
    },
    {
      keys: ['prediction'],
      write: (name, amount, chain) => `Fund $${amount} and place one market position on ${name}.`,
    },
    {
      keys: ['curator', 'allocator'],
      write: (name, amount, chain) => `Deposit $${amount} into a ${name} vault on ${chain} and keep the shares.`,
    },
    {
      keys: ['stable'],
      write: (name, amount, chain) => `Mint or deposit $${amount} of the stable asset through ${name} on ${chain}.`,
    },
    {
      keys: ['rwa'],
      write: (name, amount, chain) => `Mint $${amount} of the protocol's yield asset on ${chain} and hold it.`,
    },
    {
      keys: ['insurance'],
      write: (name, amount, chain) => `Buy $${amount} of cover from ${name} on ${chain} and keep the policy.`,
    },
  ];

  function actionFor(p, amount, chain) {
    const c = (p.category || '').toLowerCase();
    for (const rule of ACTION_RULES) {
      if (rule.keys.some((key) => c.indexOf(key) >= 0)) return rule.write(p.name, amount, chain);
    }
    return `Deposit $${amount} of USDC into ${p.name} on ${chain} and keep the position open.`;
  }

  function toStepText(step) {
    let s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }

  function farmPlan(p) {
    const chain = primaryChain(p);
    const capital = stakeFor(p);
    const hold = holdFor(p.age_days);
    return [
      {
        text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.',
        cost: 'under $3 of gas for the first transaction',
        time: '5 minutes',
      },
      {
        text: actionFor(p, capital, chain),
        cost: '$' + capital + ' of capital and about $' + (capital >= 150 ? 8 : 4) + ' of gas',
        time: '15 minutes to set up',
      },
      {
        text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.',
        cost: 'about $2 of gas a week',
        time: '10 minutes a week',
      },
      {
        text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.',
        cost: 'the $' + capital + ' stays in the position',
        time: hold + ' days',
      },
      {
        text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.",
        cost: 'no fee to check, and never pay to claim',
        time: '10 minutes',
      },
      {
        text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.',
        cost: 'nothing but the log',
        time: '5 minutes',
      },
      {
        text: 'Ignore any message offering a guaranteed airdrop, a paid claim link or support asking for your seed phrase: a real claim is free and only on the protocol\u2019s own page.',
        cost: 'nothing to check',
        time: '2 minutes',
      },
    ].map(toStepText);
  }

  /* ---------------------------------------------------------------- */
  /* Deep links: the view lives in the hash                            */
  /* ---------------------------------------------------------------- */

  function readHash() {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    if (params.get('q')) view.q = params.get('q');
    if (params.get('p')) view.selected = params.get('p');
    if (params.get('category')) view.category = params.get('category');
    if (params.get('chain')) view.chain = params.get('chain');
    if (params.get('wl') === '1') view.wl = true;
    if (params.get('tab')) view.tab = params.get('tab');
  }

  function writeHash() {
    const params = new URLSearchParams();
    if (view.q) params.set('q', view.q);
    if (view.category !== 'all') params.set('category', view.category);
    if (view.chain !== 'all') params.set('chain', view.chain);
    if (view.wl) params.set('wl', '1');
    if (view.tab !== 'pre-token') params.set('tab', view.tab);
    if (view.selected) params.set('p', view.selected);
    const next = params.toString();
    if (next) window.history.replaceState(null, '', '#' + next);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  /* ---------------------------------------------------------------- */
  /* Filtering and sorting                                             */
  /* ---------------------------------------------------------------- */

  function visibleRows() {
    const q = view.q.trim().toLowerCase();
    return DATA.rows.filter((r) => {
      if (view.category !== 'all' && r.category !== view.category) return false;
      if (view.chain !== 'all' && (r.chains || []).indexOf(view.chain) < 0) return false;
      if (view.wl && !r.watchlist) return false;
      if (!q) return true;
      const hay = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return hay.indexOf(q) >= 0;
    });
  }

  function sortRows(list) {
    const key = view.sort;
    return list.slice().sort((a, b) => {
      let av;
      let bv;
      if (key === 'name') {
        av = a.name.toLowerCase();
        bv = b.name.toLowerCase();
      } else if (key === 'tvl') {
        av = a.tvl_usd;
        bv = b.tvl_usd;
      } else if (key === 'growth') {
        av = a.change_7d === null ? -Infinity : a.change_7d;
        bv = b.change_7d === null ? -Infinity : b.change_7d;
      } else if (key === 'age') {
        av = a.age_days === null ? Infinity : a.age_days;
        bv = b.age_days === null ? Infinity : b.age_days;
      } else {
        av = a.implied_value_usd;
        bv = b.implied_value_usd;
      }
      if (av < bv) return -view.dir;
      if (av > bv) return view.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Sections                                                          */
  /* ---------------------------------------------------------------- */

  function topBar() {
    return h(
      'header',
      { className: 'top' },
      h('div', { className: 'brand' }, h('span', { className: 'mark' }), h('span', { className: 'brand-name', text: 'Token Radar' })),
      h(
        'div',
        { className: 'top-meta' },
        h('span', { html: 'Snapshot <b>' + DATA.as_of + '</b>' }),
        h('span', { text: 'DefiLlama protocol index' }),
        h('span', { html: 'Model <b>' + DATA.model_version + '</b>' }),
      ),
    );
  }

  function intro() {
    const facts = [
      ['Watchlist covered', DATA.watchlist_size + ' / ' + DATA.watchlist_size, false],
      ['Pre-token rows scored', String(DATA.board_size), false],
      ['Early rows below the floor', String(DATA.early_size), false],
      ['Total implied value', money(DATA.total_implied_value_usd), true],
      ['Market multiple (median)', multLabel(DATA.multiples.global), false],
      ['Live-token protocols set aside', String(DATA.live_size), false],
    ];
    return h(
      'section',
      { className: 'lede' },
      h(
        'div',
        null,
        h('h1', { text: DATA.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        h('p', {
          text:
            'The watchlist is the floor: every protocol with at least $' +
            Math.round(DATA.floor_usd / 1e6) +
            'M of TVL and no token on record. The early radar adds ' +
            DATA.early_size +
            ' pre-token protocols below that floor. Implied value is a model, not a promise: it prices each protocol the way the market prices the ones that already trade.',
        }),
      ),
      h(
        'div',
        { className: 'facts' },
        facts.map(([label, value, hot]) =>
          h('div', { className: 'fact' }, h('span', { text: label }), h('b', { className: hot ? 'hot' : null, text: value })),
        ),
      ),
    );
  }

  function spotlight() {
    const top = DATA.rows.slice(0, 5);
    return h(
      'div',
      { className: 'spot' },
      top.map((r) =>
        h(
          'button',
          { type: 'button', className: 'spot-chip', onClick: () => openDetail(r.slug) },
          h('span', { className: 'rank', text: '#' + r.rank }),
          h('span', { text: r.name }),
          h('span', { className: 'val', text: money(r.implied_value_usd) }),
        ),
      ),
    );
  }

  function filterBar() {
    const categories = Array.from(new Set(DATA.rows.map((r) => r.category || 'Other'))).sort();
    const chainCounts = {};
    DATA.rows.forEach((r) => {
      (r.chains || []).forEach((c) => {
        chainCounts[c] = (chainCounts[c] || 0) + 1;
      });
    });
    const chains = Object.keys(chainCounts)
      .sort((a, b) => chainCounts[b] - chainCounts[a])
      .slice(0, 14);

    const search = h('input', {
      type: 'search',
      id: 'q',
      placeholder: 'Search name, category or chain',
      value: view.q,
      'aria-label': 'Search the board',
    });
    search.addEventListener('input', () => {
      view.q = search.value;
      writeHash();
      render();
    });

    const catSelect = h(
      'select',
      { id: 'category', 'aria-label': 'Filter by category' },
      h('option', { value: 'all', text: 'All categories' }),
      categories.map((c) => h('option', { value: c, text: c, selected: c === view.category ? 'selected' : null })),
    );
    catSelect.addEventListener('change', () => {
      view.category = catSelect.value;
      writeHash();
      render();
    });

    const chainSelect = h(
      'select',
      { id: 'chain', 'aria-label': 'Filter by chain' },
      h('option', { value: 'all', text: 'All chains' }),
      chains.map((c) => h('option', { value: c, text: c + ' (' + chainCounts[c] + ')', selected: c === view.chain ? 'selected' : null })),
    );
    chainSelect.addEventListener('change', () => {
      view.chain = chainSelect.value;
      writeHash();
      render();
    });

    const wlToggle = h(
      'label',
      { className: 'check' },
      h('input', {
        type: 'checkbox',
        checked: view.wl ? 'checked' : null,
        onChange: (e) => {
          view.wl = e.target.checked;
          writeHash();
          render();
        },
      }),
      'Watchlist only',
    );

    const preTab = h('button', {
      type: 'button',
      'aria-pressed': view.tab === 'pre-token' ? 'true' : 'false',
      text: 'Pre-token',
      onClick: () => {
        view.tab = 'pre-token';
        render();
      },
    });
    const liveTab = h('button', {
      type: 'button',
      'aria-pressed': view.tab === 'live' ? 'true' : 'false',
      text: 'Live token',
      onClick: () => {
        view.tab = 'live';
        render();
      },
    });

    return h(
      'div',
      { className: 'controls' },
      h('div', { className: 'field' }, h('label', { for: 'q', text: 'Search' }), search),
      h('div', { className: 'field' }, h('label', { for: 'category', text: 'Category' }), catSelect),
      h('div', { className: 'field' }, h('label', { for: 'chain', text: 'Chain' }), chainSelect),
      wlToggle,
      h('div', { className: 'field' }, h('span', { className: 'sub', text: 'Token status' }), h('div', { className: 'tabs' }, preTab, liveTab)),
      h('span', {
        className: 'count',
        text: view.tab === 'pre-token' ? visibleRows().length + ' rows shown' : DATA.live.length + ' live-token protocols',
      }),
    );
  }

  function sortHead(key, label) {
    return h(
      'th',
      { scope: 'col' },
      h(
        'button',
        {
          type: 'button',
          onClick: () => {
            if (view.sort === key) view.dir = -view.dir;
            else {
              view.sort = key;
              view.dir = -1;
            }
            render();
          },
        },
        label,
        view.sort === key ? h('span', { 'aria-hidden': 'true', text: view.dir < 0 ? ' v' : ' ^' }) : null,
      ),
    );
  }

  function chainLabel(chains) {
    if (chains && chains.length) return chains.slice(0, 2).join(', ');
    return 'an unnamed chain';
  }

  function boardTable() {
    const list = sortRows(visibleRows());
    if (list.length === 0) {
      return h(
        'div',
        { className: 'panel' },
        h(
          'div',
          { className: 'empty' },
          h('h2', { text: 'No protocol matches that filter' }),
          h('p', { text: 'Clear the search or pick another category to see the board again.' }),
          h(
            'button',
            {
              className: 'button primary',
              type: 'button',
              text: 'Clear filters',
              onClick: () => {
                view.q = '';
                view.category = 'all';
                view.chain = 'all';
                view.wl = false;
                writeHash();
                render();
              },
            },
          ),
        ),
      );
    }
    const max = list[0].implied_value_usd || 1;
    const tbody = h('tbody');
    list.forEach((r) => {
      const growth = r.change_7d === null ? 'n/a' : pct(r.change_7d);
      const growthClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      const multNote =
        r.multiple_source === 'category'
          ? multLabel(r.multiple) + ' ' + (r.category || '') + ' median'
          : multLabel(r.multiple) + ' market median';
      const tr = h(
        'tr',
        {
          'data-selected': view.selected === r.slug ? 'true' : 'false',
          tabindex: '0',
          onClick: () => openDetail(r.slug),
          onKeydown: (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              openDetail(r.slug);
            }
          },
        },
        h('td', { className: 'num', text: String(r.rank) }),
        h(
          'td',
          null,
          h(
            'div',
            { className: 'name' },
            h('b', { text: r.name }),
            h('span', { className: 'sub', text: (r.category || 'Other') + ' on ' + chainLabel(r.chains) + (r.watchlist ? ' · watchlist' : '') }),
          ),
        ),
        h('td', { className: 'num', text: money(r.tvl_usd) }),
        h('td', { className: 'num ' + growthClass, text: growth }),
        h('td', { className: 'num', text: ageLabel(r.age_days) }),
        h(
          'td',
          null,
          h(
            'div',
            { className: 'implied' },
            h('div', { className: 'bar', 'aria-hidden': 'true' }, h('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / max) * 100)) + '%' })),
            h(
              'div',
              null,
              h('span', { className: 'num', text: money(r.implied_value_usd) }),
              h('div', { className: 'mult', text: multNote }),
            ),
          ),
        ),
        h('td', null, h('span', { className: 'status', text: 'no token' })),
      );
      tbody.appendChild(tr);
    });
    return h(
      'div',
      { className: 'panel' },
      h(
        'div',
        { className: 'table-wrap' },
        h(
          'table',
          null,
          h('caption', { className: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              sortHead('implied', 'Rank'),
              sortHead('name', 'Protocol'),
              sortHead('tvl', 'TVL'),
              sortHead('growth', '7d'),
              sortHead('age', 'Age'),
              sortHead('implied', 'Implied value'),
              h('th', { scope: 'col', text: 'Token' }),
            ),
          ),
          tbody,
        ),
      ),
    );
  }

  function liveTable() {
    const tbody = h('tbody');
    DATA.live.forEach((r) => {
      tbody.appendChild(
        h(
          'tr',
          null,
          h('td', { className: 'num', text: 'live' }),
          h(
            'td',
            null,
            h(
              'div',
              { className: 'name' },
              h('b', { text: r.name }),
              h('span', { className: 'sub', text: (r.category || 'Other') + ' on ' + chainLabel(r.chains) }),
            ),
          ),
          h('td', { className: 'num', text: money(r.tvl_usd) }),
          h('td', { className: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: pct(r.change_7d) }),
          h('td', { className: 'num', text: money(r.mcap_usd) }),
          h('td', null, h('span', { className: 'status live', text: 'already trades' })),
        ),
      );
    });
    return h(
      'div',
      { className: 'panel' },
      h(
        'div',
        { className: 'table-wrap' },
        h(
          'table',
          null,
          h('caption', {
            className: 'sub',
            text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking, and their pricing is what the board is calibrated on.',
          }),
          h(
            'thead',
            null,
            h(
              'tr',
              null,
              h('th', { scope: 'col', text: 'Status' }),
              h('th', { scope: 'col', text: 'Protocol' }),
              h('th', { scope: 'col', text: 'TVL' }),
              h('th', { scope: 'col', text: '7d' }),
              h('th', { scope: 'col', text: 'Market cap' }),
              h('th', { scope: 'col', text: 'Token' }),
            ),
          ),
          tbody,
        ),
      ),
    );
  }

  function modelSection() {
    const m = DATA.model;
    const mults = DATA.multiples;
    const cells = Object.keys(mults.categories)
      .sort()
      .map((cat) => {
        const c = mults.categories[cat];
        return h('div', { className: 'mult-cell' }, h('b', { text: multLabel(c.multiple) }), h('span', { text: cat + ' median · n=' + c.n }));
      });
    cells.unshift(
      h('div', { className: 'mult-cell' }, h('b', { text: multLabel(mults.global) }), h('span', { text: 'All live protocols · n=' + mults.global_n })),
    );
    return h(
      'section',
      { className: 'panel model' },
      h('h2', { text: 'How implied value is computed' }),
      h('p', {
        className: 'sub',
        text: 'Every row is scored by one function of the snapshot figures. No protocol name is special-cased, and no row is hand-picked. The base multiple is not a guess: it is the median market-cap / TVL the market already pays live protocols, in the same category where at least five of them trade, else across all of them. Centralised exchanges are left out of the calibration.',
      }),
      h(
        'div',
        { className: 'formula' },
        'implied = round( tvl_usd x multiple x (1 + clamp(change_7d, ' +
          m.growth_floor +
          ', ' +
          m.growth_cap +
          ') / 100 x ' +
          m.growth_weight +
          ') x (' +
          m.maturity_floor +
          ' + min(age_days, ' +
          m.maturity_days +
          ') / ' +
          m.maturity_days +
          ' x ' +
          m.maturity_range +
          ') x (1 + ' +
          m.chain_step +
          ' x (min(chains, ' +
          m.chain_max +
          ') - 1)) )',
      ),
      h('div', { className: 'mult-table' }, cells),
      h('p', {
        className: 'sub',
        text:
          'TVL and seven-day growth come from the snapshot. Age is the time since the protocol was first listed, the best record of how long it has run with no token; an unlisted age uses ' +
          m.unknown_age_days +
          ' days. The chain factor is small: one extra chain is worth two per cent. The early radar is every rankable pre-token protocol below the watchlist floor, and the live-token protocols are set aside with their market caps shown.',
      }),
    );
  }

  /* ---------------------------------------------------------------- */
  /* The detail drawer                                                 */
  /* ---------------------------------------------------------------- */

  const dialog = h('dialog', { className: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  dialog.addEventListener('close', () => {
    view.selected = null;
    writeHash();
  });

  function openDetail(slug) {
    const row = DATA.rows.filter((r) => r.slug === slug)[0];
    if (!row) return;
    view.selected = slug;
    writeHash();
    dialog.textContent = '';
    const steps = farmPlan(row);
    const recomputed = recompute(row);
    const multLine =
      row.multiple_source === 'category'
        ? multLabel(row.multiple) + ' — ' + (row.category || '') + ' median, ' + row.multiple_n + ' live protocols'
        : multLabel(row.multiple) + ' — market median, ' + row.multiple_n + ' live protocols';
    const chainText = row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain';
    dialog.appendChild(
      h(
        'div',
        { className: 'detail-head' },
        h(
          'div',
          null,
          h('span', { className: 'brand-name', text: 'Rank ' + row.rank + ' of ' + DATA.board_size + (row.watchlist ? ' · watchlist' : ' · early radar') }),
          h('h2', { id: 'detail-title', text: row.name }),
          h('p', { className: 'sub', text: (row.category || 'Other') + ' on ' + chainText }),
        ),
        h('button', { className: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onClick: () => dialog.close() }),
      ),
    );
    dialog.appendChild(
      h(
        'section',
        { className: 'detail-section' },
        h('h3', { text: 'Implied value' }),
        h(
          'div',
          { className: 'equation' },
          h('div', null, h('span', { text: 'TVL' }), h('b', { className: 'num', text: money(row.tvl_usd) })),
          h('div', null, h('span', { text: 'Market multiple' }), h('b', { className: 'num', text: multLine })),
          h('div', null, h('span', { text: 'Seven-day growth' }), h('b', { className: 'num', text: pct(row.change_7d) })),
          h('div', null, h('span', { text: 'Age with no token' }), h('b', { className: 'num', text: ageLabel(row.age_days) })),
          h('div', null, h('span', { text: 'Growth multiplier' }), h('b', { className: 'num', text: String(row.growth_multiplier) })),
          h('div', null, h('span', { text: 'Maturity multiplier' }), h('b', { className: 'num', text: String(row.maturity_multiplier) })),
          h('div', null, h('span', { text: 'Chain multiplier' }), h('b', { className: 'num', text: String(row.chain_multiplier) })),
          h('div', { className: 'total' }, h('span', { text: 'Implied value' }), h('b', { className: 'num', text: money(row.implied_value_usd) })),
        ),
        h('p', {
          className: 'sub',
          text:
            'Model ' +
            DATA.model_version +
            ': the same function scores every protocol. The page recomputes this row as ' +
            money(recomputed) +
            (recomputed === row.implied_value_usd ? ', the same number board.json carries.' : ', which differs from the board: the data would be stale.') +
            ' This is an estimate, not a price.',
        }),
      ),
    );
    dialog.appendChild(
      h(
        'section',
        { className: 'detail-section' },
        h('h3', { text: 'Farm plan' }),
        h(
          'ol',
          { className: 'steps' },
          steps.map((s, i) => {
            const at = s.indexOf(' Cost: ');
            const action = at >= 0 ? s.slice(0, at) : s;
            const tail = at >= 0 ? s.slice(at + 1) : '';
            return h('li', { className: i === steps.length - 1 ? 'warn' : null }, h('b', { text: action }), h('span', { className: 'cost', text: tail }));
          }),
        ),
      ),
    );
    dialog.appendChild(
      h('p', { className: 'note', text: 'Airdrops are never guaranteed, and a token may never come: farm only with money you can leave in place, and only on the protocol\u2019s own pages.' }),
    );
    if (typeof dialog.showModal === 'function') {
      if (!dialog.open) dialog.showModal();
    } else {
      dialog.setAttribute('open', '');
    }
  }

  /* ---------------------------------------------------------------- */
  /* Render and wire up                                                */
  /* ---------------------------------------------------------------- */

  function render() {
    mount.textContent = '';
    const shell = h('div', { className: 'shell' });
    shell.appendChild(topBar());
    shell.appendChild(intro());
    if (view.tab === 'pre-token') shell.appendChild(spotlight());
    shell.appendChild(filterBar());
    shell.appendChild(view.tab === 'pre-token' ? boardTable() : liveTable());
    if (view.tab === 'pre-token') shell.appendChild(modelSection());
    mount.appendChild(shell);
    mount.setAttribute('aria-busy', 'false');
    if (!dialog.isConnected) mount.appendChild(dialog);
    if (view.selected) openDetail(view.selected);
  }

  readHash();
  render();
  window.addEventListener('hashchange', () => {
    view.q = '';
    view.category = 'all';
    view.chain = 'all';
    view.wl = false;
    view.tab = 'pre-token';
    view.selected = null;
    readHash();
    render();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dialog.open) dialog.close();
    // "/" focuses the search box, unless the reader is already typing.
    if (e.key === '/' && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement ? document.activeElement.tagName : '')) {
      const box = document.getElementById('q');
      if (box) {
        e.preventDefault();
        box.focus();
      }
    }
  });
})();
