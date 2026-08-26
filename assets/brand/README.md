# Tonic — logo package

Every file is SVG. The wordmark is drawn as vector paths, not live text, so it
renders identically everywhere with no font dependency and no outlining step.

## The mark

A solid centre dot with three broken concentric rings, gaps rotating
counter-clockwise. The tonic is the root note of a scale; the rings are its
overtones. Also reads as effervescence.

## Palette

    Aqua highlight   #9FEEFF
    Sky              #35B8F6
    Core blue        #1360D6
    Deep navy        #0A2A7E
    Keyline          #08205F
    Flat one-colour  #0E2B72

App icon background gradient: #6D28D9 -> #2563EB -> #0E9AA7 (135 degrees).

## Contents

    01-mark/          mark alone: glossy, flat, reversed
    02-lockups/       mark + wordmark: glossy, flat, reversed, plus reflection
    03-app-icon/      1024px squircle
    04-tray/          22px and 16px system tray, white / black / currentColor

## Which file when

Glossy above roughly 120px wide. Flat below 40px, and for print, embroidery,
and anything single-colour. Reversed on dark backgrounds. The reflection lockup
is marketing only — it uses an SVG mask that Figma imports inconsistently.

`tonic-tray-22-symbolic.svg` uses currentColor for stroke and fill, so it
inherits from the host. Useful for Electron and web trays doing CSS theming.

macOS menu bar wants a template image: black glyph plus alpha, filename ending
in `Template.svg`, with AppKit handling the inversion. Use the black tray file
and rename it. Feeding it the white file gives an invisible icon on a light
menu bar.

## Clear space and minimum sizes

Every viewBox is drawn to the clear-space boundary — 20 units of padding, about
one ring gap — so files can butt against a container edge and the spacing is
already correct.

Mark: 22px minimum, using the tray file (two rings, not three). Below 22px the
three-ring version turns to grey mush.
Full lockup: 120px wide minimum.

## Tray icon construction

The 22px files are pixel-snapped, not scaled down from the display mark:
2px strokes, 2px gaps, 4px centre dot, 1px inset on all four sides. Opacity
tiers are removed — at tray size they render as dirty grey. The 22px version
drops to two rings and moves the gaps to opposite corners for balanced mass.
The 16px version drops to one ring.

For true 1-bit reproduction (laser, screenprint), set the 55% and 78% ring
opacities in the flat files to 100%.

## Alternate tray glyph

`tonic-note-tray-22-white.svg` is a beamed eighth-note tray icon, built in the
same geometric monoline language: circular noteheads, round-capped stems,
upright rather than italic. Same pixel discipline — 6px noteheads, 2px stems,
3px beam.

Beamed eighth notes are standard notation and are not ownable, but they are
also the central element of the Apple Music icon. At 22px in a tray the risk is
low and the construction differs, but if Tonic ships into the same category,
have counsel look at it. The rings mark carries no such question.

Black and currentColor versions are a single hex swap in the file.
