/**
 * One random helper, in a module that imports nothing.
 *
 * `rand` used to live in scene.ts while scene.ts imported LANES from butts.ts
 * and butts.ts imported rand back — a cycle that was safe only because both
 * bindings were read inside function bodies. A single top-level use would have
 * turned it into a crash at import. A leaf module costs nothing and removes
 * the trap.
 */
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
