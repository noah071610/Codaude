"""Build media/ai-icons.woff from src/assets/*.svg.

VS Code can only draw contributed icons from a font, so the two logos are baked
into one PUA font. Run with fontTools installed; the .woff is committed.
"""
import re, sys, pathlib
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.t2CharStringPen import T2CharStringPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path
from fontTools.misc.transform import Transform

ROOT = pathlib.Path(__file__).resolve().parent.parent
# the assets carry a translate/scale flip, which leaves the raw path data y-up in
# a 0..1000 box - the same convention as font units, so only a fit-to-text scale
# is needed here
FIT = Transform().translate(0, -70).scale(0.78)
ICONS = [("claude", 0xE900, "claude.svg"), ("codex", 0xE901, "chatgpt.svg")]

glyphs, metrics, cmap = {".notdef": T2CharStringPen(600, {}).getCharString()}, {".notdef": (600, 0)}, {}
for name, code, file in ICONS:
    d = re.search(r'<path d="(.*?)"', (ROOT / "src/assets" / file).read_text(), re.S).group(1)
    pen = T2CharStringPen(1000, {})
    parse_path(d, TransformPen(pen, FIT))
    glyphs[name], metrics[name], cmap[code] = pen.getCharString(), (1000, 0), name

fb = FontBuilder(1000, isTTF=False)
fb.setupGlyphOrder(list(glyphs))
fb.setupCharacterMap(cmap)
fb.setupCFF("AITrackerIcons", {"FullName": "AI Tracker Icons"}, glyphs, {})
fb.setupHorizontalMetrics(metrics)
fb.setupHorizontalHeader(ascent=800, descent=-200)
fb.setupNameTable({"familyName": "AITrackerIcons", "styleName": "Regular"})
fb.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
fb.setupPost()
fb.font.flavor = "woff"
out = ROOT / "media/ai-icons.woff"
fb.save(out)
print("wrote", out, out.stat().st_size, "bytes")
