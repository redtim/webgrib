# Radar archive: pick a day, then a time range

Status: approved · 2026-11-25 · extends `radar.html` · scan caching deferred (redtim/webgrib#8)

Items marked **(proposed)** are choices made while writing this up that have not
been discussed. Change any of them.

## Intent

View radar from any day the user chooses, over a time range within that day. The
live viewer already loops recent scans; this adds the past.

## Goals

- Choose a date and a radar, and see the whole day before downloading radar data.
- Select a time range on a day timeline, then play it with the existing controls.
- Show how busy each part of the day was, labelled **activity (from file size)**.

## Not in this version (proposed)

- Data in the older message format (the sampled files from March 2008 and
  earlier). It needs a second parser and a table of radar locations.
- Ranges longer than one day, several radars at once, higher tilts, velocity
  dealiasing, file export, searching for past weather events.

## Would count as failure

- Downloading radar files just to browse a day.
- Skipping scans without saying so.
- Presenting file size as a rainfall measurement.
- Changing how the live view behaves.

## Constraints

- Runs entirely in the browser, reading `unidata-nexrad-level2` directly.
- TypeScript in `src/radar/`, tests under `test/` with the existing runner.

## What the archive holds (checked on sampled days, 2026-11-25)

| Sampled files | Compression | Radar messages | Read today |
|---|---|---|---|
| June 2016 and later | bzip2 records | type 31 | yes |
| December 2008 to January 2016 | whole-file gzip | type 31, same data blocks, location included | no |
| March 2008 and earlier | whole-file gzip | type 1 | no |

- Year folders go back to 1991.
- Sampled days held about 150–325 scans per radar, up to 4.4 GB (KTBW,
  2022-09-28).
- Name endings seen: `_V06`, `_V06.gz`, `_V03.gz`, `.gz`, and `_MDM` metadata
  files that must be ignored.
- Folders are dated in UTC.

## Approaches

| Approach | Trade-off | |
|---|---|---|
| Day timeline with a draggable range | Events can be found without knowing the time, and gaps show; most work | **chosen** |
| Date, start and end fields | Quick and precise, but the user must know when it happened | |
| Start time plus a 1, 3 or 6 hour preset | Fewest clicks, awkward for odd ranges | |

## Design

```
 [ Live | Archive ]    ‹  May 20, 2013  ›    KTLX ▾    [Local | UTC]

 activity    ▁▁▁▁▂▁▁▁▁▁▂▂▃▄▆▇██▇▆▄▃▂▁
 (from       00      06      12   ┃  18┃     24
  file size)                      ┗━━━━┛
 From [14:00]   To [16:30]   31 scans · about 80 MB   [ Load ]
```

(Illustrative numbers.)

### Flow

1. Switch to **Archive**. The timeline appears along the bottom.
2. Pick a date, by date field or the previous and next arrows. The radar list
   shows sites with files for that day.
3. The timeline draws one bar per scan, placed by time. Height is file size
   relative to that day's largest. Missing periods stay blank.
4. Drag across the timeline, adjust the end handles, or type From and To.
5. The summary shows the scan count, approximate download size and approximate
   memory needed.
6. **Load** fetches the range. The current play button, slider and product
   buttons take over. A scan's date and time replace "minutes ago".
7. **Live** returns to the live loop.

### Loop length (decided)

**No maximum.** Every scan in the selected range is loaded, up to the whole day,
with none skipped. That makes these necessary:

- **Compact frames.** A frame takes about 8.7 MB today, so 323 scans (the
  busiest sampled day by count) would need about 2.8 GB. Storing one byte per
  gate, as the files do for reflectivity and velocity (checked on one 2026
  scan), brings a frame to about 2.2 MB and that day to about 0.7 GB, with no
  loss of detail.
- **Informed loading (proposed).** The summary warns when a range needs more
  than about 1 GB of download or memory, and still allows it.
- **Control while loading (proposed).** Progress shows, loaded frames can be
  played, and loading can be cancelled, keeping what has arrived. If memory
  runs short, loading stops and says how far it got, where the browser lets the
  page detect this.

### Rules (proposed)

- **Time zone:** the viewer's local time, with a UTC switch. The day on the
  timeline follows that choice, reading two UTC folders when needed.
- **Dates offered:** from the first day readable by this version to today.
  A date that turns out to use the older format says it is not supported yet.
- **Download estimate:** roughly 30% of the listed size for bzip2 files, since
  loading stops after the low tilts (27–29% measured on two files). Calibrate
  separately for gzip files.
- **No auto-refresh** in Archive.
- **Bookmarks:** the address bar holds mode, radar, date, range (in UTC) and
  product.
- **Problems:** say when a radar has no files that day. Skip a scan that fails
  to load and report how many were skipped.
- **Input:** the timeline works with mouse, touch and keyboard, and fits a
  phone-width screen.

### Reading 2008–2016 files

Unpack gzip with the browser's `DecompressionStream`. After the 24-byte header
the messages follow directly, with no bzip2 records. Message decoding is shared
with the current parser, and the download still stops after the low tilts.

## Left to the builder

- How the timeline is drawn, and how the code is split.
- The compact frame format, including how no-data and range-folded gates are
  encoded.
