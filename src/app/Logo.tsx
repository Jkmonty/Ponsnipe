/**
 * Ponsnipe mark: a P with a scope in it.
 *
 * Drawn rather than dropped in as an image, for two reasons. It has to stay
 * sharp at 32px in the header and at whatever size a favicon or a share card
 * asks for, and the glass needs to sit on this app's near-black surface — a
 * PNG with a baked white edge shows its own rectangle the moment the ground
 * behind it is not white.
 *
 * The glass is three passes, which is what stops it reading as flat grey: a
 * body gradient dark at the foot and bright at the shoulder, a green-tinted
 * rim that only shows where the light rakes across an edge, and one specular
 * highlight across the top-left. Robin Hood's green appears in the rim only —
 * green and red belong to profit and loss everywhere else in this interface,
 * and a mark that borrows them competes with the numbers.
 *
 * The reticle is deliberately coarse. A real scope has fine hairs and every
 * one of them disappears below about 24px, leaving a smudge; these are wide
 * enough to survive the header and the browser tab.
 *
 * `id` namespaces the gradients. Two of these on one page sharing ids would
 * have the second silently reuse the first one's defs.
 */
export default function Logo({ size = 30, id = "pn" }: { size?: number; id?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="Ponsnipe"
      style={{ display: "block", flex: "none" }}
    >
      <defs>
        {/* The body: heavy at the foot, lit at the shoulder. */}
        <linearGradient id={`${id}-body`} x1="6" y1="30" x2="26" y2="2" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#5f6a72" />
          <stop offset="38%" stopColor="#9aa6ac" />
          <stop offset="70%" stopColor="#dfe6e6" />
          <stop offset="100%" stopColor="#ffffff" />
        </linearGradient>
        {/* The rim. Green only where an edge catches the light. */}
        <linearGradient id={`${id}-rim`} x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#eef6ef" />
          <stop offset="45%" stopColor="#9dc4a6" />
          <stop offset="100%" stopColor="#6f9c7c" />
        </linearGradient>
        {/* One highlight, fading out before it reaches the middle. */}
        <linearGradient id={`${id}-gloss`} x1="8" y1="3" x2="18" y2="15" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>

      {/*
        The P as one closed shape: a rounded head, and a leg dropping from its
        bottom-left. No counter — the bowl is solid because the reticle lives
        there, and a hole would leave nothing to cut it into.
      */}
      <path
        d="M4.6 29.4 V8.2
           A5.6 5.6 0 0 1 10.2 2.6
           H21.6
           A5.6 5.6 0 0 1 27.2 8.2
           V14.6
           A5.6 5.6 0 0 1 21.6 20.2
           H12.6
           V29.4
           A0 0 0 0 1 12.6 29.4
           H4.6 Z"
        fill={`url(#${id}-body)`}
        stroke={`url(#${id}-rim)`}
        strokeWidth="1.5"
        strokeLinejoin="round"
      />

      {/* Specular pass, clipped to the top-left shoulder. */}
      <path
        d="M6.1 14.6 V8.4 A4.3 4.3 0 0 1 10.4 4.1 H20 A4.3 4.3 0 0 1 22 4.6 Z"
        fill={`url(#${id}-gloss)`}
      />

      {/* The scope, sitting in the bowl. Ticks stop a clear 1.3 units short of the body on every side. Drawn
          any longer they touch the rim, and the reticle stops reading as
          something sitting inside the letter and starts reading as a crack. */}
      <g stroke="#f4f8f5" strokeWidth="1.5" strokeLinecap="round" fill="none">
        <circle cx="18.8" cy="11.3" r="4.5" strokeWidth="1.6" />
        <path d="M18.8 4.7 V8.3" />
        <path d="M18.8 14.3 V17.9" />
        <path d="M12.2 11.3 H15.8" />
        <path d="M21.8 11.3 H25.4" />
      </g>
      <circle cx="18.8" cy="11.3" r="1.2" fill="#f4f8f5" />
    </svg>
  );
}
