import { describe, expect, it } from 'vitest';
import {
  GTM_IDLE_LOAD_MS,
  GTM_READY_WAIT_MS,
  GTM_SCRIPT,
  deferGtm,
  installGtm,
  pushEvent,
} from './gtm.js';

type Listener = () => void;

/** A window and a document with just what the GTM helper touches; time and events are played by hand. */
function fakePage(options: { readyState?: string } = {}) {
  const listeners = new Map<string, Listener[]>();
  const timers: { at: number; fn: Listener; id: number }[] = [];
  const scripts: { src: string; fire: (type: 'load' | 'error') => void }[] = [];
  let now = 0;
  let nextId = 1;
  const w = {
    dataLayer: undefined as unknown[] | undefined,
    addEventListener: (type: string, fn: Listener) =>
      void listeners.set(type, [...(listeners.get(type) ?? []), fn]),
    removeEventListener: (type: string, fn: Listener) =>
      void listeners.set(
        type,
        (listeners.get(type) ?? []).filter((other) => other !== fn),
      ),
    setTimeout: (fn: Listener, delay: number) => {
      const id = nextId++;
      timers.push({ at: now + delay, fn, id });
      return id;
    },
    clearTimeout: (id: number) => {
      const at = timers.findIndex((timer) => timer.id === id);
      if (at >= 0) timers.splice(at, 1);
    },
  } as unknown as Window & typeof globalThis;
  const d = {
    readyState: options.readyState ?? 'loading',
    head: { appendChild: () => {} },
    getElementsByTagName: () => [],
    createElement: () => {
      const handlers = new Map<string, Listener[]>();
      const script = {
        async: false,
        src: '',
        addEventListener: (type: string, fn: Listener) =>
          void handlers.set(type, [...(handlers.get(type) ?? []), fn]),
        fire: (type: 'load' | 'error') => (handlers.get(type) ?? []).forEach((fn) => fn()),
      };
      scripts.push(script);
      return script;
    },
  } as unknown as Document;
  // `head.appendChild` is all the fake needs to "insert" the script
  return {
    w,
    d,
    scripts,
    listenerCount: (type: string) => (listeners.get(type) ?? []).length,
    emit: (type: string) => [...(listeners.get(type) ?? [])].forEach((fn) => fn()),
    advance: (ms: number) => {
      now += ms;
      for (const timer of timers.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)) {
        const at = timers.indexOf(timer);
        if (at < 0) continue;
        timers.splice(at, 1);
        timer.fn();
      }
    },
    layer: () => w.dataLayer ?? [],
  };
}

const events = (layer: unknown[]) =>
  layer.map((entry) => (entry as { event?: string }).event ?? 'other');

describe('installGtm', () => {
  it('pushes gtm.js and adds the script for the container id', () => {
    const page = fakePage();
    const script = installGtm('GTM-TEST', page.w, page.d);
    expect(script?.src).toBe(`${GTM_SCRIPT}?id=GTM-TEST`);
    expect(events(page.layer())).toEqual(['gtm.js']);
  });

  it('with no id loads nothing, and the dataLayer still exists', () => {
    const page = fakePage();
    expect(installGtm(null, page.w, page.d)).toBeNull();
    expect(page.scripts).toHaveLength(0);
    expect(page.layer()).toEqual([]);
  });
});

describe('deferGtm: when GTM loads', () => {
  it('does not load before a first touch or the idle timeout, and the dataLayer queues events', () => {
    const page = fakePage({ readyState: 'complete' });
    deferGtm('GTM-TEST', page.w, page.d);
    page.advance(GTM_IDLE_LOAD_MS - 1);
    expect(page.scripts).toHaveLength(0);
    pushEvent({ event: 'queued' }, page.w);
    expect(events(page.layer())).toEqual(['queued']);
  });

  it.each(['pointerdown', 'touchstart', 'scroll', 'keydown'])('loads on the first %s', (type) => {
    const page = fakePage({ readyState: 'complete' });
    deferGtm('GTM-TEST', page.w, page.d);
    page.emit(type);
    expect(page.scripts).toHaveLength(1);
  });

  it('loads when the caller says so (the focus of a form field)', () => {
    const page = fakePage({ readyState: 'complete' });
    const gtm = deferGtm('GTM-TEST', page.w, page.d);
    gtm.load();
    expect(page.scripts).toHaveLength(1);
  });

  it('loads GTM_IDLE_LOAD_MS after the page load when nothing was touched', () => {
    const page = fakePage();
    deferGtm('GTM-TEST', page.w, page.d);
    page.advance(GTM_IDLE_LOAD_MS * 2); // the clock does not start before `load`
    expect(page.scripts).toHaveLength(0);
    page.emit('load');
    page.advance(GTM_IDLE_LOAD_MS - 1);
    expect(page.scripts).toHaveLength(0);
    page.advance(1);
    expect(page.scripts).toHaveLength(1);
  });

  it('loads once however many touches and timers come, and lets go of its listeners', () => {
    const page = fakePage({ readyState: 'complete' });
    const gtm = deferGtm('GTM-TEST', page.w, page.d);
    page.emit('pointerdown');
    page.emit('pointerdown');
    page.emit('keydown');
    gtm.load();
    page.advance(GTM_IDLE_LOAD_MS * 2);
    expect(page.scripts).toHaveLength(1);
    expect(events(page.layer())).toEqual(['gtm.js']);
    expect(page.listenerCount('pointerdown')).toBe(0);
    expect(page.listenerCount('scroll')).toBe(0);
  });

  it('puts gtm.js ahead of the events that follow the first touch', () => {
    const page = fakePage({ readyState: 'complete' });
    deferGtm('GTM-TEST', page.w, page.d);
    page.emit('pointerdown');
    pushEvent({ event: 'whatsapp_click' }, page.w);
    expect(events(page.layer())).toEqual(['gtm.js', 'whatsapp_click']);
  });

  it('with no id sets up nothing', () => {
    const page = fakePage({ readyState: 'complete' });
    deferGtm(null, page.w, page.d);
    expect(page.listenerCount('pointerdown')).toBe(0);
    page.advance(GTM_IDLE_LOAD_MS * 2);
    expect(page.scripts).toHaveLength(0);
  });
});

describe('deferGtm: conversion events', () => {
  const lead = { event: 'lead_submit', interesse: 'formatacao' };

  it('go straight to the dataLayer once GTM has loaded', () => {
    const page = fakePage({ readyState: 'complete' });
    const gtm = deferGtm('GTM-TEST', page.w, page.d);
    gtm.load();
    page.scripts[0]?.fire('load');
    gtm.pushWhenLoaded(lead);
    expect(events(page.layer())).toEqual(['gtm.js', 'lead_submit']);
  });

  it('load GTM at once when it has not, and go out only after the script loads', () => {
    const page = fakePage({ readyState: 'complete' });
    const gtm = deferGtm('GTM-TEST', page.w, page.d);
    gtm.pushWhenLoaded(lead);
    expect(page.scripts).toHaveLength(1);
    expect(events(page.layer())).toEqual(['gtm.js']);
    page.advance(GTM_READY_WAIT_MS - 1);
    expect(events(page.layer())).toEqual(['gtm.js']);
    page.scripts[0]?.fire('load');
    expect(events(page.layer())).toEqual(['gtm.js', 'lead_submit']);
    page.advance(GTM_READY_WAIT_MS * 2); // the timeout does not push it a second time
    expect(events(page.layer())).toEqual(['gtm.js', 'lead_submit']);
  });

  it('wait at most GTM_READY_WAIT_MS for a GTM that is slow, and still go out', () => {
    const page = fakePage({ readyState: 'complete' });
    const gtm = deferGtm('GTM-TEST', page.w, page.d);
    gtm.pushWhenLoaded(lead);
    page.advance(GTM_READY_WAIT_MS);
    expect(events(page.layer())).toEqual(['gtm.js', 'lead_submit']);
    page.scripts[0]?.fire('load'); // arriving late changes nothing
    expect(events(page.layer())).toEqual(['gtm.js', 'lead_submit']);
  });

  it('go out when the GTM script fails to load', () => {
    const page = fakePage({ readyState: 'complete' });
    const gtm = deferGtm('GTM-TEST', page.w, page.d);
    gtm.pushWhenLoaded(lead);
    page.scripts[0]?.fire('error');
    expect(events(page.layer())).toEqual(['gtm.js', 'lead_submit']);
  });

  it('keep their order while GTM is still loading', () => {
    const page = fakePage({ readyState: 'complete' });
    const gtm = deferGtm('GTM-TEST', page.w, page.d);
    gtm.pushWhenLoaded({ event: 'lead_submit' });
    gtm.pushWhenLoaded({ event: 'whatsapp_click' });
    page.scripts[0]?.fire('load');
    expect(events(page.layer())).toEqual(['gtm.js', 'lead_submit', 'whatsapp_click']);
  });

  it('with no container id go straight to the dataLayer, as before', () => {
    const page = fakePage({ readyState: 'complete' });
    deferGtm(null, page.w, page.d).pushWhenLoaded(lead);
    expect(events(page.layer())).toEqual(['lead_submit']);
  });
});
