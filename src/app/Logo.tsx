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
          <stop offset="0%" stopColor="#454e55" />
          <stop offset="34%" stopColor="#8b979e" />
          <stop offset="66%" stopColor="#dde5e5" />
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
        d="M5.6 29.6 V8.6
           A6.2 6.2 0 0 1 11.8 2.4
           H20.2
           A6.2 6.2 0 0 1 26.4 8.6
           V15.4
           A6.2 6.2 0 0 1 20.2 21.6
           H13.8
           V29.6
           H5.6 Z"
        fill={`url(#${id}-body)`}
        stroke={`url(#${id}-rim)`}
        strokeWidth="1.6"
        strokeLinejoin="round"
      />

      {/* Specular pass, clipped to the top-left shoulder. */}
      <path
        d="M7.2 15.4 V8.8 A4.8 4.8 0 0 1 12 4 H19.4 A4.8 4.8 0 0 1 21.4 4.5 Z"
        fill={`url(#${id}-gloss)`}
      />

      {/* The scope, sitting in the bowl. Ticks stop a clear 1.3 units short of the body on every side. Drawn
          any longer they touch the rim, and the reticle stops reading as
          something sitting inside the letter and starts reading as a crack. */}
      <g stroke="#f6faf7" strokeWidth="1.55" strokeLinecap="round" fill="none">
        <circle cx="19" cy="11.9" r="4.6" strokeWidth="1.7" />
        <path d="M19 5.1 V8.5" />
        <path d="M19 15.3 V18.7" />
        <path d="M12.2 11.9 H15.6" />
        <path d="M22.4 11.9 H25.8" />
      </g>
      <circle cx="19" cy="11.9" r="1.25" fill="#f6faf7" />
    </svg>
  );
}
