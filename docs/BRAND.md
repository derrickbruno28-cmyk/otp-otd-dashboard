# GH Logistics — UI design tokens

Derived from the GH Logistics brand mark: deep navy ground, white type, gold slash accent.
Dark-first — the app's default theme is navy, matching the brand. A light theme is provided
for daytime yard use and for printing the weekly audit.

## Core

| Token | Dark (default) | Light | Use |
|---|---|---|---|
| `--ground` | `#04101F` | `#F4F6F9` | Page background |
| `--surface` | `#0B2140` | `#FFFFFF` | Cards, tables, panels |
| `--surface-2` | `#113058` | `#E7ECF3` | Table headers, inset wells, hover |
| `--ink` | `#EAF0F8` | `#0A1B33` | Primary text |
| `--ink-2` | `#A9BDD6` | `#42546E` | Secondary text |
| `--ink-3` | `#7288A6` | `#6B7D96` | Muted labels |
| `--rule` | `#1B3557` | `#D3DCE7` | Hairlines |
| `--rule-strong` | `#2A4A73` | `#B6C4D5` | Table borders, dividers |
| `--brand` | `#C8A24B` | `#9A7413` | The GH gold — accent, focus rings, active chips |
| `--brand-ink` | `#04101F` | `#FFFFFF` | Text placed on a gold fill |
| `--nav` | `#071A31` | `#0B2140` | App header bar — navy in both themes |

The header bar stays navy in both themes so the product reads as GH at a glance.

## Status

Gold is reserved for the brand accent and for the driver-fault flag. Status colors are
separate and never reused as chart series.

| Token | Dark | Light |
|---|---|---|
| `--ontime` | `#4FB07C` | `#1F7A45` |
| `--late` | `#E0705A` | `#B23A22` |
| `--pending` | `#93A6BC` | `#5C6B7F` |

`--pending` is deliberately a neutral steel, not amber — amber would collide with the gold
that means *driver-flagged*, and those two must never be confusable on a scorecard.

## Chart series

Two-series categorical, validated against the six-check palette validator on both surfaces
(lightness band, chroma floor, CVD separation, normal-vision floor, contrast). Do not
substitute other hues without re-validating.

| Series | Dark (on `#0B2140`) | Light (on `#FFFFFF`) |
|---|---|---|
| Driver-category fail reasons | `#B08C33` | `#9A7413` |
| All other categories | `#4E8FCB` | `#1F5FA8` |

Gold for the driver category is not decorative — it is the same convention as the gold/bold
LS#s in the existing audit, carried into the app.

## Type

Condensed grotesque for headings and metrics, a neutral sans for body, a mono for
identifiers and timestamps. `font-variant-numeric: tabular-nums` on every column of figures —
rates, variances, LS numbers and times all line up or they are harder to scan than the
spreadsheet this replaces.

## Logo

Place the GH Logistics mark in the header at the left, gold slash intact, on the navy bar.
Ask for the SVG; do not trace it from the JPEG.
