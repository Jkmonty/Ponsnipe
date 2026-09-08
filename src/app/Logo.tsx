/**
 * The Ponsnipe mark: the supplied artwork, not a redrawing of it.
 *
 * This used to be an SVG I drew from a description of the real logo. The
 * reasoning was sound as far as it went — a raster with a white background
 * baked in shows its own rectangle on a near-black page — but the supplied
 * PNGs carry genuine alpha, so the problem that argument solved did not exist
 * and the redrawing was never needed.
 *
 * Served as WebP at two sizes rather than the 466x655 original: the mark is
 * drawn at 34-46px, so the original carries roughly two hundred times the
 * pixels any screen asks for. 1.8KB at 1x and 4KB at 2x, down from 328KB.
 *
 * `id` is unused now there are no gradients to namespace. It stays in the
 * signature so call sites do not all have to change for an implementation
 * detail, and so a future SVG version can take it back.
 */
export default function Logo({
  size = 30,
  id: _id = "pn",
}: {
  size?: number;
  id?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/brand/mark.webp"
      srcSet="/brand/mark.webp 1x, /brand/mark@2x.webp 2x"
      width={Math.round(size * (34 / 48))}
      height={size}
      alt="Ponsnipe"
      /* Decoded off the main thread, and never lazy: it is the first thing in
         the header, so deferring it only leaves a hole where the logo goes. */
      decoding="async"
      style={{ display: "block", flex: "none", height: size, width: "auto" }}
    />
  );
}
