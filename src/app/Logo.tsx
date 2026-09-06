/**
 * Ponsnipe mark: a bow, and an arrow that is also the chart.
 *
 * The arrow's shaft is a price line — it starts red and falling at the nock,
 * turns through amber, and leaves the bow green and climbing. That is the
 * whole product in one shape: Robin Hood's weapon, aimed at a trend.
 *
 * The bow is drawn as two limbs meeting at a riser rather than as one even
 * arc, because a symmetrical crescent reads as a moon at small sizes. The
 * string is a hairline: at 16px anything thicker merges with the limbs.
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
        {/* Loss to profit, along the direction the arrow travels. */}
        <linearGradient id={`${id}-line`} x1="3" y1="28" x2="29" y2="4" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ff4d4d" />
          <stop offset="34%" stopColor="#ff8a3d" />
          <stop offset="62%" stopColor="#8ad42f" />
          <stop offset="100%" stopColor="#5ee02a" />
        </linearGradient>
        {/* Polished steel, lit from the upper left. */}
        <linearGradient id={`${id}-bow`} x1="10" y1="4" x2="24" y2="28" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="45%" stopColor="#c8cedb" />
          <stop offset="100%" stopColor="#8a93a5" />
        </linearGradient>
      </defs>

      {/* Bowstring, behind everything. */}
      <path d="M11.2 4.6 L20.4 27.6" stroke="#6f7688" strokeWidth="0.7" strokeLinecap="round" />

      {/* Upper limb, riser, lower limb — one stroke, recurved at each tip. */}
      <path
        d="M11.2 4.6 C15.6 6.2 19.4 9.4 21.2 13.6 C23.4 18.4 23.2 23.6 20.4 27.6"
        stroke={`url(#${id}-bow)`}
        strokeWidth="2.6"
        strokeLinecap="round"
        fill="none"
      />

      {/* The shaft: a price line, not a straight rod. */}
      <path
        d="M2.6 27.4 L7 22.6 L10 25.2 L15.4 16.4 L18.6 18.6 L26.4 7.2"
        stroke={`url(#${id}-line)`}
        strokeWidth="2.9"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* Broadhead, leaving the bow. */}
      <path d="M29.6 3.4 L21.6 5.6 L27.2 10.4 Z" fill="#5ee02a" />
    </svg>
  );
}
