# Renderer lab

Open `experimental/webgpu/` and select **Start renderer experiment**. This
secondary entry is isolated from the city: visiting the city does not import
the experiment, and visiting the experiment does not initialize a renderer
until requested. The ordinary city remains the supported experience.

The lab renders a frozen warm-state buffer sample from the real simulation,
using the city's tile coordinates and palette. It is a material and backend
study, not a replacement district or a new teaching model. A fresh page uses
the same model seed, camera, sample, resolution policy and light. Select
**Force WebGL2 comparison** before starting to compare the node renderer's
backends. That is not the existing `WebGLRenderer` pipeline.

## Supported and missing

The current pipeline uses `MeshStandardNodeMaterial`, instanced frame columns,
directional shadow mapping, ACES tone mapping and MSAA. The WebGPU renderer
selects its WebGL2 backend when WebGPU is unavailable; initialization failure
keeps navigation back to the supported city visible.

There is no feature parity claim. City architecture, moving mechanisms,
interaction, semantic bloom, water reflection, baked transfer, GTAO, SSGI and
temporal antialiasing are not ported. Existing custom shader materials,
`onBeforeCompile` hooks and `EffectComposer` cannot simply be passed into this
renderer. Their mechanisms need node/TSL equivalents before a default switch.
See the official [migration guide](https://threejs.org/manual/en/webgpurenderer)
and [post-processing guide](https://threejs.org/manual/en/webgpu-postprocessing.html).

## Measurement protocol and adoption gate

The local report includes actual selected backend, first-frame startup time,
one-second presentation-interval windows, full-frame draw counts, triangles,
canvas resolution and the renderer's estimated memory. Presentation intervals
include browser scheduling and CPU work; they are not GPU timestamps. Renderer
memory is not whole-device memory. No hardware identity is collected and no
report is transmitted.

Before considering adoption:

1. Record named desktop and mobile hardware, OS/browser, power state, viewport,
   pixel ratio and selected backend. Keep thermal state and test settings fixed.
2. Capture the same frozen view on both backends. Review semantic colors,
   shadow artifacts, edges and material appearance, not only average FPS.
3. Capture cold startup and at least 30 steady-state report windows after
   shader warmup. Record median and worst windows; repeat after resizing and
   background/foreground transitions. Test unsupported WebGPU and initialization
   failure. Software screenshots prove rendering only, not hardware performance.
4. Add one migrated effect at a time, starting with temporal AA and SSGI;
   measure image stability, ghosting and cost. Do not enable an effect merely
   because an official demo looks good on another scene.
5. Compare against the complete supported city at equivalent quality. Require
   semantic parity, acceptable memory/startup, and useful frame times on named
   devices. 60 fps desktop and 30 fps mobile are targets, not achieved results.

Until that evidence exists, the decision is **no default renderer migration**.
The lab is the operational starting point for issue #17, not its completed
premium-graphics acceptance gate.
