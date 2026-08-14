# MMM-AppMetrics

A MagicMirror² module that displays app metrics — downloads, in-app-purchase
revenue, and ad revenue — as headline totals plus line charts. Data comes from
an App Metrics API (whose URL you supply via `baseURL`) using HTTP Basic
authentication.

![charts](docs/preview.png)

## Installation

1. Navigate to your MagicMirror's `modules` folder:
   ```bash
   cd ~/MagicMirror/modules
   ```

2. Clone this repository:
   ```bash
   git clone https://github.com/soapergem/MMM-AppMetrics.git
   ```

3. Install dependencies (none required, but keeps things consistent):
   ```bash
   cd MMM-AppMetrics
   npm install
   ```

4. Install an emoji font. Raspberry Pi OS does not ship one, and without it the
   foreign-currency markers on the revenue chart render as empty boxes:
   ```bash
   sudo apt-get install -y fonts-noto-color-emoji
   ```
   Then restart MagicMirror completely — Electron builds its font list at process
   start, so a reload won't pick up a newly installed font. Verified on
   Raspberry Pi OS. See [Foreign-currency markers](#foreign-currency-markers) if
   you'd rather not depend on a system font.

Chart.js (v4) is bundled in `vendor/` — no build step or internet access is
needed at runtime.

## Configuration

Add the module to your `config/config.js` file:

```javascript
{
    module: "MMM-AppMetrics",
    position: "top_right",
    config: {
        baseURL: "https://app-metrics.example.com",
        basicAuth: "username:password",
        days: 30,
        updateInterval: 3600000  // 1 hour
    }
}
```

## Configuration Options

| Option | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `baseURL` | String | `""` | Yes | API base URL, e.g. `https://app-metrics.example.com` |
| `basicAuth` | String | `""` | Yes | HTTP Basic credentials, `username:password` |
| `app` | String | `""` | No | Filter to a specific app (passed as `app=`) |
| `platform` | String | `""` | No | `"ios"`, `"android"`, or `""` for both combined |
| `days` | Number | `30` | No | Inclusive lookback window ending today |
| `updateInterval` | Number | `3600000` | No | Poll interval in milliseconds |
| `requestTimeout` | Number | `30000` | No | Per-request timeout in milliseconds. Keep it above the API's own worst case, or a slow upstream is reported as a timeout here while the API is still working |
| `retryBackoff` | Number | `60000` | No | Delay before retrying a round that lost a metric, in milliseconds. Doubles per consecutive bad round, capped at `updateInterval` |
| `showDownloads` | Boolean | `true` | No | Show the downloads total + chart |
| `showIapRevenue` | Boolean | `true` | No | Include IAP revenue in totals + revenue chart |
| `showAdRevenue` | Boolean | `true` | No | Include ad revenue in totals + revenue chart |
| `revenueDualAxis` | Boolean | `true` | No | Scale ad revenue against its own right-hand y axis (see below) |
| `showNativeCurrencyMarkers` | Boolean | `true` | No | Mark IAP days whose purchase was made in a foreign currency (see below) |
| `nativeCurrencySymbols` | Object | `{CAD, EUR, GBP, JPY}` | No | Symbol to draw per ISO currency code; unmapped codes render as the code itself |
| `nativeMarkerFontSize` | Number | `12` | No | Pixel size of those markers |
| `downloadsMirroredAxis` | Boolean | `true` | No | Repeat the downloads y-axis ticks on the right-hand edge too |
| `downloadsChartLabel` | String | `"Downloads"` | No | Downloads label in the chart legend |
| `iapChartLabel` | String | `"IAP"` | No | IAP revenue label in the chart legend |
| `adChartLabel` | String | `"Ad"` | No | Ad revenue label in the chart legend |
| `downloadsSummaryLabel` | String | `"Downloads"` | No | Downloads label on the summary card |
| `iapSummaryLabel` | String | `"IAP Revenue"` | No | IAP revenue label on the summary card |
| `adSummaryLabel` | String | `"Ad Revenue"` | No | Ad revenue label on the summary card |
| `chartHeight` | Number | `150` | No | Pixel height of each chart |
| `width` | String | `"420px"` | No | Module width |
| `title` | String | `"App Metrics"` | No | Heading text (set `""` to hide) |

## How it works

The `node_helper` computes the `start_date`/`end_date` window from `days` in the
host's **local** timezone (see below), then queries the enabled endpoints with
Basic auth:

- `GET /metrics/downloads`
- `GET /metrics/iap-revenue`
- `GET /metrics/ad-revenue`

`platform` and `app` are forwarded as query parameters when set. If one endpoint
fails the others still render, and the failure is noted under the charts. Per-day
values are summed across platforms before plotting. The downloads chart and the
revenue chart (IAP + ad as separate series) are drawn with Chart.js.

### Metrics are held over when a poll loses them

Each metric is kept separately along with the time it was fetched, and a poll
only overwrites what it actually returned. A metric that fails is left showing
its last known value rather than disappearing.

Held-over figures are dimmed and listed under the charts with their age
(`Held over: IAP Revenue (2h ago)`), alongside whatever the API reported as the
reason. Nothing on screen is silently out of date: if a number is old, the
widget says how old.

If the metric's window has since rolled past what the held-over copy covers,
the missing days are drawn as a break in the line rather than as zero — a gap
says "not known", a zero would claim there was no revenue that day.

A failure that takes down *every* metric leaves the existing display in place
too, with the error reported beneath it. The full-screen error state is only
reached when nothing has ever loaded.

### A failed round retries sooner, not later

Losing a metric shortens the poll interval instead of lengthening it. Something
is on screen going stale, so the sooner a retry lands the less time the display
spends wrong. Starting from `retryBackoff`, the delay doubles for each
consecutive round that lost something, capped at `updateInterval`:

| Consecutive bad rounds | Next poll (defaults) |
|---|---|
| 0 (all clean) | 60 min |
| 1 | 1 min |
| 2 | 2 min |
| 3 | 4 min |
| 4 | 8 min |
| 5 | 16 min |
| 6 | 32 min |
| 7+ | 60 min (capped) |

So a one-off blip — the case that prompted all this — is corrected about a
minute later rather than an hour later, while a genuine outage decays back to
the ordinary hourly cadence instead of hammering the API. A single clean round
resets it.

Only a round in which *every* enabled metric came back resets the counter, so a
persistently broken endpoint parks the delay at the cap — the loop keeps running
at the ordinary interval rather than ending. The only conditions that stop it
are configuration errors retrying cannot fix: a missing `baseURL`/`basicAuth`,
or all three `show*` options set to false.

### Dates are local, not UTC

The date window is both computed *and* formatted in the local timezone of the
machine running MagicMirror. This matters more than it sounds: `Date`'s
`toISOString()` renders the **UTC** date, and UTC is a different calendar day
from local time for part of every day — from 19:00 in US Central (18:00 on
standard time) through midnight, and from midnight until 09:00 in Tokyo.

Formatting a locally-computed window as UTC slides the whole range one day off.
Going west that means requesting tomorrow, which the API accepts without
complaint and zero-fills, so the chart grows a phantom empty day on the right and
silently drops the oldest real one. Going east it means requesting yesterday and
losing today entirely.

Because the window follows the host clock, the module depends on that clock being
right. On a Raspberry Pi, check with `timedatectl` and set it with
`sudo timedatectl set-timezone America/Chicago`.

### The downloads chart's mirrored axis

With `downloadsMirroredAxis: true` (the default) the downloads y-axis ticks are
repeated down the right-hand edge, so a value at that end of the chart can be
read without tracking back across the full width to the left axis.

This is a second axis with no dataset of its own. No dataset means no data
limits, and Chart.js would give it an arbitrary `0..1` range, so it is handed the
same limits the left axis derives from the data — same range through the same
tick algorithm, landing on the same ticks at the same pixels. Only the left axis
draws gridlines; both drawing them would stack two translucent strokes on the
same pixels and leave this grid brighter than the revenue chart's.

### The revenue chart's two y axes

IAP revenue is typically dollars while ad revenue is cents, so on a shared scale
the ad line flatlines along the bottom. With `revenueDualAxis: true` (the
default) IAP is measured against the left axis and ad revenue against a
right-hand axis with its own range, so both lines use the full height of the
chart. Each axis' tick labels are tinted to match its series — green on the
left, amber on the right — since that colour is the only thing tying a line to
its scale.

Tick labels are formatted for the range each axis lands on: an axis that tops
out under a dollar is labelled in cents (`0¢ 5¢ 10¢`), anything larger in
dollars. Nothing is hardcoded per axis, so a growing ad-revenue axis switches to
dollars on its own.

Whether a dollar axis shows cents is decided per axis rather than per tick. If
every tick is a whole dollar, none of them show cents (`$0 $1 $2 $3`); if any
tick lands on a part dollar, they all do (`$0.00 $0.50 $1.00 $1.50 $2.00`). Both
halves of that matter — `$1.5` isn't a way of writing money, and an axis mixing
`$1` with `$1.50` reads as though the labels had been rounded inconsistently.

An empty series has nothing to scale against, and Chart.js falls back to an
arbitrary `0..1` range. What the axis shows instead depends on whether there is
anything to borrow from.

When one series is empty for the period — no IAP purchases at all, which happens
— its gridlines would land nowhere near the other axis'. The empty axis is given
the same data limits as the series that does have values, so both run the same
tick algorithm over the same range and agree exactly: if ad revenue reads
`0¢ 20¢ 40¢ 60¢`, so does the IAP axis. This is symmetric — an empty ad series
borrows the IAP scale the same way. Two populated series keep their own
independent scales, which is the whole point of dual mode.

When *both* are empty there is nothing to borrow, and the `0..1` fallback renders
as a dollar scale, overstating what this chart measures — revenue here lives in
cents. An empty revenue chart is instead given a 60-cent axis, so it reads
`0¢ 20¢ 40¢ 60¢` rather than `$0.00 $0.50 $1.00`. The same applies when only one
revenue series is enabled and it comes back empty.

Two axes means the two lines are on different units: where they cross, or which
one sits higher, carries no meaning. Only the shape of each line does. Set
`revenueDualAxis: false` to put both series back on one shared axis, which
preserves that comparison at the cost of squashing the ad line. The axis is also
skipped automatically when only one revenue series is on the chart.

### Foreign-currency markers

Every IAP figure on the chart is in USD, but the purchase behind it wasn't
necessarily made in dollars — the API reports the original amount in each daily
entry's `native` array. `showNativeCurrencyMarkers` draws a small symbol above
any day with a non-USD purchase, so a CAD$2.79 donation that converted to $1.99
is still recognisable as Canadian:

```javascript
nativeCurrencySymbols: {
    CAD: "🍁",
    EUR: "💶",
    GBP: "💷",
    JPY: "💴"
}
```

Currency is not 1:1 with country — the euro spans twenty of them — so these are
currency symbols rather than flags. That also sidesteps a rendering problem: flag
emoji are regional-indicator pairs, which Windows refuses to draw at all, showing
bare letters like `CA` instead. The symbols above are ordinary single-codepoint
emoji, so any font that covers emoji will draw them — but the host does still
need such a font, which is not a given on a Pi. See below.

Extend the map with any ISO 4217 code. Codes you don't map fall back to the code
itself as text (`AUD`), tinted to match the IAP line, so a new currency shows up
as legible rather than disappearing. A day with purchases in two currencies gets
both symbols. Days whose purchases were natively in USD are skipped — the API
does report those, and marking them would say nothing.

**These markers need an emoji font on the host** (step 4 of
[Installation](#installation)). Raspberry Pi OS does not ship one, and without it
the symbols render as empty boxes. Install it once per Pi:

```bash
fc-list | grep -i emoji                            # expect no output
sudo apt-get install -y fonts-noto-color-emoji
fc-list | grep -i emoji                            # NotoColorEmoji.ttf: Noto Color Emoji:...
```

Then restart MagicMirror completely — Electron builds its font list at process
start, so a reload won't pick up a newly installed font. If the second `fc-list`
comes back empty after installing, run `fc-cache -f` and re-check.

The module asks for `"Noto Color Emoji"` first in its font stack, which is the
family name that package registers, so nothing needs configuring once it's there.

If you'd rather not depend on a system font at all, set the map to plain currency
glyphs instead. `€`, `£` and `¥` are in DejaVu Sans, which is always present, and
`C$` / `A$` cover the dollar currencies:

```javascript
nativeCurrencySymbols: { CAD: "C$", AUD: "A$", EUR: "€", GBP: "£", JPY: "¥" }
```

That needs no code change — the marker plugin draws whatever string the map
holds.

Drawing is a small inline Chart.js plugin (`nativeMarkerPlugin`) on the
`afterDatasetsDraw` hook, which is where the resolved pixel position of each
point is available — those coordinates depend on the scale Chart.js settles on,
so they can't be computed ahead of time. Markers near the left or right edge are
nudged inward to clear the axis labels, and when any marker is present the left
axis ceiling is raised 20% so a peak day has room for a symbol above it. That
headroom is skipped entirely for an all-USD range, which keeps the existing tick
scale untouched.

## License

MIT
