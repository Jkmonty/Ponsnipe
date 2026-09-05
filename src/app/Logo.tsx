/**
 * Ponsnipe mark: an arrow loosed through a sniper's reticle.
 *
 * The two halves of the name. Robin Hood's weapon is a bow, and a bow held on
 * one target is the same idea as a scope — so the arrow IS the crosshair,
 * entering bottom-left and leaving top-right. The ring is cut where the shaft
 * crosses it, by a mask rather than a dash pattern, so the two gaps land
 * exactly on the arrow instead of wherever the dashes happen to fall.
 *
 * Lincoln green at the nock running to gold at the head: the forest and what
 * he took from it.
 *
 * `id` namespaces the mask and gradient. Two of these on one page with the
 * same ids would have the second silently reuse the first one's defs.
 */
export default function Logo({ size = 28, id = "pn" }: { size?: number; id?: string }) {
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
        <linearGradient id={`${id}-shaft`} x1="7" y1="25" x2="25" y2="7" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="var(--accent-2, #1f9d5c)" />
          <stop offset="100%" stopColor="var(--accent, #f0b429)" />
        </linearGradient>
        <mask id={`${id}-cut`}>
          <rect x="0" y="0" width="32" height="32" fill="#fff" />
          <line x1="4" y1="28" x2="28" y2="4" stroke="#000" strokeWidth="7" strokeLinecap="round" />
        </mask>
      </defs>

      <g mask={`url(#${id}-cut)`}>
        <circle cx="16" cy="16" r="10.5" stroke="currentColor" strokeWidth="2.6" />
        <g stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" opacity="0.75">
          <path d="M16 2v3.4" />
          <path d="M16 26.6V30" />
          <path d="M2 16h3.4" />
          <path d="M26.6 16H30" />
        </g>
      </g>

      <path
        d="M8.4 23.6 L21 11"
        stroke={`url(#${id}-shaft)`}
        strokeWidth="3"
        strokeLinecap="round"
      />
      {/* Broadhead, leaving the ring. */}
      <path d="M28 4 L19.9 6.4 L25.6 12.1 Z" fill="var(--accent, #f0b429)" />
      {/* Fletching, at the nock. */}
      <path d="M4 28 L6.2 20.5 L11.5 25.8 Z" fill="var(--accent-2, #1f9d5c)" />
    </svg>
  );
}
