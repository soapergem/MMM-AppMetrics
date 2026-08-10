const NodeHelper = require("node_helper");
const https = require("https");
const http = require("http");

module.exports = NodeHelper.create({
    start: function() {
        console.log("Starting node helper for: " + this.name);
        this.config = null;
        this.updateTimer = null;
        this.consecutiveErrors = 0;
        this.maxConsecutiveErrors = 5;
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
            clearInterval(this.updateTimer);
        }

        if (!this.config.baseURL || !this.config.basicAuth) {
            this.sendSocketNotification("ERROR", "Base URL and Basic Auth are required");
            return;
        }

        this.consecutiveErrors = 0;
        this.fetchData();
        this.updateTimer = setInterval(() => {
            this.fetchData();
        }, this.config.updateInterval);
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

            req.setTimeout(15000, () => {
                req.destroy();
                reject(new Error("Request timeout for " + endpoint));
            });

            req.end();
        });
    },

    fetchData: function() {
        // Stop polling if too many consecutive errors
        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
            console.error(this.name + ": Too many consecutive errors (" + this.consecutiveErrors + "), stopping polling");
            clearInterval(this.updateTimer);
            this.sendSocketNotification("ERROR", "Too many consecutive errors. Please check your configuration and restart MagicMirror.");
            return;
        }

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

            if (!anySuccess) {
                this.consecutiveErrors++;
                this.sendSocketNotification("ERROR", payload.errors.join("; "));
                return;
            }

            this.consecutiveErrors = 0;
            this.sendSocketNotification("APP_DATA", payload);
        });
    },

    stop: function() {
        if (this.updateTimer) {
            clearInterval(this.updateTimer);
        }
    }
});
