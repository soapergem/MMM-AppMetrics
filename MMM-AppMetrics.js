Module.register("MMM-AppMetrics", {
    defaults: {
        baseURL: "",              // API base URL, e.g. "https://app-metrics.example.com"
        basicAuth: "",            // "username:password"
        app: "",                  // optional app filter
        platform: "",             // "", "ios" or "android"
        days: 30,                 // lookback window (inclusive)
        updateInterval: 3600000,  // 1 hour in milliseconds
        requestTimeout: 30000,    // per-request timeout in milliseconds
        // First retry delay after a round that lost a metric. Doubles per
        // consecutive bad round, capped at updateInterval.
        retryBackoff: 60000,      // 1 minute in milliseconds
        showDownloads: true,
        showIapRevenue: true,
        showAdRevenue: true,
        // Plot ad revenue against its own right-hand axis so cent-scale ad
        // numbers stay legible next to dollar-scale IAP numbers.
        revenueDualAxis: true,
        // Mark IAP days whose purchase was made in a foreign currency. The
        // chart plots the converted USD figure; the marker records that the
        // money didn't arrive in dollars.
        showNativeCurrencyMarkers: true,
        // Symbol drawn above such a day, keyed by ISO currency code. Currency
        // is not 1:1 with country (the euro spans twenty of them), so these are
        // currency symbols rather than flags. Unmapped codes fall back to the
        // code itself, e.g. "AUD".
        nativeCurrencySymbols: {
            AUD: "🦘",
            CAD: "🍁",
            EUR: "💶",
            GBP: "💷",
            JPY: "💴"
        },
        nativeMarkerFontSize: 12,
        // Repeat the downloads y-axis ticks down the right-hand edge, so a
        // value over there can be read without tracking back across the chart.
        downloadsMirroredAxis: true,
        // Chart legend labels (kept short to fit the chart)
        downloadsChartLabel: "Downloads",
        iapChartLabel: "IAP",
        adChartLabel: "Ad",
        // Summary-card labels (can be more descriptive)
        downloadsSummaryLabel: "Downloads",
        iapSummaryLabel: "IAP Revenue",
        adSummaryLabel: "Ad Revenue",
        chartHeight: 150,         // pixel height of each chart
        width: "420px",
        title: "App Metrics"
    },

    requiresVersion: "2.1.0",

    // Palette tuned for MagicMirror's dark background.
    palette: {
        downloads: "#3498db",
        iap: "#2ecc71",
        ad: "#f39c12",
        grid: "rgba(255, 255, 255, 0.1)",
        text: "rgba(255, 255, 255, 0.7)"
    },

    // The metric keys the helper can deliver, in display order.
    metricKeys: ["downloads", "iapRevenue", "adRevenue"],

    start: function() {
        // Each metric is held separately, with the time it was fetched, so a
        // poll that loses one of them keeps displaying the last good copy of
        // the others — and of that one. A single upstream having a bad minute
        // used to blank its number until the next poll an hour later.
        this.metrics = {};
        this.range = null;
        this.errors = [];
        this.loaded = false;
        this.error = null;
        this.lastUpdate = null;
        this.isRefreshing = false;
        this.charts = {};
        this.sendSocketNotification("CONFIG", this.config);
    },

    getStyles: function() {
        return ["MMM-AppMetrics.css"];
    },

    getScripts: function() {
        return [this.file("vendor/chart.umd.min.js")];
    },

    socketNotificationReceived: function(notification, payload) {
        var self = this;
        if (notification === "APP_DATA") {
            var now = new Date();
            // Only overwrite what actually arrived. A metric missing from the
            // payload failed this round; its previous value stays put, and
            // its timestamp stays behind lastUpdate, which is what marks it
            // stale on screen.
            this.metricKeys.forEach(function(key) {
                if (payload[key]) {
                    self.metrics[key] = { body: payload[key], at: now };
                }
            });
            this.range = payload.range || this.range;
            this.errors = payload.errors || [];
            this.error = null;
            this.isRefreshing = false;
            this.lastUpdate = now;
            this.loaded = true;
            this.updateDom();
        } else if (notification === "ERROR") {
            Log.error("MMM-AppMetrics: " + payload);
            // Every metric failed. Anything already on screen is still the
            // best information available, so keep rendering it and report
            // the failure alongside rather than replacing the display.
            this.error = payload;
            this.isRefreshing = false;
            this.loaded = true;
            this.updateDom();
        }
    },

    // Metrics held from any poll, shaped like the helper's payload so the
    // rendering path does not care whether a value is fresh or retained.
    currentData: function() {
        var self = this;
        var data = {};
        this.metricKeys.forEach(function(key) {
            if (self.metrics[key]) { data[key] = self.metrics[key].body; }
        });
        return data;
    },

    // Metrics whose newest copy predates the last completed poll.
    staleMetrics: function() {
        var self = this;
        return this.metricKeys.filter(function(key) {
            var held = self.metrics[key];
            return held && self.lastUpdate && held.at < self.lastUpdate;
        });
    },

    // Coarse age, sized to a display that is read from across the room.
    formatAge: function(then) {
        var minutes = Math.round((Date.now() - then.getTime()) / 60000);
        if (minutes < 2) { return "just now"; }
        if (minutes < 60) { return minutes + "m ago"; }
        var hours = Math.round(minutes / 60);
        if (hours < 24) { return hours + "h ago"; }
        return Math.round(hours / 24) + "d ago";
    },

    summaryLabelFor: function(key) {
        if (key === "downloads") { return this.config.downloadsSummaryLabel; }
        if (key === "iapRevenue") { return this.config.iapSummaryLabel; }
        return this.config.adSummaryLabel;
    },

    // ---- Data shaping helpers -------------------------------------------

    // Sum a numeric field across each platform's daily array, keyed by date.
    // `getValue` extracts the value (count or revenue) from a daily entry.
    mergeDaily: function(metric, getValue) {
        var byDate = {};
        if (!metric || !Array.isArray(metric.platforms)) {
            return byDate;
        }
        metric.platforms.forEach(function(platform) {
            (platform.daily || []).forEach(function(entry) {
                var v = getValue(entry);
                byDate[entry.date] = (byDate[entry.date] || 0) + (isNaN(v) ? 0 : v);
            });
        });
        return byDate;
    },

    // Collect the currencies a day's purchases were actually made in, keyed by
    // date and merged across platforms. The API reports these in each daily
    // entry's `native` array alongside the converted figure, and a single day
    // can carry more than one. The display currency is skipped: a USD purchase
    // shown in USD is not worth marking.
    mergeNativeCurrencies: function(metric) {
        var byDate = {};
        if (!metric || !Array.isArray(metric.platforms)) {
            return byDate;
        }
        metric.platforms.forEach(function(platform) {
            (platform.daily || []).forEach(function(entry) {
                var display = entry.currency || platform.currency || "USD";
                (entry.native || []).forEach(function(native) {
                    if (!native.currency || native.currency === display) { return; }
                    var seen = byDate[entry.date] || (byDate[entry.date] = []);
                    if (seen.indexOf(native.currency) === -1) {
                        seen.push(native.currency);
                    }
                });
            });
        });
        return byDate;
    },

    // One marker string per chart label, or null for days that need no marker.
    // Days with several native currencies get their symbols concatenated.
    nativeMarkersFor: function(labels, byDate) {
        var symbols = this.config.nativeCurrencySymbols || {};
        return labels.map(function(date) {
            var currencies = byDate[date];
            if (!currencies || !currencies.length) { return null; }
            return currencies.map(function(code) {
                return symbols[code] || code;
            }).join("");
        });
    },

    // Ordered union of dates across the metrics we have.
    collectLabels: function(maps) {
        var set = {};
        maps.forEach(function(map) {
            Object.keys(map).forEach(function(date) { set[date] = true; });
        });
        return Object.keys(set).sort();
    },

    seriesFor: function(labels, map) {
        return labels.map(function(date) {
            return map.hasOwnProperty(date) ? map[date] : 0;
        });
    },

    // As seriesFor, but absent dates become null rather than zero, which
    // Chart.js draws as a break in the line. Identical to seriesFor while
    // every series covers the same range — which is the case unless one of
    // them is being held over from an earlier poll and its window has since
    // rolled forward. Plotting that day as 0 would claim there was no
    // revenue, when the truth is that this series does not reach that far.
    seriesGapped: function(labels, map) {
        return labels.map(function(date) {
            return map.hasOwnProperty(date) ? map[date] : null;
        });
    },

    formatMoney: function(amount, currency) {
        try {
            return new Intl.NumberFormat("en-US", {
                style: "currency",
                currency: currency || "USD",
                maximumFractionDigits: 2
            }).format(amount);
        } catch (e) {
            return "$" + Number(amount).toFixed(2);
        }
    },

    revenueTotal: function(metric) {
        if (!metric || !Array.isArray(metric.platforms)) {
            return 0;
        }
        return metric.platforms.reduce(function(sum, p) {
            return sum + (parseFloat(p.total_revenue) || 0);
        }, 0);
    },

    revenueCurrency: function(metric) {
        if (metric && Array.isArray(metric.platforms) && metric.platforms.length) {
            return metric.platforms[0].currency || "USD";
        }
        return "USD";
    },

    downloadsTotal: function(metric) {
        if (!metric || !Array.isArray(metric.platforms)) {
            return 0;
        }
        return metric.platforms.reduce(function(sum, p) {
            return sum + (p.total_downloads || 0);
        }, 0);
    },

    // ---- Rendering ------------------------------------------------------

    getDom: function() {
        var wrapper = document.createElement("div");
        wrapper.className = "mmm-app-widget";
        wrapper.style.width = this.config.width;

        if (!this.loaded) {
            wrapper.innerHTML = "Loading app metrics...";
            return wrapper;
        }

        var data = this.currentData();
        var haveAnything = this.metricKeys.some(function(key) {
            return !!data[key];
        });

        // Only surrender the whole display when there is nothing to show. If
        // a previous poll left numbers on screen they are still the best
        // available, so the error joins them instead of replacing them.
        if (this.error && !haveAnything) {
            var errorMessage = document.createElement("div");
            errorMessage.className = "error-message";
            errorMessage.innerHTML = "Error loading metrics: " + this.error;
            wrapper.appendChild(errorMessage);
            wrapper.className += " error";
            wrapper.appendChild(this.buildFooter());
            return wrapper;
        }

        if (this.config.title) {
            var heading = document.createElement("div");
            heading.className = "widget-title";
            heading.innerHTML = this.config.title;
            wrapper.appendChild(heading);
        }

        wrapper.appendChild(this.buildSummary(data));

        // Charts are created after the canvases are attached to the DOM.
        this.pendingCharts = [];

        if (this.config.showDownloads && data.downloads) {
            wrapper.appendChild(this.buildChartCard("downloads", "Downloads", data));
        }
        if ((this.config.showIapRevenue && data.iapRevenue) ||
            (this.config.showAdRevenue && data.adRevenue)) {
            wrapper.appendChild(this.buildChartCard("revenue", "Revenue", data));
        }

        // Say plainly that a number is being held over, and how old it is.
        // Without this the widget would quietly present last hour's revenue
        // as though it were this hour's.
        var stale = this.staleMetrics();
        if (stale.length) {
            var self_ = this;
            var notice = document.createElement("div");
            notice.className = "stale-notice";
            notice.innerHTML = "Held over: " + stale.map(function(key) {
                return self_.summaryLabelFor(key) + " (" +
                    self_.formatAge(self_.metrics[key].at) + ")";
            }).join(", ");
            wrapper.appendChild(notice);
        }

        var reasons = (this.errors || []).slice();
        if (this.error) { reasons.push(this.error); }
        if (reasons.length) {
            var partial = document.createElement("div");
            partial.className = "partial-error";
            partial.innerHTML = "Some metrics unavailable: " + reasons.join("; ");
            wrapper.appendChild(partial);
        }

        wrapper.appendChild(this.buildFooter());

        // Defer chart instantiation until the canvases are in the document.
        var self = this;
        setTimeout(function() { self.renderCharts(); }, 0);

        return wrapper;
    },

    buildSummary: function(data) {
        var summary = document.createElement("div");
        summary.className = "summary";

        var items = [];
        if (this.config.showDownloads && data.downloads) {
            items.push({
                key: "downloads",
                label: this.config.downloadsSummaryLabel,
                value: this.downloadsTotal(data.downloads).toLocaleString("en-US"),
                cls: "metric-downloads"
            });
        }
        if (this.config.showIapRevenue && data.iapRevenue) {
            items.push({
                key: "iapRevenue",
                label: this.config.iapSummaryLabel,
                value: this.formatMoney(this.revenueTotal(data.iapRevenue), this.revenueCurrency(data.iapRevenue)),
                cls: "metric-iap"
            });
        }
        if (this.config.showAdRevenue && data.adRevenue) {
            items.push({
                key: "adRevenue",
                label: this.config.adSummaryLabel,
                value: this.formatMoney(this.revenueTotal(data.adRevenue), this.revenueCurrency(data.adRevenue)),
                cls: "metric-ad"
            });
        }

        var self = this;
        var stale = this.staleMetrics();
        items.forEach(function(item) {
            var cell = document.createElement("div");
            cell.className = "summary-item " + item.cls;
            // Dim a held-over figure so the eye does not read it as current.
            if (stale.indexOf(item.key) !== -1) {
                cell.className += " stale";
            }

            var value = document.createElement("div");
            value.className = "summary-value";
            value.innerHTML = item.value;

            var label = document.createElement("div");
            label.className = "summary-label";
            label.innerHTML = item.label;

            cell.appendChild(value);
            cell.appendChild(label);
            summary.appendChild(cell);
        });

        return summary;
    },

    buildChartCard: function(id, title, data) {
        var card = document.createElement("div");
        card.className = "chart-card";

        var canvas = document.createElement("canvas");
        canvas.id = "appmetrics-chart-" + this.identifier + "-" + id;
        canvas.height = this.config.chartHeight;
        card.appendChild(canvas);

        this.pendingCharts.push({ id: id, canvasId: canvas.id, data: data });
        return card;
    },

    renderCharts: function() {
        if (typeof Chart === "undefined") {
            Log.error("MMM-AppMetrics: Chart.js failed to load");
            return;
        }

        var self = this;
        (this.pendingCharts || []).forEach(function(spec) {
            var canvas = document.getElementById(spec.canvasId);
            if (!canvas) { return; }

            // Tear down any previous chart bound to this canvas.
            if (self.charts[spec.id]) {
                self.charts[spec.id].destroy();
                delete self.charts[spec.id];
            }

            var config = spec.id === "downloads"
                ? self.downloadsChartConfig(spec.data)
                : self.revenueChartConfig(spec.data);

            if (config) {
                self.charts[spec.id] = new Chart(canvas.getContext("2d"), config);
            }
        });
    },

    baseChartOptions: function() {
        var p = this.palette;
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { intersect: false, mode: "index" },
            plugins: {
                legend: {
                    display: true,
                    labels: { color: p.text, boxWidth: 12, font: { size: 10 } }
                },
                tooltip: { enabled: true }
            },
            scales: {
                x: {
                    grid: { color: p.grid },
                    ticks: { color: p.text, maxTicksLimit: 6, font: { size: 9 } }
                },
                y: {
                    beginAtZero: true,
                    grid: { color: p.grid },
                    ticks: { color: p.text, maxTicksLimit: 5, font: { size: 9 } }
                }
            }
        };
    },

    // Currency tick, formatted for the scale the axis actually landed on. An
    // axis that tops out below a dollar reads better in cents (0¢ 5¢ 10¢) than
    // in fractions of a dollar ($0.00 $0.05 $0.10). `ticks` is Chart.js' full
    // tick list, so the top tick tells us the axis range.
    moneyTick: function(value, ticks) {
        var list = (ticks && ticks.length) ? ticks : [{ value: value }];
        var top = Math.abs(list[list.length - 1].value);

        if (top > 0 && top < 1) {
            var cents = value * 100;
            // Whole cents normally; one decimal if the axis is finer than that.
            return this.trimNumber(Math.abs(cents) >= 1 ? Math.round(cents) : cents, 1) + "¢";
        }

        // Dollars. A part-dollar amount has to show both decimal places --
        // "$1.5" isn't a way of writing money -- and an axis mixing "$1" with
        // "$1.50" reads as though the labels were rounded inconsistently. So
        // the decision is per axis, not per tick: if any tick lands on a part
        // dollar, every tick shows cents ($1.00 $1.50 $2.00); if they are all
        // whole dollars, none of them do ($0 $1 $2 $3).
        var fractional = list.some(function(tick) {
            return Math.round(tick.value * 100) % 100 !== 0;
        });
        return "$" + (fractional ? value.toFixed(2) : this.trimNumber(value, 2));
    },

    // Round to `decimals` and drop trailing zeros ($1.50 -> 1.5, $2.00 -> 2).
    trimNumber: function(value, decimals) {
        var factor = Math.pow(10, decimals);
        return String(Math.round(value * factor) / factor);
    },

    shortLabels: function(dates) {
        return dates.map(function(d) {
            var parts = d.split("-");
            return parts.length === 3 ? (parts[1] + "/" + parts[2]) : d;
        });
    },

    // Inline Chart.js plugin that stamps each native-currency symbol above its
    // data point. `afterDatasetsDraw` runs once the lines are painted and hands
    // us the resolved pixel position of every point, which is the only place
    // those coordinates exist — they depend on the scale Chart.js settled on.
    nativeMarkerPlugin: function(datasetIndex, markers) {
        var size = this.config.nativeMarkerFontSize || 12;
        // Only reached by the currency-code fallback; emoji carry their own
        // colour. Tinting it like the series ties the code to the right line.
        var color = this.palette.iap;

        return {
            id: "nativeCurrencyMarkers",
            afterDatasetsDraw: function(chart) {
                var meta = chart.getDatasetMeta(datasetIndex);
                // Legend clicks hide a dataset without removing it; its markers
                // should go with it.
                if (!meta || meta.hidden || !meta.data) { return; }

                var ctx = chart.ctx;
                var area = chart.chartArea;
                var margin = size * 0.75;

                ctx.save();
                // Emoji live in a dedicated font on every platform, so name the
                // usual suspects before falling through to sans-serif for the
                // currency-code fallback.
                ctx.font = size + 'px "Noto Color Emoji", "Apple Color Emoji", ' +
                    '"Segoe UI Emoji", sans-serif';
                ctx.textAlign = "center";
                ctx.textBaseline = "bottom";
                ctx.fillStyle = color;

                markers.forEach(function(marker, index) {
                    var point = meta.data[index];
                    if (!marker || !point) { return; }
                    // Centred text on the first or last day would hang over the
                    // axis labels; nudge those inside the plot instead.
                    var x = Math.min(
                        Math.max(point.x, area.left + margin),
                        area.right - margin
                    );
                    // The headroom added below normally leaves room above the
                    // point. Clamp anyway so a marker can never escape upward.
                    var y = Math.max(point.y - 4, area.top + size);
                    ctx.fillText(marker, x, y);
                });

                ctx.restore();
            }
        };
    },

    downloadsChartConfig: function(data) {
        var byDate = this.mergeDaily(data.downloads, function(e) { return e.count; });
        var labels = this.collectLabels([byDate]);
        if (!labels.length) { return null; }

        var series = this.seriesFor(labels, byDate);
        var options = this.baseChartOptions();

        if (this.config.downloadsMirroredAxis) {
            // A second axis with no dataset of its own — it exists only to
            // repeat the left axis' ticks on the right. No dataset means no
            // data limits, and Chart.js falls back to an arbitrary 0..1 range,
            // so hand it the limits the left axis sees: same range through the
            // same tick algorithm lands on the same ticks.
            var max = Math.max.apply(null, series);
            // A series of all zeros collapses the range to 0..0, which yields a
            // duplicated tick. Chart.js widens that to 0..1 for the left axis
            // before `afterDataLimits` can see it, so do the same here.
            if (max <= 0) { max = 1; }
            options.scales.yRight = {
                axis: "y",
                position: "right",
                beginAtZero: true,
                // The left axis already draws the gridlines. Letting this one
                // draw them too would stack two translucent strokes on the same
                // pixels, leaving this grid brighter than the revenue chart's.
                grid: { drawOnChartArea: false, color: this.palette.grid },
                ticks: {
                    color: this.palette.text,
                    maxTicksLimit: 5,
                    font: { size: 9 }
                },
                afterDataLimits: function(scale) {
                    // Downloads are counts, so never negative.
                    scale.min = 0;
                    scale.max = max;
                }
            };
        }

        return {
            type: "line",
            data: {
                labels: this.shortLabels(labels),
                datasets: [{
                    label: this.config.downloadsChartLabel,
                    data: series,
                    borderColor: this.palette.downloads,
                    backgroundColor: this.palette.downloads,
                    tension: 0.3,
                    pointRadius: 0,
                    borderWidth: 2,
                    fill: false
                }]
            },
            options: options
        };
    },

    revenueChartConfig: function(data) {
        var maps = [];
        var datasets = [];
        var iapIndex = -1;
        var adIndex = -1;
        var nativeByDate = {};

        if (this.config.showIapRevenue && data.iapRevenue) {
            var iap = this.mergeDaily(data.iapRevenue, function(e) { return parseFloat(e.revenue); });
            maps.push(iap);
            iapIndex = datasets.length;
            datasets.push({ _map: iap, label: this.config.iapChartLabel, color: this.palette.iap, axis: "y" });
            nativeByDate = this.mergeNativeCurrencies(data.iapRevenue);
        }
        if (this.config.showAdRevenue && data.adRevenue) {
            var ad = this.mergeDaily(data.adRevenue, function(e) { return parseFloat(e.revenue); });
            maps.push(ad);
            adIndex = datasets.length;
            datasets.push({ _map: ad, label: this.config.adChartLabel, color: this.palette.ad, axis: "y1" });
        }

        var labels = this.collectLabels(maps);
        if (!labels.length) { return null; }

        // A second axis only makes sense when both series are on the chart.
        var dual = this.config.revenueDualAxis && datasets.length === 2;

        var self = this;
        var options = this.baseChartOptions();
        options.scales.y.ticks.callback = function(value, index, ticks) {
            return self.moneyTick(value, ticks);
        };

        if (dual) {
            // Tint each axis with its series colour: that's what tells the
            // viewer which line is measured against which scale.
            options.scales.y.ticks.color = this.palette.iap;
            options.scales.y1 = {
                position: "right",
                beginAtZero: true,
                // Only the left axis draws gridlines, otherwise the two sets
                // of lines fight each other in 150px of height.
                grid: { drawOnChartArea: false, color: this.palette.grid },
                ticks: {
                    color: this.palette.ad,
                    maxTicksLimit: 5,
                    font: { size: 9 },
                    callback: function(value, index, ticks) {
                        return self.moneyTick(value, ticks);
                    }
                }
            };
        }

        // Markers ride above the IAP line, which on a peak day sits flush
        // against the top of the plot. Lift the axis ceiling to open up room —
        // but only when there is actually something to draw, so an all-USD
        // range keeps the tick scale it has today.
        var plugins = [];
        var headroom = 1;
        if (iapIndex >= 0 && this.config.showNativeCurrencyMarkers) {
            var markers = this.nativeMarkersFor(labels, nativeByDate);
            if (markers.some(function(m) { return !!m; })) {
                plugins.push(this.nativeMarkerPlugin(iapIndex, markers));
                headroom = 1.2;
            }
        }
        if (headroom !== 1) {
            // IAP is on the left axis in both single- and dual-axis mode.
            options.scales.y.afterDataLimits = function(scale) {
                scale.max = scale.max * headroom || 1;
            };
        }

        // An empty series has nothing to scale against, so Chart.js falls back
        // to an arbitrary 0..1 range. What that axis should show instead depends
        // on whether the other series has anything to borrow from.
        var series = datasets.map(function(ds) {
            return self.seriesFor(labels, ds._map);
        });
        var hasValues = series.map(function(s) {
            return s.some(function(v) { return v > 0; });
        });
        var setLimits = function(axisId, max) {
            options.scales[axisId].afterDataLimits = function(scale) {
                // Every revenue axis is beginAtZero and revenue is never negative.
                scale.min = 0;
                scale.max = max;
            };
        };

        if (!hasValues.some(Boolean)) {
            // Nothing at all this period. Chart.js' 0..1 fallback reads as a
            // dollar scale, which overstates what this chart measures — revenue
            // here lives in cents. Default to a 60-cent axis so an empty chart
            // reads 0¢ 20¢ 40¢ 60¢ instead of $0.00 $0.50 $1.00.
            var emptyAxes = dual ? ["y", "y1"] : ["y"];
            emptyAxes.forEach(function(axisId) { setLimits(axisId, 0.6); });
        } else if (dual && hasValues[iapIndex] !== hasValues[adIndex]) {
            // One side empty, the other populated: without this the empty axis'
            // ticks would be unrelated to the other's — two sets of gridlines at
            // different heights, one of them meaningless. Give the empty axis the
            // same data limits as the series that does have values, so both run
            // the same tick algorithm over the same range and agree exactly.
            var emptyIsIap = !hasValues[iapIndex];
            var max = Math.max.apply(null, series[emptyIsIap ? adIndex : iapIndex]);
            // Match whatever the populated axis ends up showing, including the
            // marker headroom if it was applied to the IAP axis.
            if (!emptyIsIap) { max = max * headroom; }
            setLimits(emptyIsIap ? "y" : "y1", max);
        }

        return {
            type: "line",
            plugins: plugins,
            data: {
                labels: this.shortLabels(labels),
                datasets: datasets.map(function(ds) {
                    return {
                        label: ds.label,
                        data: self.seriesGapped(labels, ds._map),
                        borderColor: ds.color,
                        backgroundColor: ds.color,
                        yAxisID: dual ? ds.axis : "y",
                        tension: 0.3,
                        pointRadius: 0,
                        borderWidth: 2,
                        fill: false
                    };
                })
            },
            options: options
        };
    },

    buildFooter: function() {
        var self = this;
        var footer = document.createElement("div");
        footer.className = "widget-footer";

        var timestamp = document.createElement("span");
        timestamp.className = "last-update";
        if (this.lastUpdate) {
            var timeString = this.lastUpdate.toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit"
            });
            timestamp.innerHTML = "Last updated: " + timeString;
        } else {
            timestamp.innerHTML = "Not yet updated";
        }

        var refreshButton = document.createElement("span");
        refreshButton.className = "refresh-button";

        if (this.isRefreshing) {
            refreshButton.innerHTML = "Refreshing...";
            footer.className += " refreshing";
        } else {
            refreshButton.innerHTML = "Refresh ⟳";
            footer.onclick = function() {
                self.isRefreshing = true;
                self.updateDom();
                self.sendSocketNotification("REFRESH_NOW");
            };
        }

        footer.appendChild(timestamp);
        footer.appendChild(refreshButton);
        return footer;
    }
});
