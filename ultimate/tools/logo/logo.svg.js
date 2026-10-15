// The Ganesham app mark: a geometric "G" on a deep-navy tile, with the
// reserved amber carrying the crossbar. White bowl + one amber accent is the
// same two-tone rule as the "Ganesham Teleradiology" wordmark, so the icon and
// the type read as one brand.
//
// Geometry notes, because the numbers are not arbitrary:
//   - The bowl is a STROKE, not a filled outline: one stroke-width controls
//     the whole weight, so the mark stays even when it is resized to 16px.
//   - The bowl opens on the upper right (from `gapDeg` above the horizontal
//     round to the 3 o'clock point), which is what reads as "G" rather than
//     "C" once the bar is added.
//   - The crossbar runs inward from the end of the bowl, and is lighter than
//     the bowl: a bar as thick as the stroke reads as a filled block at 16px.
//   - Round caps: the terminals keep their weight at 16px, where a butt end
//     would read as a hard notch.
module.exports = function svg({
  S = 1024,           // canvas side
  W = 142,            // bowl stroke width
  R = 262,            // bowl radius (to the stroke centreline)
  gapDeg = 48,        // opening, measured up from 3 o'clock
  barW = 96,
  barInset = 60,      // how far short of the centre the bar stops
} = {}) {
  const cx = S / 2, cy = S / 2;
  const a = gapDeg * Math.PI / 180;

  // Start at the upper-right terminal and sweep counter-clockwise (top, left,
  // bottom) back round to 3 o'clock: a large arc, sweep-flag 0 in SVG's
  // y-down space.
  const sx = cx + R * Math.cos(a), sy = cy - R * Math.sin(a);
  const ex = cx + R, ey = cy;
  const f = n => n.toFixed(1);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0"   stop-color="#1B2250"/>
      <stop offset="0.55" stop-color="#0D1231"/>
      <stop offset="1"   stop-color="#070A1C"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.3" cy="0.18" r="0.75">
      <stop offset="0" stop-color="#6558e0" stop-opacity="0.30"/>
      <stop offset="1" stop-color="#6558e0" stop-opacity="0"/>
    </radialGradient>
  </defs>

  <rect x="0" y="0" width="${S}" height="${S}" rx="${Math.round(S * 0.225)}" fill="url(#tile)"/>
  <rect x="0" y="0" width="${S}" height="${S}" rx="${Math.round(S * 0.225)}" fill="url(#glow)"/>

  <g fill="none" stroke-linecap="round">
    <line x1="${f(ex)}" y1="${f(ey)}" x2="${f(cx + barInset)}" y2="${f(ey)}"
          stroke="#f5a524" stroke-width="${barW}"/>
    <path d="M ${f(sx)} ${f(sy)} A ${R} ${R} 0 1 0 ${f(ex)} ${f(ey)}"
          stroke="#F4F5FB" stroke-width="${W}"/>
  </g>
</svg>`;
};
