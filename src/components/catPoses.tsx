/**
 * The cat's resting poses, drawn to match the Lottie walk cycle
 * (assets/cat/walk.json): same body, closed happy eyes, whiskers.
 * Same 204×201 frame as the walk sprite, so poses line up when swapping.
 * Fur colours come from the theme (--cat-fur, --cat-shade in styles.css).
 */
const FUR = { fill: "var(--cat-fur)" };
const FUR_LINE = { stroke: "var(--cat-fur)" };
const SHADE_LINE = { stroke: "var(--cat-shade)" };

export function CatSit({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 204 201" aria-hidden="true">
      <path className="tail" d="M66 192 C40 198 16 196 12 180 C9 168 16 160 24 162" fill="none" style={FUR_LINE} strokeWidth="13" strokeLinecap="round"/><path d="M58 190 C50 160 66 132 96 118 C112 104 122 96 140 96 C162 98 170 126 162 152 C158 172 150 192 140 197 L80 199 C66 199 60 196 58 190 Z" style={FUR}/><path d="M126 150 L127 193 M146 148 L148 193" style={FUR_LINE} strokeWidth="13" strokeLinecap="round"/><path d="M120 160 L121 196" style={SHADE_LINE} strokeWidth="1.4" strokeLinecap="round"/><ellipse cx="88" cy="176" rx="34" ry="24" style={FUR}/><g transform="rotate(0 146 72)"><path d="M110 58 L115 32 L134 42 Z" style={FUR}/><path d="M116 52 L118 38 L128 43 Z" fill="#404040"/><path d="M158 41 L177 29 L181 57 Z" style={FUR}/><path d="M164 42 L175 35 L176 50 Z" fill="#404040"/><ellipse cx="146" cy="72" rx="40" ry="36" style={FUR}/><g fill="none" stroke="#000" strokeLinecap="round"><path d="M119 76 Q128 83 138 78" strokeWidth="1.6"/><path d="M156 76 Q166 82 176 73" strokeWidth="1.6"/><path d="M143 85 Q147 89 151 85" strokeWidth="1.6"/><path d="M106 82 L124 85 M108 88 L125 88 M172 81 L190 75 M172 85 L190 82" strokeWidth="0.9"/></g><circle cx="147" cy="82" r="1.6" fill="#000"/></g>
    </svg>
  );
}

export function CatSleep({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 204 201" aria-hidden="true">
      <g className="breathe"><ellipse cx="96" cy="172" rx="78" ry="28" style={FUR}/><path d="M30 178 C22 198 70 199 112 196 C132 195 140 192 146 188" fill="none" style={SHADE_LINE} strokeWidth="16" strokeLinecap="round"/><path d="M30 178 C22 198 70 199 112 196 C132 195 140 192 146 188" fill="none" style={FUR_LINE} strokeWidth="13" strokeLinecap="round"/><g transform="rotate(8 158 160)"><path d="M122 146 L127 120 L146 130 Z" style={FUR}/><path d="M128 140 L130 126 L140 131 Z" fill="#404040"/><path d="M170 129 L189 117 L193 145 Z" style={FUR}/><path d="M176 130 L187 123 L188 138 Z" fill="#404040"/><ellipse cx="158" cy="160" rx="40" ry="36" style={FUR}/><g fill="none" stroke="#000" strokeLinecap="round"><path d="M131 167 Q140 171 150 168" strokeWidth="1.6"/><path d="M168 168 Q178 171 188 166" strokeWidth="1.6"/><path d="M155 173 Q159 177 163 173" strokeWidth="1.6"/><path d="M118 170 L136 173 M120 176 L137 176 M184 169 L202 163 M184 173 L202 170" strokeWidth="0.9"/></g><circle cx="159" cy="170" r="1.6" fill="#000"/></g></g>
    </svg>
  );
}
