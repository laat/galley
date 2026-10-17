// laatsux web UI. Server-rendered pages; this file adds the interactive parts.
(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const main = () => document.getElementById('main');
  const ds = () => main().dataset;
  const viewer = () => document.body.dataset.viewer;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ------------------------------------------------------------------ API

  async function api(method, url, body) {
    const opts = { method, headers: {} };
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

  const draftPrefix = () => `laatsux:draft:${ds().pullId || 'global'}:`;

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
      const res = await fetch(location.href, { headers: { accept: 'text/html' } });
      if (!res.ok) return;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const next = doc.getElementById('main');
      if (!next) return;
      // The repository filter keeps its focus and caret.
      const active = document.activeElement;
      const filtering = active && active.matches('.js-repo-filter') ? [active.selectionStart, active.selectionEnd] : null;
      // Steps of a transcript the reviewer opened stay open while the run goes on.
      const open = $$('details.js-keep-open[open]').map((d) => d.id);
      main().replaceWith(document.adoptNode(next));
      for (const id of open) {
        const d = document.getElementById(id);
        if (d) d.open = true;
      }
      // The repo tabs live in the header, outside #main, and their counts change too.
      const tabs = $('.app-header-wrap .UnderlineNav');
      const nextTabs = doc.querySelector('.app-header-wrap .UnderlineNav');
      if (tabs && nextTabs) tabs.replaceWith(document.adoptNode(nextTabs));
      document.title = doc.title;
      afterRender();
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

  function afterRender() {
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
    showRepos();
    markActiveTreeItem();
    markLines(false);
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
    codex_started: 'started reviewing',
    codex_failed: 'could not finish its review',
    codex_cancelled: 'stopped reviewing',
    claude_started: 'started reviewing',
    claude_failed: 'could not finish its review',
    claude_cancelled: 'stopped reviewing',
  };
  // What laatsux did on its own on the viewer's behalf, or learned from GitHub: their page has not heard of it.
  const AUTOMATIC = {
    auto_published: 'Published to GitHub with auto-publish',
    auto_publish_failed: 'Auto-publish failed',
    auto_merge_enabled: 'Auto-merge enabled on GitHub',
    auto_merge_failed: 'Enabling auto-merge on GitHub failed',
    merged: 'Merged on GitHub',
    closed_on_github: 'Closed on GitHub',
  };

  // The viewer's own changes that its other tabs show too: a pin moves the pull request on every front page.
  const EVERY_TAB = { pinned: true, unpinned: true };

  const dirty = () => $$('textarea').some((t) => t.value !== t.defaultValue);

  let pending = null;
  function onChange(ev) {
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

  // Live updates. All tabs share one connection through a SharedWorker, since each open
  // EventSource holds one of the browser's six connections to the server.
  function connectLive() {
    const live = document.body.dataset.live;
    if (!live) return;
    const mine = (ev) => live === 'all' || ev.pullId === null || String(ev.pullId) === live;
    // What the server sends: { type, event }, passed on by the worker as it is.
    const hear = (message) => {
      if (message.type === 'reconnected') refresh();
      else if (message.type === 'change' && mine(message.event)) onChange(message.event);
      else if (message.type === 'progress' && mine(message.event)) onProgress(message.event);
    };

    if (window.SharedWorker) {
      try {
        const join = () => {
          // One worker for every tab with this version of it. The name changes when the worker
          // changes what it sends, or a tab could join an older one still open in another tab.
          const worker = new SharedWorker('/static/live-worker.js', { name: 'laatsux-live-2' });
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
          refresh();
        });
        return;
      } catch {
        // Fall through to a connection of our own.
      }
    }

    // Without a SharedWorker, hold a connection only while the tab is visible, and catch
    // up on whatever happened while it was hidden.
    if (!window.EventSource) return;
    let es = null;
    const open = () => {
      if (es) return;
      es = new EventSource(live === 'all' ? '/events' : `/events?pull=${live}`);
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
        refresh();
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
      if (el.type === 'checkbox') body[el.name] = el.checked;
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
      await refresh();
      if (publishing) toast('Published to GitHub');
      else if (target.dataset.toast) toast(target.dataset.toast);
    } catch (err) {
      busy(form, false);
      formError(form, err);
      if (publishing && err.status === 409) {
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

  // ⌘/Ctrl+Enter submits; Escape closes an empty inline form.
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
  function confirmed(btn, prompt = 'Click again to confirm') {
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
      timer: setTimeout(() => {
        armed.delete(btn);
        btn.innerHTML = label;
      }, 3000),
    });
    return false;
  }

  // ---------------------------------------------------------------- files

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
    if (!thread) return;
    const file = thread.closest('.file');
    if (file.classList.contains('is-collapsed') && $('.file-body', file).contains(thread)) {
      userState.collapsed.set(file.dataset.path, false);
      setCollapsed(file, false);
    }
    thread.open = true;
    userState.threads.set(thread.dataset.thread, true);
    thread.scrollIntoView({ block: thread.offsetHeight > innerHeight / 2 ? 'start' : 'center' });
    for (const t of $$('.review-thread.is-flash')) t.classList.remove('is-flash');
    void thread.offsetWidth; // restart the animation
    thread.classList.add('is-flash');
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
      sessionStorage.setItem('laatsux:browse-tree-open', JSON.stringify({ sha: treeState.sha, open: [...treeState.open], at }));
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
      saved = JSON.parse(sessionStorage.getItem('laatsux:browse-tree-open'));
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
      localStorage.setItem('laatsux:browse-tree', hide ? 'hidden' : 'shown');
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
    } else if ((el = on('.js-codex-step'))) {
      stepCodexLimit(el);
    } else if ((el = on('.js-codex-reset'))) {
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
    } else if ((el = on('.js-run-codex'))) {
      el.disabled = true;
      await api('POST', el.dataset.api).catch((err) => toast(err.message));
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
        localStorage.setItem('laatsux:tree-hidden', document.body.classList.contains('tree-hidden') ? '1' : '');
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
  function stepCodexLimit(button) {
    const box = button.closest('.codex-limit');
    const max = Number(box.dataset.max);
    const value = Math.min(max, Math.max(0, Number(box.dataset.limit) + Number(button.dataset.step)));
    box.dataset.limit = String(value);
    $('.js-codex-limit', box).textContent = String(value);
    for (const b of $$('.js-codex-step', box)) b.disabled = Number(b.dataset.step) < 0 ? value <= 0 : value >= max;
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

  // Settings: the effort levels on offer depend on the model.
  document.addEventListener('change', (e) => {
    const model = e.target;
    if (!model.matches || !model.matches('.js-codex-model')) return;
    const option = model.selectedOptions[0];
    const efforts = (option.dataset.efforts || '').split(',').filter(Boolean);
    const effort = $('.js-codex-effort', model.form);
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
  // The front page's repositories: the first few, "Show more" for the rest, and a filter over
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
    let matching = 0;
    for (const item of $$('.repo-list-item', list)) {
      const match = item.dataset.name.toLowerCase().includes(filter);
      item.hidden = !match || matching >= limit;
      if (match) matching++;
    }
    const more = $('.js-repo-more');
    if (more) more.hidden = matching <= limit;
    const none = $('.js-repo-none');
    if (none) none.hidden = matching > 0;
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
  // page knows after each live refresh, so it works while a list page is open in some tab.

  let yourTurn = null; // the pull ids whose turn was yours when the page last rendered

  function notifying() {
    try {
      return !!window.Notification && Notification.permission === 'granted' && localStorage.getItem('laatsux:notify') === '1';
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
    // The server lists them whatever the tab shows: { id, title, url, reasons }.
    const list = $('[data-your-turn]');
    const turns = list ? JSON.parse(list.dataset.yourTurn) : [];
    if (yourTurn && notifying()) {
      for (const t of turns.filter((t) => !yourTurn.has(t.id))) {
        // The tag keeps other tabs showing a list from notifying twice.
        const n = new Notification(`Your turn: ${t.title}`, { body: t.reasons, tag: `laatsux-turn-${t.id}`, icon: '/static/favicon.svg' });
        n.onclick = () => {
          window.focus();
          location.href = t.url;
        };
      }
    }
    yourTurn = new Set(turns.map((t) => t.id));
  }

  document.addEventListener('click', async (e) => {
    const button = e.target.closest && e.target.closest('.js-notify');
    if (!button) return;
    try {
      if (notifying()) localStorage.removeItem('laatsux:notify');
      else if ((await Notification.requestPermission()) === 'granted') localStorage.setItem('laatsux:notify', '1');
    } catch {}
    notifyTurns();
  });

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
    if (localStorage.getItem('laatsux:tree-hidden')) document.body.classList.add('tree-hidden');
    const browseTreeShown = localStorage.getItem('laatsux:browse-tree');
    if (browseTreeShown === 'hidden' || browseTreeShown === 'shown') document.body.classList.add(`browse-tree-${browseTreeShown}`);
  } catch {}
  // Avatars that failed before this script ran.
  for (const img of $$('img[data-fallback]')) if (img.complete && !img.naturalWidth) avatarFallback(img);
  afterRender();
  markLines(true);
  setUpBrowseTree();
  connectLive();
  setInterval(updateTimes, 30_000);
})();
