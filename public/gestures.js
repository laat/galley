// Back and forward in the desktop app's windows (desktop/) as in Chrome on macOS, which a browser
// tab has from the browser: a two-finger swipe sideways, with an arrow that comes in with it and
// fills once the swipe is far enough, and ⌘← and ⌘→ outside a text field. app.js loads this in the
// app only. The app's menu has ⌘[ and ⌘], and the three-finger swipe (desktop/main.ts); Chromium
// itself goes back and forward with the mouse's side buttons.
(() => {
  'use strict';

  /** How far a swipe goes, in the wheel's pixels, before it goes back or forward. */
  const THRESHOLD = 150;
  /** A pause in the wheel events this long (ms) ends a swipe, as when the fingers lift with no momentum after them. */
  const QUIET = 150;

  const svg = (path) => `<svg class="octicon" width="24" height="24" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><path d="${path}"></path></svg>`;
  const ARROWS = {
    back: svg('M10.78 19.03a.75.75 0 0 1-1.06 0l-6.25-6.25a.75.75 0 0 1 0-1.06l6.25-6.25a.749.749 0 0 1 1.275.326.749.749 0 0 1-.215.734L5.81 11.5h14.44a.75.75 0 0 1 0 1.5H5.81l4.97 4.97a.75.75 0 0 1 0 1.06Z'),
    forward: svg('M13.22 19.03a.75.75 0 0 1 0-1.06L18.19 13H3.75a.75.75 0 0 1 0-1.5h14.44l-4.97-4.97a.749.749 0 0 1 .326-1.275.749.749 0 0 1 .734.215l6.25 6.25a.75.75 0 0 1 0 1.06l-6.25 6.25a.75.75 0 0 1-1.06 0Z'),
  };

  /** Whether there is a page to go to that way. */
  function canGo(direction) {
    const nav = window.navigation;
    return !nav || (direction === 'back' ? nav.canGoBack : nav.canGoForward);
  }

  function go(direction) {
    if (!canGo(direction)) return;
    if (direction === 'back') history.back();
    else history.forward();
  }

  /**
   * Whether a sideways scroll from `target` scrolls rather than goes back or forward: a box it is in,
   * or the page, can scroll further that way (left for back), or keeps its scrolling to itself
   * (overscroll-behavior, which in Chrome also turns the page's swipes off).
   */
  function scrolls(target, left) {
    const root = document.scrollingElement || document.documentElement;
    for (let el = target && target.nodeType === 1 ? target : root; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      const scroller = el === root ? !['hidden', 'clip'].includes(style.overflowX) : ['auto', 'scroll'].includes(style.overflowX);
      const room = el.scrollWidth - el.clientWidth;
      if (scroller && room >= 1) {
        // From the left edge: in a right-to-left box, scrollLeft runs from 0 down to -room.
        const at = style.direction === 'rtl' ? room + el.scrollLeft : el.scrollLeft;
        if (left ? at >= 1 : at <= room - 1) return true;
      }
      if ((el === root || (scroller && room >= 1)) && style.overscrollBehaviorX !== 'auto') return true;
    }
    return false;
  }

  /**
   * Whether a wheel event comes in whole notches, as a mouse's wheel does: also a tilt or thumb
   * wheel, and Shift with the wheel, which macOS makes sideways. Chromium counts the notches in
   * wheelDeltaX, 120 each, in CSS pixels, and a mouse may send two or three at once. A trackpad's
   * and a Magic Mouse's are their deltas over 40, so an event of theirs within 2 px of 40, 80, …
   * looks like notches too: only a gesture's first event is asked, which is seldom that large.
   * Chrome swipes only with a trackpad or a Magic Mouse, whose events have phases, which a page
   * does not see.
   */
  function notches(e) {
    // wheelDeltaX is a whole number, so zoomed in, a notch can come out a little under 120.
    const ticks = (Math.abs(e.wheelDeltaX) * devicePixelRatio) / 120;
    return Math.round(ticks) >= 1 && Math.abs(ticks - Math.round(ticks)) < 0.05;
  }

  /**
   * A swipe is a run of wheel events with no pause of QUIET in it, and with the fingers on the
   * trackpad from its start: one that comes after momentum touched down again. What it does is
   * decided at its first event, as Chrome latches a scroll to what it starts on: one that starts sideways, where
   * `starts` says it may, goes back (toward the left) or forward. More up and down than sideways,
   * as Chrome counts it, it is a scroll after all. It ends when the fingers lift, which the first
   * event of the momentum after them says (WheelEvent.momentum), or at a pause, and then goes if
   * the fingers took it THRESHOLD that way. Its momentum neither takes it further nor scrolls the
   * page, and never starts a swipe, also on the page it brought.
   */
  function swiper() {
    /** 'idle' between swipes; 'swipe'; 'lifted', its fingers; 'done'; 'scroll', not a swipe. */
    let state = 'idle';
    let lastAt = -Infinity;
    let lastMomentum = false;
    let x = 0;
    let travelY = 0;
    let direction = null;
    const along = () => (direction === 'back' ? -x : x);
    return {
      /** The swipe under way, and how far it has come: 1 is far enough. */
      get direction() {
        return state === 'swipe' ? direction : null;
      },
      get progress() {
        return state === 'swipe' ? Math.max(0, along()) / THRESHOLD : 0;
      },
      /** Takes a wheel event; true when it is a swipe's, and must not scroll the page. */
      wheel(dx, dy, at, momentum, starts) {
        if (at - lastAt >= QUIET || (lastMomentum && !momentum)) {
          state = 'idle';
          x = travelY = 0;
        }
        lastAt = at;
        lastMomentum = momentum;
        if (state === 'scroll') return false;
        if (state === 'lifted' || state === 'done') return true;
        if (momentum) {
          if (state !== 'swipe') {
            state = 'scroll';
            return false;
          }
          state = 'lifted';
          return true;
        }
        x += dx;
        travelY += Math.abs(dy);
        if (state === 'idle') {
          if (Math.abs(dx) <= Math.abs(dy)) {
            if (dx || dy) state = 'scroll';
            return false;
          }
          direction = dx < 0 ? 'back' : 'forward';
          if (!starts(direction)) {
            state = 'scroll';
            return false;
          }
          state = 'swipe';
        }
        if (travelY * 1.3 > Math.abs(x)) {
          state = 'scroll';
          return false;
        }
        return true;
      },
      /** When a pause would end the swipe under way, or null. */
      due() {
        return state === 'swipe' ? lastAt + QUIET : null;
      },
      /** At `now`, where a swipe that ended goes, once; null while one goes on, or goes nowhere. */
      settle(now) {
        if (state !== 'lifted' && !(state === 'swipe' && now >= lastAt + QUIET)) return null;
        state = 'done';
        return along() >= THRESHOLD ? direction : null;
      },
    };
  }

  const swipe = swiper();

  let arrow = null;
  function show() {
    const { direction, progress } = swipe;
    if (!arrow) {
      if (!direction) return;
      arrow = document.createElement('div');
      arrow.className = 'swipe-arrow';
      document.body.append(arrow);
    }
    arrow.hidden = !direction || progress <= 0;
    if (arrow.hidden) return;
    if (arrow.dataset.direction !== direction) {
      arrow.dataset.direction = direction;
      arrow.innerHTML = ARROWS[direction];
    }
    arrow.style.setProperty('--swipe', String(Math.min(progress, 1)));
    arrow.classList.toggle('ready', progress >= 1);
  }

  let timer = null;
  /** Go where a swipe that ended at `now` goes, or look again when a pause would end it. */
  function settle(now) {
    clearTimeout(timer);
    const direction = swipe.settle(now);
    show();
    if (direction) go(direction);
    const due = swipe.due();
    if (due !== null) timer = setTimeout(() => settle(performance.now()), Math.max(0, Math.ceil(due - performance.now())));
  }

  // Not passive: a swipe keeps the page from scrolling, or bouncing at its edge. Chromium's wheel
  // deltas are in pixels; with ctrlKey, the wheel event is a pinch. An event settles at its own
  // time, so that events that waited on a busy page do not end a swipe early.
  window.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.deltaMode !== 0) return;
      const starts = (direction) => !notches(e) && canGo(direction) && !scrolls(e.target, direction === 'back');
      if (swipe.wheel(e.deltaX, e.deltaY, e.timeStamp, e.momentum === true, starts) && e.cancelable) e.preventDefault();
      settle(e.timeStamp);
    },
    { passive: false },
  );

  // ⌘← and ⌘→, which in a text field move the caret instead. Not the menu's: its Back and Forward
  // have one shortcut each, ⌘[ and ⌘].
  const typing = (el) => !!el && (el.isContentEditable || (el.matches && el.matches('textarea, input:not([type=checkbox], [type=radio], [type=button], [type=submit], [type=reset], [type=file], [type=image], [type=color], [type=range])')));
  document.addEventListener('keydown', (e) => {
    if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.defaultPrevented) return;
    if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || typing(e.target)) return;
    e.preventDefault();
    go(e.key === 'ArrowLeft' ? 'back' : 'forward');
  });
})();
