# RIGGED visual spec (binding for render code)

Fantasy: an industrial 1980s arcade cabinet that has become self-aware. NOT: SaaS UI, glassmorphism, purple/blue gradients, glossy cyberpunk, excess neon, Press Start 2P, Undertale.

## Palette
| token | hex | role |
|---|---|---|
| void | #0A0A09 | page bg, hole interiors |
| metal-0 | #16171A | backboard base |
| metal-1 | #25272B | panels, solid area outside chamber |
| metal-2 | #3B3D40 | wall faces, rail, housings |
| metal-3 | #5C5D59 | bevel highlight, rivet highlight |
| grime | #2A251E | stains (20–35% alpha) |
| bone | #D6CFBE | off-white mechanics: bar, stencils, HUD |
| bone-dim | #8E897B | secondary text |
| amber | #C98A2B | warnings, checkpoint, motor lamps |
| amber-dim | #5E4019 | unlit lamps |
| red | #B3302A | death, motor strain only |
| red-dim | #4E1714 | unlit danger lamps |
| rig | #5EE07C | RIG only |
| rig-dim | #227A3C | RIG secondary, corruption trails |
| rig-deep | #0C2614 | RIG panel tint |
| ball | body #C4C8CC, shade #666B71, spec #FFFFFF | the only true white |

Rules: green appears ONLY on things RIG touches. No gradients with > 2 stops. No blue/purple.

## Rendering approach
Pixel art at integer scale: render to a low-res offscreen canvas (1 logical px = PX screen px, PX = 2 normally, 3 on very large canvases) with imageSmoothing off, then blit scaled. Logical canvas size = floor(canvasCss/PX). World→logical scale chosen so the machine (playfield W=600 world units + side rails/motor housings) fills the width. Ball/bar positions rounded to logical px (smooth enough at 60 fps).

## Recipes (logical px)
- Backboard: metal-0, faint vertical brushed lines every 3px (metal-1, 30%), panel seams (1px void + 1px metal-2) every ~110px forming plates, 2x2 rivets every 22px along seams, 6–10 seeded grime blotches per chamber, stamped chamber stencil ("CH-03 // HOURGLASS") in metal-2 with 1px metal-3 emboss.
- Area outside the chamber profile: metal-1 solid plate. Chamber edge stroke ~6px: 1px metal-3 highlight, 4px metal-2, 1px void; rivets every 14px (bone-dim 60%). Islands (dividers) same. Hazard stripe band (amber/void 45°, 4px stripes) along the chamber floor.
- Hole: void disc, 2px bevel (top-left arc metal-3, bottom-right metal-0), inner crescent shadow, tiny stencil id (H07) bone-dim 50% below.
- EXIT (must read in grayscale): ring of 8 bone segments rotating in steps every 125ms; 4 inward chevrons pulsing; stamped "EXIT" above + blinking amber lamp.
- Bar: 4px rail (1px bone top, 2px bone-dim, 1px metal-2), tick notches every 16px, stepped pixel line (no AA).
- Motor housings on left/right side rails, vertical guide rails with rungs; housing 12x18 metal-2, vent slits, gear window animates while moving, amber lamp on while moving, dust pixels; at max tilt: lamp red, housing shakes ±1px, vent puffs.
- Ball: body disc, lower-right shade crescent, 2x2 spec top-left, 1px void outline; trail of 3 ghost dots when fast. Brightest object on screen.
- Death: ball red 2 frames, shrinks into hole in 4 steps, 8 red pixels ring out, hole bevel flashes red, 1-frame horizontal tear.
- Checkpoint: amber lamp column fills bottom→top, amber scanline sweeps the bar, "CHKPT" stamp.

## RIG corruption language
Corruption pixels (rig / rig-dim 1x1) sprinkle onto the target outline during telegraph and stay as residue. Green bracket [ ] around the target, a 3px countdown bar shrinking over telegraphMs.
- SHIFT: hole bevel turns green pixel-by-pixel, dotted rig-dim path + ghost outline at destination, hole jitters then slides.
- PULSE: stacked rig chevrons (>>>) march along the side rails in shove direction; active = full-width 1px rig scanline sweeping.
- CRUSH: wall rivets turn green, rig/void hazard stripes on the wall, wall advances in 1px steps, 1px rig-dim piston line marks max travel.
- MAGNET: green ring around hole, 12 pixels spiral inward (r 30→0, 600ms loop); while active a faint rig-dim line hole↔ball.
- JAM: motor vents turn green, gear freezes/skips, amber+green sparks, lamp blinks green.

## RIG eye (13x7 grid, brackets < >)
States idle / tracking / smug (slit) / annoyed / glitch. Pupil tracks ball x jerkily (every 100ms). Blink every 4–7s.

## Infection by chamber (infection 0..1)
1 clean · 2 residue + 1 green rivet · 3 seams faintly green, stencil glyph occasionally green · 4 green conduit lines creep along seams, idle motor lamps flicker green · 5 MODEL: stencil "MODEL OF <PLAYER>", corruption on walls ~15%, rare distortion frames.

## CRT
Scanlines 10% every 2 device px, vignette to 35% at corners, 1-frame row shift rarely (≥ 20s apart, more in MODEL). No bloom, no blur.
