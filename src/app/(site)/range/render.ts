/**
 * The seam between `World` and the browser.
 *
 * `World` used to build a `T.WebGLRenderer` in its own constructor, which
 * meant nothing about it could be constructed in a node test — no WebGL, no
 * canvas, no `document`. Three defects shipped in `World`'s wiring while the
 * decisions they called (`resolveButtHit`, `attractStep`, ...) were
 * correctly tested in isolation, because nothing could drive the class that
 * actually wires those decisions together. `Surface` is the fix: the one
 * place `World` touches a renderer, narrowed to exactly the four calls it
 * makes (`setSize`, `setPixelRatio`, `render`, `dispose`) plus the
 * tone-mapping/shadow settings it never touches directly. `makeSurface`
 * builds the real one; `makeNullSurface` builds one a test can hand to
 * `World` instead.
 */
import * as T from "three";

export interface Surface {
  setSize(w: number, h: number): void;
  setPixelRatio(r: number): void;
  render(scene: T.Scene, camera: T.Camera): void;
  dispose(): void;
  /** The renderer's own shadow configuration, set once in `makeSurface` and
      never touched by `World` directly — so a null surface reports the same
      shape without owning a renderer to configure. */
  readonly shadows: { enabled: boolean; mapSize: number };
}

/** The shadow map's full-resolution size — halved per-light in `world.ts`'s
    `resize()` below `SHADOW_DROP_WIDTH`, which is a different knob (the
    light's own shadow camera) from anything here. */
const SHADOW_MAP_SIZE = 2048;

/**
 * The real surface: a `WebGLRenderer` wrapped down to what `World` needs.
 *
 * Tone mapping and shadow settings live here and only here. `World` never
 * reaches into a renderer to set them, so there is nothing for the null
 * surface below to have to remember to leave out.
 */
export function makeSurface(canvas: HTMLCanvasElement): Surface {
  const renderer = new T.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  // Shadows and a filmic curve. The wood is flat-shaded low-poly, which
  // reads as cardboard under a flat light — the long shadows of a low sun
  // are what give it depth, and ACES stops the warm sun clipping to white
  // where it lands.
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap was removed in this three.js version (0.186); it
  // warned on the console and silently fell back to PCFShadowMap, which is
  // what this now asks for directly.
  renderer.shadowMap.type = T.PCFShadowMap;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  return {
    setSize: (w, h) => renderer.setSize(w, h, false),
    setPixelRatio: (r) => renderer.setPixelRatio(r),
    render: (scene, camera) => renderer.render(scene, camera),
    dispose: () => renderer.dispose(),
    shadows: { enabled: true, mapSize: SHADOW_MAP_SIZE },
  };
}

/**
 * A `Surface` that does nothing: no WebGL, no canvas, no DOM.
 *
 * `setSize` records the last size it was given and nothing more; every
 * other call is a no-op. This is what lets `World` be built in a node test
 * — the acceptance test in `tests/range.test.ts` hands it one directly.
 */
export function makeNullSurface(): Surface {
  let lastSize = { w: 0, h: 0 };
  return {
    setSize: (w, h) => {
      lastSize = { w, h };
    },
    setPixelRatio: () => {},
    render: () => {},
    dispose: () => {},
    shadows: { enabled: true, mapSize: SHADOW_MAP_SIZE },
  };
}
