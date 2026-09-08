import { expect, it } from 'vitest'
import { inspectRenderedPages } from './disclosure-browser.mjs'

it('applies the requested key strength on first Day, theme round trips and local-clock changes', async () => {
  const reports = await inspectRenderedPages([
    { name: 'City', path: '/', readySelector: '.hud-investigate', reducedMotion: true },
  ], async ({ evaluate }) => evaluate(`(async () => {
    for (let i = 0; i < 240 && !window.PGSIMCITY; i++) await new Promise(r => setTimeout(r, 50));
    const p = PGSIMCITY;
    p.sim.setKnob('paused', true);
    p.gfx.setQuality('low');
    const read = (stage) => {
      const air = p.themeAtmosphere();
      const key = p.gfx.scene.children.find(o => o.isDirectionalLight &&
        o.position.toArray().every((v, i) => Math.abs(v - air.keyPos[i]) < 1e-6));
      const hemi = p.gfx.scene.children.find(o => o.isHemisphereLight);
      const fill = p.gfx.scene.children.find(o => o.isDirectionalLight && o !== key);
      return { stage, actual: key?.intensity, expected: air.keyIntensity, t: p.sim.state.t,
        night: p.themeMode() === 'night', hemi: hemi?.intensity, fill: fill?.intensity,
        minHemi: air.noBloomHemi, minFill: air.noBloomFill };
    };
    const results = [read('initial')];
    for (const mode of ['night', 'day', 'night', 'clock']) {
      p.setThemeMode(mode, { persist: false });
      results.push(read(mode));
    }
    for (const minutes of [420, 720, 1020, 0]) {
      p.setThemeClockMinutes(minutes);
      results.push(read('clock:' + minutes));
    }
    p.setThemeMode('day', { persist: false });
    results.push(read('return-day'));
    for (const quality of ['high', 'low', 'medium', 'low']) {
      p.gfx.setQuality(quality);
      results.push(read('quality:' + quality));
    }
    p.setThemeMode('night', { persist: false });
    for (const quality of ['low', 'medium', 'high', 'low']) {
      p.gfx.setQuality(quality);
      results.push(read('night-quality:' + quality));
    }
    return results;
  })()`))
  for (const result of reports[0]) {
    expect(result.actual, result.stage).toBeCloseTo(result.expected, 8)
    expect(result.t, result.stage).toBe(reports[0][0].t)
    if (result.night) {
      expect(result.hemi, result.stage + ' matte hemisphere').toBeGreaterThanOrEqual(result.minHemi)
      expect(result.fill, result.stage + ' matte fill').toBeGreaterThanOrEqual(result.minFill)
    }
  }
}, 180_000)
