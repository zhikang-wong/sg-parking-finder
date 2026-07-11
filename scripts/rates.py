#!/usr/bin/env python3
"""Parse free-text carpark rate descriptions into structured time segments.

Segment encoding (compact JSON arrays, mirrored by the cost engine in app.js):
  ["f", s, e, fp, fd, pp, pi]  $fp for first fd minutes, then $pp per pi minutes
  ["p", s, e, pp, pi]          $pp per pi minutes
  ["e", s, e, p]               $p per entry
  ["z", s, e]                  free
s/e are minutes from midnight; e <= s means the window wraps past midnight.
A carpark's rates are {"w": [...], "a": [...], "u": [...]} for weekday / Sat / Sun-PH.
"""
import math
import re

# ---------------------------------------------------------------- time parsing
_TIME = r"(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm|noon|midnight)?|(noon|midnight)"


def _to_min(h, m, ap):
    h, m = int(h), int(m or 0)
    if ap == "pm" and h != 12:
        h += 12
    elif ap == "am" and h == 12:
        h = 0
    return (h * 60 + m) % 1440


def parse_time(tok):
    tok = tok.strip().lower()
    if "midnight" in tok or tok in ("12mn", "mn"):
        m = re.match(r"(\d{1,2})(?:[.:](\d{2}))?", tok)
        return _to_min(m.group(1), m.group(2), "am") if m else 0
    if "noon" in tok:
        return 720
    m = re.match(r"(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm)?$", tok)
    if not m:
        return None
    return _to_min(m.group(1), m.group(2), m.group(3))


# one time token like "6.01am", "12 midnight", "11.59pm", "12noon"
T = r"\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm|noon|midnight|mn)|noon|midnight"

RANGE = re.compile(
    rf"(?:from\s+)?({T})\s*(?:-|–|to)\s*({T})(?:\s+the\s+following\s+day)?", re.I)
AFTER = re.compile(rf"(?:aft(?:er)?|from)\s+({T})(?:\s+onwards)?", re.I)
BEFORE = re.compile(rf"(?:before|until|till|up to)\s+({T})", re.I)

SAME_WD = re.compile(r"same as (?:on )?(?:the )?(?:wkdays?|weekdays?)", re.I)
SAME_SAT = re.compile(r"same as (?:on )?(?:the )?sat(?:urday)?", re.I)


def _round(x):
    return round(x + 1e-9, 2)


# ---------------------------------------------------------------- rule parsing
def parse_rule(s):
    """Parse one chunk of rate text (time range already stripped) into a rule
    list (without s/e, which the caller prepends). Returns None if unparseable."""
    s = s.lower().replace("½", "1/2")
    s = re.sub(r"\s+", " ", s).strip()
    if not s or s in ("-", "–"):
        return None

    if "$" not in s:
        if re.search(r"\bhdb\b|\bura\b", s):        # "HDB / URA parking rates"
            return ["p", 0.60, 30]
        if "free" in s:
            return ["z"]
        return None

    def sub_rate(rest):
        m = re.search(
            r"\$(\d+(?:\.\d+)?)(?:\s*(?:for|per|\/|every)?\s*"
            r"(?:each |every |next |all |the )?(?:sub\.?s?e?q?u?e?n?t? ?|additional |succeeding )?"
            r"(?:(\d+) ?mins?|1\/2 ?(?:hr|hour)|half (?:an )?(?:hr|hour)|(?:hr|hour)))", rest)
        if not m:
            return None
        pp = float(m.group(1))
        if m.group(2):
            pi = int(m.group(2))
        elif re.search(r"1\/2 ?(?:hr|hour)|half", m.group(0)):
            pi = 30
        else:
            pi = 60
        return pp, pi

    def first_dur(n, unit):
        n = int(n) if n else 1
        return n if unit and unit.startswith("min") else n * 60

    # "free for 1st hr, $Y per ..."  /  "1st hr free ..."
    m = (re.search(r"(?:free|\$0(?:\.00)?) for (?:the )?(?:1st|first) ?(\d+)? ?(hours?|hrs?|mins?)", s)
         or re.search(r"(?:1st|first) ?(\d+)? ?(hours?|hrs?|mins?) free", s))
    if m:
        fd = first_dur(m.group(1), m.group(2))
        sub = sub_rate(s[m.end():])
        if sub:
            return ["f", 0.0, fd, sub[0], sub[1]]
        return ["f", 0.0, fd, 0.0, 60]

    # "$X for 1st [N] hr/min" or "1st [N] hr: $X"
    m = re.search(r"\$(\d+(?:\.\d+)?)\s*(?:\/|for|:)?\s*(?:the )?(?:1st|first) ?(\d+)? ?(hours?|hrs?|mins?)", s)
    if m:
        fp, fd = float(m.group(1)), first_dur(m.group(2), m.group(3))
    else:
        m = re.search(r"(?:1st|first) ?(\d+)? ?(hours?|hrs?|mins?)\s*[:\-]\s*\$(\d+(?:\.\d+)?)", s)
        if m:
            fp, fd = float(m.group(3)), first_dur(m.group(1), m.group(2))
    if m:
        sub = sub_rate(s[m.end():])
        if sub:
            return ["f", fp, fd, sub[0], sub[1]]
        return ["f", fp, fd, fp, fd]     # no follow-up rate: repeat first block

    # "$X per entry" / "$X/entry"
    m = re.search(r"\$(\d+(?:\.\d+)?)\s*(?:per|\/)\s*entry", s)
    if m:
        return ["e", float(m.group(1))]

    # "$X per/for/each N min(s)"
    m = re.search(r"\$(\d+(?:\.\d+)?)\s*(?:\/|per|for|every)?\s*(?:every |each )?(\d+) ?mins?", s)
    if m:
        return ["p", float(m.group(1)), int(m.group(2))]

    # "$X per 1/2 hr"
    m = re.search(r"\$(\d+(?:\.\d+)?)\s*(?:\/|per|for)?\s*(?:1\/2 ?(?:hr|hour)|half (?:an )?(?:hr|hour))", s)
    if m:
        return ["p", float(m.group(1)), 30]

    # "$X per hr"
    m = re.search(r"\$(\d+(?:\.\d+)?)\s*(?:\/|per|for)?\s*(?:1 )?(?:hr|hour)", s)
    if m:
        return ["p", float(m.group(1)), 60]

    # "$X /min" (per-minute charging)
    m = re.search(r"\$(\d+(?:\.\d+)?)\s*\/? ?min", s)
    if m:
        return ["p", float(m.group(1)), 1]

    return None


# ---------------------------------------------------------------- segments
def parse_segments(text):
    """Parse one rate field (may contain several time-ranged chunks) into a
    list of [type, s, e, ...] segments. Returns [] if nothing parseable."""
    if not text:
        return []
    text = text.replace("½", "1/2")
    # find every time-range marker; text between markers belongs to the marker
    marks = []
    for m in RANGE.finditer(text):
        marks.append((m.start(), m.end(), parse_time(m.group(1)), parse_time(m.group(2))))
    if not marks:
        m = AFTER.search(text)
        if m and not re.search(r"for|per", text[max(0, m.start() - 12):m.start()]):
            t = parse_time(m.group(1))
            marks.append((m.start(), m.end(), t, 420))   # until 7am next day
        else:
            m2 = BEFORE.search(text)
            if m2:
                marks.append((m2.start(), m2.end(), 0, parse_time(m2.group(1))))

    segs = []
    if not marks:
        rule = parse_rule(text)
        return [[rule[0], 0, 1440] + rule[1:]] if rule else []

    # Rate text comes in two shapes: "RULE from A to B, RULE2 from C to D"
    # (rule precedes its range) and "A-B: RULE; C-D: RULE2" (rule follows).
    head = text[:marks[0][0]].lower()
    rule_before = any(k in head for k in ("$", "free", "hdb", "ura"))
    for i, (ms, me, s, e) in enumerate(marks):
        if rule_before:
            lo = marks[i - 1][1] if i else 0
            chunk = text[lo:ms]
        else:
            hi = marks[i + 1][0] if i + 1 < len(marks) else len(text)
            chunk = text[me:hi]
        rule = parse_rule(chunk)
        if rule and s is not None and e is not None:
            if e % 60 == 59:          # "to 4.59pm" means up to 5pm
                e = e + 1 if e < 1439 else 1440
            segs.append([rule[0], s, e] + rule[1:])
    return segs


def parse_carpark_rates(wd1, wd2, sat, sun):
    """Build the {"w","a","u"} rates dict from sgcarmart's four fields."""
    wd = parse_segments(wd1) + parse_segments(wd2)

    def day(txt, fallbacks):
        if not txt or txt.strip() in ("-", ""):
            return fallbacks[0]
        if SAME_WD.search(txt):
            return fallbacks[0]
        if SAME_SAT.search(txt) and len(fallbacks) > 1:
            return fallbacks[1]
        segs = parse_segments(txt)
        return segs if segs else fallbacks[0]

    sa = day(sat, [wd])
    su = day(sun, [wd, sa])
    return {"w": wd, "a": sa, "u": su} if wd else None


# ---------------------------------------------------------------- cost engine
def _find_seg(segs, m):
    best = None
    for seg in segs:
        s, e = seg[1], seg[2]
        if (e > s and s <= m < e) or (e <= s and (m >= s or m < e)):
            return seg
        if s <= m and (best is None or s > best[1]):
            best = seg
    return best or segs[0]


def estimate_cost(rates, weekday, start_min, dur_min):
    """Estimate total cost. weekday: 0-4 wd, 5 sat, 6 sun. Mirrors app.js."""
    if not rates:
        return None
    total, m, rem, first, guard = 0.0, start_min, dur_min, True, 0
    day = weekday
    while rem > 0 and guard < 40:
        guard += 1
        segs = rates["w" if day < 5 else "a" if day == 5 else "u"]
        if not segs:
            return None
        mm = m % 1440
        seg = _find_seg(segs, mm)
        s, e = seg[1], seg[2]
        if e > s:                     # normal window
            if s <= mm < e:
                until = e - mm        # inside: until window ends
            elif mm < s:
                until = s - mm        # gap before window: until it starts
            else:
                until = 1440 - mm     # gap after window: until midnight
        else:                         # window wraps midnight
            if mm >= s:
                until = (1440 - mm) + e
            elif mm < e:
                until = e - mm
            else:
                until = s - mm        # gap between e and s
        visit = min(rem, max(1, until))
        kind = seg[0]
        if kind == "e":
            total += seg[3]
        elif kind == "p":
            total += math.ceil(visit / seg[4]) * seg[3]
        elif kind == "f":
            fp, fd, pp, pi = seg[3], seg[4], seg[5], seg[6]
            if first:
                total += fp
                if visit > fd:
                    total += math.ceil((visit - fd) / pi) * pp
            else:
                total += math.ceil(visit / pi) * pp
        first = False
        rem -= visit
        m += visit
        if m >= 1440:
            m -= 1440
            day = (day + 1) % 7
    return _round(total)
