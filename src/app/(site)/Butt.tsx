import type { ReactNode } from "react";

/**
 * The one motif. Concentric rings in CSS: gold centre, red, blue, dark green,
 * cream. Drawn once, used in the hero with pins, in the range window at three
 * distances, and beside the range page's title.
 *
 * No hooks, so it renders on the server and inside client pages alike.
 */
export default function Butt({
  size,
  className = "",
  children,
}: {
  size?: number;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={`butt ${className}`.trim()}
      style={size ? { width: size, height: size } : undefined}
      aria-hidden="true"
    >
      {children}
    </div>
  );
}
