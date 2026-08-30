#!/usr/bin/env python3
"""Render index.html and zh/index.html from content/*.json.

No template engine and no third-party dependencies — the page structure is
fixed, so it lives here as code, and everything that changes lives in
content/. That keeps the Cloudflare Pages build to a bare `python build.py`
with no requirements.txt to install.

    python build.py            # write index.html and zh/index.html in place
    python build.py --dist     # assemble a deployable dist/ (what Pages runs)
    python build.py --check    # render and diff against what is on disk

content/shared.json holds the spine: ids, order, media paths and the
non-text attributes (which video is the feature, which release gets the
badge). content/en.json and content/zh.json hold every string, keyed by
those same ids, so the two locales stay paired and adding an item is one
edit rather than two.

String values are authored HTML, not escaped text: they may contain <em>,
<strong>, <b>, <span lang="..."> and entities, because the real copy needs
them. Attribute values (urls, alt text, ids) ARE escaped.
"""

from __future__ import annotations

import hashlib
import json
import sys
from html import escape, unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parent
CONTENT = ROOT / "content"

BANNER = (
    "<!-- GENERATED FILE — do not edit by hand.\n"
    "     Source: content/*.json + build.py. Hand edits are lost on the next\n"
    "     build. Edit the JSON (or use the admin at /admin) and re-run\n"
    "     `python build.py`. -->"
)


# ---------------------------------------------------------------- helpers

def asset(rel: str, prefix: str) -> str:
    """`css/styles.css?v=<hash of its contents>`.

    Without this a browser keeps serving the stylesheet it already has, and an
    edit looks like it silently did nothing - new markup wearing old CSS.
    """
    digest = hashlib.sha256((ROOT / rel).read_bytes()).hexdigest()[:8]
    return f"{prefix}{rel}?v={digest}"


def attr(value: str) -> str:
    """Escape a value for use inside a double-quoted HTML attribute."""
    return escape(str(value), quote=True)


def lang_attr(value: str | None) -> str:
    return f' lang="{attr(value)}"' if value else ""


def indent(lines: list[str], by: int) -> list[str]:
    pad = " " * by
    return [pad + line if line else line for line in lines]


# The site is five pages per locale. The homepage carries a trimmed version
# of each section and links through; the other four carry the full thing.
PAGE_FILE = {
    "home": "index.html",
    "music": "music.html",
    "videos": "videos.html",
    "about": "about.html",
    "press": "press.html",
}


ARROW_PREV = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4l-8 8 8 8"/></svg>'
ARROW_NEXT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4l8 8-8 8"/></svg>'

PLAY_SVG = '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>'


# ---------------------------------------------------------------- sections

def render_head(loc: dict, page: str) -> list[str]:
    p = loc["assetPrefix"]
    head = loc["pages"][page]
    rel = PAGE_FILE[page]
    return [
        "<head>",
        '<meta charset="UTF-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
        f'<title>{head["title"]}</title>',
        f'<meta name="description" content="{attr(head["description"])}">',
        "<!-- fonts are self-hosted: fonts.googleapis.com is blocked in mainland China -->",
        f'<link rel="preload" href="{p}fonts/inter-400-latin.woff2" as="font" type="font/woff2" crossorigin>',
        f'<link rel="preload" href="{p}fonts/instrument-serif-400-latin.woff2" as="font" type="font/woff2" crossorigin>',
        f'<link rel="stylesheet" href="{asset("css/styles.css", p)}">',
        # each page points at its own counterpart, not back at the two homepages
        f'<link rel="alternate" hreflang="en" href="/{rel}">',
        f'<link rel="alternate" hreflang="zh-Hans" href="/zh/{rel}">',
        f'<link rel="alternate" hreflang="x-default" href="/{rel}">',
        "<!-- scroll-reveal is a progressive enhancement: without JS the content",
        "     must still be visible, so opt in to the hidden state only when JS runs -->",
        "<script>document.documentElement.classList.add('js');</script>",
        "</head>",
    ]


def render_nav(loc: dict, page: str) -> list[str]:
    """Six evenly spaced slots; CSS orders the wordmark into the middle."""
    nav = loc["nav"]
    mark = "#top" if page == "home" else "index.html"

    def link(l: dict) -> str:
        # the page you are on is marked rather than linked away from
        cur = " is-active" if l["href"] == PAGE_FILE[page] else ""
        aria = ' aria-current="page"' if cur else ""
        slug = l["href"].split(".")[0]
        return (f'    <a href="{attr(l["href"])}"'
                f' class="nav__item nav__item--{slug}{cur}"{aria}>{l["label"]}</a>')

    cta = nav["cta"]
    # contact sits at the foot of every page now, so this stays a local anchor
    cta_href = cta["href"]
    alt = nav["altLang"]
    # the other locale's copy of *this* page, not its homepage
    alt_href = ("zh/" if loc["assetPrefix"] == "" else "../") + PAGE_FILE[page]

    out = [
        "<!-- nav -->",
        '<header class="nav" id="nav">',
        f'  <nav class="nav__links" id="navLinks" aria-label="{attr(nav["ariaPrimary"])}">',
    ]
    out += [link(l) for l in nav["links"]]
    out += [
        "",
        "    <!-- contact and the language switch travel together as one slot -->",
        '    <span class="nav__pair">',
        f'      <a href="{attr(cta_href)}" class="nav__cta">{cta["label"]}</a>',
        f'      <a href="{attr(alt_href)}" class="nav__lang" lang="{attr(alt["lang"])}"'
        f' hreflang="{attr(alt["lang"])}">{alt["label"]}</a>',
        "    </span>",
        "  </nav>",
        "",
        "  <!-- outside .nav__links so it stays in the bar when the menu is a panel -->",
        f'  <a class="nav__mark" href="{mark}">TONY&nbsp;D</a>',
        "",
        "  <!-- shown under 900px, where the link row collapses -->",
        f'  <button class="nav__burger" id="navBurger" aria-expanded="false" aria-controls="navLinks" aria-label="{attr(nav["burgerLabel"])}">',
        "    <span></span><span></span><span></span>",
        "  </button>",
        "</header>",
    ]
    return out


def render_hero(loc: dict, shared: dict) -> list[str]:
    p = loc["assetPrefix"]
    hero = loc["hero"]
    sec = hero["secondary"]
    return [
        "<!-- ================= HERO ================= -->",
        '<section class="hero" id="top">',
        *render_hero_media(loc, shared, hero),
        '  <div class="hero__scrim" aria-hidden="true"></div>',
        '  <div class="hero__enter" aria-hidden="true"></div>',
        "",
        '  <div class="hero__inner">',
        '    <p class="hero__eyebrow">',
        '      <span class="dot" aria-hidden="true"></span>',
        f'      {hero["eyebrow"]}',
        "    </p>",
        "",
        '    <h1 class="hero__title">',
        f'      <span class="sr-only">{hero["srTitle"]}</span>',
        f'      <img class="ink" src="{p}{shared["images"]["ink"]}" alt="" aria-hidden="true">',
        "    </h1>",
        "",
        '    <p class="hero__sub">',
        f'      {hero["sub"]}',
        "    </p>",
        "",
        '    <div class="hero__actions">',
        '      <button class="btn btn--play" id="playBtn" aria-pressed="false">',
        '        <span class="vinyl" aria-hidden="true"></span>',
        # sits over the disc and stays put while it turns: the specular
        # sweep is the light in the room, not something printed on the record
        '        <span class="vinyl__gloss" aria-hidden="true"></span>',
        '        <span class="btn__icon" aria-hidden="true">',
        '          <svg class="i-play" viewBox="0 0 24 24"><path d="M8 5.5v13l11-6.5z"/></svg>',
        '          <svg class="i-pause" viewBox="0 0 24 24"><rect x="7" y="5.5" width="3.4" height="13" rx="1"/><rect x="13.6" y="5.5" width="3.4" height="13" rx="1"/></svg>',
        "        </span>",
        f'        <span class="btn__label">{hero["playLabel"]}</span>',
        "      </button>",
        # Revealed by JS only once a real playlist has loaded — with the
        # synth fallback there is nothing to skip to.
        f'      <button class="btn btn--skip" id="skipBtn" aria-label="{attr(hero["nextLabel"])}" hidden>',
        '        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5.5v13l9-6.5z"/><rect x="16" y="5.5" width="2.6" height="13" rx="1"/></svg>',
        "      </button>",
        f'      <a class="btn btn--ghost" href="{attr(sec["href"])}">{sec["label"]}</a>',
        "    </div>",
        "  </div>",
        "",
        "  <!-- audio-reactive FX stack; see HeroViz in js/main.js -->",
        '  <canvas class="hero__fx hero__fx--glow" id="vizGlow" aria-hidden="true"></canvas>',
        '  <canvas class="hero__fx hero__fx--beam" id="vizBeam" aria-hidden="true"></canvas>',
        '  <canvas class="hero__wave" id="wave" aria-hidden="true"></canvas>',
        '  <div class="hero__flash" id="vizFlash" aria-hidden="true"></div>',
        f'  <p class="hero__note" id="audioNote" data-now="{attr(hero["nowPlaying"])}" hidden></p>',
        "",
        *render_playlist(loc, shared),
        "</section>",
    ]


def render_hero_media(loc: dict, shared: dict, hero: dict) -> list[str]:
    """The portrait, as two planes at different depths.

    One flat photograph is the only thing on the first screen that cannot
    move, and on a page where the grain, the wordmark, the spectrum and
    the ticker all drift, the one still object reads as dead rather than
    as calm. Splitting it lets the near plane and the far plane disagree
    under the cursor, which is what depth is.

    `heroSubject` is him cut out with an alpha channel; `heroPlate` is the
    same frame with him painted out, so there is a real backdrop behind
    the cut-out to slide against — without it the far plane still holds a
    copy of him and the two separate into a double image. Both are
    generated from `hero` by tools/planes.py.

    Falls back to the single flat image if the pair is missing, because
    they are derived assets and a content edit can legitimately point
    `hero` at a new photograph before anyone has run the tool.

    The subject path also rides in as a custom property: the ::before and
    ::after copies that tear him into colour channels on a kick are
    backgrounds, and CSS cannot reach an <img>'s src.
    """
    p = loc["assetPrefix"]
    img = shared["images"]
    plate, subject = img.get("heroPlate"), img.get("heroSubject")

    if not (plate and subject):
        return [
            f'  <div class="hero__media" style="--hero-img:url({attr(p + img["hero"])})">',
            f'    <img class="hero__plane" src="{p}{img["hero"]}"'
            f' alt="{attr(hero["imageAlt"])}" fetchpriority="high">',
            *render_hero_cut(loc, shared),
            "  </div>",
        ]

    return [
        f'  <div class="hero__media" style="--hero-img:url({attr(p + subject)})">',
        # decorative: the backdrop carries no information the alt does not
        f'    <img class="hero__plane hero__plane--far" src="{p}{plate}" alt=""'
        ' aria-hidden="true">',
        f'    <img class="hero__plane hero__plane--near" src="{p}{subject}"'
        f' alt="{attr(hero["imageAlt"])}" fetchpriority="high">',
        *render_hero_cut(loc, shared),
        "  </div>",
    ]


def render_hero_cut(loc: dict, shared: dict) -> list[str]:
    """The frame the hero jump-cuts to on a hard beat.

    One element carrying every frame as a custom property rather than one
    element per frame: JumpCut only ever shows one at a time, and three
    stacked divs would mean three composited layers sitting at opacity 0
    for the whole visit. Which one is live is a `data-f` index the JS
    swaps at the moment of the cut.

    Background images, not <img>: these are decorative, must not be
    announced, and CSS has to be able to swap between them in one
    property write.
    """
    cuts = (shared.get("images") or {}).get("heroCuts") or []
    if not cuts:
        return []
    p = loc["assetPrefix"]
    style = ";".join(
        f"--cut-{i}:url({attr(p + src)})" for i, src in enumerate(cuts)
    )
    return [
        f'    <div class="hero__cut" style="{style}" data-frames="{len(cuts)}"'
        ' data-f="0" aria-hidden="true"></div>',
    ]


def plain(value: str) -> str:
    """Markup out, text in.

    Release titles are written as markup because the page sets the two
    scripts of "Overthinking / 想太多" in different fonts. The player's
    now-playing line is written by JS into textContent, which would print
    the tags, so anything that crosses into the queue comes through here.
    """
    out, depth = [], 0
    for ch in str(value):
        if ch == "<":
            depth += 1
        elif ch == ">":
            depth = max(0, depth - 1)
        elif not depth:
            out.append(ch)
    return unescape("".join(out)).strip()


def render_playlist(loc: dict, shared: dict) -> list[str]:
    """The hero player's queue, as inert JSON the page reads at boot.

    Kept out of main.js on purpose: the file paths and the track titles are
    content, they differ per locale, and the admin already round-trips
    anything it finds in the JSON.

    Each entry may carry `hue`, the stage-light colour for that track
    (degrees on the colour wheel). While playing, AlbumMood cycles the
    portrait through colour, a song-hue gel, silver, and a complementary
    gel (`--print` / `--gel` / `--shift` in js/main.js). It no longer
    reads album chroma — a provisional map bleaching the photo mid-queue
    was the wrong hook.

    The album's NAME only rides along once the mapping is real. While
    `albumMapProvisional` is set, printing "Saturn Diary" under a track
    that is not on Saturn Diary is a false statement about a released
    record, under his name, on his own site.
    """
    tracks = shared.get("tracks") or []
    if not tracks:
        return []

    p = loc["assetPrefix"]
    titles = loc.get("tracks", {})
    named = not shared.get("albumMapProvisional")
    albums = loc.get("releases", {})

    queue = []
    for t in tracks:
        entry = {
            "id": t["id"],
            "src": f'{p}{t["file"]}',
            "title": titles.get(t["id"], {}).get("title", t["id"]),
        }
        hue = t.get("hue")
        if isinstance(hue, (int, float)):
            entry["hue"] = int(hue)
        album = t.get("album")
        if album and named:
            entry["album"] = plain(albums.get(album, {}).get("title", album))
        queue.append(entry)

    # `<` escaped so a title can never close this script element early.
    body = json.dumps(queue, ensure_ascii=False).replace("<", "<")
    return [
        '  <script type="application/json" id="playlist">' + body + "</script>",
    ]


def render_ticker(loc: dict) -> list[str]:
    ticker = loc["ticker"]
    out = [
        "<!-- ================= TICKER ================= -->",
        f'<div class="ticker" id="ticker" aria-label="{attr(ticker["aria"])}">',
        '  <div class="ticker__track" id="tickerTrack">',
        '    <span class="ticker__set">',
    ]
    for item in ticker["items"]:
        out.append(f"      {item} <i>·</i>")
    out += ["    </span>", "  </div>", "</div>"]
    return out


def section_head(loc: dict, key: str, href: str | None = None) -> list[str]:
    """`href` makes the heading itself the way through, with no extra label."""
    sec = loc["sections"][key]
    title = sec["title"]
    if href:
        title = f'<a class="section__link" href="{attr(href)}">{title}</a>'
    return [
        '  <div class="section__head reveal">',
        f'    <span class="section__num">{sec["num"]}</span>',
        f'    <h2 class="section__title">{title}</h2>',
        f'    <p class="section__desc">{sec["desc"]}</p>',
        "  </div>",
    ]


def render_links(links: list[dict], pad: int) -> list[str]:
    out = []
    for link in links:
        if link.get("missing"):
            out.append(" " * pad + f'<a href="#" class="is-missing">{link["label"]}</a>')
        else:
            out.append(
                " " * pad
                + f'<a href="{attr(link["url"])}" target="_blank" rel="noopener">{link["label"]}</a>'
            )
    return out


def render_singles_rail(loc: dict) -> list[str]:
    """The singles as a marquee - the same treatment the awards ticker gets."""
    names = loc["releases"]["singles"]["trackList"]
    out = [
        f'  <h3 class="rail__heading reveal">{loc["singlesHeading"]}</h3>',
        f'  <div class="ticker ticker--inset" aria-label="{attr(loc["railAria"]["singles"])}">',
        '    <div class="ticker__track" id="singlesTrack">',
        '      <span class="ticker__set">',
    ]
    for name in names:
        out.append(f"        <b>{name}</b> <i>&middot;</i>")
    out += ["      </span>", "    </div>", "  </div>"]
    return out


def render_press_rail(loc: dict, shared: dict) -> list[str]:
    """Every press item, looping - the homepage shows them all this way rather
    than listing the first three."""
    out = [
        f'  <div class="rail rail--press" aria-label="{attr(loc["railAria"]["press"])}">',
        '    <div class="rail__track" id="pressRailTrack">',
        '      <span class="rail__set">',
    ]
    for item in shared["press"]:
        c = loc["press"][item["id"]]
        out += [
            f'        <a class="chip" href="{attr(item["url"])}" target="_blank" rel="noopener">',
            f'          <span class="chip__src">{c["src"]}</span>',
            f'          <span class="chip__title"{lang_attr(c.get("titleLang"))}>{c["title"]}</span>',
            "        </a>",
        ]
    out += ["      </span>", "    </div>", "  </div>"]
    return out


def section_cta(href: str, label: str) -> list[str]:
    return ["", '  <p class="section__cta reveal">', f'    <a href="{attr(href)}">{label}</a>', "  </p>"]


def render_sleeve(rel: dict, p: str, alt: str) -> list[str]:
    """The artwork inside a card: one image, or the depth planes of one.

    A release with a `layers` block was cut up by tools/sleeve.py and the
    card composites the pieces - see .sleeve in the stylesheet. Everything
    else, and this release too if the derived files are ever dropped, gets
    the flat artwork it always had.

    The photograph carries the alt text because it is the part a reader is
    being told about; the paper, the pen strokes and the printed badge are
    decoration of it and are hidden from the reader entirely.
    """
    layers = rel.get("layers")
    if not layers:
        return [f'          <img src="{p}{rel["art"]}" alt="{alt}" loading="lazy">']

    out = ['          <span class="sleeve">']
    for key, cls, tail in (
        ("back", "back", ' alt="" aria-hidden="true"'),
        ("near", "near", f' alt="{alt}"'),
        ("mark", "mark", ' alt="" aria-hidden="true"'),
    ):
        # the ink plane is not in this loop: it is a strip of frames, and it
        # needs the wrapper below so the boil and the parallax are not two
        # animations fighting over one transform
        if key == "near":
            out += [
                '            <span class="sleeve__l sleeve__l--ink">',
                f'              <img src="{p}{layers["ink"]}" alt="" aria-hidden="true"'
                f' loading="lazy" style="width:{layers["frames"] * 100}%">',
                "            </span>",
            ]
        out.append(f'            <img class="sleeve__l sleeve__l--{cls}" '
                   f'src="{p}{layers[key]}"{tail} loading="lazy">')
    out.append("          </span>")
    return out


def load_groove() -> dict:
    """content/groove.json if tools/groove.html has ever been run, else {}.

    Optional by design. Without it the record still draws and still seeks —
    the groove is just a smooth spiral instead of the song's own waveform.
    Missing data must never cost the page a feature it could still offer.
    """
    path = CONTENT / "groove.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        print("WARN   content/groove.json is unreadable; the record will draw "
              "a plain spiral. Re-run tools/groove.html.")
        return {}


def render_groove(loc: dict, shared: dict) -> list[str]:
    """The record whose groove IS the waveform of the song playing.

    A spiral from the rim inward, exactly the way a record is actually cut,
    with the loudness of the track pushed into it as sideways wobble — which
    is also what a real groove is. The part behind the needle is lit, the
    part ahead of it is not, so the disc doubles as the progress bar, and
    clicking anywhere on it seeks there.

    It only goes on the homepage because that is the only page that builds
    an AudioEngine (see the boot block in js/main.js). Put a player on
    music.html and this can be called there too, unchanged.

    The envelope is baked by tools/groove.html and read here as inert JSON,
    the same way the hero's queue is. Baking it matters: computing it in the
    browser would mean fetching and decoding the whole MP3 up front, which
    on a site carrying 25MB of audio is the difference between streaming a
    track and downloading it twice.
    """
    tracks = shared.get("tracks") or []
    if not tracks:
        return []

    g = loc.get("groove") or {}
    baked = load_groove()
    have = baked.get("tracks") or {}

    # only the tracks this locale actually queues, and only if baked
    keep = {t["id"]: have[t["id"]] for t in tracks if t["id"] in have}
    data = {"n": baked.get("n", 0), "tracks": keep} if keep else {"n": 0, "tracks": {}}
    body = json.dumps(data, ensure_ascii=False).replace("<", "&lt;")

    return [
        '  <div class="groove reveal" id="groove">',
        # The canvas is the seek control, so it is focusable and reports
        # itself as a slider; the arrow keys step it. Without that the
        # scrubbing would be mouse-only, and the hero's buttons are the
        # only other way to move through a track.
        f'    <canvas class="groove__cv" id="grooveCv" role="slider" tabindex="0"'
        f' aria-label="{attr(g.get("aria", "Seek within the track"))}"'
        ' aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"></canvas>',
        f'    <p class="groove__hint" id="grooveHint">{g.get("idle", "")}</p>',
        '    <script type="application/json" id="grooveData">' + body + "</script>",
        "  </div>",
    ]


def render_music(loc: dict, shared: dict, full: bool = False) -> list[str]:
    p = loc["assetPrefix"]
    lead = " section--lead" if full else ""
    out = [
        "<!-- ================= 01 MUSIC ================= -->",
        f'<section class="section{lead}" id="music">',
    ] + section_head(loc, "music", None if full else "music.html")

    # On the music page the singles run as a marquee and the two albums keep
    # their cards. The homepage keeps all three cards exactly as they were.
    releases = shared["releases"]
    if full:
        out += [""] + render_singles_rail(loc)
        releases = [r for r in releases if r["id"] != "singles"]
    else:
        out += [""] + render_groove(loc, shared)

    out += ["", '  <div class="cards">']

    for i, rel in enumerate(releases):
        c = loc["releases"][rel["id"]]
        if i:
            out.append("")
        out += [
            '    <article class="card reveal" data-tilt>',
            '      <div class="card__art">',
            # The record sits behind the sleeve and slides out on hover. It is
            # drawn entirely in CSS - no extra request, which matters on a site
            # that has to render inside the GFW.
            '        <span class="card__disc" aria-hidden="true"><span class="card__disc-face"></span></span>',
            # the sleeve carries its own clipping so the disc can escape .card__art
            '        <span class="card__sleeve">',
        ]
        out += render_sleeve(rel, p, attr(c["alt"]))
        out += ["        </span>"]
        if rel.get("badge") and c.get("badge"):
            out.append(f'        <span class="card__badge">{c["badge"]}</span>')
        out += [
            "      </div>",
            '      <div class="card__body">',
            f'        <h3 class="card__title"{lang_attr(c.get("titleLang"))}>{c["title"]}</h3>',
            f'        <p class="card__meta">{c["meta"]}</p>',
        ]

        # A release with named tracks gets them as real list items, so each one
        # can be hovered on its own. Only the singles have names to list: the
        # resume PDF gives no track order for either album, and it is the only
        # source, so nothing is invented to fill the gap.
        if c.get("trackList"):
            out.append(f'        <ul class="card__tracks"{lang_attr(c.get("copyLang"))}>')
            for name in c["trackList"]:
                out.append(f"          <li>{name}</li>")
            out.append("        </ul>")
        else:
            out.append(
                f'        <p class="card__copy"{lang_attr(c.get("copyLang"))}>{c["copy"]}</p>'
            )

        out.append('        <div class="card__links">')
        out += render_links(c["links"], 10)
        out += ["        </div>", "      </div>", "    </article>"]

    out.append("  </div>")

    # every listening link the content has, gathered on the page that is about
    # listening - the singles playlist plus the channel playlists
    if full:
        out += ["", '  <div class="playlists reveal">']
        out += render_links(loc["releases"]["singles"]["links"] + loc["playlists"], 4)
        out.append("  </div>")

    out.append("</section>")
    return out


def render_video_tile(loc: dict, shared_v: dict, pad: int, feature: bool) -> list[str]:
    p = loc["assetPrefix"]
    v = loc["videos"][shared_v["id"]]
    bilibili = loc["videoBackend"] == "bilibili"
    pending = bilibili and not shared_v.get("bv")

    cls = "vid vid--feature reveal" if feature else "vid reveal"
    data = ""
    if bilibili:
        data += f' data-bv="{attr(shared_v.get("bv", ""))}"'
    data += f' data-yt="{attr(shared_v["yt"])}"'
    href = f'https://youtu.be/{shared_v["yt"]}'

    s = " " * pad
    if feature:
        out = [
            f'{s}<a class="{cls}"{data}',
            f'{s}   href="{href}" target="_blank" rel="noopener">',
        ]
    else:
        out = [f'{s}<a class="{cls}"{data} href="{href}" target="_blank" rel="noopener">']

    out += [
        f'{s}  <span class="vid__frame">',
        f'{s}    <img class="vid__thumb" src="{p}{shared_v["poster"]}" alt="" loading="lazy">',
        f'{s}    <span class="vid__play" aria-hidden="true">{PLAY_SVG}</span>',
    ]
    if pending and loc.get("videoFlag"):
        flag = loc["videoFlag"]["feature"] if feature else loc["videoFlag"]["default"]
        out.append(f'{s}    <span class="vid__flag">{flag}</span>')
    out += [f'{s}  </span>', f'{s}  <span class="vid__meta">']
    if v.get("kicker"):
        out.append(f'{s}    <span class="vid__kicker">{v["kicker"]}</span>')
    out += [
        f'{s}    <span class="vid__title"{lang_attr(v.get("titleLang"))}>{v["title"]}</span>',
        f'{s}    <span class="vid__sub">{v["sub"]}</span>',
        f'{s}  </span>',
        f'{s}</a>',
    ]
    return out


def render_videos(loc: dict, shared: dict, full: bool = False) -> list[str]:
    lead = " section--lead" if full else ""
    alt = "" if full else " section--alt"
    out = [
        "<!-- ================= 02 VIDEOS ================= -->",
        f'<section class="section{alt}{lead}" id="videos">',
    ] + section_head(loc, "videos", None if full else "videos.html")

    if loc.get("notice") and full:
        n = loc["notice"]
        out += [
            "",
            '  <div class="notice reveal">',
            f'    <p class="notice__title">{n["title"]}</p>',
            f'    <p>{n["body"]}</p>',
            "  </div>",
        ]

    out += [
        "",
        "  <!-- data-yt (or data-bv) drives the click-to-load embed in js/main.js.",
        "       Each tile is a real link first, so with JS off it still reaches the",
        "       video. Posters are self-hosted rather than pulled from i.ytimg.com,",
        "       which is blocked in mainland China. -->",
    ]

    feature = [v for v in shared["videos"] if v.get("feature")]
    grid = [v for v in shared["videos"] if not v.get("feature")]

    for v in feature:
        out += render_video_tile(loc, v, 2, True)

    # The homepage shows the title track and nothing else; the rest of the
    # catalogue lives on videos.html.
    if not full:
        out += section_cta("videos.html", loc["sections"]["videos"]["more"])
        out.append("</section>")
        return out

    out += ["", '  <div class="vids">']
    for i, v in enumerate(grid):
        if i:
            out.append("")
        out += render_video_tile(loc, v, 4, False)
    out.append("  </div>")

    out += ["", '  <div class="playlists reveal">']
    out += render_links(loc["playlists"], 4)
    out += ["  </div>", "</section>"]
    return out


def render_about(loc: dict, shared: dict, full: bool = False) -> list[str]:
    p = loc["assetPrefix"]
    a = loc["about"]
    img = shared["images"]
    lead = " section--lead" if full else ""
    shape = "about--full" if full else "about--brief"
    # one photograph either way, stretched in CSS to start and finish exactly
    # where the column of text does
    photo, alt_key = (img["aboutTop"], "altTop") if full else (img["aboutBottom"], "altBottom")

    out = [
        "<!-- ================= 03 ABOUT ================= -->",
        f'<section class="section{lead}" id="about">',
    ] + section_head(loc, "about", None if full else "about.html") + [
        "",
        f'  <div class="about {shape}">',
        '    <div class="about__media">',
        '      <figure class="about__shot reveal">',
        f'        <img src="{p}{photo}" alt="{attr(a[alt_key])}" loading="lazy">',
        "      </figure>",
        "    </div>",
        "",
        '    <div class="about__prose">',
    ]

    if not full:
        # Homepage: the line he leads with, what shaped him, the bare facts.
        out += [
            '      <blockquote class="quote reveal">',
            f'        <p>{a["quote"]}</p>',
            "      </blockquote>",
            "",
            f'      <h3 class="about__sub reveal">{a["influencesHeading"]}</h3>',
            '      <ul class="tags reveal">',
        ]
        for tag in a["influences"]:
            out.append(f'        <li{lang_attr(tag.get("lang"))}>{tag["label"]}</li>')
        out += [
            "      </ul>",
            "",
            f'      <h3 class="about__sub reveal">{a["profileHeading"]}</h3>',
            '      <dl class="facts reveal">',
        ]
        for fact in a["facts"]:
            out.append(f'        <div><dt>{fact["term"]}</dt><dd>{fact["value"]}</dd></div>')
        out += ["      </dl>", "    </div>", "  </div>", "</section>"]
        return out

    # About page: the long copy.
    for para in a["prose"]:
        out.append(f'      <p class="reveal">{para}</p>')
        out.append("")
    out += [
        '      <blockquote class="quote reveal">',
        f'        <p>{a["quote"]}</p>',
        "      </blockquote>",
        "",
    ]
    for para in a["proseAfterQuote"]:
        out.append(f'      <p class="reveal">{para}</p>')
        out.append("")
    out += ["    </div>", "  </div>", "</section>"]
    return out


def render_milestones(loc: dict, shared: dict, full: bool = False) -> list[str]:
    # newest first either way: the whole run on the about page, the last three
    # fading out on the homepage
    rows = list(reversed(shared["milestones"] if full else shared["milestones"][-3:]))
    out = [
        "<!-- ================= 04 MILESTONES ================= -->",
        '<section class="section section--alt" id="milestones">',
    ] + section_head(loc, "milestones", None if full else "about.html#milestones") + [
        "", f'  <ol class="tl{"" if full else " tl--brief"}">'
    ]

    for i, row in enumerate(rows):
        if i:
            out.append("")
        year_cls = "tl__year tl__year--now" if row.get("current") else "tl__year"
        out += [
            '    <li class="tl__row reveal">',
            f'      <h3 class="{year_cls}">{row["year"]}</h3>',
            '      <ul class="tl__list">',
        ]
        for item_id in row["items"]:
            out.append(f'        <li>{loc["milestones"][item_id]}</li>')
        out += ["      </ul>", "    </li>"]

    out.append("  </ol>")
    if not full:
        out += section_cta("about.html#milestones", loc["sections"]["milestones"]["more"])
    out.append("</section>")
    return out


def render_press(loc: dict, shared: dict, full: bool = False) -> list[str]:
    lead = " section--lead" if full else ""
    out = [
        "<!-- ================= 05 PRESS ================= -->",
        f'<section class="section{lead}" id="press">',
    ] + section_head(loc, "press", None if full else "press.html")

    # the homepage runs the whole lot past as a marquee rather than listing a few
    if not full:
        out += [""] + render_press_rail(loc, shared)
        out.append("</section>")
        return out

    p = loc["assetPrefix"]
    a = loc["about"]
    nav = loc["pressNav"]
    out += [
        "",
        "  <!-- Four items are in view at a time, two either side of the photograph,",
        "       and the arrows step that window along. Every item is in the markup:",
        "       without JS this stays a plain grid of all of them and the arrows are",
        "       never shown. -->",
        '  <div class="press-stage" id="pressStage">',
        f'    <button class="press-arrow press-arrow--prev" type="button" aria-label="{attr(nav["prev"])}">{ARROW_PREV}</button>',
        "",
        '    <figure class="press-stage__media about__shot about__shot--wide reveal">',
        f'      <img src="{p}{shared["images"]["aboutWide"]}" alt="{attr(a["altWide"])}" loading="lazy">',
        f'      <figcaption>{a["captionWide"]}</figcaption>',
        "    </figure>",
        "",
        '    <ul class="press press--stage">',
    ]
    for item in shared["press"]:
        c = loc["press"][item["id"]]
        out += [
            '      <li class="press__item reveal">',
            f'        <a href="{attr(item["url"])}" target="_blank" rel="noopener">',
            f'          <span class="press__src">{c["src"]}</span>',
            f'          <span class="press__title"{lang_attr(c.get("titleLang"))}>{c["title"]}</span>',
            f'          <span class="press__gloss">{c["gloss"]}</span>',
            "        </a>",
            "      </li>",
        ]

    out += [
        "    </ul>",
        "",
        f'    <button class="press-arrow press-arrow--next" type="button" aria-label="{attr(nav["next"])}">{ARROW_NEXT}</button>',
        "  </div>",
        "</section>",
    ]
    return out


def render_contact(loc: dict, shared: dict) -> list[str]:
    c = loc["contact"]
    sec = loc["sections"]["contact"]
    email = shared["contactEmail"]
    out = [
        "<!-- ================= 06 CONTACT ================= -->",
        '<section class="section section--alt" id="contact">',
        '  <div class="contact">',
        '    <div class="contact__lead reveal">',
        f'      <span class="section__num">{sec["num"]}</span>',
        f'      <h2 class="section__title">{sec["title"]}</h2>',
        f'      <p class="section__desc">{sec["desc"]}</p>',
        f'      <a class="btn btn--play contact__mail" href="mailto:{attr(email)}">{email}</a>',
        f'      <p class="contact__who">{c["who"]}</p>',
        "    </div>",
        "",
        '    <div class="contact__grid reveal">',
    ]
    for col in c["columns"]:
        out += [
            '      <div class="contact__col">',
            f'        <h3>{col["heading"]}</h3>',
            "        <ul>",
        ]
        for item in col["items"]:
            muted = ""
            if item.get("muted"):
                # mutedTight drops the leading space — correct after a full-width
                # bracket in CJK, where the punctuation already carries the gap.
                gap = "" if item.get("mutedTight") else " "
                muted = f'{gap}<span class="muted">{item["muted"]}</span>'
            if item.get("url"):
                out.append(
                    f'          <li><a href="{attr(item["url"])}" target="_blank" '
                    f'rel="noopener">{item["label"]}</a>{muted}</li>'
                )
            else:
                out.append(f'          <li>{item["label"]}{muted}</li>')
        out += ["        </ul>", "      </div>"]

    out += ["    </div>", "  </div>", "</section>"]
    return out


def render_footer(loc: dict, shared: dict) -> list[str]:
    f = loc["footer"]
    return [
        '<footer class="foot">',
        "  <p>",
        f'    <span>&copy; <span id="year">{shared["copyrightYear"]}</span> {f["copyright"]}</span>',
        f'    <a href="#top">{f["backToTop"]}</a>',
        "  </p>",
        "</footer>",
    ]


# ---------------------------------------------------------------- page

def render_page(loc: dict, shared: dict, page: str) -> str:
    p = loc["assetPrefix"]
    html_attrs = f' lang="{attr(loc["lang"])}"'
    lines = ["<!DOCTYPE html>", BANNER]

    if loc["videoBackend"] == "bilibili":
        lines += [
            '<!-- data-video="bilibili" tells VideoFacade to embed Bilibili rather than',
            "     YouTube on this page. Tiles whose data-bv is still empty stay ordinary",
            "     outbound links instead of becoming players that cannot load in China. -->",
        ]
        html_attrs += ' data-video="bilibili"'

    lines.append(f"<html{html_attrs}>")
    lines += render_head(loc, page)

    # the skip link has to name a section that exists on this page
    first = "music" if page == "home" else page
    lines += ["<body>", "", "<!-- film grain overlay, and the light that follows the pointer -->",
              '<div class="grain" aria-hidden="true"></div>',
              '<div class="glow" aria-hidden="true"></div>', "",
              f'<a class="skip" href="#{first}">{loc["nav"]["skip"]}</a>', ""]

    # The homepage hangs #top on the hero. Pages with no hero still carry the
    # footer's back-to-top link, so they need a target of their own.
    if page != "home":
        lines += ['<span id="top" aria-hidden="true"></span>', ""]

    if page == "home":
        # a trimmed version of each section, every heading a way through
        blocks = [
            render_nav(loc, page),
            render_hero(loc, shared),
            # sits straight after the hero, and the hero is sized so this lands
            # at the foot of the first screen rather than below it
            render_ticker(loc),
            render_music(loc, shared),
            render_videos(loc, shared),
            render_about(loc, shared),
            render_milestones(loc, shared),
            render_press(loc, shared),
        ]
    elif page == "music":
        blocks = [
            render_nav(loc, page),
            render_music(loc, shared, full=True),
        ]
    elif page == "videos":
        blocks = [
            render_nav(loc, page),
            render_videos(loc, shared, full=True),
        ]
    elif page == "about":
        blocks = [
            render_nav(loc, page),
            render_about(loc, shared, full=True),
            render_milestones(loc, shared, full=True),
        ]
    else:
        blocks = [
            render_nav(loc, page),
            render_press(loc, shared, full=True),
        ]

    # Every page finishes the same way: the copyright line, then the contact
    # block. It carries the only email address on the site, so it should not
    # be a trip back to the homepage to find it.
    blocks += [
        render_footer(loc, shared),
        render_contact(loc, shared),
    ]

    for block in blocks:
        lines += block
        lines.append("")

    lines += [f'<script src="{asset("js/main.js", p)}"></script>', "</body>", "</html>", ""]
    return "\n".join(lines)


def load(name: str) -> dict:
    return json.loads((CONTENT / name).read_text(encoding="utf-8"))


# Everything Cloudflare Pages should serve. The repo also holds build.py,
# content/, tools/ and workers/, and none of those belong on a public host.
DEPLOY_DIRS = ("css", "js", "img", "fonts", "admin", "audio")


def build_dist(shared: dict, pages: list[tuple[dict, str]]) -> None:
    """Assemble dist/ — what Pages uploads. Excludes sources by construction."""
    import itertools
    import shutil
    import stat

    dist = ROOT / "dist"

    # OneDrive sets the read-only bit on the folders it syncs. rmtree then
    # fails with WinError 5 and, because it is called with ignore_errors,
    # fails silently — dist/ survives and the mkdir below is what raises.
    # Clearing the bit first is what makes a local rebuild work twice; on
    # Cloudflare the checkout is fresh and there is no dist/ to remove.
    if dist.exists():
        for p in itertools.chain([dist], dist.rglob("*")):
            try:
                p.chmod(p.stat().st_mode | stat.S_IWRITE)
            except OSError:
                pass
    shutil.rmtree(dist, ignore_errors=True)
    dist.mkdir(parents=True, exist_ok=True)

    for name in DEPLOY_DIRS:
        src = ROOT / name
        if src.is_dir():
            shutil.copytree(src, dist / name, dirs_exist_ok=True)

    for loc, page, rel in pages:
        out = dist / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(render_page(loc, shared, page), encoding="utf-8", newline="\n")

    # The admin is gated by Cloudflare Access, but keep it out of search
    # indexes too — Access returns a login page, not a 404, and that is
    # exactly the sort of thing Baidu will happily index.
    (dist / "_headers").write_text(
        "/admin/*\n  X-Robots-Tag: noindex, nofollow\n", encoding="utf-8", newline="\n"
    )
    (dist / "robots.txt").write_text(
        "User-agent: *\nDisallow: /admin/\n", encoding="utf-8", newline="\n"
    )

    total = sum(f.stat().st_size for f in dist.rglob("*") if f.is_file())
    count = sum(1 for f in dist.rglob("*") if f.is_file())
    print(f"dist/  {count} files, {total / 1e6:.1f}MB")


def audit(shared: dict) -> None:
    """Say out loud the things a render cannot fail on but a person should know.

    Both of these are silent by construction: a track pointing at a
    release id that does not exist simply gets no grade, and a placeholder
    album table renders perfectly. Neither shows up as a broken page, so
    the only place they can surface is here.
    """
    ids = {rel["id"] for rel in shared.get("releases") or []}
    orphans = [
        t["id"] for t in shared.get("tracks") or []
        if t.get("album") and t["album"] not in ids
    ]
    if orphans:
        print("WARN   no such release for: " + ", ".join(orphans)
              + "  (those tracks play at the site's own colour)")

    if shared.get("albumMapProvisional"):
        print("NOTE   track -> album map is provisional: the hero still grades "
              "itself per track, but no album is named on the page.")
        print("       Drop `albumMapProvisional` from content/shared.json once "
              "the label sends the real table.")


def main() -> int:
    shared = load("shared.json")
    audit(shared)
    # five pages per locale: the homepage plus one for each full section
    pages = [
        (loc, page, f"{prefix}{PAGE_FILE[page]}")
        for loc, prefix in ((load("en.json"), ""), (load("zh.json"), "zh/"))
        for page in PAGE_FILE
    ]

    if "--dist" in sys.argv:
        build_dist(shared, pages)
        return 0

    check = "--check" in sys.argv
    stale = []

    for loc, page, rel in pages:
        path = ROOT / rel
        html = render_page(loc, shared, page)
        if check:
            current = path.read_text(encoding="utf-8") if path.exists() else ""
            if current != html:
                stale.append(rel)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(html, encoding="utf-8", newline="\n")
            print(f"wrote {rel}  ({len(html):,} bytes)")

    if check:
        for rel in stale:
            print(f"STALE  {rel}")
        if stale:
            print("\nRun `python build.py` to refresh them.")
            return 1
        print(f"all {len(pages)} pages match content/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
