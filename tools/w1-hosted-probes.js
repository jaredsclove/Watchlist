// W1's hosted checks: a page-memory script for the release verification and the recovery drill in docs/W1_RELEASE_PROCEDURE.md.
// It runs in the signed-in live page, with the page's own session (window.W1Probes(pageEnv())), and the local test runs the
// same file. It only ever touches one synthetic show it created through the library functions, and it stops at the first
// answer it doesn't expect. It prints no token, and no row other than that show's id.
//
// The direct write: PATCH tv_shows?id=eq.<the synthetic show>&priority=eq.normal, body {priority: 'high'}. priority is a
// guarded column, and normal to high is a real change, so a guard answers it. A deleted row or a title wouldn't test
// anything: those are item 11, unguarded on purpose.
(function (root) {
  'use strict';
  const LABEL = 'ZZ W1 Release Test', KEY = 'zz w1 release test';
  const ORIGINAL = 'normal', ATTEMPTED = 'high', LEGITIMATE = 'low';
  const STATE = 'status,priority,ended,catalog_new,status_review';

  // env: { url, key, owner: async () => headers with the owner's token, uuid: () => a random id }
  function W1Probes(env) {
    let record = null, halted = null;
    const call = async (method, path, body, headers) => {
      const res = await fetch(`${env.url}/rest/v1/${path}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
      return { status: res.status, ok: res.ok, text, json };
    };
    const owner = async (method, path, body, extra) => call(method, path, body, await env.owner(extra));
    const rpc = (fn, args) => owner('POST', `rpc/${fn}`, args);
    // Every answer is one of these words, so a report can't carry a row.
    const kind = r => {
      if (/library_under_repair/.test(r.text)) return 'gate';
      if (/library_write_required/.test(r.text)) return 'guard';
      if (/library_write_misconfigured/.test(r.text)) return 'misconfigured';
      if (/library_write_scope/.test(r.text)) return 'scope';
      if (/target_missing/.test(r.text)) return 'target_missing';
      if (/permission denied/.test(r.text) || r.status === 401 || r.status === 403) return 'denied';
      if (r.ok && Array.isArray(r.json) && r.json.length === 0) return 'no_row';
      if (r.ok) return 'wrote';
      return `other_${r.status}`;
    };
    const stop = why => { halted = halted || why; throw new Error(`w1 probes stopped: ${why}`); };
    const live = () => { if (halted) throw new Error(`w1 probes stopped earlier: ${halted}`); if (!record) throw new Error('w1 probes: no record'); };
    const read = async () => {
      const r = await owner('GET', `tv_shows?select=${STATE}&id=eq.${record.showId}`);
      if (!r.ok || !Array.isArray(r.json) || r.json.length !== 1) stop(`the record could not be read (${kind(r)})`);
      return r.json[0];
    };
    const priority = async () => (await read()).priority;
    const setState = async (from, to) => {
      const s = await read();
      if (s.priority !== from) stop(`the record is ${s.priority}, expected ${from}`);
      const r = await rpc('library_set_show_state_b45', { p_show_id: record.showId, p_expected: s, p_changes: { priority: to } });
      if (!r.ok || !r.json || !r.json.changed) stop(`the library function answered ${kind(r)}`);
      if ((await priority()) !== to) stop('the library function did not change the record');
    };

    return {
      kind,
      // The record is created once, and a show of that name already there stops it: it could be a leftover to look at first.
      async create() {
        if (record) stop('a record already exists on this page');
        const before = await owner('GET', `tv_shows?select=id&show_key=eq.${encodeURIComponent(KEY)}`);
        if (!before.ok || before.json.length) stop(`a show with the test key answered ${kind(before)}, ${before.ok ? before.json.length : '?'} rows`);
        const r = await rpc('library_create_show_b45', { p_show: { title: LABEL, show_key: KEY, network: 'ZZ' },
          p_seasons: [{ item_key: `${KEY}|season 1`, title: LABEL, season: 'Season 1', theme: 'ZZ', display_date: 'Jan 1, 2021', date_sort: '2021-01-01' }] });
        if (!r.ok || !r.json || !r.json.show) stop(`create answered ${kind(r)}`);
        const showId = r.json.show.id;
        const rows = await owner('GET', `watchlist_items?select=id&show_id=eq.${showId}`);
        if (!rows.ok || rows.json.length !== 1) { record = { showId, seasonId: null }; stop('the record has no single season'); }
        record = { showId, seasonId: rows.json[0].id };
        if ((await read()).priority !== ORIGINAL) stop('the record did not start at normal');
        return { ...record, field: 'tv_shows.priority', original: ORIGINAL, attempted: ATTEMPTED };
      },
      // The ids again after a reload of the page: from the private record, never from a search.
      adopt(saved) { if (record) stop('a record already exists on this page'); record = { showId: saved.showId, seasonId: saved.seasonId }; },
      // n direct writes at once, across PostgREST's pool, then a read. Anything but the expected answer stops the run,
      // and a write that went through is put back at once by restore.
      async direct(expected, n = 8) {
        live();
        const answers = await Promise.all(Array.from({ length: n }, async () => kind(await owner('PATCH', `tv_shows?id=eq.${record.showId}&priority=eq.${ORIGINAL}`, { priority: ATTEMPTED }, { Prefer: 'return=representation' }))));
        const value = expected === 'denied' ? null : await priority();
        const counts = answers.reduce((c, k) => ({ ...c, [k]: (c[k] || 0) + 1 }), {});
        if (answers.includes('wrote') || (value !== null && value !== ORIGINAL)) return { counts, value, wrote: true, restored: await this.restore() };
        if (!answers.every(k => k === expected)) stop(`direct write: ${JSON.stringify(counts)}, expected ${expected}`);
        return { counts, value };
      },
      // Only for a direct write that went through: its own exact change, with the attempted value as the filter. Tried by
      // the direct path, then the library function. Whatever happens, nothing further runs on this page.
      async restore() {
        halted = 'a direct write went through; its restore did not finish';
        const r = await owner('PATCH', `tv_shows?id=eq.${record.showId}&priority=eq.${ATTEMPTED}`, { priority: ORIGINAL }, { Prefer: 'return=representation' });
        let how = 'direct';
        if (!(r.ok && Array.isArray(r.json) && r.json.length === 1)) { how = 'function'; await setState(ATTEMPTED, ORIGINAL).catch(() => {}); }
        const value = await priority().catch(() => 'unread');
        halted = `a direct write went through; restored by ${how}, value ${value}`;
        return { how, value, confirmed: value === ORIGINAL };
      },
      // A check that writes nothing: an id that matches no row reaches lib_write_on, then stops.
      async noWrite(expected = 'target_missing', n = 8) {
        const answers = await Promise.all(Array.from({ length: n }, async () => kind(await rpc('library_cu_set_show_settings', { p_show_id: env.uuid(), p_expected: {}, p_follow_when_skipped: false, p_clear_ended_flag: false }))));
        if (!answers.every(k => k === expected)) stop(`no-write check: ${[...new Set(answers)]}, expected ${expected}`);
        return { n, answer: expected };
      },
      // A real write through a library function, there and back, on the record.
      async legitimate() {
        live();
        await setState(ORIGINAL, LEGITIMATE);
        await setState(LEGITIMATE, ORIGINAL);
        return { changed: `${ORIGINAL} to ${LEGITIMATE} and back`, value: await priority() };
      },
      // No sign-in: the gate's error while it is on, the ordinary refusal once it is off.
      async signedOut(expected, n = 8) {
        const answers = await Promise.all(Array.from({ length: n }, async () => kind(await call('GET', 'tv_shows?select=id&limit=1', undefined, { apikey: env.key }))));
        if (!answers.every(k => k === expected)) stop(`signed out: ${[...new Set(answers)]}, expected ${expected}`);
        return { n, answer: expected };
      },
      // What a signed-out request answers now, for polling after a reload. Never stops.
      async peek() { return kind(await call('GET', 'tv_shows?select=id&limit=1', undefined, { apikey: env.key })); },
      // The same request's status and error code, to tell a gate that didn't load from an answer kind can't read.
      async shape() { const r = await call('GET', 'tv_shows?select=id&limit=1', undefined, { apikey: env.key }); return { status: r.status, code: r.json && !Array.isArray(r.json) ? r.json.code || null : null, json: !!r.json }; },
      // Removes the record with delete_tv_season: its last season takes the show. Refused if the record isn't as created.
      async cleanup() {
        live();
        if ((await priority()) !== ORIGINAL) stop('the record is not at its original value');
        const r = await rpc('delete_tv_season', { p_row_id: record.seasonId, p_marks_expected: 0 });
        if (!r.ok || !r.json || !r.json.show_deleted) stop(`delete answered ${kind(r)}`);
        const a = await owner('GET', `tv_shows?select=id&id=eq.${record.showId}`), b = await owner('GET', `watchlist_items?select=id&show_id=eq.${record.showId}`);
        if (!a.ok || !b.ok || a.json.length || b.json.length) stop('the record is still there');
        record = null;
        return { removed: true };
      },
    };
  }
  root.W1Probes = W1Probes;
  // The live page's own session, through its own functions. Run in that page only.
  root.W1PageEnv = () => ({ url: root.SUPABASE_URL || SUPABASE_URL, key: root.SUPABASE_KEY || SUPABASE_KEY, owner: extra => authHeaders(extra || {}), uuid: () => crypto.randomUUID() }); // eslint-disable-line no-undef
})(typeof window === 'undefined' ? globalThis : window);
