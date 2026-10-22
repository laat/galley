// galley web UI. Server-rendered pages; this file adds the interactive parts.
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const main = () => document.getElementById('main');
  const ds = () => main().dataset;
  const viewer = () => document.body.dataset.viewer;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ------------------------------------------------------------------ API

  async function api(method, url, body, extra) {
    const opts = { method, ...extra, headers: { ...(extra && extra.headers) } };
    if (body !== undefined) {
      opts.headers['content-type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {}
    if (!res.ok) {
      const err = new Error((json && json.message) || text || res.statusText);
      err.status = res.status;
      err.json = json;
      throw err;
    }
    return json;
  }

  // --------------------------------------------------------------- drafts
  // Unsent text survives live refreshes and reloads (per tab, per pull request).

  const draftPrefix = () => `galley:draft:${ds().pullId || 'global'}:`;

  function saveDraft(key, value, meta, priority) {
    try {
      if (value.trim()) sessionStorage.setItem(draftPrefix() + key, JSON.stringify({ value, meta, priority }));
      else sessionStorage.removeItem(draftPrefix() + key);
    } catch {}
  }

  function clearDraft(key) {
    try {
      sessionStorage.removeItem(draftPrefix() + key);
    } catch {}
  }

  function drafts() {
    const out = [];
    try {
      const prefix = draftPrefix();
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k && k.startsWith(prefix)) out.push([k.slice(prefix.length), JSON.parse(sessionStorage.getItem(k))]);
      }
    } catch {}
    return out;
  }

  function restoreDrafts() {
    for (const [key, d] of drafts()) {
      let ta = $(`textarea[data-draft-key="${CSS.escape(key)}"]`);
      if (!ta && d.meta) ta = reopenForm(d.meta);
      if (ta) fillDraft(ta, d);
      // A comment on lines that are folded away again: load them first.
      else if (d.meta && d.meta.kind === 'line') unfoldFor(d.meta).then((t) => t && fillDraft(t, d), () => {});
    }
  }

  function fillDraft(ta, d) {
    if (!ta.value || ta.value === ta.defaultValue) {
      ta.value = withoutStaleUploads(d.value);
      if (ta.value !== d.value) saveDraftOf(ta);
    }
    const priority = ta.closest('.inline-comment-form') && $('select[name=priority]', ta.closest('.inline-comment-form'));
    if (priority && d.priority && !priority.value) priority.value = d.priority;
    reveal(ta);
  }

  /** Show the (hidden) form a textarea lives in. */
  function reveal(ta) {
    const edit = ta.closest('.comment-edit-form');
    if (edit && edit.hidden) openEdit(edit);
    const reply = ta.closest('.review-thread-reply-form');
    if (reply && reply.hidden) openReply(reply.closest('.review-thread-reply'), false);
  }

  /** A draft is its text, where it goes, and for a new review comment its priority. */
  function saveDraftOf(textarea) {
    const holder = textarea.closest('[data-draft-meta]');
    const priority = holder && $('select[name=priority]', holder);
    saveDraft(textarea.dataset.draftKey, textarea.value, holder ? JSON.parse(holder.dataset.draftMeta) : undefined, priority ? priority.value : undefined);
  }

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches && t.matches('textarea[data-draft-key]')) saveDraftOf(t);
  });
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t.matches || !t.matches('.inline-comment-form select[name=priority]')) return;
    const textarea = $('textarea[data-draft-key]', t.closest('.inline-comment-form'));
    if (textarea) saveDraftOf(textarea);
  });

  // ------------------------------------------------------------- refresh

  const userState = { collapsed: new Map(), threads: new Map(), expanded: new Map() };
  let refreshing = null;
  let refreshAgain = null;
  // The control in a reviewer agent's menu that has the focus, or had it last.
  let menuFocus = null;
  document.addEventListener('focusin', (e) => {
    const menu = e.target.closest && e.target.closest('.agent-menu');
    menuFocus = menu ? { id: e.target.id, menu: menu.id } : null;
  });

  async function refresh() {
    // What asks for this may have changed after the page in flight was rendered: fetch it once
    // more after that one, for everyone who asks meanwhile.
    if (refreshing) {
      // Also after one that failed (the server was away): the one queued tries again.
      refreshAgain ??= refreshing
        .catch(() => {})
        .then(() => {
          refreshAgain = null;
          return refresh();
        });
      return refreshAgain;
    }
    refreshing = (async () => {
      const n = ++fetched;
      const asked = ++headerAsked;
      const res = await fetch(location.href, { headers: { accept: 'text/html' } });
      if (!res.ok) return;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const next = doc.getElementById('main');
      if (!next) return;
      // The repository filter keeps its focus and caret. A reviewer agent's menu keeps the focus on
      // its control, also one that lost it by disabling itself while its change saves.
      const active = document.activeElement;
      const filtering = active && active.matches('.js-repo-filter') ? [active.selectionStart, active.selectionEnd] : null;
      const lost = !active || active === document.body;
      const menuOpen = menuFocus && document.getElementById(menuFocus.menu);
      const refocus = menuFocus && ((active && active.closest('.agent-menu')) || (lost && menuOpen && menuOpen.open)) ? menuFocus : null;
      // Steps of a transcript the reviewer opened stay open while the run goes on.
      const open = $$('details.js-keep-open[open]').map((d) => d.id);
      // A Stop clicked once stays armed for its second click, for what is left of its time, as long
      // as the page still has it for the same run (its id has the run's).
      const armedStops = $$('.js-stop-review').flatMap((b) => (armed.has(b) ? [[b.id, armed.get(b)]] : []));
      main().replaceWith(document.adoptNode(next));
      // The header says whether the server is stopping, and how many reviews are running.
      const stopping = doc.getElementById('server-stopping');
      const shown = document.getElementById('server-stopping');
      if (stopping && shown) shown.replaceWith(document.adoptNode(stopping));
      const indicator = doc.getElementById('runs-indicator');
      if (indicator) showRunsIndicator(document.adoptNode(indicator), asked);
      for (const [id, was] of armedStops) {
        const b = document.getElementById(id);
        const left = was.until - Date.now();
        if (b && left > 0) confirmed(b, was.prompt, left);
      }
      for (const id of open) {
        const d = document.getElementById(id);
        if (d) d.open = true;
      }
      document.title = doc.title;
      shownFetch = n;
      afterRender();
      // On its button, when the control is gone or disabled.
      if (refocus) {
        const control = document.getElementById(refocus.id);
        const menu = document.getElementById(refocus.menu);
        const target = control && !control.disabled ? control : menu && $('summary', menu);
        if (target) target.focus({ preventScroll: true });
      }
      const filter = filtering && $('.js-repo-filter');
      if (filter) {
        filter.focus();
        filter.setSelectionRange(...filtering);
      }
    })().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  let rendered = 0; // pages rendered, so confirmTurn can tell whether its refresh got anything new
  let fetched = 0; // page fetches begun by refresh, so an Undo can tell the renders after it (madeYours)
  let shownFetch = 0; // the fetch the page shown came from: 0 for the one the browser loaded
  function afterRender() {
    rendered++;
    for (const file of $$('.file')) {
      const user = userState.collapsed.get(file.dataset.path);
      const body = $('.file-body', file);
      if (user !== undefined) setCollapsed(file, user);
      else file.classList.toggle('is-collapsed', !!(body && body.hidden));
    }
    for (const [id, open] of userState.threads) {
      const t = $(`details.review-thread[data-thread="${id}"]`);
      if (t) t.open = open;
    }
    restoreDrafts();
    updateTimes();
    notifyTurns();
    showOpenInApp();
    showRepos();
    markActiveTreeItem();
    markLines(false);
    observeToolbar();
    restoreExpanded().then(restoreDrafts);
  }

  // ---------------------------------------------------------------- toast

  let toastTimer;
  function toast(message, action) {
    const el = document.getElementById('toast');
    el.innerHTML = `<span>${esc(message)}</span>`;
    if (action) {
      const b = document.createElement('button');
      b.className = 'btn btn-sm';
      b.textContent = action.label;
      b.onclick = () => {
        el.hidden = true;
        action.run();
      };
      el.append(b);
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    if (!action) toastTimer = setTimeout(() => (el.hidden = true), 4000);
  }

  // ------------------------------------------------------------ live updates

  const DESCRIBE = {
    pushed: 'pushed new commits',
    comment: 'commented',
    reply: 'replied to a thread',
    review: 'submitted a review',
    review_comment: 'commented on the diff',
    updated: 'updated the pull request',
    created: 'staged a pull request',
    published: 'published the pull request',
    resolved: 'resolved a conversation',
    comment_edited: 'edited a comment',
    reviewer_started: 'started reviewing',
    reviewer_failed: 'could not finish its review',
    reviewer_cancelled: 'stopped reviewing',
  };
  // What galley did on its own on the viewer's behalf, or learned from GitHub: their page has not heard of it.
  const AUTOMATIC = {
    auto_published: 'Published to GitHub with auto-publish',
    auto_publish_failed: 'Auto-publish failed',
    github_pushed: 'Pushed to GitHub',
    github_push_failed: 'Pushing to GitHub failed',
    github_edited: 'Published the edits to GitHub',
    github_edit_failed: 'Publishing the edits to GitHub failed',
    auto_merge_enabled: 'Auto-merge enabled on GitHub',
    auto_merge_failed: 'Enabling auto-merge on GitHub failed',
    merged: 'Merged on GitHub',
    closed_on_github: 'Closed on GitHub',
  };

  // The viewer's own changes that its other tabs show too: a pin moves the pull request on every
  // front page, and so does dismissing their turn, also from the desktop app's menu.
  const EVERY_TAB = { pinned: true, unpinned: true, dismissed: true, undismissed: true };

  const dirty = () => $$('textarea').some((t) => t.value !== t.defaultValue);

  let pending = null;
  function onChange(ev) {
    // Your turn again by your own Undo, here or elsewhere: nothing to notify of.
    if (ev.type === 'undismissed' && ev.pullId != null) madeYours(ev.pullId);
    const own = ev.actor === viewer();
    // Our own actions refresh after the request. Those every tab shows refresh here as well, in
    // the tab they were made in a second time, since nothing tells which tab that was.
    if (own && ev.type !== 'waiting' && !AUTOMATIC[ev.type] && !EVERY_TAB[ev.type]) return;
    if (ev.type === 'waiting' && dirty()) return;
    refreshSoon(AUTOMATIC[ev.type] || (DESCRIBE[ev.type] ? `${ev.actor} ${DESCRIBE[ev.type]}` : null));
  }

  // Refresh in a moment, once for a burst of events, saying `msg` after. While the reviewer types
  // in a field, which a refresh would replace, a toast offers it instead.
  let pendingMsg = null;
  function refreshSoon(msg) {
    // What the burst has to say, if anything does.
    pendingMsg = msg || pendingMsg;
    clearTimeout(pending);
    pending = setTimeout(() => {
      const said = pendingMsg;
      pendingMsg = null;
      const active = document.activeElement;
      const typing = active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && active.type === 'text')) && active.value;
      if (typing) toast(said || 'There are updates', { label: 'Refresh', run: refresh });
      // One that fails (the server is away) leaves the page as it is, until the next event.
      else refresh().then(() => said && toast(said), () => {});
    }, 250);
  }

  // A reviewer agent made progress (the server says so at most every few seconds). The sidebar
  // fetches its view of the run again; a transcript page of the run refreshes, as for a change.
  const progressing = new Map();
  function onProgress(ev) {
    if (document.querySelector(`#main[data-run-live="${ev.runId}"]`)) refreshSoon(null);
    for (const box of $$(`.js-run-progress[data-run="${ev.runId}"]`)) refreshProgress(box.dataset.src);
  }
  async function refreshProgress(src) {
    // One request at a time; progress during it fetches once more after it.
    if (progressing.has(src)) {
      progressing.set(src, true);
      return;
    }
    progressing.set(src, false);
    try {
      const res = await fetch(src, { headers: { accept: 'text/html' } });
      // 204: the run is over, and the page hears so on its own.
      if (res.status !== 200) return;
      const t = document.createElement('template');
      t.innerHTML = await res.text();
      const next = t.content.firstElementChild;
      const box = $$('.js-run-progress').find((b) => b.dataset.src === src);
      if (next && box) box.replaceWith(next);
    } catch {
      // The next progress tries again.
    } finally {
      const again = progressing.get(src);
      progressing.delete(src);
      if (again) refreshProgress(src);
    }
  }

  // The header's count of reviews running comes with every page refresh, and alone when a review
  // starts or ends, also when the page does not refresh for it (another pull request's, or someone
  // is typing). Answers can come out of order: the one asked for last of those that came is shown.
  let headerAsked = 0;
  let headerShown = 0;
  function showRunsIndicator(next, asked) {
    const shown = document.getElementById('runs-indicator');
    if (!next || !shown || asked < headerShown) return;
    headerShown = asked;
    shown.replaceWith(next);
  }

  // The count alone. One request at a time; a change during it fetches once more after it.
  let indicating = null;
  async function refreshRunsIndicator() {
    if (indicating !== null) {
      indicating = true;
      return;
    }
    indicating = false;
    try {
      const asked = ++headerAsked;
      const res = await fetch('/runs/indicator', { headers: { accept: 'text/html' } });
      if (!res.ok) return;
      const t = document.createElement('template');
      t.innerHTML = await res.text();
      showRunsIndicator(t.content.firstElementChild, asked);
    } catch {
      // The next change tries again.
    } finally {
      const again = indicating;
      indicating = null;
      if (again) refreshRunsIndicator();
    }
  }

  // Live updates. All tabs share one connection through a SharedWorker, since each open
  // EventSource holds one of the browser's six connections to the server. A page without live
  // updates of its own (Settings) follows only the header's count of reviews running.
  function connectLive() {
    const live = document.body.dataset.live;
    const mine = (ev) => !!live && (live === 'all' || ev.pullId === null || String(ev.pullId) === live);
    const catchUp = () => (live ? refresh() : refreshRunsIndicator());
    // What the server sends: { type, event }, passed on by the worker as it is.
    const hear = (message) => {
      if (message.type === 'reconnected') catchUp();
      else if (message.type === 'change') {
        if (mine(message.event)) onChange(message.event);
        // A review started or ended: the header's count, whether the page refreshes or not.
        if (message.event.type.startsWith('reviewer_')) refreshRunsIndicator();
      } else if (message.type === 'progress' && mine(message.event)) onProgress(message.event);
    };

    if (window.SharedWorker) {
      try {
        const join = () => {
          // One worker for every tab with this version of it. The name changes when the worker
          // changes what it sends, or a tab could join an older one still open in another tab.
          const worker = new SharedWorker('/static/live-worker.js', { name: 'galley-live-2' });
          worker.port.onmessage = (m) => hear(m.data);
          worker.port.start();
          return worker.port;
        };
        let port = join();
        window.addEventListener('pagehide', () => port.postMessage('bye'));
        // Back to a page kept in the back/forward cache (as after publishing): it said bye
        // when it left, and missed what happened since.
        window.addEventListener('pageshow', (e) => {
          if (!e.persisted) return;
          port = join();
          catchUp();
        });
        return;
      } catch {
        // Fall through to a connection of our own.
      }
    }

    // Without a SharedWorker, hold a connection only while the tab is visible, and catch
    // up on whatever happened while it was hidden. It hears of every pull request, as the
    // worker's does, for the header's count.
    if (!window.EventSource) return;
    let es = null;
    const open = () => {
      if (es) return;
      es = new EventSource('/events');
      es.addEventListener('message', (e) => hear(JSON.parse(e.data)));
    };
    const close = () => {
      if (es) es.close();
      es = null;
    };
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) close();
      else {
        open();
        catchUp();
      }
    });
    window.addEventListener('pagehide', close);
    if (!document.hidden) open();
  }

  // ------------------------------------------------------- generic forms

  function formError(form, err) {
    let box = $('.js-form-error', form);
    if (!box) {
      box = document.createElement('div');
      box.className = 'flash flash-error js-form-error';
      const actions = $('.form-actions', form);
      actions ? actions.before(box) : form.append(box);
    }
    box.textContent = err ? err.message : '';
    box.hidden = !err;
  }

  function busy(form, on, label) {
    for (const b of $$('button[type=submit]', form)) {
      b.disabled = on;
      if (on && label && b.classList.contains('btn-primary')) {
        b.dataset.label = b.innerHTML;
        b.textContent = label;
      } else if (!on && b.dataset.label) {
        b.innerHTML = b.dataset.label;
        delete b.dataset.label;
      }
    }
  }

  function formJson(form) {
    const body = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled || el.tagName === 'BUTTON') continue;
      // A box that stands for a list (the commits publishing brings back) sends the list when checked.
      if (el.type === 'checkbox') body[el.name] = el.checked && el.dataset.values ? el.dataset.values.split(' ') : el.checked;
      else if (el.type === 'radio') {
        if (el.checked) body[el.name] = el.value;
      } else body[el.name] = el.value;
    }
    return body;
  }

  async function submitApiForm(form, submitter) {
    formError(form, null);
    // A submit button may send the form elsewhere, as "Publish when reviews are done" does.
    const target = submitter && submitter.dataset.api ? submitter : form;
    const publishing = form.matches('.js-publish-form') && target === form;
    busy(form, true, publishing ? 'Publishing…' : null);
    let leaving = false;
    try {
      const body = formJson(form);
      // The second click on a Publish button that asked first: publish while a reviewer is at work,
      // or a head that conflicts with its base, as the button says.
      if (publishing && submitter && submitter.dataset.confirm) {
        for (const field of (submitter.dataset.acknowledge || '').split(' ').filter(Boolean)) body[field] = true;
      }
      const res = await api(target.dataset.method || 'POST', target.dataset.api, body);
      for (const t of $$('textarea[data-draft-key]', form)) clearDraft(t.dataset.draftKey);
      if (form.dataset.reset) form.reset();
      // A publish clicked in this tab goes on to the pull request on GitHub; the button stays
      // busy until the page is gone. Publishes from anywhere else never navigate.
      if (publishing && res && res.published_url) {
        leaving = true;
        location.href = res.published_url;
        return;
      }
      // A form that made something goes on to where it is listed.
      if (target.dataset.next) {
        leaving = true;
        location.href = target.dataset.next;
        return;
      }
      await refresh();
      if (publishing) toast('Published to GitHub');
      else if (target.dataset.toast) toast(target.dataset.toast);
    } catch (err) {
      busy(form, false);
      formError(form, err);
      // Refused for commits a rewrite on GitHub removed: force does not get past that, the box to bring them back does.
      if (publishing && err.status === 409 && !(err.json && err.json.bring_back)) {
        const force = $('.js-force-option', form);
        if (force) force.hidden = false;
      }
      if (publishing && err.status === 412) toast('The pull request changed.', { label: 'Refresh', run: refresh });
      // A reviewer started, or the base moved, after this page was loaded: ask now, as the page
      // would have. The server says what else the second click acknowledges.
      if (publishing && err.status === 428 && submitter) {
        const asked = new Set((submitter.dataset.acknowledge || '').split(' ').filter(Boolean));
        for (const field of (err.json && err.json.acknowledge) || []) asked.add(field);
        submitter.dataset.confirm = 'Click again to publish anyway';
        submitter.dataset.acknowledge = [...asked].join(' ');
        confirmed(submitter, submitter.dataset.confirm);
      }
    } finally {
      if (!leaving) busy(form, false);
    }
  }

  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (form.matches('.js-api-form')) {
      e.preventDefault();
      if (stillUploading(form)) return;
      const prompt = e.submitter && e.submitter.dataset.confirm;
      if (prompt && !confirmed(e.submitter, prompt)) return;
      submitApiForm(form, e.submitter);
    } else if (form.matches('.js-new-comment-form')) {
      e.preventDefault();
      if (stillUploading(form)) return;
      submitNewComment(form, e.submitter);
    }
  });

  // ------------------------------------------------------ autosave forms
  // Settings save as they change: a box, a choice or a menu at once, a text field when it is left
  // or Enter is pressed, and one still being typed in when the page goes away. Each save sends the
  // fields that differ from what the form last saved, so a value the server refuses holds up no
  // other field; a refused one goes back to what is saved, next to the server's reason. Changes
  // made in one turn of the event loop (a tool that resets its model and effort) save together,
  // one save at a time per form, and with keepalive, so a save started as a link is clicked is
  // not cancelled by the page going away.

  const autosaves = new WeakMap(); // form -> { saved, sending (the fields under way, or null), again, timer, id, count }
  const KEEPALIVE_MAX = 60000; // the browser refuses keepalive bodies over 64 KiB

  /** A form's values as the page has them from the server, as formJson reads them. */
  function formDefaults(form) {
    const body = {};
    for (const el of form.elements) {
      if (!el.name || el.disabled || el.tagName === 'BUTTON') continue;
      if (el.type === 'checkbox') body[el.name] = el.defaultChecked;
      else if (el.type === 'radio') {
        if (el.defaultChecked) body[el.name] = el.value;
      } else if (el.tagName === 'SELECT') {
        const option = [...el.options].find((o) => o.defaultSelected) || el.options[0];
        body[el.name] = option ? option.value : '';
      } else body[el.name] = el.defaultValue;
    }
    return body;
  }

  function autosaveState(form) {
    let state = autosaves.get(form);
    if (!state) autosaves.set(form, (state = { saved: formDefaults(form), sending: null, again: false, timer: null, id: Math.random().toString(36).slice(2), count: 0 }));
    return state;
  }

  function autosaveChanges(form) {
    const saved = autosaveState(form).saved;
    const changes = {};
    for (const [name, value] of Object.entries(formJson(form))) if (value !== saved[name]) changes[name] = value;
    return Object.keys(changes).length ? changes : null;
  }

  // Each save of a form counts up, and the server refuses one older than a save it made (docs/api.md).
  function saveFields(form, changes) {
    const state = autosaveState(form);
    const headers = { 'x-galley-save': `${state.id} ${++state.count}` };
    return api(form.dataset.method, form.dataset.api, changes, { headers, keepalive: JSON.stringify(changes).length < KEEPALIVE_MAX });
  }

  /** Put the fields refused back to what is saved, unless they were changed again meanwhile. */
  function restoreFields(form, refused, saved) {
    const now = formJson(form);
    for (const el of form.elements) {
      if (!(el.name in refused) || now[el.name] !== refused[el.name]) continue;
      const value = saved[el.name];
      if (el.type === 'checkbox') el.checked = value;
      else if (el.type === 'radio') el.checked = el.value === value;
      else el.value = value;
      // The models follow the tool, and the efforts the model.
      if (el.matches('.js-reviewer-engine, .js-reviewer-model')) el.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  function autosave(form) {
    const state = autosaveState(form);
    clearTimeout(state.timer);
    state.timer = setTimeout(() => sendAutosave(form));
  }

  async function sendAutosave(form) {
    const state = autosaveState(form);
    if (state.sending) {
      state.again = true;
      return;
    }
    const changes = autosaveChanges(form);
    if (!changes) return;
    state.sending = changes;
    try {
      await saveFields(form, changes);
      Object.assign(state.saved, changes);
      formError(form, null);
      if (!state.again && form.dataset.toast) toast(form.dataset.toast);
    } catch (err) {
      // A value the server refused goes back; one that did not reach it stays, to be sent again.
      if (err.status) restoreFields(form, changes, state.saved);
      formError(form, err);
      toast(`Not saved: ${err.message}`);
    } finally {
      state.sending = null;
      if (state.again) {
        state.again = false;
        sendAutosave(form);
      }
    }
  }

  const autosaveForm = (el) => el.closest && el.closest('form.js-autosave-form');

  document.addEventListener('change', (e) => {
    const form = autosaveForm(e.target);
    if (form) autosave(form);
  });
  // Enter in a field, or ⌘/Ctrl+Enter in a text area, saves now.
  document.addEventListener('keydown', (e) => {
    const form = autosaveForm(e.target);
    if (form && e.key === 'Enter' && e.target.matches('input')) {
      e.preventDefault();
      autosave(form);
    }
  });
  document.addEventListener('submit', (e) => {
    const form = e.target;
    if (!form.matches('.js-autosave-form')) return;
    e.preventDefault();
    autosave(form);
  });
  // Leaving the page: what is not saved yet goes now. With a save still under way, this one has its
  // fields too, as they are now: should it arrive first, the server refuses the earlier one.
  window.addEventListener('pagehide', () => {
    for (const form of $$('form.js-autosave-form')) {
      const state = autosaveState(form);
      const now = formJson(form);
      const changes = { ...autosaveChanges(form) };
      for (const name of Object.keys(state.sending || {})) changes[name] = now[name];
      if (!Object.keys(changes).length) continue;
      clearTimeout(state.timer);
      saveFields(form, changes).catch(() => {});
    }
  });

  // ⌘/Ctrl+Enter submits; Escape closes an empty inline form.
  // Escape closes an open menu, outside its text fields, and gives the focus back to its button
  // (also when a control in it lost the focus by disabling itself).
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.target.matches('textarea, input, select')) return;
    for (const d of $$('details.dropdown[open]')) {
      d.open = false;
      if (d.contains(e.target) || e.target === document.body) $('summary', d).focus();
    }
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (!(t instanceof HTMLTextAreaElement)) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      const form = t.closest('form');
      if (!form) return;
      e.preventDefault();
      form.requestSubmit($('button[type=submit].btn-primary', form) || undefined);
    } else if (e.key === 'Escape' && !t.value) {
      const inline = t.closest('.inline-comment-form');
      if (inline) closeInlineForm(inline);
    }
  });

  // --------------------------------------------------- markdown editor

  /** The latest preview asked for in each editor; an earlier one answering late is dropped. */
  const previews = new WeakMap();

  async function showPreview(editor) {
    const ta = $('.md-input', editor);
    const preview = $('.md-preview', editor);
    const holder = editor.closest('[data-suggestion]');
    const request = {};
    previews.set(editor, request);
    preview.innerHTML = '<p class="color-fg-muted">Loading preview…</p>';
    ta.hidden = true;
    preview.hidden = false;
    try {
      const res = await fetch('/api/markdown', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: ta.value, suggestion_lines: holder ? JSON.parse(holder.dataset.suggestion) : undefined, pull: ds().apiBase }),
      });
      const htmlText = await res.text();
      if (previews.get(editor) === request) preview.innerHTML = htmlText || '<p class="color-fg-muted">Nothing to preview</p>';
    } catch (err) {
      if (previews.get(editor) === request) preview.textContent = err.message;
    }
  }

  function showWrite(editor) {
    $('.md-input', editor).hidden = false;
    $('.md-preview', editor).hidden = true;
    $('.md-input', editor).focus();
  }

  function insertSuggestion(editor) {
    const holder = editor.closest('[data-suggestion]');
    const lines = holder ? JSON.parse(holder.dataset.suggestion) : [];
    const ta = $('.md-input', editor);
    const block = '```suggestion\n' + lines.join('\n') + '\n```\n';
    const at = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, at);
    ta.value = before + (before && !before.endsWith('\n') ? '\n' : '') + block + ta.value.slice(at);
    ta.focus();
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function editorHtml({ placeholder = 'Leave a comment', draftKey, suggestion = false }) {
    return `<div class="md-editor">
  <div class="md-editor-header">
    <div class="md-tabs"><button type="button" class="md-tab selected" data-tab="write">Write</button><button type="button" class="md-tab" data-tab="preview">Preview</button></div>
    <div class="md-toolbar">${suggestion ? '<button type="button" class="md-toolbar-btn js-insert-suggestion" title="Insert a suggestion">±</button>' : ''}<button type="button" class="md-toolbar-btn js-attach-image" title="Attach an image" aria-label="Attach an image">${IMAGE_ICON}</button></div>
  </div>
  <textarea class="form-control md-input" name="body" rows="4" placeholder="${esc(placeholder)}" data-draft-key="${esc(draftKey)}"></textarea>
  <div class="md-preview markdown-body" hidden></div>
</div>`;
  }

  // ---------------------------------------------------------------- images
  // Pasted, dropped and attached images are uploaded, and go into the text as on GitHub: a
  // placeholder where the cursor was, replaced by the image's Markdown once it is stored.

  const MAX_UPLOAD = 10 * 1024 * 1024; // as in src/server/uploads.ts
  const IMAGE_ICON =
    '<svg class="octicon octicon-image" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M16 13.25A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25V2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75ZM1.75 2.5a.25.25 0 0 0-.25.25v10.5c0 .138.112.25.25.25h.94l.03-.03 6.077-6.078a1.75 1.75 0 0 1 2.412-.06L14.5 10.31V2.75a.25.25 0 0 0-.25-.25Zm12.5 11a.25.25 0 0 0 .25-.25v-.917l-4.298-3.889a.25.25 0 0 0-.344.009L4.81 13.5ZM7 6a2 2 0 1 1-3.999.001A2 2 0 0 1 7 6ZM5.5 6a.5.5 0 1 0-1 0 .5.5 0 0 0 1 0Z"></path></svg>';
  /** The placeholders of uploads still running. A draft restored after a reload drops the others. */
  const uploading = new Set();

  const withoutStaleUploads = (text) => text.replace(/!\[Uploading [^\]\n]*…\]\(\)/g, (p) => (uploading.has(p) ? p : ''));

  function stillUploading(form) {
    const busy = $$('textarea', form).some((t) => [...uploading].some((p) => t.value.includes(p)));
    if (busy) formError(form, new Error('Wait until the images have uploaded.'));
    return busy;
  }

  function replaceText(ta, from, to) {
    const at = ta.value.indexOf(from);
    if (at < 0) return;
    ta.setRangeText(to, at, at + from.length, 'preserve');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  async function upload(file) {
    if (file.size > MAX_UPLOAD) throw new Error(`${file.name || 'The image'} is larger than 10 MB.`);
    const res = await fetch('/api/uploads', { method: 'POST', headers: file.type ? { 'content-type': file.type } : {}, body: file });
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new Error((json && json.message) || res.statusText);
    return json.path;
  }

  function attachImages(ta, files) {
    const editor = ta.closest('.md-editor');
    if (ta.hidden) showWrite(editor);
    for (const tab of $$('.md-tab', editor)) tab.classList.toggle('selected', tab.dataset.tab === 'write');
    const key = ta.dataset.draftKey;
    const form = ta.closest('form');
    if (form) formError(form, null);
    [...files].forEach(async (file, i) => {
      const name = (file.name || 'image.png').replace(/[[\]\n]/g, '');
      let placeholder = `![Uploading ${name}…]()`;
      for (let n = 2; uploading.has(placeholder); n++) placeholder = `![Uploading ${name} (${n})…]()`;
      uploading.add(placeholder);
      ta.setRangeText((i > 0 ? '\n' : '') + placeholder, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      let markdown = '';
      let failure = null;
      try {
        markdown = `![${name.replace(/\.\w+$/, '')}](${await upload(file)})`;
      } catch (err) {
        failure = err;
      }
      uploading.delete(placeholder);
      // A live refresh may have replaced the textarea meanwhile; its draft went to the new one.
      const target = ta.isConnected ? ta : key ? $(`textarea[data-draft-key="${CSS.escape(key)}"]`) : null;
      if (target) {
        replaceText(target, placeholder, markdown);
        // A preview opened during the upload shows the placeholder; show what took its place.
        const editor = target.closest('.md-editor');
        if (!$('.md-preview', editor).hidden) showPreview(editor);
      }
      if (failure) {
        const box = target && target.closest('form');
        box ? formError(box, failure) : toast(failure.message);
      }
    });
  }

  document.addEventListener('paste', (e) => {
    const ta = e.target;
    if (!ta.matches || !ta.matches('textarea.md-input')) return;
    const files = [...((e.clipboardData && e.clipboardData.files) || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    attachImages(ta, files);
  });

  /** The textarea of the editor a file is dragged over. */
  function dropTarget(e) {
    const editor = e.target.closest && e.target.closest('.md-editor');
    const carriesFiles = e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    return editor && carriesFiles ? $('.md-input', editor) : null;
  }
  document.addEventListener('dragover', (e) => {
    const ta = dropTarget(e);
    if (!ta) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    ta.closest('.md-editor').classList.add('is-dragover');
  });
  document.addEventListener('dragleave', (e) => {
    const editor = e.target.closest && e.target.closest('.md-editor');
    if (editor && !editor.contains(e.relatedTarget)) editor.classList.remove('is-dragover');
  });
  document.addEventListener('drop', (e) => {
    const ta = dropTarget(e);
    if (!ta) return;
    e.preventDefault();
    ta.closest('.md-editor').classList.remove('is-dragover');
    attachImages(ta, e.dataTransfer.files);
    ta.focus();
  });

  function chooseImages(editor) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp';
    input.multiple = true;
    input.onchange = () => attachImages($('.md-input', editor), input.files);
    input.click();
  }

  // ---------------------------------------------------------- inline forms

  /** A form for a new review comment (on lines, a file, or a commit message). */
  function newCommentForm({ key, meta, title, suggestion }) {
    const pendingReview = ds().pendingReview;
    const wrap = document.createElement('div');
    wrap.className = 'inline-comment-form';
    wrap.dataset.formKey = key;
    wrap.dataset.draftMeta = JSON.stringify(meta);
    if (suggestion) wrap.dataset.suggestion = JSON.stringify(suggestion);
    wrap.innerHTML = `<div class="inline-comment-form-title">${esc(title)}</div>
<form class="js-new-comment-form">
  ${editorHtml({ draftKey: key, suggestion: !!suggestion })}
  <div class="form-actions">
    <select class="form-select priority-select" name="priority" aria-label="Priority">
      <option value="">No priority</option><option value="high">High priority</option><option value="medium">Medium priority</option><option value="low">Low priority</option>
    </select>
    <button type="button" class="btn js-inline-cancel">Cancel</button>
    ${pendingReview ? '' : '<button type="submit" class="btn" value="single">Add single comment</button>'}
    <button type="submit" class="btn btn-primary" value="review">${pendingReview ? 'Add review comment' : 'Start a review'}</button>
  </div>
</form>`;
    return wrap;
  }

  async function submitNewComment(form, submitter) {
    const wrap = form.closest('.inline-comment-form');
    const meta = JSON.parse(wrap.dataset.draftMeta);
    const body = $('textarea', form).value;
    const mode = submitter ? submitter.value : ds().pendingReview ? 'review' : 'single';
    const payload = { body, priority: $('select[name=priority]', form).value || null };
    if (meta.kind === 'commit') Object.assign(payload, { subject_type: 'commit', commit_id: meta.sha });
    else {
      Object.assign(payload, { path: meta.path, commit_id: ds().commitId, base_commit_id: ds().baseCommitId });
      if (meta.kind === 'file') payload.subject_type = 'file';
      else Object.assign(payload, { line: meta.line, side: meta.side, start_line: meta.startLine || undefined, start_side: meta.startSide || undefined });
    }
    formError(form, null);
    busy(form, true);
    try {
      await api('POST', `${ds().apiBase}/${mode === 'review' ? 'pending-comments' : 'comments'}`, payload);
      clearDraft(wrap.dataset.formKey);
      await refresh();
    } catch (err) {
      formError(form, err);
    } finally {
      busy(form, false);
    }
  }

  function closeInlineForm(wrap) {
    clearDraft(wrap.dataset.formKey);
    const row = wrap.closest('tr.js-form-row');
    for (const c of $$('.is-selected')) c.classList.remove('is-selected');
    (row || wrap).remove();
  }

  function cellFor(path, side, line) {
    return $(`td.blob-code[data-path="${CSS.escape(path)}"][data-side="${side}"][data-line="${line}"]`);
  }

  function lineText(cell) {
    const inner = $('.blob-code-inner', cell);
    return inner ? inner.textContent : '';
  }

  function cellsBetween(start, end) {
    const file = start.closest('.file');
    const split = !!start.closest('.diff-split');
    const cells = $$('td.blob-code[data-line]', file).filter((c) => !split || c.dataset.side === start.dataset.side);
    let a = cells.indexOf(start);
    let b = cells.indexOf(end);
    if (a > b) [a, b] = [b, a];
    return cells.slice(a, b + 1);
  }

  function openLineForm(end, start) {
    const path = end.dataset.path;
    const side = end.dataset.side;
    const line = Number(end.dataset.line);
    const range = start && start !== end ? cellsBetween(start, end) : [end];
    const first = range[0];
    const last = range[range.length - 1];
    const multi = range.length > 1;
    const meta = {
      kind: 'line',
      path,
      side: last.dataset.side,
      line: Number(last.dataset.line),
      startSide: multi ? first.dataset.side : null,
      startLine: multi ? Number(first.dataset.line) : null,
    };
    const key = `line:${path}:${meta.startSide || ''}${meta.startLine || ''}:${meta.side}${meta.line}`;
    const existing = $(`.inline-comment-form[data-form-key="${CSS.escape(key)}"]`);
    if (existing) {
      $('textarea', existing).focus();
      return $('textarea', existing);
    }
    const label = (c) => `${c.dataset.side === 'LEFT' ? 'L' : 'R'}${c.dataset.line}`;
    const wrap = newCommentForm({
      key,
      meta,
      title: multi ? `Commenting on lines ${label(first)} to ${label(last)}` : `Commenting on line ${label(last)}`,
      suggestion: last.dataset.side === 'RIGHT' ? range.filter((c) => c.dataset.side === 'RIGHT').map(lineText) : null,
    });
    for (const c of range) c.classList.add('is-selected');
    const row = last.closest('tr');
    let after = row;
    while (after.nextElementSibling && after.nextElementSibling.classList.contains('inline-comments')) after = after.nextElementSibling;
    const tr = document.createElement('tr');
    tr.className = 'inline-comments js-form-row';
    if (last.closest('.diff-split')) {
      const left = document.createElement('td');
      const right = document.createElement('td');
      left.colSpan = right.colSpan = 2;
      left.className = right.className = 'inline-comments-cell';
      (last.dataset.side === 'LEFT' ? left : right).append(wrap);
      tr.append(left, right);
    } else {
      const td = document.createElement('td');
      td.colSpan = 3;
      td.className = 'inline-comments-cell';
      td.append(wrap);
      tr.append(td);
    }
    after.after(tr);
    const ta = $('textarea', wrap);
    ta.focus();
    return ta;
  }

  function openFileForm(file) {
    const path = file.dataset.path;
    const key = `file:${path}`;
    const existing = $(`.inline-comment-form[data-form-key="${CSS.escape(key)}"]`);
    if (existing) return $('textarea', existing);
    const wrap = newCommentForm({ key, meta: { kind: 'file', path }, title: `Commenting on ${path}` });
    $('.file-threads', file).append(wrap);
    const ta = $('textarea', wrap);
    ta.focus();
    return ta;
  }

  function openCommitForm(li) {
    const sha = li.dataset.commit;
    const key = `commit:${sha}`;
    const existing = $(`.inline-comment-form[data-form-key="${CSS.escape(key)}"]`);
    if (existing) return $('textarea', existing);
    const title = $('.commit-title a', li).textContent;
    const wrap = newCommentForm({ key, meta: { kind: 'commit', sha }, title: `Commenting on the message of ${sha.slice(0, 7)} “${title}”` });
    $('.commit-threads', li).append(wrap);
    const ta = $('textarea', wrap);
    ta.focus();
    return ta;
  }

  function reopenForm(meta) {
    if (meta.kind === 'line') {
      const end = cellFor(meta.path, meta.side, meta.line);
      if (!end) return null;
      const start = meta.startLine ? cellFor(meta.path, meta.startSide, meta.startLine) : null;
      // A range reopens whole or not at all, so it never turns into a comment on its last line.
      if (meta.startLine && !start) return null;
      return openLineForm(end, start);
    }
    if (meta.kind === 'file') {
      const file = $(`.file[data-path="${CSS.escape(meta.path)}"]`);
      return file ? openFileForm(file) : null;
    }
    if (meta.kind === 'commit') {
      const li = $(`li[data-commit="${CSS.escape(meta.sha)}"]`);
      return li ? openCommitForm(li) : null;
    }
    return null;
  }

  // Drag across "+" buttons to comment on a range of lines, like GitHub.
  let selecting = null;
  document.addEventListener('mousedown', (e) => {
    const btn = e.target.closest && e.target.closest('.add-line-comment');
    if (!btn || e.button !== 0) return;
    e.preventDefault();
    const cell = btn.closest('td.blob-code');
    selecting = { start: cell, end: cell };
    document.body.classList.add('selecting');
    paintSelection();
  });
  document.addEventListener('mouseover', (e) => {
    if (!selecting) return;
    const cell = e.target.closest && e.target.closest('td.blob-code[data-line]');
    if (!cell || cell.closest('.file') !== selecting.start.closest('.file')) return;
    if (cell.closest('.diff-split') && cell.dataset.side !== selecting.start.dataset.side) return;
    selecting.end = cell;
    paintSelection();
  });
  document.addEventListener('mouseup', () => {
    if (!selecting) return;
    const { start, end } = selecting;
    selecting = null;
    document.body.classList.remove('selecting');
    for (const c of $$('.is-selected')) c.classList.remove('is-selected');
    const range = cellsBetween(start, end);
    openLineForm(range[range.length - 1], range.length > 1 ? range[0] : null);
  });
  function paintSelection() {
    for (const c of $$('.is-selected')) c.classList.remove('is-selected');
    for (const c of cellsBetween(selecting.start, selecting.end)) c.classList.add('is-selected');
  }

  // ------------------------------------------------------- comment edits

  function openEdit(form) {
    const box = form.closest('.timeline-comment, .review-comment');
    $('.js-comment-body', box).hidden = true;
    form.hidden = false;
    $('textarea', form).focus();
  }

  function closeEdit(form) {
    const box = form.closest('.timeline-comment, .review-comment');
    $('.js-comment-body', box).hidden = false;
    form.hidden = true;
    const ta = $('textarea', form);
    ta.value = ta.defaultValue;
    clearDraft(ta.dataset.draftKey);
  }

  function openReply(container, focus = true) {
    $('.js-reply-open', container).hidden = true;
    const form = $('.review-thread-reply-form', container);
    form.hidden = false;
    if (focus) $('textarea', form).focus();
  }

  // Two clicks for destructive actions, instead of a modal dialog.
  const armed = new WeakMap();
  function confirmed(btn, prompt = 'Click again to confirm', ms = 3000) {
    const was = armed.get(btn);
    if (was) {
      // Put the label back now, so a button still there after the action (an error, say) reads right.
      clearTimeout(was.timer);
      armed.delete(btn);
      btn.innerHTML = was.label;
      return true;
    }
    const label = btn.innerHTML;
    btn.textContent = prompt;
    armed.set(btn, {
      label,
      prompt,
      until: Date.now() + ms,
      timer: setTimeout(() => {
        armed.delete(btn);
        btn.innerHTML = label;
      }, ms),
    });
    return false;
  }

  // ---------------------------------------------------------------- files

  // The file headers stick right under the toolbar (app.css), so nothing scrolls by between them.
  let toolbarHeight = null;

  function observeToolbar() {
    toolbarHeight?.disconnect();
    const toolbar = $('.files-toolbar');
    if (!toolbar) return;
    toolbarHeight ??= new ResizeObserver((entries) => {
      document.documentElement.style.setProperty('--files-toolbar-height', `${entries.at(-1).borderBoxSize[0].blockSize}px`);
    });
    toolbarHeight.observe(toolbar, { box: 'border-box' });
  }

  function setCollapsed(file, collapsed) {
    const body = $('.file-body', file);
    if (body) body.hidden = collapsed;
    file.classList.toggle('is-collapsed', collapsed);
    const note = $('.file-collapsed-note', file);
    if (note && !collapsed) note.remove();
    const toggle = $('.file-header .js-file-toggle', file);
    if (toggle) toggle.setAttribute('aria-expanded', String(!collapsed));
  }

  // ------------------------------------------------------ expand context
  // The unfold arrows on a hunk header load the unchanged lines above it (GitHub's
  // blob_excerpt). Lines a reviewer loaded come back after a live refresh, and can carry comments.

  const EXPAND_STEP = 20;

  const gapOf = (row) => ({ from: Number(row.dataset.gapFrom), to: Number(row.dataset.gapTo), delta: Number(row.dataset.delta) });

  /** The arrows that fit what is left of a gap: one for a short gap, else down (under the hunk above) and up. */
  function updateGapRow(row) {
    const { from, to } = gapOf(row);
    const size = to - from + 1;
    const show = { all: size <= EXPAND_STEP, down: size > EXPAND_STEP && from > 1, up: size > EXPAND_STEP && !row.classList.contains('hunk-row-end') };
    for (const b of $$('.js-expand', row)) {
      b.hidden = !show[b.dataset.dir];
      b.disabled = false;
    }
  }

  /** Each hunk header says which lines follow it, as `git diff` would after loading the lines. */
  function relabelHunks(table) {
    for (const row of $$('tr.hunk-row:not(.hunk-row-end)', table)) {
      const first = [null, null];
      const count = [0, 0];
      for (let r = row.nextElementSibling; r && !r.classList.contains('hunk-row'); r = r.nextElementSibling) {
        if (!r.classList.contains('line')) continue;
        $$('td.blob-num', r).forEach((td, i) => {
          if (!td.dataset.num) return;
          if (first[i] === null) first[i] = td.dataset.num;
          count[i]++;
        });
      }
      const section = row.dataset.section;
      $('.blob-code-hunk', row).textContent = `@@ -${first[0] ?? 0},${count[0]} +${first[1] ?? 0},${count[1]} @@${section ? ' ' + section : ''}`;
    }
  }

  /** Load lines from..to (new side) of the gap above `row`. */
  async function loadGap(row, from, to) {
    const file = row.closest('.file');
    const gap = gapOf(row);
    from = Math.max(from, gap.from);
    to = Math.min(to, gap.to);
    if (from > to) return;
    const table = row.closest('table');
    const mode = table.classList.contains('diff-split') ? 'split' : 'unified';
    const res = await fetch(`${file.dataset.excerpt}&from=${from}&to=${to}&delta=${gap.delta}&diff=${mode}`);
    if (!res.ok) throw new Error(`Could not load lines ${from} to ${to}`);
    const rows = document.createElement('template');
    rows.innerHTML = await res.text();
    if (!row.isConnected) return;
    // Lines above the loaded ones stay folded behind a row of their own; this row keeps those below.
    if (from > gap.from) {
      const upper = row.cloneNode(true);
      upper.classList.remove('hunk-row-end');
      upper.dataset.gapTo = String(from - 1);
      upper.dataset.section = '';
      row.before(upper);
      updateGapRow(upper);
    }
    row.before(rows.content);
    if (to < gap.to) {
      row.dataset.gapFrom = String(to + 1);
      updateGapRow(row);
    } else row.remove();
    relabelHunks(table);
  }

  const expandedKey = (file) => `${ds().commitId}:${ds().baseCommitId}:${file.dataset.path}`;
  const expanding = new WeakMap();

  /**
   * Load lines from..to (new side) wherever they are still folded in a file. A file loads one
   * range at a time, so each sees the gaps the one before it left.
   */
  function expandRange(file, from, to, remember) {
    if (remember) {
      const key = expandedKey(file);
      userState.expanded.set(key, [...(userState.expanded.get(key) || []), [from, to]]);
    }
    const run = (expanding.get(file) || Promise.resolve()).then(async () => {
      for (const row of $$('tr.hunk-row[data-gap-from]', file)) {
        const g = gapOf(row);
        if (row.isConnected && from <= g.to && to >= g.from) await loadGap(row, from, to);
      }
    });
    expanding.set(file, run.catch(() => {}));
    return run;
  }

  /** After a refresh, load again what the reviewer had loaded. */
  function restoreExpanded() {
    return Promise.all(
      $$('.file[data-excerpt]').map(async (file) => {
        for (const [from, to] of userState.expanded.get(expandedKey(file)) || []) await expandRange(file, from, to, false).catch(() => {});
      }),
    );
  }

  /** Load the lines a draft line comment is on, with a few around them, and reopen its form. */
  async function unfoldFor(meta) {
    const file = $(`.file[data-path="${CSS.escape(meta.path)}"][data-excerpt]`);
    if (!file) return null;
    for (const [side, line] of [[meta.startSide, meta.startLine], [meta.side, meta.line]]) {
      if (!line || cellFor(meta.path, side, line)) continue;
      for (const row of $$('tr.hunk-row[data-gap-from]', file)) {
        const g = gapOf(row);
        const n = side === 'LEFT' ? line + g.delta : line;
        if (n >= g.from && n <= g.to) {
          await expandRange(file, n - 3, n + 3, true);
          break;
        }
      }
    }
    return cellFor(meta.path, meta.side, meta.line) ? reopenForm(meta) : null;
  }

  // ----------------------------------------------------------- file view
  // Line numbers select lines, shift-click a range, kept in the URL as #L12 or #L12-L20.

  function selectedLines() {
    const m = location.hash.match(/^#L(\d+)(?:-L(\d+))?$/);
    if (!m) return null;
    const a = Number(m[1]);
    const b = Number(m[2] || m[1]);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return null;
    return [Math.min(a, b), Math.max(a, b)];
  }

  // Walks the file's rows, not the numbers in the URL, so #L1-L1000000000 costs no more than the file.
  function markLines(scroll) {
    // Rendered Markdown and SVG have no line numbers: lines in the URL open the source, as on GitHub.
    const rendered = $('.blob-body[data-plain]');
    if (rendered && selectedLines()) return location.replace(rendered.dataset.plain + location.hash);
    const table = $('.blob-table');
    if (!table) return;
    const sel = selectedLines();
    let first = null;
    for (const td of $$('td.js-line-number', table)) {
      const n = Number(td.dataset.num);
      const on = !!sel && n >= sel[0] && n <= sel[1];
      td.parentElement.classList.toggle('selected-line', on);
      if (on && !first) first = td;
    }
    if (scroll && first) first.scrollIntoView({ block: 'center' });
  }
  window.addEventListener('hashchange', () => markLines(true));

  function markActiveTreeItem() {
    const id = location.hash.slice(1);
    for (const a of $$('.file-tree a')) a.classList.toggle('active', a.getAttribute('href') === `#${id}`);
  }
  window.addEventListener('hashchange', markActiveTreeItem);

  // A file's bubble in the tree goes to its unresolved conversations in turn, wrapping around.
  // Per file it remembers the last one, and its place in case it was resolved since.
  const treeThread = new Map();

  function nextTreeThread(button) {
    const path = $('a', button.closest('li')).dataset.path;
    const ids = button.dataset.threads.split(' ');
    const last = treeThread.get(path);
    const index = (!last ? 0 : ids.includes(last.id) ? ids.indexOf(last.id) + 1 : last.index) % ids.length;
    treeThread.set(path, { id: ids[index], index });
    const thread = document.getElementById(`thread-${ids[index]}`);
    if (thread) showComment(thread);
  }

  // ------------------------------------------------------ linked comments
  // A link to a comment (#discussion_r12, #issuecomment-3, as the API's html_url and Copy link
  // give them) or a thread (#thread-12) goes to it on load and when the hash changes. The tab
  // shown may not have it: the Conversation tab shows every thread but those of the viewer's
  // pending review, and Files changed leaves out outdated threads and those on a commit's message.
  // Such a link goes on to the tab that has it (#main's data-comment-tabs, else the Conversation tab).

  const COMMENT_LINK = /^#(?:(?:discussion_r|thread-)(\d+)|issuecomment-\d+|pullrequestreview-\d+|pullrequest-description)$/;

  function goToLinked() {
    const m = location.hash.match(COMMENT_LINK);
    if (!m) return;
    const target = document.getElementById(location.hash.slice(1));
    if (target) return showComment(target);
    const tabs = JSON.parse(ds().commentTabs || '{}');
    const url = (m[1] && tabs[m[1]]) || ds().conversationUrl;
    if (url && url !== location.pathname + location.search) location.replace(url + location.hash);
  }
  window.addEventListener('hashchange', goToLinked);
  // Until the page has loaded, the browser keeps the linked element at the top of the window, where
  // the sticky headers cover a thread's first lines: show it again after that.
  window.addEventListener('load', () => {
    const target = COMMENT_LINK.test(location.hash) && document.getElementById(location.hash.slice(1));
    if (target) showComment(target);
  });

  /**
   * Open the file and the thread a comment is in, as live refreshes will keep them, scroll it into
   * view under the sticky headers (their scroll-margin in app.css) and flash it. A thread's first
   * comment stands for the thread.
   */
  function showComment(target) {
    const file = target.closest('.file');
    if (file && file.classList.contains('is-collapsed') && $('.file-body', file).contains(target)) {
      userState.collapsed.set(file.dataset.path, false);
      setCollapsed(file, false);
    }
    const thread = target.closest('details.review-thread');
    if (thread) {
      thread.open = true;
      userState.threads.set(thread.dataset.thread, true);
    }
    const box = thread && target === $('.review-comment', thread) ? thread : target.matches('.timeline-comment-group') ? $('.timeline-comment', target) : target;
    box.scrollIntoView({ block: box.offsetHeight > innerHeight / 2 ? 'start' : 'center' });
    for (const el of $$('.is-flash')) el.classList.remove('is-flash');
    void box.offsetWidth; // restart the animation
    box.classList.add('is-flash');
  }

  // ----------------------------------------------------- browser file tree
  // The tree beside the repository browser. A directory loads its items when it opens, what is
  // open stays open on the next page of the same commit (per tab), and "Go to file" filters the
  // commit's paths, fetched once.

  const FILE_ICON =
    '<svg class="octicon octicon-file" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011Z"></path></svg>';
  const SHOWN_MATCHES = 100;
  const browseTree = () => $('.js-browse-tree');
  const pathUrl = (path) => path.split('/').map(encodeURIComponent).join('/');
  /** { sha, open }: the commit browsed and the directories open in its tree. */
  let treeState = null;
  let treePaths = null;
  const treeLoads = new WeakMap();

  /** `at` is where the link clicked was in the tree, for the next page to show its entry there. */
  function saveTreeState(at) {
    try {
      sessionStorage.setItem('galley:browse-tree-open', JSON.stringify({ sha: treeState.sha, open: [...treeState.open], at }));
    } catch {}
  }

  /** Load a directory's items, once, and open those of its directories that were open. */
  function loadTreeDir(details) {
    if (!treeLoads.has(details)) {
      const load = (async () => {
        if (!$(':scope > ul', details)) {
          const res = await fetch(`${browseTree().dataset.items}/${pathUrl(details.dataset.path)}`);
          if (!res.ok) throw new Error(`Could not load ${details.dataset.path}`);
          const items = document.createElement('template');
          items.innerHTML = await res.text();
          details.append(items.content);
        }
        await openTreeDirs(details);
      })().catch((err) => {
        treeLoads.delete(details);
        toast(err.message);
      });
      treeLoads.set(details, load);
    }
    return treeLoads.get(details);
  }

  function openTreeDirs(root) {
    const dirs = $$('details[data-path]', root).filter((d) => treeState.open.has(d.dataset.path));
    return Promise.all(
      dirs.map((d) => {
        d.open = true;
        return loadTreeDir(d);
      }),
    );
  }

  document.addEventListener(
    'toggle',
    (e) => {
      const d = e.target;
      if (!treeState || !(d instanceof HTMLDetailsElement) || !d.dataset.path || !d.closest('.js-browse-tree')) return;
      if (d.open) {
        treeState.open.add(d.dataset.path);
        loadTreeDir(d);
      } else treeState.open.delete(d.dataset.path);
      saveTreeState();
    },
    true, // toggle does not bubble
  );

  /** Show the page's own entry where the link clicked on the last page was, or else in view. */
  function placeActiveEntry(tree, at) {
    const active = $('[aria-current="page"]', tree);
    if (!active || !tree.clientHeight) return;
    const row = active.closest('summary, .tree-file');
    const offset = row.getBoundingClientRect().top - tree.getBoundingClientRect().top;
    if (typeof at === 'number') tree.scrollTop += offset - at;
    else if (offset + row.offsetHeight > tree.clientHeight) tree.scrollTop += offset - tree.clientHeight / 2;
  }

  function setUpBrowseTree() {
    const tree = browseTree();
    if (!tree) return;
    let saved = null;
    try {
      saved = JSON.parse(sessionStorage.getItem('galley:browse-tree-open'));
    } catch {}
    const same = saved && saved.sha === tree.dataset.sha && Array.isArray(saved.open);
    treeState = { sha: tree.dataset.sha, open: new Set(same ? saved.open : []) };
    // The directories down to this page are open now, and stay open on the next.
    for (const d of $$('details[open][data-path]', tree)) treeState.open.add(d.dataset.path);
    saveTreeState();
    openTreeDirs(tree).then(() => placeActiveEntry(tree, same ? saved.at : undefined));
  }

  function rememberTreeLink(link) {
    const tree = link.closest('.js-browse-tree');
    saveTreeState(link.getBoundingClientRect().top - tree.getBoundingClientRect().top);
  }

  // Shown on wide screens and hidden on narrow ones (app.css), until the viewer says otherwise.
  function toggleBrowseTree() {
    const hide = getComputedStyle(browseTree()).display !== 'none';
    document.body.classList.toggle('browse-tree-hidden', hide);
    document.body.classList.toggle('browse-tree-shown', !hide);
    try {
      localStorage.setItem('galley:browse-tree', hide ? 'hidden' : 'shown');
    } catch {}
  }

  /** "Go to file": the paths containing the text, the ones whose file name does first. */
  async function filterTree(input) {
    const tree = input.closest('.js-browse-tree');
    const results = $('.js-browse-results', tree);
    const filtering = () => input.value.trim().toLowerCase();
    $('.js-browse-items', tree).hidden = !!filtering();
    results.hidden = !filtering();
    if (!filtering()) {
      // An empty box leaves nothing for Enter or the arrows to open.
      results.replaceChildren();
      return;
    }
    if (!treePaths) {
      treePaths = fetch(tree.dataset.paths).then(async (res) => {
        if (!res.ok) throw new Error('Could not load the files');
        return (await res.json()).paths;
      });
    }
    let paths;
    try {
      paths = await treePaths;
    } catch (err) {
      treePaths = null;
      results.innerHTML = `<li class="browse-tree-note">${esc(err.message)}</li>`;
      return;
    }
    // Typing on while the paths loaded: show what the box says now.
    const q = filtering();
    if (!q) return;
    const inName = (p) => p.slice(p.lastIndexOf('/') + 1).toLowerCase().includes(q);
    const hits = paths.filter((p) => p.toLowerCase().includes(q)).sort((a, b) => inName(b) - inName(a));
    const rows = hits.slice(0, SHOWN_MATCHES).map((p) => {
      const at = p.toLowerCase().lastIndexOf(q);
      const name = `${esc(p.slice(0, at))}<mark>${esc(p.slice(at, at + q.length))}</mark>${esc(p.slice(at + q.length))}`;
      return `<li class="tree-file"><a href="${esc(`${tree.dataset.blob}/${pathUrl(p)}`)}">${FILE_ICON}<span class="tree-name">${name}</span></a></li>`;
    });
    const more = hits.length - rows.length;
    if (!hits.length) rows.push('<li class="browse-tree-note">No files match</li>');
    else if (more) rows.push(`<li class="browse-tree-note">${more} more ${more === 1 ? 'file matches' : 'files match'}</li>`);
    results.innerHTML = rows.join('');
  }

  document.addEventListener('input', (e) => {
    if (e.target.matches && e.target.matches('.js-browse-filter')) filterTree(e.target);
  });

  // Up and down move between the box and the files found, Enter opens one, Escape clears the box.
  document.addEventListener('keydown', (e) => {
    const tree = e.target.closest && e.target.closest('.js-browse-tree');
    if (!tree || e.altKey || e.ctrlKey || e.metaKey) return;
    const input = $('.js-browse-filter', tree);
    const results = $('.js-browse-results', tree);
    const links = results.hidden ? [] : $$('a', results);
    const at = links.indexOf(e.target);
    if (e.target !== input && at < 0) return;
    if (e.key === 'ArrowDown' && links[at + 1]) links[at + 1].focus();
    else if (e.key === 'ArrowUp' && at >= 0) (links[at - 1] || input).focus();
    else if (e.key === 'Enter' && e.target === input && links[0]) {
      rememberTreeLink(links[0]);
      location.href = links[0].href;
    } else if (e.key === 'Escape' && input.value) {
      input.value = '';
      input.focus();
      filterTree(input);
    } else return;
    e.preventDefault();
  });

  // --------------------------------------------------------------- clicks

  document.addEventListener('click', async (e) => {
    const t = e.target.closest ? e.target : null;
    if (!t) return;
    const on = (sel) => t.closest(sel);
    let el;

    // Close dropdowns when clicking elsewhere.
    for (const d of $$('details.dropdown[open]')) if (!d.contains(t)) d.open = false;

    if ((el = on('.js-expand'))) {
      const row = el.closest('tr.hunk-row');
      const { from, to } = gapOf(row);
      const [a, b] = el.dataset.dir === 'up' ? [to - EXPAND_STEP + 1, to] : el.dataset.dir === 'down' ? [from, from + EXPAND_STEP - 1] : [from, to];
      el.disabled = true;
      expandRange(row.closest('.file'), a, b, true).catch((err) => {
        el.disabled = false;
        toast(err.message);
      });
    } else if ((el = on('.js-line-number'))) {
      const n = Number(el.dataset.num);
      const sel = selectedLines();
      const hash = e.shiftKey && sel && n !== sel[0] ? `#L${Math.min(sel[0], n)}-L${Math.max(sel[0], n)}` : `#L${n}`;
      history.replaceState(null, '', hash);
      markLines(false);
    } else if ((el = on('.md-tab'))) {
      const editor = el.closest('.md-editor');
      for (const tab of $$('.md-tab', editor)) tab.classList.toggle('selected', tab === el);
      el.dataset.tab === 'preview' ? showPreview(editor) : showWrite(editor);
    } else if ((el = on('.js-insert-suggestion'))) {
      insertSuggestion(el.closest('.md-editor'));
    } else if ((el = on('.js-attach-image'))) {
      chooseImages(el.closest('.md-editor'));
    } else if ((el = on('.markdown-body img[src^="/uploads/"]')) && !el.closest('a')) {
      window.open(el.src, '_blank', 'noopener');
    } else if ((el = on('.js-title-edit'))) {
      $('.js-title-view').hidden = true;
      const form = $('.js-title-form');
      form.hidden = false;
      $('input', form).select();
    } else if ((el = on('.js-title-cancel'))) {
      $('.js-title-view').hidden = false;
      $('.js-title-form').hidden = true;
    } else if ((el = on('.js-copy-link'))) {
      el.closest('details').open = false;
      try {
        await navigator.clipboard.writeText(el.dataset.copy);
        toast('Copied the link');
      } catch {
        toast(el.dataset.copy);
      }
    } else if ((el = on('.js-comment-edit'))) {
      el.closest('details').open = false;
      const box = el.closest('.timeline-comment, .review-comment');
      openEdit($('.comment-edit-form', box));
    } else if ((el = on('.js-comment-edit-cancel'))) {
      closeEdit(el.closest('.comment-edit-form'));
    } else if ((el = on('.js-comment-delete'))) {
      if (!confirmed(el, 'Click again to delete')) return;
      await api('DELETE', el.dataset.path).catch((err) => toast(err.message));
      refresh();
    } else if ((el = on('.js-reply-open'))) {
      openReply(el.closest('.review-thread-reply'));
    } else if ((el = on('.js-reply-cancel'))) {
      const container = el.closest('.review-thread-reply');
      const form = $('.review-thread-reply-form', container);
      form.hidden = true;
      clearDraft($('textarea', form).dataset.draftKey);
      $('textarea', form).value = '';
      $('.js-reply-open', container).hidden = false;
    } else if ((el = on('.js-resolve'))) {
      el.disabled = true;
      await api(el.dataset.method, el.dataset.api).catch((err) => toast(err.message));
      userState.threads.delete(el.closest('.review-thread').dataset.thread);
      refresh();
    } else if ((el = on('.js-pin'))) {
      el.disabled = true;
      await api(el.dataset.method, el.dataset.api).catch((err) => toast(err.message));
      refresh();
    } else if ((el = on('.js-dismiss'))) {
      el.disabled = true;
      // What the page shows: something new since, which the server refuses to dismiss, shows once it refreshes.
      const seen = el.dataset.seen;
      const done = await api(el.dataset.method, el.dataset.api, seen === undefined ? undefined : { seen }).then(
        () => true,
        (err) => toast(err.message),
      );
      if (done && el.dataset.toast) toast(el.dataset.toast);
      refresh();
    } else if ((el = on('.js-reviewer-step'))) {
      stepReviewerLimit(el);
    } else if ((el = on('.js-reviewer-reset'))) {
      el.disabled = true;
      await api('PATCH', el.dataset.api, { [el.dataset.field]: null }).catch((err) => toast(err.message));
      refresh();
    } else if ((el = on('.js-reviewer-switch'))) {
      el.disabled = true;
      await api('PATCH', el.dataset.api, { enabled: el.dataset.enabled === 'true' }).catch((err) => toast(err.message));
      refresh();
    } else if ((el = on('.js-iterations'))) {
      el.disabled = true;
      await api(el.dataset.method, el.dataset.api).catch((err) => toast(err.message));
      refresh();
    } else if ((el = on('.js-auto-publish-cancel'))) {
      el.disabled = true;
      await api('DELETE', el.dataset.api).catch((err) => toast(err.message));
      refresh();
    } else if ((el = on('.js-run-reviewer'))) {
      el.disabled = true;
      // Asked from its menu, the menu closes; the row shows the review starting.
      const menu = el.closest('details.dropdown');
      if (menu) {
        menu.open = false;
        $('summary', menu).focus();
      }
      await api('POST', el.dataset.api).catch((err) => toast(err.message));
      refresh();
    } else if ((el = on('.js-stop-review'))) {
      if (!confirmed(el, 'Click again to stop')) return;
      el.disabled = true;
      const menu = el.closest('details.dropdown');
      if (menu) {
        menu.open = false;
        $('summary', menu).focus();
      }
      await api('POST', el.dataset.api, { run_id: Number(el.dataset.run) }).catch((err) => toast(err.message));
      refresh();
    } else if ((el = on('.js-set-state'))) {
      el.disabled = true;
      await api('PATCH', ds().apiBase, { state: el.dataset.state }).catch((err) => toast(err.message));
      refresh();
    } else if ((el = on('.js-discard-review'))) {
      if (!confirmed(el, 'Click again to discard')) return;
      await api('DELETE', el.dataset.api).catch((err) => toast(err.message));
      refresh();
    } else if ((el = on('.js-delete-pull'))) {
      if (!confirmed(el, 'Click again to delete this staged pull request')) return;
      await api('DELETE', el.dataset.api).catch((err) => toast(err.message));
      location.href = el.dataset.next;
    } else if ((el = on('.js-delete-reviewer'))) {
      if (!confirmed(el, 'Click again to delete its file')) return;
      try {
        await api('DELETE', el.dataset.api);
        location.href = el.dataset.next;
      } catch (err) {
        toast(err.message);
      }
    } else if ((el = on('.js-inline-cancel'))) {
      closeInlineForm(el.closest('.inline-comment-form'));
    } else if ((el = on('.js-file-toggle'))) {
      const file = el.closest('.file');
      const collapsed = !file.classList.contains('is-collapsed');
      userState.collapsed.set(file.dataset.path, collapsed);
      setCollapsed(file, collapsed);
    } else if ((el = on('.js-file-comment'))) {
      openFileForm(el.closest('.file'));
    } else if ((el = on('.js-commit-comment'))) {
      openCommitForm(el.closest('li[data-commit]'));
    } else if ((el = on('.js-commit-expand'))) {
      const desc = $('.commit-desc', el.closest('.commit'));
      if (desc) desc.hidden = !desc.hidden;
    } else if ((el = on('.js-tree-threads'))) {
      nextTreeThread(el);
    } else if ((el = on('.js-tree-toggle[data-tree="browse"]'))) {
      toggleBrowseTree();
    } else if ((el = on('.js-browse-tree a[href]'))) {
      rememberTreeLink(el);
    } else if ((el = on('.js-tree-toggle'))) {
      document.body.classList.toggle('tree-hidden');
      try {
        localStorage.setItem('galley:tree-hidden', document.body.classList.contains('tree-hidden') ? '1' : '');
      } catch {}
    } else if ((el = on('.js-copy'))) {
      try {
        await navigator.clipboard.writeText(el.dataset.copy);
        el.classList.add('copied');
        setTimeout(() => el.classList.remove('copied'), 1200);
      } catch {
        toast(el.dataset.copy);
      }
    } else if ((el = on('summary.review-thread-header'))) {
      const thread = el.closest('details.review-thread');
      // Let the toggle happen, then remember the choice across refreshes.
      setTimeout(() => userState.threads.set(thread.dataset.thread, thread.open));
    }
  });

  // A reviewer agent's review limit on a pull request: each click moves the number at once, and the
  // last value is saved shortly after the clicks stop. Each reviewer's limit waits on its own.
  const limitSaves = new Map();
  function stepReviewerLimit(button) {
    const box = button.closest('.reviewer-limit');
    const max = Number(box.dataset.max);
    const value = Math.min(max, Math.max(0, Number(box.dataset.limit) + Number(button.dataset.step)));
    box.dataset.limit = String(value);
    $('.js-reviewer-limit', box).textContent = String(value);
    for (const b of $$('.js-reviewer-step', box)) b.disabled = Number(b.dataset.step) < 0 ? value <= 0 : value >= max;
    clearTimeout(limitSaves.get(box.dataset.api));
    limitSaves.set(
      box.dataset.api,
      setTimeout(async () => {
        limitSaves.delete(box.dataset.api);
        await api('PATCH', box.dataset.api, { max_iterations: value }).catch((err) => toast(err.message));
        refresh();
      }, 500),
    );
  }

  // A custom reviewer's models are its tool's, and only a reviewer of the code runs the tests.
  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches && t.matches('.js-reviewer-engine')) {
      const model = $('.js-reviewer-model', t.form);
      for (const o of model.options) o.hidden = o.disabled = o.dataset.engine !== t.value;
      const tool = [...model.options].find((o) => o.dataset.engine === t.value && !o.value);
      model.value = '';
      tool.selected = true;
      $('.js-reviewer-effort', t.form).dataset.defaultLabel = tool.dataset.defaultLabel;
      model.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (t.matches && t.matches('.js-reviewer-reviews')) {
      $('.js-code-only', t.form).hidden = t.value !== 'code';
    }
  });

  // Settings: the effort levels on offer depend on the model.
  document.addEventListener('change', (e) => {
    const model = e.target;
    if (!model.matches || !model.matches('.js-reviewer-model')) return;
    const option = model.selectedOptions[0];
    const efforts = (option.dataset.efforts || '').split(',').filter(Boolean);
    const effort = $('.js-reviewer-effort', model.form);
    const current = effort.value;
    const fallback = option.dataset.defaultEffort;
    effort.innerHTML =
      `<option value="">${esc(effort.dataset.defaultLabel)}${fallback ? ` (${esc(fallback)})` : ''}</option>` + efforts.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
    effort.value = efforts.includes(current) ? current : '';
  });

  document.addEventListener('change', async (e) => {
    const t = e.target;
    if (!t.matches || !t.matches('.js-viewed')) return;
    const file = t.closest('.file');
    const viewed = t.checked;
    try {
      await api('PUT', `${ds().apiBase}/viewed`, { path: file.dataset.path, blob: file.dataset.blob, viewed });
    } catch (err) {
      t.checked = !viewed;
      toast(err.message);
      return;
    }
    userState.collapsed.set(file.dataset.path, viewed);
    setCollapsed(file, viewed);
    const count = $('.js-viewed-count');
    if (count) count.textContent = String($$('.js-viewed:checked').length);
    const item = $(`.file-tree a[data-path="${CSS.escape(file.dataset.path)}"]`);
    if (item) item.closest('li').classList.toggle('is-viewed', viewed);
    if (viewed) {
      const next = file.nextElementSibling;
      if (next && file.getBoundingClientRect().top < 0) file.scrollIntoView({ block: 'start' });
    }
  });

  // ---------------------------------------------------------- repositories
  // The repositories beside the list: the first few, "Show more" for the rest, and a filter over
  // all of them. Both last through live refreshes.

  const repoList = { filter: '', more: false };

  function showRepos() {
    const list = $('.js-repo-list');
    if (!list) return;
    const input = $('.js-repo-filter');
    // Down to so few that the filter is gone: what was typed in it goes too.
    if (!input) repoList.filter = '';
    else input.value = repoList.filter;
    const filter = repoList.filter.trim().toLowerCase();
    const limit = filter || repoList.more ? Infinity : Number(list.dataset.shown);
    const items = $$('.repo-list-item', list);
    const matching = items.filter((item) => item.dataset.name.toLowerCase().includes(filter));
    // The repository whose page this is is among the first few, in place of the last when it is further down.
    const shown = new Set(matching.slice(0, limit));
    const selected = matching.find((item) => item.classList.contains('selected'));
    if (selected && !shown.has(selected)) {
      shown.delete(matching[limit - 1]);
      shown.add(selected);
    }
    for (const item of items) item.hidden = !shown.has(item);
    const more = $('.js-repo-more');
    if (more) more.hidden = matching.length <= limit;
    const none = $('.js-repo-none');
    if (none) none.hidden = matching.length > 0;
  }

  document.addEventListener('input', (e) => {
    if (!e.target.matches || !e.target.matches('.js-repo-filter')) return;
    repoList.filter = e.target.value;
    showRepos();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('.js-repo-more')) return;
    repoList.more = true;
    showRepos();
  });

  // -------------------------------------------------------- notifications
  // Opt in on a list page: a desktop notification when a pull request becomes your turn. The
  // page knows after each live refresh, so it works while a list page is open in some tab. It
  // tells once the pull request has been your turn for NOTIFY_AFTER_MS, and still is when the page
  // is refreshed then, so a turn that is yours for a moment (on its way from the agents to
  // auto-publish, say) tells nothing. The desktop app waits as long (desktop/turns.ts).

  const NOTIFY_AFTER_MS = 10000;
  let yourTurn = null; // the pull ids whose turn was yours when the page last rendered
  const held = new Map(); // pull id → the timer for those that became yours, until told or no longer yours
  // pull id → { at, fetched } when you made it your turn again yourself, undoing its dismissal.
  const undone = new Map();

  // Nothing to tell of it becoming your turn, in the renders of fetches in flight and of the first
  // that begins after, which shows what the Undo did; a turn after that is news again. For a
  // minute, should no render come.
  function madeYours(id) {
    clearTimeout(held.get(id));
    held.delete(id);
    undone.set(id, { at: Date.now(), fetched });
  }

  function notifying() {
    try {
      return !!window.Notification && Notification.permission === 'granted' && localStorage.getItem('galley:notify') === '1';
    } catch {
      return false;
    }
  }

  function notifyTurns() {
    const button = $('.js-notify');
    if (!button) return void (yourTurn = null);
    button.hidden = !window.Notification || Notification.permission === 'denied';
    $('.js-notify-label', button).textContent = notifying() ? 'Notifying' : 'Notify me';
    button.classList.toggle('selected', notifying());
    const turns = listedTurns();
    // No longer yours: nothing to tell, and becoming yours again starts the wait again.
    for (const [id, timer] of held) {
      if (turns.some((t) => t.id === id)) continue;
      clearTimeout(timer);
      held.delete(id);
    }
    const quiet = (id) => undone.has(id) && Date.now() - undone.get(id).at < 60000;
    if (yourTurn && notifying()) for (const t of turns.filter((t) => !yourTurn.has(t.id) && !quiet(t.id))) holdTurn(t.id);
    for (const [id, u] of undone) if (shownFetch > u.fetched) undone.delete(id);
    yourTurn = new Set(turns.map((t) => t.id));
  }

  // The server lists them whatever the tab shows: { id, title, url, reasons }.
  function listedTurns() {
    const list = $('[data-your-turn]');
    return list ? JSON.parse(list.dataset.yourTurn) : [];
  }

  function holdTurn(id) {
    const timer = setTimeout(() => confirmTurn(id, timer), NOTIFY_AFTER_MS);
    held.set(id, timer);
  }

  // Refresh, and tell of it if it has been your turn all along. When the refresh fails, wait again.
  async function confirmTurn(id, timer) {
    const before = rendered;
    await refresh().catch(() => {});
    if (held.get(id) !== timer) return;
    if (rendered === before) return holdTurn(id);
    held.delete(id);
    const t = listedTurns().find((t) => t.id === id);
    if (!t || !notifying()) return;
    // The tag keeps other tabs showing a list from notifying twice.
    const n = new Notification(`Your turn: ${t.title}`, { body: t.reasons, tag: `galley-turn-${t.id}`, icon: '/static/favicon.svg' });
    n.onclick = () => {
      window.focus();
      location.href = t.url;
    };
  }

  document.addEventListener('click', async (e) => {
    const button = e.target.closest && e.target.closest('.js-notify');
    if (!button) return;
    try {
      if (notifying()) localStorage.removeItem('galley:notify');
      else if ((await Notification.requestPermission()) === 'granted') localStorage.setItem('galley:notify', '1');
    } catch {}
    notifyTurns();
  });

  // ------------------------------------------------------ the desktop app
  // A page opened in the browser goes to the desktop app's window while the app runs on the
  // browser's computer and opens galley links (the server says so in data-desktop-app), as Zoom's
  // and Slack's pages do: through its galley:// link (src/app-link.ts), which the browser asks
  // about first. Only a page that came from outside galley, such as a link clicked in a terminal:
  // not one reached from another galley page, a reload, Back or Forward, or a live refresh, and
  // never in the app's own windows. The tab then says so, and "Stay in the browser" keeps galley
  // links in this browser from then on, until Settings > Desktop app says otherwise.

  const STAY = 'galley:stay-in-browser';
  const OPENED = 'galley:opened-from-galley';
  const inApp = () => / Electron\//.test(navigator.userAgent);

  // A link in a comment opens in a tab of its own with no referrer (markdown.ts), also one to a
  // galley page: a page says when it opens one of galley's, and the page opened takes that.
  function opening(e) {
    const a = e.target.closest && e.target.closest('a[href]');
    try {
      if (a && new URL(a.href).origin === location.origin) localStorage.setItem(OPENED, String(Date.now()));
    } catch {}
  }
  document.addEventListener('click', opening, { capture: true });
  document.addEventListener('auxclick', opening, { capture: true });

  /** Whether a galley page opened this one in the last few seconds; said once. */
  function openedFromGalley() {
    try {
      const at = Number(localStorage.getItem(OPENED));
      localStorage.removeItem(OPENED);
      return Date.now() - at < 10_000;
    } catch {
      return false;
    }
  }

  function staysInBrowser() {
    try {
      return localStorage.getItem(STAY) === '1';
    } catch {
      return false;
    }
  }

  function setStaysInBrowser(stay) {
    try {
      if (stay) localStorage.setItem(STAY, '1');
      else localStorage.removeItem(STAY);
    } catch {}
  }

  function handOff() {
    const fromGalley = openedFromGalley();
    if (document.body.dataset.desktopApp !== 'open-links' || inApp() || staysInBrowser() || fromGalley) return;
    const [nav] = performance.getEntriesByType('navigation');
    if (nav && nav.type !== 'navigate') return;
    try {
      if (document.referrer && new URL(document.referrer).origin === location.origin) return;
    } catch {}
    const link = 'galley://' + (location.pathname + location.search + location.hash).replace(/^\/+/, '');
    const notice = document.createElement('div');
    notice.className = 'handoff-notice';
    notice.setAttribute('role', 'status');
    notice.innerHTML = `<span class="handoff-notice-text">Opened in the galley app.</span>
<a class="btn btn-sm" href="${esc(link)}">Open it again</a>
<button type="button" class="btn btn-sm js-stay-in-browser">Stay in the browser</button>`;
    main().before(notice);
    location.href = link;
  }

  document.addEventListener('click', (e) => {
    if (!(e.target.closest && e.target.closest('.js-stay-in-browser'))) return;
    setStaysInBrowser(true);
    const notice = $('.handoff-notice');
    if (notice) notice.remove();
    toast('galley links stay in this browser. Settings > Desktop app changes that.', {
      label: 'Undo',
      run: () => {
        setStaysInBrowser(false);
        toast('galley links open in the app again');
      },
    });
  });

  // Settings > Desktop app: this browser's choice, which has no say in the app's own windows.
  function showOpenInApp() {
    for (const box of $$('.js-open-in-app')) box.checked = !staysInBrowser();
    for (const setting of $$('.js-open-in-app-setting')) setting.hidden = inApp();
  }

  document.addEventListener('change', (e) => {
    if (!e.target.matches('.js-open-in-app')) return;
    setStaysInBrowser(!e.target.checked);
    toast('Settings saved');
  });

  // The app's windows go back and forward with a swipe and with ⌘← and ⌘→, as a Chrome tab does
  // (gestures.js).
  function loadGestures() {
    if (!inApp()) return;
    const script = document.createElement('script');
    script.src = '/static/gestures.js';
    document.head.append(script);
  }

  // ------------------------------------------------------------- times

  function ago(d) {
    const s = Math.round((Date.now() - d.getTime()) / 1000);
    if (s < 45) return 'now';
    const m = Math.round(s / 60);
    if (m < 60) return m === 1 ? '1 minute ago' : `${m} minutes ago`;
    const h = Math.round(m / 60);
    if (h < 24) return h === 1 ? '1 hour ago' : `${h} hours ago`;
    const days = Math.round(h / 24);
    if (days < 30) return days === 1 ? 'yesterday' : `${days} days ago`;
    return 'on ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** How long since `d`, as html.ts's duration: "3 min", "5 h", "4 days". */
  function duration(d) {
    const m = Math.max(1, Math.round((Date.now() - d.getTime()) / 60000));
    if (m < 60) return `${m} min`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;
  }

  function updateTimes() {
    for (const el of $$('relative-time')) {
      const d = new Date(el.getAttribute('datetime'));
      el.textContent = el.dataset.format === 'duration' ? duration(d) : ago(d);
    }
  }

  // ------------------------------------------------------------- avatars

  // An avatar from elsewhere (an agent's logo, your GitHub avatar) that can't load, such as
  // offline, shows the generated one instead. Load errors don't bubble: listen in the capture phase.
  function avatarFallback(img) {
    img.src = img.dataset.fallback;
    delete img.dataset.fallback;
  }
  document.addEventListener('error', (e) => {
    if (e.target instanceof HTMLImageElement && e.target.dataset.fallback) avatarFallback(e.target);
  }, { capture: true });

  // ---------------------------------------------------------------- boot

  try {
    if (localStorage.getItem('galley:tree-hidden')) document.body.classList.add('tree-hidden');
    const browseTreeShown = localStorage.getItem('galley:browse-tree');
    if (browseTreeShown === 'hidden' || browseTreeShown === 'shown') document.body.classList.add(`browse-tree-${browseTreeShown}`);
  } catch {}
  // Avatars that failed before this script ran.
  for (const img of $$('img[data-fallback]')) if (img.complete && !img.naturalWidth) avatarFallback(img);
  afterRender();
  markLines(true);
  goToLinked();
  setUpBrowseTree();
  connectLive();
  handOff();
  loadGestures();
  setInterval(updateTimes, 30_000);
})();
