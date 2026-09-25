// One cookieless page view per load, counted per day and page by the Worker in waitlist/.
if (location.hostname === "gangway.sh" && navigator.sendBeacon) {
  navigator.sendBeacon("https://gangway-waitlist.charles-2cc.workers.dev/hit", location.pathname);
}
