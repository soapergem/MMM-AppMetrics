const NodeHelper = require("node_helper");
const https = require("https");
const http = require("http");

module.exports = NodeHelper.create({
    start: function() {
        console.log("Starting node helper for: " + this.name);
        this.config = null;
        this.updateTimer = null;
        // Consecutive rounds in which at least one metric failed. Drives the
        // retry delay; reset only by a round where everything came back.
        this.consecutiveErrors = 0;
    },

    socketNotificationReceived: function(notification, payload) {
        if (notification === "CONFIG") {
            this.config = payload;
            this.startPolling();
        } else if (notification === "REFRESH_NOW") {
            // Restart polling (which resets the timer and fetches immediately)
            this.startPolling();
        }
    },

    startPolling: function() {
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        }

        if (!this.config.baseURL || !this.config.basicAuth) {
            this.sendSocketNotification("ERROR", "Base URL and Basic Auth are required");
            return;
        }

        // Each round schedules the next one itself, so the interval can vary
        // with how the last one went.
        this.consecutiveErrors = 0;
        this.fetchData();
    },

    // How long to wait before the next round.
    //
    // A failed round retries *sooner* than the normal interval, not later:
    // something is on screen going stale, so the quicker a retry lands the
    // less time the display spends wrong. The delay doubles from retryBackoff
    // and is capped at updateInterval, so a persistent outage settles back
    // into the ordinary cadence rather than hammering the API.
    //
    // Both values are floored, because this paces the loop that talks to the
    // API and a zero or missing delay would turn it into a hot retry loop.
    nextDelay: function() {
        const interval = Math.max(this.config.updateInterval || 3600000, 1000);
        if (this.consecutiveErrors < 1) {
            return interval;
        }
        const backoff = Math.max(this.config.retryBackoff || 60000, 1000);
        return Math.min(
            backoff * Math.pow(2, this.consecutiveErrors - 1),
            interval
        );
    },

    // Queue the next round, replacing any already pending, and report the
    // delay chosen. Polling never stops: this module used to give up
    // permanently after five consecutive failures, which froze the display
    // until MagicMirror was restarted — the one state a wall display cannot
    // recover from on its own.
    scheduleNext: function() {
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
        }
        const delay = this.nextDelay();
        this.updateTimer = setTimeout(() => {
            this.fetchData();
        }, delay);
        return delay;
    },

    // Compute the inclusive date window [start, end] as YYYY-MM-DD strings.
    //
    // Formatted in local time, deliberately. toISOString() renders the UTC
    // date, which anywhere west of Greenwich is already tomorrow late in the
    // evening — 19:00 in US Central, 18:00 once it drops back to standard time.
    // The window is built from a local `new Date()`, so formatting it as UTC
    // slid the whole range a day forward: the API accepts the future date
    // without complaint and zero-fills it, so the chart grew a phantom empty
    // day on the right and silently dropped the oldest real one.
    dateRange: function() {
        const fmt = (d) => {
            const pad = (n) => String(n).padStart(2, "0");
            return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
        };
        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - (this.config.days - 1));
        return { start_date: fmt(start), end_date: fmt(end) };
    },

    // Fetch a single metrics endpoint and resolve its parsed JSON body.
    fetchJSON: function(endpoint, query) {
        return new Promise((resolve, reject) => {
            const base = new URL(this.config.baseURL);
            const isHttps = base.protocol === "https:";
            const requestModule = isHttps ? https : http;

            // Join base path with the endpoint, tolerating a trailing slash.
            const basePath = base.pathname.replace(/\/+$/, "");
            const params = new URLSearchParams(query);
            const path = basePath + endpoint + "?" + params.toString();

            const authHeader = "Basic " + Buffer.from(this.config.basicAuth, "utf8").toString("base64");

            const options = {
                hostname: base.hostname,
                port: base.port || (isHttps ? 443 : 80),
                path: path,
                method: "GET",
                headers: {
                    "Authorization": authHeader,
                    "Accept": "application/json"
                }
            };

            const req = requestModule.request(options, (res) => {
                let data = "";
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    if (res.statusCode === 200) {
                        try {
                            resolve(JSON.parse(data));
                        } catch (error) {
                            reject(new Error("Failed to parse " + endpoint + ": " + error.message));
                        }
                    } else {
                        reject(new Error(endpoint + " returned status " + res.statusCode));
                    }
                });
            });

            req.on("error", (error) => {
                reject(new Error("Request error for " + endpoint + ": " + error.message));
            });

            // Must stay above the API's own worst case, or a slow-but-working
            // upstream is reported here as a timeout while the API is still
            // waiting on it — which is what used to drop IAP revenue on the
            // days its currency-conversion provider ran slow. Nothing is
            // waiting on this interactively; it is a background poll.
            req.setTimeout(this.config.requestTimeout, () => {
                req.destroy();
                reject(new Error("Request timeout for " + endpoint));
            });

            req.end();
        });
    },

    fetchData: function() {
        const range = this.dateRange();
        const query = Object.assign({}, range);
        if (this.config.platform) { query.platform = this.config.platform; }
        if (this.config.app) { query.app = this.config.app; }

        // Build the set of metric requests the user has enabled.
        const jobs = [];
        if (this.config.showDownloads) {
            jobs.push({ key: "downloads", endpoint: "/metrics/downloads" });
        }
        if (this.config.showIapRevenue) {
            jobs.push({ key: "iapRevenue", endpoint: "/metrics/iap-revenue" });
        }
        if (this.config.showAdRevenue) {
            jobs.push({ key: "adRevenue", endpoint: "/metrics/ad-revenue" });
        }

        if (jobs.length === 0) {
            // Configuration, not connectivity. Retrying cannot change it.
            this.sendSocketNotification("ERROR", "No metrics enabled (showDownloads / showIapRevenue / showAdRevenue are all false)");
            return;
        }

        Promise.all(jobs.map((job) =>
            this.fetchJSON(job.endpoint, query)
                .then((body) => ({ key: job.key, body: body, error: null }))
                .catch((error) => ({ key: job.key, body: null, error: error.message }))
        )).then((results) => {
            const payload = { range: range, errors: [] };
            let anySuccess = false;

            results.forEach((result) => {
                if (result.error) {
                    payload.errors.push(result.key + ": " + result.error);
                } else {
                    payload[result.key] = result.body;
                    anySuccess = true;
                }
            });

            // Any metric missing is enough to retry early — the module is
            // holding that one over from an earlier round, and a short retry
            // is what gets it current again instead of waiting out the hour.
            const failed = payload.errors.length;
            this.consecutiveErrors = failed ? this.consecutiveErrors + 1 : 0;

            if (anySuccess) {
                this.sendSocketNotification("APP_DATA", payload);
            } else {
                this.sendSocketNotification("ERROR", payload.errors.join("; "));
            }

            const delay = this.scheduleNext();
            if (failed) {
                console.warn(
                    this.name + ": " + failed + " metric(s) failed (" +
                    this.consecutiveErrors + " round(s) in a row); retrying in " +
                    Math.round(delay / 1000) + "s"
                );
            }
        });
    },

    stop: function() {
        if (this.updateTimer) {
            clearTimeout(this.updateTimer);
        }
    }
});
