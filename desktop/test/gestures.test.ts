// Back and forward in the desktop app's windows: a two-finger swipe sideways, and ⌘← and ⌘→
// (public/gestures.js, run in a VM against stand-ins for the DOM, the wheel events a trackpad or a
// mouse sends as Chromium makes them on a Retina Mac, and a clock of the test's).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';

const SCRIPT = readFileSync(join(import.meta.dirname, '..', '..', 'public', 'gestures.js'), 'utf8');

/** A box on the page, as gestures.js reads it: how it scrolls, and how far it is scrolled. */
interface Box {
  nodeType: 1;
  parentElement: Box | null;
  scrollWidth: number;
  clientWidth: number;
  scrollLeft: number;
  style: { overflowX: string; overscrollBehaviorX: string; direction: string };
  isContentEditable?: boolean;
  matches?: (selector: string) => boolean;
}

function box(o: Partial<Omit<Box, 'style'>> & Partial<Box['style']> = {}): Box {
  const { overflowX = 'visible', overscrollBehaviorX = 'auto', direction = 'ltr', ...rest } = o;
  return { nodeType: 1, parentElement: null, scrollWidth: 1280, clientWidth: 1280, scrollLeft: 0, ...rest, style: { overflowX, overscrollBehaviorX, direction } };
}

/** A form field, which `matches` the way a browser would for the selectors gestures.js asks about. */
function field(tag: 'textarea' | 'input' | 'button', parent: Box, type = 'text'): Box {
  const matches = (selector: string) => (tag === 'textarea' ? /\btextarea\b/.test(selector) : tag === 'input' ? /\binput\b/.test(selector) && !selector.includes(`[type=${type}]`) : false);
  return { ...box({ parentElement: parent }), matches };
}

/** A page running gestures.js, at `dpr` device pixels to the CSS pixel (2 on a Retina Mac, more when zoomed in). */
function page(o: { dpr?: number; canGoBack?: boolean; canGoForward?: boolean } = {}) {
  const dpr = o.dpr ?? 2;
  let now = 1000;
  const timers = new Map<number, { at: number; run: () => void }>();
  let nextTimer = 1;
  const went: string[] = [];
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const listen = (type: string, fn: (e: unknown) => void) => listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  const passive = new Map<string, boolean>();
  const html = box();
  const body = Object.assign(box({ parentElement: html }), { append: (el: Arrow) => (arrow = el) });
  type Arrow = { hidden: boolean; dataset: Record<string, string>; innerHTML: string; classes: Set<string>; vars: Map<string, string> };
  let arrow: Arrow | null = null;
  const navigation = { canGoBack: o.canGoBack ?? true, canGoForward: o.canGoForward ?? true };
  runInNewContext(SCRIPT, {
    window: {
      navigation,
      addEventListener: (type: string, fn: (e: unknown) => void, opts?: { passive?: boolean }) => {
        listen(type, fn);
        passive.set(type, opts?.passive ?? true);
      },
    },
    document: {
      scrollingElement: html,
      documentElement: html,
      body,
      addEventListener: listen,
      createElement: () => {
        const classes = new Set<string>();
        const vars = new Map<string, string>();
        return { hidden: false, dataset: {}, innerHTML: '', classes, vars, classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) }, style: { setProperty: (k: string, v: string) => vars.set(k, v) } };
      },
    },
    history: { back: () => went.push('back'), forward: () => went.push('forward') },
    devicePixelRatio: dpr,
    getComputedStyle: (el: Box) => el.style,
    performance: { now: () => now },
    setTimeout: (run: () => void, ms: number) => {
      timers.set(nextTimer, { at: now + ms, run });
      return nextTimer++;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });

  /** Let `ms` pass, running the timers that come due. */
  function wait(ms: number) {
    const until = now + ms;
    for (let runs = 0; ; runs++) {
      assert.ok(runs < 1000, 'the timers settle');
      const [id, due] = [...timers].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
      if (!due || due.at > until) break;
      timers.delete(id!);
      now = Math.max(now, due.at);
      due.run();
    }
    now = until;
  }

  /**
   * A wheel event over `target` now, a trackpad's unless `more` says otherwise: Chromium makes its
   * wheelDeltaX three times its delta in points, over the device pixels. Says whether the page kept
   * it from scrolling.
   */
  function wheel(deltaX: number, deltaY: number, target: Box = body, more: { ctrlKey?: boolean; momentum?: boolean; wheelDeltaX?: number } = {}) {
    let prevented = false;
    const e = { deltaX, deltaY, deltaMode: 0, ctrlKey: false, momentum: false, wheelDeltaX: Math.trunc((-3 * deltaX) / dpr), ...more, timeStamp: now, target, cancelable: true, preventDefault: () => (prevented = true) };
    for (const fn of listeners.get('wheel') ?? []) fn(e);
    return prevented;
  }

  /**
   * A swipe of `dx` sideways (and `dy` up or down), as a trackpad sends it: an event every 16 ms
   * over `target`. Says whether the page kept every one of them from scrolling, and whether any.
   */
  function swipe(dx: number, o: { target?: Box; steps?: number; dy?: number; during?: (step: number) => void } = {}) {
    const steps = o.steps ?? 10;
    const prevented: boolean[] = [];
    for (let i = 0; i < steps; i++) {
      if (i) wait(16);
      prevented.push(wheel(dx / steps, (o.dy ?? 0) / steps, o.target));
      o.during?.(i);
    }
    return { all: prevented.every(Boolean), any: prevented.some(Boolean) };
  }

  /** The fingers lift, and `steps` events of momentum follow, 16 ms apart, slowing down from `dx`. Says whether the page kept each from scrolling. */
  function fling(dx: number, steps = 30) {
    const prevented: boolean[] = [];
    for (let i = 0; i < steps; i++) {
      wait(16);
      prevented.push(wheel(dx * 0.92 ** i, 0, body, { momentum: true }));
    }
    return { all: prevented.every(Boolean), any: prevented.some(Boolean) };
  }

  function key(key: string, target: Box = body, mods: { metaKey?: boolean; shiftKey?: boolean; altKey?: boolean; ctrlKey?: boolean } = { metaKey: true }) {
    let prevented = false;
    const e = { key, metaKey: false, shiftKey: false, altKey: false, ctrlKey: false, ...mods, target, defaultPrevented: false, preventDefault: () => (prevented = true) };
    for (const fn of listeners.get('keydown') ?? []) fn(e);
    return prevented;
  }

  return {
    went,
    wait,
    wheel,
    swipe,
    fling,
    key,
    body,
    html,
    navigation,
    passive,
    arrow: () => (arrow && !arrow.hidden ? { direction: arrow.dataset.direction, swipe: Number(arrow.vars.get('--swipe')), ready: arrow.classes.has('ready') } : null),
  };
}

test('a two-finger swipe toward the left goes back, with an arrow that comes in as it goes and fills once it is far enough', () => {
  const p = page();
  // Halfway: the arrow comes in from the left, half of the way.
  const first = p.swipe(-75, { steps: 5 });
  assert.ok(first.all, 'the page neither scrolls nor bounces while it swipes');
  assert.deepEqual(p.arrow(), { direction: 'back', swipe: 0.5, ready: false });
  p.wait(16);
  p.swipe(-125, { steps: 5 });
  assert.deepEqual(p.arrow(), { direction: 'back', swipe: 1, ready: true });
  // A slow swipe, held there: it goes when the fingers lift, which with no momentum after them is a pause.
  p.wait(140);
  assert.deepEqual(p.went, [], 'not while the fingers may still move');
  p.wait(10);
  assert.deepEqual(p.went, ['back']);
  assert.equal(p.arrow(), null);
  assert.equal(p.passive.get('wheel'), false, 'the wheel listener can keep the page from scrolling');
});

test('a flick toward the right goes forward as the fingers lift, once, and its momentum does not scroll the page', () => {
  const p = page();
  p.swipe(200, { steps: 4 });
  assert.deepEqual(p.arrow(), { direction: 'forward', swipe: 1, ready: true });
  assert.deepEqual(p.went, []);
  const momentum = p.fling(40, 60);
  assert.deepEqual(p.went, ['forward'], 'at the first event of the momentum');
  assert.ok(momentum.all);
  p.wait(500);
  assert.deepEqual(p.went, ['forward']);
  // The next swipe goes again.
  p.swipe(200);
  p.wait(150);
  assert.deepEqual(p.went, ['forward', 'forward']);
});

test('a swipe the fingers did not take far enough goes nowhere: short, taken back, or carried on only by its momentum', () => {
  const p = page();
  p.swipe(-100);
  p.wait(500);
  assert.deepEqual(p.went, []);
  assert.equal(p.arrow(), null);
  // Far enough, then back the other way.
  p.swipe(-200);
  p.wait(16);
  p.swipe(120, { steps: 3 });
  assert.equal(p.arrow()?.ready, false);
  p.wait(500);
  assert.deepEqual(p.went, []);
  // A short flick, whose momentum would go on far past the threshold.
  p.swipe(-100, { steps: 3 });
  assert.ok(p.fling(-40).all, 'the momentum of a swipe that goes nowhere does not scroll the page either');
  p.wait(500);
  assert.deepEqual(p.went, []);
});

test('fingers that touch down again while the momentum goes on start anew: they scroll, or swipe', () => {
  const p = page();
  // A short flick, whose momentum goes nowhere.
  p.swipe(-50, { steps: 5 });
  p.fling(-5, 3);
  p.wait(16);
  assert.equal(p.wheel(0, 30), false, 'a scroll up or down scrolls');
  p.wait(500);
  p.swipe(-50, { steps: 5 });
  p.fling(-5, 3);
  p.wait(16);
  p.swipe(-200);
  p.wait(150);
  assert.deepEqual(p.went, ['back']);
  // A scroll down coasting, and a swipe sideways in the meantime.
  p.wait(500);
  p.swipe(0, { dy: 300 });
  for (let i = 0; i < 3; i++) {
    p.wait(16);
    assert.equal(p.wheel(0, 20, p.body, { momentum: true }), false);
  }
  p.wait(16);
  assert.ok(p.swipe(-200).all);
  p.wait(150);
  assert.deepEqual(p.went, ['back', 'back']);
});

test('momentum never starts a swipe, also on the page a swipe brought', () => {
  // The page a flick went back to, as its momentum goes on.
  const p = page();
  assert.equal(p.fling(-30, 40).any, false, 'it scrolls as it would');
  p.wait(500);
  assert.deepEqual(p.went, []);
});

test("a mouse's wheel sideways is not a swipe: a tilt or thumb wheel, or Shift with the wheel", () => {
  // A notch is 120 in wheelDeltaX, over the device pixels; faster, the notches come in twos and threes.
  const p = page();
  for (const [deltaX, wheelDeltaX] of [[-40, 60], [-40, 60], [-80, 120], [-120, 180], [-40, 60]]) {
    assert.equal(p.wheel(deltaX, 0, p.body, { wheelDeltaX }), false);
    p.wait(30);
  }
  p.wait(500);
  assert.deepEqual(p.went, []);
  // Zoomed in, 120 over 2.2 device pixels is 54 and a bit.
  const zoomed = page({ dpr: 2.2 });
  for (let i = 0; i < 6; i++) {
    assert.equal(zoomed.wheel(40, 0, zoomed.body, { wheelDeltaX: -54 }), false);
    zoomed.wait(30);
  }
  zoomed.wait(500);
  assert.deepEqual(zoomed.went, []);
  // A trackpad's events of 40 points look like a notch, but only its first event counts.
  p.wheel(-10, 0);
  p.wait(16);
  assert.ok(p.swipe(-200, { steps: 5 }).all);
  p.wait(150);
  assert.deepEqual(p.went, ['back']);
});

test('a swipe over a box that scrolls sideways scrolls it; one that starts at its edge goes back or forward, as Chrome does', () => {
  const p = page();
  // A diff with long lines, scrolled to the middle.
  const diff = box({ parentElement: p.body, overflowX: 'auto', scrollWidth: 2400, clientWidth: 900, scrollLeft: 600 });
  const line = box({ parentElement: diff });
  for (const dx of [-200, 200]) {
    assert.equal(p.swipe(dx, { target: line }).any, false, `${dx}: the diff scrolls`);
    assert.equal(p.arrow(), null);
    p.wait(500);
  }
  // A swipe that reaches the edge as it scrolls the diff keeps scrolling it: what a swipe does is
  // decided as it starts.
  diff.scrollLeft = 40;
  p.swipe(-200, { target: line, during: () => (diff.scrollLeft = 0) });
  p.wait(500);
  assert.deepEqual(p.went, []);
  // At its left edge, the next swipe goes back; toward the right, it scrolls the diff.
  assert.ok(p.swipe(-200, { target: line }).all);
  p.wait(150);
  assert.deepEqual(p.went, ['back']);
  assert.equal(p.swipe(200, { target: line }).any, false);
  p.wait(500);
  // At its right edge, forward.
  diff.scrollLeft = 1500;
  p.swipe(200, { target: line });
  p.wait(150);
  assert.deepEqual(p.went, ['back', 'forward']);
  // A box that could scroll but has nothing more to show, or that hides what overflows, does not count.
  for (const other of [box({ parentElement: p.body, overflowX: 'auto' }), box({ parentElement: p.body, overflowX: 'hidden', scrollWidth: 2400, clientWidth: 900, scrollLeft: 600 })]) {
    p.swipe(-200, { target: other });
    p.wait(150);
  }
  assert.deepEqual(p.went, ['back', 'forward', 'back', 'back']);
});

test('a page scrolled sideways scrolls, unless it hides what overflows; a box right to left counts from its right edge; overscroll-behavior keeps the swipes', () => {
  const p = page();
  Object.assign(p.html, { scrollWidth: 1600, scrollLeft: 100 });
  assert.equal(p.swipe(-200).any, false);
  p.wait(500);
  // Unless it hides what overflows it.
  p.html.style.overflowX = 'hidden';
  assert.ok(p.swipe(-200).all);
  p.wait(150);
  assert.deepEqual(p.went, ['back']);
  p.html.style.overflowX = 'visible';
  Object.assign(p.html, { scrollWidth: 1280, scrollLeft: 0 });
  // Right to left, scrollLeft runs from 0 at the right edge to -1500 at the left one.
  const rtl = box({ parentElement: p.body, overflowX: 'auto', direction: 'rtl', scrollWidth: 2400, clientWidth: 900, scrollLeft: 0 });
  assert.equal(p.swipe(-200, { target: rtl }).any, false, 'at its right edge, it scrolls toward the left');
  p.wait(500);
  assert.ok(p.swipe(200, { target: rtl }).all, 'and not further right: it goes forward');
  p.wait(150);
  assert.deepEqual(p.went, ['back', 'forward']);
  // overscroll-behavior-x on the page, or on a box that scrolls sideways at its edge.
  p.html.style.overscrollBehaviorX = 'none';
  assert.equal(p.swipe(-200).any, false);
  p.wait(500);
  p.html.style.overscrollBehaviorX = 'auto';
  const contained = box({ parentElement: p.body, overflowX: 'auto', overscrollBehaviorX: 'contain', scrollWidth: 2400, clientWidth: 900, scrollLeft: 0 });
  assert.equal(p.swipe(-200, { target: contained }).any, false);
  p.wait(500);
  assert.deepEqual(p.went, ['back', 'forward']);
});

test('a swipe toward a page there is none of scrolls as before', () => {
  const p = page({ canGoBack: false });
  assert.equal(p.swipe(-200).any, false);
  assert.equal(p.arrow(), null);
  p.wait(500);
  assert.ok(p.swipe(200).all);
  p.wait(150);
  assert.deepEqual(p.went, ['forward']);
});

test('scrolling up and down is not a swipe: one that starts so, one more up and down than sideways, and a pinch', () => {
  const p = page();
  assert.equal(p.swipe(-60, { dy: 400 }).any, false);
  p.wait(500);
  // Starts sideways, goes on down: it scrolls from then on.
  assert.equal(p.wheel(-6, 2), true);
  p.wait(16);
  p.swipe(-200, { dy: 300 });
  p.wait(500);
  assert.deepEqual(p.went, []);
  assert.equal(p.swipe(-200).all, true, 'a swipe after it');
  p.wait(500);
  // A pinch to zoom comes as wheel events with ctrlKey.
  for (let i = 0; i < 10; i++) {
    assert.equal(p.wheel(-20, 0, p.body, { ctrlKey: true }), false);
    p.wait(16);
  }
  p.wait(500);
  assert.deepEqual(p.went, ['back']);
});

test('⌘← and ⌘→ go back and forward, but move the caret in a text field', () => {
  const p = page();
  assert.ok(p.key('ArrowLeft'));
  assert.ok(p.key('ArrowRight'));
  assert.deepEqual(p.went, ['back', 'forward']);
  const comment = field('textarea', p.body);
  const title = field('input', p.body);
  const editable = { ...box({ parentElement: p.body }), isContentEditable: true };
  for (const target of [comment, title, editable]) {
    assert.equal(p.key('ArrowLeft', target), false);
    assert.equal(p.key('ArrowRight', target), false);
  }
  // A checkbox and a button have no caret.
  p.key('ArrowLeft', field('input', p.body, 'checkbox'));
  p.key('ArrowLeft', field('button', p.body));
  // Other keys, and ⌘ with Shift (select to the start of the line) or Option.
  p.key('ArrowUp');
  p.key('ArrowLeft', p.body, { metaKey: true, shiftKey: true });
  p.key('ArrowLeft', p.body, { metaKey: true, altKey: true });
  p.key('ArrowLeft', p.body, {});
  assert.deepEqual(p.went, ['back', 'forward', 'back', 'back']);
  // Nowhere to go back to.
  p.navigation.canGoBack = false;
  p.key('ArrowLeft');
  assert.deepEqual(p.went, ['back', 'forward', 'back', 'back']);
});
