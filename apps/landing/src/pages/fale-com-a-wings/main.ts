import './style.css';
import { loadSiteForm, type SiteFormInfo } from '../../lib/api.js';
import { browserBeacon, eventSender, visitIdOf } from '../../lib/events.js';
import { primeInlineFonts } from '../../lib/fonts.js';
import { installGtm, pushEvent } from '../../lib/gtm.js';
import { readRuntimeConfig } from '../../lib/runtime-config.js';
import { captureOrigin, dataLayerOriginOf, trackingPayloadOf } from '../../lib/tracking.js';
import { applyWhatsappUrl } from '../../lib/whatsapp.js';
import { setupForm } from './form.js';
import type { GyroState, PointerState, Scene3d } from './scene.js';

/**
 * "Fale com a Wings" (fale.wingscompany.com.br): the approved landing page
 * (landing v3, Eric), white background only. The form sends the lead to the
 * Wings System (`/public/site-forms/fale-com-a-wings`); the WhatsApp buttons
 * open the tracked link the API answers with, never a number of the page's own.
 */

export const SLUG = 'fale-com-a-wings';

// before anything is laid out, so the first frame already has the brand's fonts
primeInlineFonts(['Limelight', 'Nunito']);

const config = readRuntimeConfig(document, import.meta.env.VITE_LANDING_API_BASE || '/api');
installGtm(config.gtmId);

const doc = document.documentElement;
doc.classList.add('js');
const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarse = (navigator.maxTouchPoints || 0) > 0 && matchMedia('(pointer: coarse)').matches;
const fine = matchMedia('(hover: hover) and (pointer: fine)').matches;
const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const $ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) =>
  r.querySelector<T>(s);
const $$ = <T extends Element = HTMLElement>(s: string, r: ParentNode = document) => [
  ...r.querySelectorAll<T>(s),
];
const must = <T extends Element = HTMLElement>(s: string): T => {
  const el = $<T>(s);
  if (!el) throw new Error(`missing ${s}`);
  return el;
};

/* ---------- social icons: when the font does not load, the name shows ---------- */
const faCheck = () => {
  try {
    if (!document.fonts.check('19px "FA Brands"')) doc.classList.add('no-fa');
  } catch {
    doc.classList.add('no-fa');
  }
};
if (document.fonts && document.fonts.ready) void document.fonts.ready.then(faCheck);
else faCheck();

/* ---------- lead origin: UTMs and click ids, first touch kept ---------- */
const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();
const origin = captureOrigin(location.search, document.referrer || '', storage);

/* ---------- what the visitor does, counted on the server (nothing personal) ---------- */
const session = (() => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
})();
const sendEvent = eventSender({
  apiBase: config.apiBase,
  slug: SLUG,
  visit: visitIdOf(session),
  origin: () => dataLayerOriginOf(origin),
  beacon: browserBeacon(),
});
sendEvent('page_view');

/* ---------- texts revealed word by word ---------- */
function splitWords(el: Element) {
  let i = 0;
  const walk = (node: Node) => {
    [...node.childNodes].forEach((ch) => {
      if (ch.nodeType === 3) {
        const parts = (ch.textContent ?? '').split(/(\s+)/),
          frag = document.createDocumentFragment();
        parts.forEach((p) => {
          if (!p) return;
          if (/^\s+$/.test(p)) {
            frag.appendChild(document.createTextNode(' '));
            return;
          }
          const s = document.createElement('span');
          s.className = 'w';
          s.style.setProperty('--i', String(i++));
          s.textContent = p;
          frag.appendChild(s);
        });
        node.replaceChild(frag, ch);
      } else if (ch.nodeType === 1) walk(ch);
    });
  };
  walk(el);
}
$$('[data-words]').forEach(splitWords);
if (reduce) $$('[data-words]').forEach((el) => el.classList.add('in'));
else {
  const go = () => requestAnimationFrame(() => $('#h1')?.classList.add('in'));
  void (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(go);
  setTimeout(go, 900);
  const io = new IntersectionObserver(
    (es) =>
      es.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      }),
    { rootMargin: '0px 0px -12% 0px' },
  );
  $$('[data-words]').forEach((el) => {
    if (el.id !== 'h1') io.observe(el);
  });
}

/* ---------- back to the form ---------- */
function goToForm() {
  must('#topo').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
  setTimeout(
    () => {
      const f = $<HTMLInputElement>('#f-nome');
      if (f && !f.closest('[hidden]')) f.focus({ preventScroll: true });
    },
    reduce ? 0 : 700,
  );
}

/* ---------- WhatsApp buttons: the API's tracked link, else the form ---------- */
const waButtons = $$<HTMLAnchorElement>('[data-wa]');
let whatsappUrl: string | null = null;
function setWhatsappUrl(url: string | null) {
  whatsappUrl = url;
  waButtons.forEach((a) => {
    if (!a.closest('#thanks')) applyWhatsappUrl(a, url);
  });
}
waButtons.forEach((a) =>
  a.addEventListener('click', (e) => {
    if (a.target === '_blank' && a.href.startsWith('https://')) {
      pushEvent({ event: 'whatsapp_click', origem: dataLayerOriginOf(origin) });
      sendEvent(
        'whatsapp_click',
        a.closest('#thanks') ? 'thanks' : a.closest('header') ? 'header' : 'final',
      );
      return;
    }
    e.preventDefault();
    goToForm();
  }),
);
$$<HTMLAnchorElement>('a[href="#formulario"]').forEach((a) =>
  a.addEventListener('click', (e) => {
    if (a.hasAttribute('data-wa')) return;
    e.preventDefault();
    goToForm();
  }),
);

/* ---------- magnetic buttons and cursor (mouse only) ---------- */
const ptr: PointerState & { px: number; py: number } = {
  x: 0,
  y: 0,
  px: -100,
  py: -100,
  active: false,
  t: 0,
};
const magnets = $$('.magnetic');
const cursor = must('.cursor');
let cx = -100,
  cy = -100;
addEventListener(
  'pointermove',
  (e) => {
    ptr.px = e.clientX;
    ptr.py = e.clientY;
    ptr.x = (e.clientX / innerWidth) * 2 - 1;
    ptr.y = -((e.clientY / innerHeight) * 2 - 1);
    ptr.active = true;
    ptr.t = performance.now();
    if (fine && !reduce) {
      cursor.classList.add('on');
      const target = e.target instanceof Element ? e.target : null;
      cursor.classList.toggle('hot', !!target?.closest('a,button,select,input,label,.tilt'));
      magnets.forEach((m) => {
        if ((m as HTMLButtonElement).disabled) return;
        const r = m.getBoundingClientRect(),
          mx = r.left + r.width / 2,
          my = r.top + r.height / 2;
        const dx = e.clientX - mx,
          dy = e.clientY - my,
          reach = Math.max(r.width, r.height) / 2 + 36;
        if (Math.abs(dx) < reach && Math.abs(dy) < reach * 0.9) {
          m.style.setProperty('--mx', clamp(dx * 0.22, -14, 14).toFixed(1) + 'px');
          m.style.setProperty('--my', clamp(dy * 0.3, -10, 10).toFixed(1) + 'px');
        } else if (m.style.getPropertyValue('--mx')) {
          m.style.removeProperty('--mx');
          m.style.removeProperty('--my');
        }
      });
    }
  },
  { passive: true },
);
addEventListener(
  'pointerdown',
  (e) => {
    if (e.pointerType !== 'mouse') {
      ptr.px = e.clientX;
      ptr.py = e.clientY;
      ptr.x = (e.clientX / innerWidth) * 2 - 1;
      ptr.y = -((e.clientY / innerHeight) * 2 - 1);
      ptr.active = true;
      ptr.t = performance.now();
    }
  },
  { passive: true },
);
document.addEventListener('pointerleave', () => {
  cursor.classList.remove('on');
});

/* ---------- cards with 3D tilt and a glow that follows the mouse ---------- */
$$('.tilt').forEach((c) => {
  if (!fine || reduce) return;
  c.addEventListener('pointermove', (e) => {
    const r = c.getBoundingClientRect(),
      px = (e.clientX - r.left) / r.width,
      py = (e.clientY - r.top) / r.height;
    c.style.setProperty('--ry', ((px - 0.5) * 14).toFixed(2) + 'deg');
    c.style.setProperty('--rx', ((0.5 - py) * 11).toFixed(2) + 'deg');
    c.style.setProperty('--sx', (px * 100).toFixed(1) + '%');
    c.style.setProperty('--sy', (py * 100).toFixed(1) + '%');
  });
  c.addEventListener('pointerleave', () => {
    c.style.setProperty('--rx', '0deg');
    c.style.setProperty('--ry', '0deg');
  });
});

/* ---------- phone gyroscope (only after a tap, as the iPhone requires) ---------- */
interface OrientationEventStatic {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}
const gyro: GyroState & { base: number | null } = { x: 0, y: 0, on: false, base: null };
const motionBtn = must<HTMLButtonElement>('.motion-btn');
if (coarse && !reduce && 'DeviceOrientationEvent' in window) {
  motionBtn.hidden = false;
  motionBtn.addEventListener('click', async () => {
    try {
      const orientation = DeviceOrientationEvent as unknown as OrientationEventStatic;
      if (typeof orientation.requestPermission === 'function') {
        const r = await orientation.requestPermission();
        if (r !== 'granted') throw new Error('negado');
      }
      addEventListener(
        'deviceorientation',
        (e) => {
          if (e.gamma == null || e.beta == null) return;
          if (gyro.base == null) gyro.base = e.beta;
          gyro.x = clamp(e.gamma / 28, -1, 1);
          gyro.y = clamp((e.beta - gyro.base) / 28, -1, 1);
          gyro.on = true;
          $$('.tilt').forEach((c) => {
            c.style.setProperty('--ry', (gyro.x * 9).toFixed(2) + 'deg');
            c.style.setProperty('--rx', (-gyro.y * 7).toFixed(2) + 'deg');
          });
        },
        { passive: true },
      );
      motionBtn.textContent = 'Movimento ligado';
      motionBtn.disabled = true;
    } catch {
      motionBtn.textContent = 'Movimento indisponível';
      motionBtn.disabled = true;
    }
  });
}

/* ---------- the form: the button turns on only with everything filled ---------- */
const form = setupForm({
  slug: SLUG,
  apiBase: config.apiBase,
  reduce,
  tracking: () => trackingPayloadOf(origin),
  whatsappUrl: () => whatsappUrl,
  onSent: (answer, eventId) =>
    pushEvent({
      event: 'lead_submit',
      interesse: answer,
      origem: dataLayerOriginOf(origin),
      ...(eventId ? { event_id: eventId } : {}),
    }),
  onEvent: sendEvent,
});
// the form seen once (a third of it on screen), wherever the visitor stopped before
const leadForm = $('#lead-form');
if (leadForm && 'IntersectionObserver' in window) {
  const seen = new IntersectionObserver(
    (entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      seen.disconnect();
      sendEvent('form_view');
    },
    { threshold: 0.3 },
  );
  seen.observe(leadForm);
}

void loadSiteForm(config.apiBase, SLUG).then((result) => {
  const info: SiteFormInfo | null = result.kind === 'ok' ? result.info : null;
  setWhatsappUrl(info?.whatsappUrl ?? null);
  form.configure(result);
});

/* ---------- native scroll: header, ghost words, bridge and timeline ---------- */
const ghosts = $$('.ghost'),
  bridge = must('.bridge'),
  proc = must('#processo'),
  tl = must('.tl'),
  tlItems = $$('.tl li'),
  aura = must('.aura');
let activeStep = -1;
function domScroll() {
  const vh = innerHeight,
    y = scrollY;
  doc.classList.toggle('scrolled', y > 40);
  if (!reduce) {
    aura.style.setProperty('--aura-y', (-y * 0.04).toFixed(1) + 'px');
    ghosts.forEach((g) => {
      const r = g.parentElement?.getBoundingClientRect();
      if (!r || r.bottom < -200 || r.top > vh + 200) return;
      g.style.setProperty('--gy', ((r.top + r.height / 2 - vh / 2) * -0.22).toFixed(1) + 'px');
    });
    const br = bridge.getBoundingClientRect();
    bridge.style.setProperty('--bp', clamp(1 - Math.abs(br.top - vh / 2) / (vh * 0.5)).toFixed(3));
  }
  const pr = proc.getBoundingClientRect(),
    total = pr.height - vh;
  const p = total > 0 ? clamp(-pr.top / total / 0.86) : pr.top < vh / 2 ? 1 : 0;
  tl.style.setProperty('--p', p.toFixed(4));
  const inProc = pr.top < vh * 0.6 && pr.bottom > vh * 0.4;
  const step = inProc ? Math.min(3, Math.floor(p * 4 + 0.0001)) : -1;
  if (step !== activeStep) {
    activeStep = step;
    tlItems.forEach((li, i) => {
      li.classList.toggle('done', step >= 0 && i < step);
      if (i === step) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
  }
}

/* ---------- 3D scene: loaded after the first paint; .no-gl when it cannot start ---------- */
let scene3d: Scene3d | null = null;
function startScene() {
  import('./scene.js')
    .then(({ createScene }) => {
      scene3d = createScene({
        canvas: must<HTMLCanvasElement>('#gl'),
        reduce,
        coarse,
        pointer: ptr,
        gyro,
        step: () => activeStep,
        sections: $$('[data-form]'),
        brake: new URLSearchParams(location.search).get('freio') !== '0',
      });
      if (!scene3d) doc.classList.add('no-gl');
    })
    .catch(() => doc.classList.add('no-gl'));
}
requestAnimationFrame(() => setTimeout(startScene, 0));

/* ---------- one scroll loop ---------- */
let sRaf = 0;
const onScroll = () => {
  if (sRaf) return;
  sRaf = requestAnimationFrame(() => {
    sRaf = 0;
    domScroll();
    scene3d?.onScroll();
  });
};
addEventListener('scroll', onScroll, { passive: true });
addEventListener('resize', onScroll);
if (document.fonts && document.fonts.ready) {
  void document.fonts.ready.then(() => {
    scene3d?.remeasure();
    domScroll();
  });
}
addEventListener('load', () => {
  scene3d?.remeasure();
  domScroll();
});
domScroll();

/* ---------- cursor that follows with a delay (mouse only) ---------- */
if (fine && !reduce) {
  const loop = () => {
    cx += (ptr.px - cx) * 0.2;
    cy += (ptr.py - cy) * 0.2;
    cursor.style.transform = `translate3d(${cx.toFixed(1)}px,${cy.toFixed(1)}px,0)`;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
