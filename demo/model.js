// SilentCKD in-browser scorer: evaluates the exported XGBoost trees and computes exact
// path-dependent TreeSHAP (Lundberg et al., 2018, Algorithm 2). No patient data leaves the device.
(function (root) {
  function leafValue(t, x) {
    let n = 0;
    while (t.f[n] !== -1) {
      const v = x[t.f[n]];
      n = v === null || v === undefined || Number.isNaN(v) ? t.m[n] : Math.fround(v) < t.t[n] ? t.l[n] : t.r[n];
    }
    return t.v[n];
  }

  function margin(model, x) {
    let s = model.base_margin;
    for (const t of model.trees) s += leafValue(t, x);
    return s;
  }

  const sigmoid = (z) => 1 / (1 + Math.exp(-z));

  function extend(m, pz, po, pi) {
    const l = m.length;
    m.push({ d: pi, z: pz, o: po, w: l === 0 ? 1 : 0 });
    for (let i = l - 1; i >= 0; i--) {
      m[i + 1].w += (po * m[i].w * (i + 1)) / (l + 1);
      m[i].w = (pz * m[i].w * (l - i)) / (l + 1);
    }
  }

  function unwind(m, i) {
    const l = m.length - 1;
    let n = m[l].w;
    const { o, z } = m[i];
    for (let j = l - 1; j >= 0; j--) {
      if (o !== 0) {
        const t = m[j].w;
        m[j].w = (n * (l + 1)) / ((j + 1) * o);
        n = t - (m[j].w * z * (l - j)) / (l + 1);
      } else {
        m[j].w = (m[j].w * (l + 1)) / (z * (l - j));
      }
    }
    for (let j = i; j < l; j++) {
      m[j].d = m[j + 1].d;
      m[j].z = m[j + 1].z;
      m[j].o = m[j + 1].o;
    }
    m.pop();
  }

  function unwoundSum(m, i) {
    const l = m.length - 1;
    const { o, z } = m[i];
    let total = 0;
    if (o !== 0) {
      let n = m[l].w;
      for (let j = l - 1; j >= 0; j--) {
        const t = (n * (l + 1)) / ((j + 1) * o);
        total += t;
        n = m[j].w - (t * z * (l - j)) / (l + 1);
      }
    } else {
      for (let j = l - 1; j >= 0; j--) total += (m[j].w * (l + 1)) / (z * (l - j));
    }
    return total;
  }

  function treeShap(t, x, phi) {
    (function recurse(j, parent, pz, po, pi) {
      const m = parent.map((e) => ({ ...e }));
      extend(m, pz, po, pi);
      if (t.f[j] === -1) {
        for (let i = 1; i < m.length; i++) phi[m[i].d] += unwoundSum(m, i) * (m[i].o - m[i].z) * t.v[j];
        return;
      }
      const d = t.f[j];
      const v = x[d];
      const hot = v === null || v === undefined || Number.isNaN(v) ? t.m[j] : Math.fround(v) < t.t[j] ? t.l[j] : t.r[j];
      const cold = hot === t.l[j] ? t.r[j] : t.l[j];
      let iz = 1, io = 1;
      const k = m.findIndex((e, idx) => idx > 0 && e.d === d);
      if (k > 0) {
        iz = m[k].z;
        io = m[k].o;
        unwind(m, k);
      }
      recurse(hot, m, (iz * t.c[hot]) / t.c[j], io, d);
      recurse(cold, m, (iz * t.c[cold]) / t.c[j], 0, d);
    })(0, [], 1, 1, -1);
  }

  function expectedValue(t, j = 0) {
    if (t.f[j] === -1) return t.v[j];
    return (t.c[t.l[j]] * expectedValue(t, t.l[j]) + t.c[t.r[j]] * expectedValue(t, t.r[j])) / t.c[j];
  }

  function explain(model, x) {
    const phi = new Array(model.features.length).fill(0);
    for (const t of model.trees) treeShap(t, x, phi);
    if (model._bias === undefined) model._bias = model.base_margin + model.trees.reduce((s, t) => s + expectedValue(t), 0);
    const z = margin(model, x);
    return { risk: sigmoid(z), margin: z, bias: model._bias, baseline: sigmoid(model._bias), phi };
  }

  // split thresholds are float32 in XGBoost; JSON round-trips them as doubles
  function prepare(model) {
    for (const t of model.trees) t.t = t.t.map(Math.fround);
    return model;
  }

  const api = { prepare, margin, risk: (model, x) => sigmoid(margin(model, x)), explain };
  if (typeof module !== "undefined") module.exports = api;
  else root.SilentCKD = api;
})(this);
