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

  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const res = await fetch(location.href, { headers: { accept: 'text/html' } });
      if (!res.ok) return;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const next = doc.getElementById('main');
      if (!next) return;
      main().replaceWith(document.adoptNode(next));
      // The repo tabs live in the header, outside #main, and their counts change too.
      const tabs = $('.app-header-wrap .UnderlineNav');
      const nextTabs = doc.querySelector('.app-header-wrap .UnderlineNav');
      if (tabs && nextTabs) tabs.replaceWith(document.adoptNode(nextTabs));
      document.title = doc.title;
      afterRender();
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
  };
  // What laatsux did on its own on the viewer's behalf: their page has not heard of it.
  const AUTOMATIC = {
    auto_published: 'Published to GitHub with auto-publish',
    auto_publish_failed: 'Auto-publish failed',
  };

  const dirty = () => $$('textarea').some((t) => t.value !== t.defaultValue);

  let pending = null;
  function onChange(ev) {
    const own = ev.actor === viewer();
    if (own && ev.type !== 'waiting' && !AUTOMATIC[ev.type]) return; // our own actions refresh after the request
    if (ev.type === 'waiting' && dirty()) return;
    const msg = AUTOMATIC[ev.type] || (DESCRIBE[ev.type] ? `${ev.actor} ${DESCRIBE[ev.type]}` : null);
    clearTimeout(pending);
    pending = setTimeout(() => {
      const active = document.activeElement;
      const typing = active && (active.tagName === 'TEXTAREA' || (active.tagName === 'INPUT' && active.type === 'text')) && active.value;
      if (typing) toast(msg || 'There are updates', { label: 'Refresh', run: refresh });
      else refresh().then(() => msg && toast(msg));
    }, 250);
  }

  // Live updates. All tabs share one connection through a SharedWorker, since each open
  // EventSource holds one of the browser's six connections to the server.
  function connectLive() {
    const live = document.body.dataset.live;
    if (!live) return;
    const mine = (ev) => live === 'all' || ev.pullId === null || String(ev.pullId) === live;

    if (window.SharedWorker) {
      try {
        const join = () => {
          const worker = new SharedWorker('/static/live-worker.js', { name: 'laatsux-live' });
          worker.port.onmessage = (m) => {
            if (m.data.type === 'reconnected') refresh();
            else if (m.data.type === 'change' && mine(m.data.event)) onChange(m.data.event);
          };
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
      es.addEventListener('change', (e) => {
        const ev = JSON.parse(e.data);
        if (mine(ev)) onChange(ev);
      });
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
      // The second click on a Publish button that asked first: publish while a reviewer is at work.
      if (publishing && submitter && submitter.dataset.confirm) body.during_review = true;
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
      // A reviewer started after this page was loaded: ask now, as the page would have.
      if (publishing && err.status === 428 && submitter) {
        submitter.dataset.confirm = 'Click again to publish anyway';
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
        body: JSON.stringify({ text: ta.value, suggestion_lines: holder ? JSON.parse(holder.dataset.suggestion) : undefined }),
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
    } else if ((el = on('.js-codex-step'))) {
      stepCodexLimit(el);
    } else if ((el = on('.js-codex-reset'))) {
      el.disabled = true;
      await api('PATCH', el.dataset.api, { [el.dataset.field]: null }).catch((err) => toast(err.message));
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

  // The Codex review limit of a pull request: each click moves the number at once, and the
  // last value is saved shortly after the clicks stop.
  let limitSave = null;
  function stepCodexLimit(button) {
    const box = button.closest('.codex-limit');
    const max = Number(box.dataset.max);
    const value = Math.min(max, Math.max(0, Number(box.dataset.limit) + Number(button.dataset.step)));
    box.dataset.limit = String(value);
    $('.js-codex-limit', box).textContent = String(value);
    for (const b of $$('.js-codex-step', box)) b.disabled = Number(b.dataset.step) < 0 ? value <= 0 : value >= max;
    clearTimeout(limitSave);
    limitSave = setTimeout(async () => {
      await api('PATCH', box.dataset.api, { max_iterations: value }).catch((err) => toast(err.message));
      refresh();
    }, 500);
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
      `<option value="">Codex default${fallback ? ` (${esc(fallback)})` : ''}</option>` + efforts.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
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

  function updateTimes() {
    for (const el of $$('relative-time')) el.textContent = ago(new Date(el.getAttribute('datetime')));
  }

  // ---------------------------------------------------------------- boot

  try {
    if (localStorage.getItem('laatsux:tree-hidden')) document.body.classList.add('tree-hidden');
  } catch {}
  afterRender();
  markLines(true);
  connectLive();
  setInterval(updateTimes, 30_000);
})();
