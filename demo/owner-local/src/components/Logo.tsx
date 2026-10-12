// "speed / writ" in the SpeedHacks poster's lettering: wide, heavy, italic, sharp inner counters,
// a rounded-rectangle bowl for p/e/d, p's stem dropping below the line, d's stem sweeping up and right.
// The poster face is custom lettering, so each glyph is drawn here as a path (unskewed, baseline y=60,
// x-height 40), then the whole word is sheared into italic. Chrome fill, warm gold rim. No image, no font.

type Glyph = { d: string; w: number };

const G: Record<string, Glyph> = {
  s: {
    w: 66,
    d: "M16 20H66L62 30H18Q14 30 14 33Q14 36 18 36H52Q64 36 64 47Q64 60 50 60H0L4 50H48Q52 50 52 47Q52 45 48 45H14Q2 45 2 33Q2 20 16 20Z",
  },
  p: {
    w: 72,
    d: "M18 20H58Q70 20 70 32V48Q70 60 58 60H17V80H3V33Q3 20 18 20ZM17 31V49H54Q58 49 58 45V35Q58 31 54 31Z",
  },
  e: {
    w: 70,
    d: "M18 20H56Q68 20 68 32V43H16V49H68L64 60H17Q3 60 3 47V33Q3 20 18 20ZM16 30V35H56V30Z",
  },
  d: {
    w: 84,
    d: "M18 20H56L64 -8H80L70 48Q68 60 56 60H17Q3 60 3 47V33Q3 20 18 20ZM17 31V49H52Q56 49 57 45L59 31Z",
  },
  w: {
    w: 92,
    d: "M3 20H17V49H38V20H52V49H73V20H87V48Q87 60 75 60H15Q3 60 3 48Z",
  },
  r: {
    w: 54,
    d: "M3 60V33Q3 20 18 20H54L50 31H17V60Z",
  },
  i: {
    w: 20,
    d: "M3 60V20H17V60ZM3 3H17V13H3Z",
  },
  t: {
    w: 52,
    d: "M10 2H24V20H50L46 31H24V45Q24 49 28 49H50L46 60H24Q10 60 10 47V31H0L4 20H10Z",
  },
};

function Word({ text, x, y, gap = 6 }: { text: string; x: number; y: number; gap?: number }) {
  let cursor = 0;
  const parts = [...text].map((ch, i) => {
    const glyph = G[ch];
    if (!glyph) return null;
    const at = cursor;
    cursor += glyph.w + gap;
    return <path key={i} d={glyph.d} transform={`translate(${at} 0)`} />;
  });
  return <g transform={`translate(${x} ${y})`}>{parts}</g>;
}

export function Logo({ height = 44 }: { height?: number }) {
  return (
    <svg viewBox="0 0 470 184" height={height} role="img" aria-label="speed writ" style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id="sw-chrome" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".22" stopColor="#eef0f3" />
          <stop offset=".44" stopColor="#9aa0a8" />
          <stop offset=".5" stopColor="#5f646c" />
          <stop offset=".56" stopColor="#f6f7f9" />
          <stop offset=".8" stopColor="#c3c7ce" />
          <stop offset="1" stopColor="#ffffff" />
        </linearGradient>
        <linearGradient id="sw-rim" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#8a6424" />
          <stop offset=".45" stopColor="#ffe7a8" />
          <stop offset="1" stopColor="#a87b2e" />
        </linearGradient>
        <filter id="sw-glow" x="-10%" y="-20%" width="120%" height="140%">
          <feDropShadow dx="0" dy="2" stdDeviation="2.4" floodColor="#000000" floodOpacity=".65" />
        </filter>
      </defs>
      <g transform="translate(64 8) skewX(-19) scale(1 1.12)" fill="url(#sw-chrome)" stroke="url(#sw-rim)" strokeWidth={3.4} strokeLinejoin="round" paintOrder="stroke" fillRule="evenodd" filter="url(#sw-glow)">
        <Word text="speed" x={0} y={16} />
        <Word text="writ" x={158} y={86} />
      </g>
    </svg>
  );
}
