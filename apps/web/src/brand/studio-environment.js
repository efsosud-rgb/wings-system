import * as THREE from 'three';

// Ambiente de estúdio gerado por código (HDR): céu claro, linha do horizonte brilhante,
// chão escuro, duas tiras de softbox na frente e contraluzes laranja (marca) e lilás.
// É o que dá o aspecto de cromado ao logo e o brilho acetinado dos gráficos 3D: o horizonte
// e as tiras correm pelas superfícies quando as peças se movem. Devolve um alvo PMREM;
// quem chama faz dispose() dele ao sair.
export function buildStudioEnvironment(renderer, variant = 'light') {
  const dark = variant === 'dark';
  const W = 512;
  const H = 256;
  const data = new Uint16Array(W * H * 4);
  const g = (x, s) => Math.exp(-(x / s) * (x / s));
  const smooth = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const sky0 = dark ? [1.25, 1.25, 1.38] : [1.35, 1.33, 1.3];
  const sky1 = dark ? [0.26, 0.28, 0.46] : [0.8, 0.82, 0.9];
  const gnd0 = dark ? [0.09, 0.075, 0.09] : [0.55, 0.52, 0.5];
  const gnd1 = dark ? [0.006, 0.005, 0.008] : [0.3, 0.29, 0.28];
  const toHalf = THREE.DataUtils.toHalfFloat;
  for (let j = 0; j < H; j++) {
    const e = ((j + 0.5) / H - 0.5) * Math.PI; // elevação
    for (let i = 0; i < W; i++) {
      const phi = ((i + 0.5) / W - 0.5) * 2 * Math.PI;
      const x = Math.cos(phi) * Math.cos(e);
      const z = Math.sin(phi) * Math.cos(e);
      const a = Math.atan2(x, z); // 0 = de frente para o logo (atrás da câmera)
      let r;
      let gg;
      let b;
      if (e >= 0) {
        const t = smooth(0, 0.7, e);
        r = sky0[0] + (sky1[0] - sky0[0]) * t;
        gg = sky0[1] + (sky1[1] - sky0[1]) * t;
        b = sky0[2] + (sky1[2] - sky0[2]) * t;
      } else {
        const t = smooth(0, -0.55, e);
        r = gnd0[0] + (gnd1[0] - gnd0[0]) * t;
        gg = gnd0[1] + (gnd1[1] - gnd0[1]) * t;
        b = gnd0[2] + (gnd1[2] - gnd0[2]) * t;
      }
      const horizon = (dark ? 3.2 : 2.2) * g(e, 0.022);
      const strips =
        (e > -0.35 && e < 0.95 ? 1 : 0) *
        ((dark ? 7 : 5) * g(a - 0.36, 0.045) + (dark ? 4.5 : 3.5) * g(a + 0.52, 0.03));
      const top = (dark ? 2.6 : 2) * smooth(1.0, 1.25, e);
      const orange = (dark ? 5 : 3) * g(a - 1.8, 0.38) * g(e - 0.12, 0.42);
      const lilac = (dark ? 3.6 : 2) * g(a + 1.85, 0.36) * g(e - 0.08, 0.45);
      const w = horizon + strips + top;
      r += w + orange * 1.0 + lilac * 0.42;
      gg += w + orange * 0.36 + lilac * 0.32;
      b += w + orange * 0.12 + lilac * 1.0;
      const k = (j * W + i) * 4;
      data[k] = toHalf(r);
      data[k + 1] = toHalf(gg);
      data[k + 2] = toHalf(b);
      data[k + 3] = toHalf(1);
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const target = pmrem.fromEquirectangular(tex);
  pmrem.dispose();
  tex.dispose();
  return target;
}
