Brand artwork, as supplied.

  mark.png       the glass P with the crosshair   (1254x1254, content 438x632)
  wordmark.png   the word "Ponsnipe"              (1254x1254, content 978x186)
  tagline.png    "PRECISION SNIPING. MAXIMUM EDGE." (content 981x28)

The .webp files beside them are generated, not authored. Each source is
trimmed to its content and resized to the height it is actually drawn at, in
1x and 2x. Replacing a source means regenerating them — the originals are
roughly a hundred times the pixels a header ever asks for, and shipping one
directly would cost a third of a megabyte to draw a 40px logo.

Transparent backgrounds matter: the site is near-black, and a white
background baked into the file shows as a rectangle around the mark.

Anything in public/ is served from the site root, so mark.webp here is
/brand/mark.webp in the page.
