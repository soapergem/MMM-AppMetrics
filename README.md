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
| `showDownloads` | Boolean | `true` | No | Show the downloads total + chart |
| `showIapRevenue` | Boolean | `true` | No | Include IAP revenue in totals + revenue chart |
| `showAdRevenue` | Boolean | `true` | No | Include ad revenue in totals + revenue chart |
| `revenueDualAxis` | Boolean | `true` | No | Scale ad revenue against its own right-hand y axis (see below) |
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

The `node_helper` computes the `start_date`/`end_date` window from `days`, then
queries the enabled endpoints with Basic auth:

- `GET /metrics/downloads`
- `GET /metrics/iap-revenue`
- `GET /metrics/ad-revenue`

`platform` and `app` are forwarded as query parameters when set. If one endpoint
fails the others still render, and the failure is noted under the charts. Per-day
values are summed across platforms before plotting. The downloads chart and the
revenue chart (IAP + ad as separate series) are drawn with Chart.js.

### The revenue chart's two y axes

IAP revenue is typically dollars while ad revenue is cents, so on a shared scale
the ad line flatlines along the bottom. With `revenueDualAxis: true` (the
default) IAP is measured against the left axis and ad revenue against a
right-hand axis with its own range, so both lines use the full height of the
chart. Each axis' tick labels are tinted to match its series — green on the
left, amber on the right — since that colour is the only thing tying a line to
its scale.

Two axes means the two lines are on different units: where they cross, or which
one sits higher, carries no meaning. Only the shape of each line does. Set
`revenueDualAxis: false` to put both series back on one shared axis, which
preserves that comparison at the cost of squashing the ad line. The axis is also
skipped automatically when only one revenue series is on the chart.

## License

MIT
