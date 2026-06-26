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

## License

MIT
