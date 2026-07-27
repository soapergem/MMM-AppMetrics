Module.register("MMM-AppMetrics", {
    defaults: {
        baseURL: "",              // API base URL, e.g. "https://app-metrics.example.com"
        basicAuth: "",            // "username:password"
        app: "",                  // optional app filter
        platform: "",             // "", "ios" or "android"
        days: 30,                 // lookback window (inclusive)
        updateInterval: 3600000,  // 1 hour in milliseconds
        showDownloads: true,
        showIapRevenue: true,
        showAdRevenue: true,
        // Plot ad revenue against its own right-hand axis so cent-scale ad
        // numbers stay legible next to dollar-scale IAP numbers.
        revenueDualAxis: true,
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

    start: function() {
        this.data_ = null;
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
        if (notification === "APP_DATA") {
            this.error = null;
            this.isRefreshing = false;
            this.data_ = payload;
            this.lastUpdate = new Date();
            this.loaded = true;
            this.updateDom();
        } else if (notification === "ERROR") {
            Log.error("MMM-AppMetrics: " + payload);
            this.error = payload;
            this.isRefreshing = false;
            this.loaded = true;
            this.updateDom();
        }
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

        if (this.error) {
            var errorMessage = document.createElement("div");
            errorMessage.className = "error-message";
            errorMessage.innerHTML = "Error loading metrics: " + this.error;
            wrapper.appendChild(errorMessage);
            wrapper.className += " error";
            wrapper.appendChild(this.buildFooter());
            return wrapper;
        }

        var data = this.data_ || {};

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

        if (data.errors && data.errors.length) {
            var partial = document.createElement("div");
            partial.className = "partial-error";
            partial.innerHTML = "Some metrics unavailable: " + data.errors.join("; ");
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
                label: this.config.downloadsSummaryLabel,
                value: this.downloadsTotal(data.downloads).toLocaleString("en-US"),
                cls: "metric-downloads"
            });
        }
        if (this.config.showIapRevenue && data.iapRevenue) {
            items.push({
                label: this.config.iapSummaryLabel,
                value: this.formatMoney(this.revenueTotal(data.iapRevenue), this.revenueCurrency(data.iapRevenue)),
                cls: "metric-iap"
            });
        }
        if (this.config.showAdRevenue && data.adRevenue) {
            items.push({
                label: this.config.adSummaryLabel,
                value: this.formatMoney(this.revenueTotal(data.adRevenue), this.revenueCurrency(data.adRevenue)),
                cls: "metric-ad"
            });
        }

        var self = this;
        items.forEach(function(item) {
            var cell = document.createElement("div");
            cell.className = "summary-item " + item.cls;

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

    // Compact currency tick, with enough decimals for whatever scale the
    // axis ended up on ($120 / $1.4 / $0.03).
    moneyTick: function(value) {
        var abs = Math.abs(value);
        if (abs >= 10 || value === 0) { return "$" + value.toFixed(0); }
        if (abs >= 1) { return "$" + value.toFixed(1); }
        return "$" + value.toFixed(2);
    },

    shortLabels: function(dates) {
        return dates.map(function(d) {
            var parts = d.split("-");
            return parts.length === 3 ? (parts[1] + "/" + parts[2]) : d;
        });
    },

    downloadsChartConfig: function(data) {
        var byDate = this.mergeDaily(data.downloads, function(e) { return e.count; });
        var labels = this.collectLabels([byDate]);
        if (!labels.length) { return null; }

        return {
            type: "line",
            data: {
                labels: this.shortLabels(labels),
                datasets: [{
                    label: this.config.downloadsChartLabel,
                    data: this.seriesFor(labels, byDate),
                    borderColor: this.palette.downloads,
                    backgroundColor: this.palette.downloads,
                    tension: 0.3,
                    pointRadius: 0,
                    borderWidth: 2,
                    fill: false
                }]
            },
            options: this.baseChartOptions()
        };
    },

    revenueChartConfig: function(data) {
        var maps = [];
        var datasets = [];

        if (this.config.showIapRevenue && data.iapRevenue) {
            var iap = this.mergeDaily(data.iapRevenue, function(e) { return parseFloat(e.revenue); });
            maps.push(iap);
            datasets.push({ _map: iap, label: this.config.iapChartLabel, color: this.palette.iap, axis: "y" });
        }
        if (this.config.showAdRevenue && data.adRevenue) {
            var ad = this.mergeDaily(data.adRevenue, function(e) { return parseFloat(e.revenue); });
            maps.push(ad);
            datasets.push({ _map: ad, label: this.config.adChartLabel, color: this.palette.ad, axis: "y1" });
        }

        var labels = this.collectLabels(maps);
        if (!labels.length) { return null; }

        // A second axis only makes sense when both series are on the chart.
        var dual = this.config.revenueDualAxis && datasets.length === 2;

        var self = this;
        var options = this.baseChartOptions();
        options.scales.y.ticks.callback = function(value) { return self.moneyTick(value); };

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
                    callback: function(value) { return self.moneyTick(value); }
                }
            };
        }

        return {
            type: "line",
            data: {
                labels: this.shortLabels(labels),
                datasets: datasets.map(function(ds) {
                    return {
                        label: ds.label,
                        data: self.seriesFor(labels, ds._map),
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
